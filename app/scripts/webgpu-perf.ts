#!/usr/bin/env bun
// Sequential native WebGPU vs existing WebGL measurements at identical Full
// preview settings. GPU-only timings and rAF/CPU timing are separate metrics.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const url = opt('url', 'http://127.0.0.1:5173');
const root = opt('out', '../out/webgpu-eval');
const scale = +opt('scale', '2'), frames = +opt('frames', '120'), runs = +opt('runs', '3');
const warmup = +opt('warmup-frames', '12'), rafMs = +opt('raf-ms', '3000');
const times = opt('times', '98,100,101').split(',').map(Number);
const effects = opt('effects', '0,1').split(',').map(n => n === '1');
assert.ok(Number.isInteger(frames) && frames > 0 && Number.isInteger(runs) && runs > 0);
assert.ok(warmup >= 0 && rafMs >= 500 && [1, 2].includes(scale) && times.every(Number.isFinite));
const browser = await chromium.launch({ channel: 'chrome', headless: !args.includes('--headed') });
const results: any[] = [];
try {
  for (const on of effects) {
    for (let run = 0; run < runs; run++) {
      // Reverse order every round to reduce systematic thermal/order bias.
      for (const backend of run % 2 ? ['webgpu', 'webgl'] : ['webgl', 'webgpu']) {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
        await page.goto(`${url}/${backend === 'webgpu' ? 'webgpu-preview.html' : ''}?export=1&only=paperclips&scale=${scale}&t=100`);
        await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 120000 });
        const hardware = await page.evaluate(({ backend, on }) => {
          const P = (window as any).__pdoom, e = P.engine;
          if (P.error || e.errors.length) throw new Error(JSON.stringify(P.error ?? e.errors));
          e.effects.grain = on; e.effects.motionBlur = on;
          if (backend === 'webgpu') {
            if (P.backend !== 'webgpu') throw new Error('WebGPU fell back; cannot benchmark it as WebGPU.');
            return { ...e.diagnostics(), width: P.width, height: P.height };
          }
          e.preview = true; e.quality.mode = 'full';
          const gl = e.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
          return { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), width: P.width, height: P.height };
        }, { backend, on });
        for (const t of times) {
          const measurements = await page.evaluate(async ({ t, frames, warmup, rafMs, backend }) => {
            const e = (window as any).__pdoom.engine;
            const gl: WebGL2RenderingContext | null = backend === 'webgl' ? e.renderer.getContext() : null;
            const ext = gl?.getExtension('EXT_disjoint_timer_query_webgl2');
            const median = (a: number[]) => [...a].sort((a, b) => a - b)[Math.floor(a.length * .5)];
            const p95 = (a: number[]) => [...a].sort((a, b) => a - b)[Math.floor(a.length * .95)];
            const complete = async () => {
              if (!gl) { await e.settled(); return; }
              const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!; gl.flush();
              const deadline = performance.now() + 30000;
              try {
                while (true) {
                  const status = gl.clientWaitSync(fence, 0, 0);
                  if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break;
                  if (status === gl.WAIT_FAILED || performance.now() > deadline) throw new Error('GPU completion failed/timed out');
                  await new Promise(r => setTimeout(r, 4));
                }
              } finally { gl.deleteSync(fence); }
            };
            const gpu: number[] = [], submit: number[] = [], completion: number[] = [];
            const haveTimer = gl ? !!ext : e.gpuTimer;
            for (let i = 0; i < frames + warmup; i++) {
              let duration: number | null = null;
              if (!gl && haveTimer) duration = await e.measureGPU(t);
              else if (gl && ext) {
                const q = gl.createQuery()!;
                try {
                  gl.beginQuery(ext.TIME_ELAPSED_EXT, q); e.render(t); gl.endQuery(ext.TIME_ELAPSED_EXT); gl.flush();
                  const deadline = performance.now() + 30000;
                  while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
                    if (performance.now() > deadline) throw new Error('GPU timer query timed out');
                    await new Promise(r => setTimeout(r, 4));
                  }
                  if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) duration = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
                } finally { gl.deleteQuery(q); }
              } else { e.render(t); await complete(); }
              if (i >= warmup && duration !== null) gpu.push(duration);
            }
            // Use the same wall-clock completion protocol category for each
            // backend, but don't label fence polling vs map/queue time as GPU.
            for (let i = 0; i < 30; i++) {
              const start = performance.now(); e.render(t + i / 60); submit.push(performance.now() - start);
              await complete(); completion.push(performance.now() - start);
            }
            const interval: number[] = [], cpu: number[] = []; let first = 0, last = 0, count = 0;
            await new Promise<void>(resolve => {
              const tick = (now: number) => {
                if (count > 0) interval.push(now - last); else first = now;
                last = now; const start = performance.now(); e.render(t + (count % 30) / 60); cpu.push(performance.now() - start); count++;
                if (now - first < rafMs) requestAnimationFrame(tick); else resolve();
              };
              requestAnimationFrame(tick);
            });
            await complete();
            if (e.errors.length) throw new Error(JSON.stringify(e.errors));
            return { gpuMedianMs: gpu.length ? median(gpu) : null, gpuP95Ms: gpu.length ? p95(gpu) : null, gpuSamples: gpu.length,
              cpuMedianMs: median(cpu), cpuP95Ms: p95(cpu), completionMedianMs: median(completion),
              rafFPS: (count - 1) * 1000 / (last - first), rafP95Ms: p95(interval) };
          }, { t, frames, warmup, rafMs, backend });
          const result = { backend, scale, effects: on, run: run + 1, t, hardware, ...measurements };
          results.push(result); console.log(JSON.stringify(result));
        }
        await page.close();
      }
    }
  }
  const median = (a: number[]) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
  const comparison = effects.flatMap(on => times.map(t => {
    const a = results.filter(r => r.effects === on && r.t === t && r.backend === 'webgl');
    const b = results.filter(r => r.effects === on && r.t === t && r.backend === 'webgpu');
    const glGPU = a.every(r => r.gpuMedianMs !== null) ? median(a.map(r => r.gpuMedianMs)) : null;
    const wgGPU = b.every(r => r.gpuMedianMs !== null) ? median(b.map(r => r.gpuMedianMs)) : null;
    const glP95 = median(a.map(r => r.rafP95Ms)), wgP95 = median(b.map(r => r.rafP95Ms));
    return { effects: on, t, webglGPU: glGPU, webgpuGPU: wgGPU, gpuReduction: glGPU && wgGPU !== null ? 1 - wgGPU / glGPU : null,
      webglRafP95: glP95, webgpuRafP95: wgP95, rafP95Reduction: 1 - wgP95 / glP95,
      webglFPS: median(a.map(r => r.rafFPS)), webgpuFPS: median(b.map(r => r.rafFPS)) };
  }));
  // Performance is a finding, not a CI correctness assertion. A failed gate
  // means retain the experiment, not silently reduce quality or migrate more.
  const heavy = comparison.filter(r => r.t === 100 || r.t === 101);
  const performanceGate = heavy.length === effects.length * 2 && heavy.every(r => r.gpuReduction !== null && r.gpuReduction >= .2 && r.rafP95Reduction >= .1);
  const output = { browser: browser.version(), date: new Date().toISOString(), config: { scale, frames, runs, warmup, rafMs, times, effects },
    notes: ['WebGL timer queries include work submitted by engine.render; WebGPU timestamps bracket rendering passes, excluding external-image queue copies.',
      'rAF rates measure submitted frames, not physical display scanout. Timestamp quantization and driver code generation differ.',
      'No GPU benchmarks ran concurrently. Native HDR and offline export are outside this experiment.'], performanceGate, comparison, results };
  if (!existsSync(root)) await mkdir(root, { recursive: true });
  await Bun.write(`${root}/perf-results.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ performanceGate, comparison }, null, 2));
} finally { await browser.close(); }
