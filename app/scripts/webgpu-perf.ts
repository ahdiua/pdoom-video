#!/usr/bin/env bun
// The native WebGPU Paperclips renderer against the WebGL preview at Full detail (docs/WEBGPU.md).
// Every configuration is measured the same way, in a visible Chrome on the real display:
//   burst GPU    one GPU timer around N back-to-back frames, best of three (frames timed one at a time
//                let the GPU clock down between them, and the two APIs wait differently)
//   burst wall   N back-to-back frames, then wait for the GPU: wall clock per frame, uploads included
//   rAF          a moving 0.5 s excerpt looped for some seconds: mean frame interval, its standard deviation
//                and how many refreshes each frame took (a P95 only says which multiple of the refresh was hit)
//   cold start   each launch is a fresh profile: time to a ready page, shader preparation, longest freeze
// The idle GPU is sampled before each launch (nvidia-smi) and other processes' GPU use while it runs
// (gpu-watch.ps1), so a run disturbed by other software shows.
//   bun scripts/webgpu-perf.ts [--scale 2] [--rounds 5] [--times 98,99.5,100,101,101.5] [--burst 40] [--seconds 5]
//     [--configs webgl,webgpu-loop,webgpu-unrolled,webgpu-flat] [--hdr] [--grain] [--headless]
//     [--chrome-args "--a --b"] [--url URL] [--out ../out/webgpu-eval]
// --hdr measures the HDR preview instead: WebGL through its bridge against the native HDR canvas
// (?hdr=test on both; results go to perf-results-hdr.json).
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { reachable, startServer } from './server';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const flag = (name: string) => args.includes(`--${name}`);
const scale = +opt('scale', '2'), rounds = +opt('rounds', '5'), burst = +opt('burst', '40'), seconds = +opt('seconds', '5');
const times = opt('times', '98,99.5,100,101,101.5').split(',').map(Number);
const hdr = flag('hdr'), grain = flag('grain'), headless = flag('headless');
const configs = opt('configs', hdr ? 'webgl,webgpu-loop' : 'webgl,webgpu-loop,webgpu-unrolled,webgpu-flat').split(',');
const chromeArgs = opt('chrome-args', '').split(' ').filter(Boolean);
const out = path.resolve(opt('out', '../out/webgpu-eval'));
const HEAVY = [100, 101];
assert.ok([1, 2].includes(scale) && rounds > 0 && burst > 0 && seconds >= 1 && times.every(Number.isFinite));
assert.ok(configs.every((c) => /^webgl$|^webgpu-(loop|unrolled|flat)$/.test(c)), 'configs: webgl, webgpu-loop, webgpu-unrolled, webgpu-flat');

/** The idle GPU, averaged over a second: other software shows here as utilisation before anything of ours runs. */
async function idleGPU() {
  const samples: number[][] = [];
  for (let i = 0; i < 4; i++) {
    try {
      const p = Bun.spawnSync(['nvidia-smi', '--query-gpu=utilization.gpu,clocks.current.graphics,power.draw,temperature.gpu', '--format=csv,noheader,nounits']);
      const row = p.stdout.toString().trim().split('\n')[0]!.split(',').map(Number);
      if (row.length === 4 && row.every(Number.isFinite)) samples.push(row);
    } catch { return null; }
    await Bun.sleep(300);
  }
  if (!samples.length) return null;
  const mean = (k: number) => +(samples.reduce((a, s) => a + s[k]!, 0) / samples.length).toFixed(1);
  return { utilization: mean(0), maxUtilization: Math.max(...samples.map((s) => s[0]!)), clockMHz: mean(1), watts: mean(2), celsius: mean(3) };
}
/**
 * What else used the GPU while a run measured: gpu-watch.ps1 reports the 3D engine's utilisation per process
 * about once a second. Chrome is the benchmark and the window manager composes its frames; the rest is other software.
 */
function watchGPU() {
  const samples: { at: number; other: number; top: string }[] = [];
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try { proc = Bun.spawn(['pwsh', '-NoProfile', '-File', path.resolve(import.meta.dir, 'gpu-watch.ps1')], { stdout: 'pipe', stderr: 'ignore' }); } catch { return null; }
  void (async () => {
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      rest = lines.pop()!;
      for (const line of lines) {
        const others = line.split(';').filter(Boolean).map((e) => e.split('=')).filter(([name]) => !/^(chrome|dwm)$/i.test(name!))
          .map(([name, percent]) => ({ name: name!, percent: Number(percent) })).sort((a, b) => b.percent - a.percent);
        samples.push({ at: performance.now(), other: others.reduce((a, o) => a + o.percent, 0), top: others[0]?.name ?? '' });
      }
    }
  })().catch(() => {});
  return {
    /** Other software's GPU use since `from` (performance.now()): mean and peak percent, and who led at the peak. */
    since(from: number) {
      const window = samples.filter((s) => s.at >= from);
      if (!window.length) return null;
      const peak = window.reduce((a, s) => (s.other > a.other ? s : a));
      return { mean: +(window.reduce((a, s) => a + s.other, 0) / window.length).toFixed(1), max: +peak.other.toFixed(1), top: peak.top, samples: window.length };
    },
    stop() { proc?.kill(); },
  };
}
function gpuProcesses() {
  try {
    const text = Bun.spawnSync(['nvidia-smi']).stdout.toString();
    return [...new Set([...text.matchAll(/\b[CG+]+\s+(\S.*?\.exe)/g)].map((m) => m[1]!.split(/[\\/]/).pop()!))].sort();
  } catch { return []; }
}

const base = opt('url', '');
const server = base ? null : await startServer();
const url = base || server!.url;
if (base && !(await reachable(base))) throw new Error(`No preview server at ${base}`);

type Row = Record<string, any>;
const results: Row[] = [];
let browserVersion = '', display: Row | null = null;
const watch = watchGPU();
try {
  for (let round = 0; round < rounds; round++) {
    // reverse the order every round: whatever drifts (temperature, clocks) lands on each side equally
    for (const config of round % 2 ? [...configs].reverse() : configs) {
      await Bun.sleep(2500); // let the previous run's load leave the utilisation average
      const idle = await idleGPU(), launched = performance.now();
      const webgpu = config !== 'webgl';
      // (the forced sRGB profile hides an HDR display from the page: drop it when HDR output is the subject)
      const browser = await chromium.launch({ channel: 'chrome', headless, args: ['--start-maximized', ...chromeArgs], ignoreDefaultArgs: hdr ? ['--force-color-profile=srgb'] : [] });
      try {
        browserVersion = browser.version();
        const page = await browser.newPage(headless ? { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } : { viewport: null });
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        // the longest gap between animation frames until the page is ready: how long loading froze
        await page.addInitScript(() => {
          const boot = ((window as any).__boot = { frozen: 0, last: performance.now(), done: false });
          const tick = () => { const now = performance.now(); boot.frozen = Math.max(boot.frozen, now - boot.last); boot.last = now; if (!boot.done) requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        });
        const query = `scale=${scale}&t=100${hdr ? '&hdr=test' : ''}`;
        await page.goto(webgpu ? `${url}/webgpu-preview.html?${query}&map=${config.slice(7)}` : `${url}/?only=paperclips&detail=full&${query}`);
        await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error || location.search.includes('webgpu-fallback'), null, { timeout: 180000 });
        const start = await page.evaluate(async ({ webgpu, hdr, grain }) => {
          const P = (window as any).__pdoom, boot = (window as any).__boot;
          const readyMs = performance.now(); boot.done = true;
          if (location.search.includes('webgpu-fallback')) throw new Error(`WebGPU fell back: ${location.search}`);
          if (P.error) throw new Error(P.error);
          const e = P.engine;
          if (e.errors.length) throw new Error(JSON.stringify(e.errors));
          e.effects.grain = grain; e.effects.motionBlur = false;
          // the display's refresh interval: the median gap of a second of idle animation frames
          const gaps: number[] = [];
          await new Promise<void>((resolve) => {
            let last = 0, first = 0;
            const tick = (now: number) => { if (last) gaps.push(now - last); else first = now; last = now; if (now - first < 1000) requestAnimationFrame(tick); else resolve(); };
            requestAnimationFrame(tick);
          });
          gaps.sort((a, b) => a - b);
          const displayInfo = { refreshMs: gaps[gaps.length >> 1], screen: [screen.width, screen.height], window: [innerWidth, innerHeight], dpr: devicePixelRatio,
            hdrDisplay: matchMedia('(dynamic-range: high)').matches, visible: document.visibilityState, focused: document.hasFocus() };
          if (webgpu) {
            if (P.backend !== 'webgpu') throw new Error('Not the WebGPU renderer.');
            const d = e.diagnostics();
            if (d.hdr !== hdr) throw new Error('HDR output was not set up as asked.');
            return { readyMs, frozenMs: boot.frozen, prepareMs: d.timing.compileMs + d.timing.warmupMs, compileMs: d.timing.compileMs, firstDrawsMs: d.timing.warmupMs,
              gpu: `${d.adapter.vendor} ${d.adapter.architecture} ${d.adapter.device} ${d.adapter.description}`.trim(), canvasFormat: d.canvasFormat, displayInfo };
          }
          if (!e.preview || e.quality.mode !== 'full') throw new Error('The WebGL preview is not at Full detail.');
          if (hdr && !e.hdrDisplay) throw new Error(`HDR preview unavailable: ${P.hdr?.reason}`);
          const gl = e.renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
          return { readyMs, frozenMs: boot.frozen, prepareMs: e.warmupStats.milliseconds, programs: e.warmupStats.programs,
            gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), displayInfo };
        }, { webgpu, hdr, grain });
        display ??= start.displayInfo;
        for (const t of times) {
          const m = await page.evaluate(async ({ t, burst, seconds, webgpu, refreshMs }) => {
            const e = (window as any).__pdoom.engine;
            const gl: WebGL2RenderingContext | null = webgpu ? null : e.renderer.getContext();
            const timer = gl?.getExtension('EXT_disjoint_timer_query_webgl2');
            const complete = async () => {
              if (!gl) { await e.settled(); return; }
              // (the HDR bridge's copy needs the WebGL frame, so its queue finishing covers both)
              if (e.hdrDisplay) { await e.hdrDisplay.settled(); return; }
              const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!; gl.flush();
              try {
                while (true) {
                  const status = gl.clientWaitSync(fence, 0, 0);
                  if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break;
                  if (status === gl.WAIT_FAILED) throw new Error('GPU fence failed');
                  await new Promise((r) => setTimeout(r, 0));
                }
              } finally { gl.deleteSync(fence); }
            };
            const gpuBurst = async (frames: number) => {
              if (!gl) return e.gpuTimer ? e.burstGPU(t, frames) as Promise<number> : null;
              if (!timer) return null;
              const q = gl.createQuery()!;
              gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
              for (let i = 0; i < frames; i++) e.render(t);
              gl.endQuery(timer.TIME_ELAPSED_EXT); gl.flush();
              while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await new Promise((r) => setTimeout(r, 2));
              const ms = gl.getParameter(timer.GPU_DISJOINT_EXT) ? null : gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / frames;
              gl.deleteQuery(q);
              return ms;
            };
            const wallBurst = async (frames: number) => {
              const started = performance.now();
              for (let i = 0; i < frames; i++) e.render(t);
              await complete();
              return (performance.now() - started) / frames;
            };
            // the excerpt is t .. t + 0.5 s: outside the plate WebGL draws nothing and would look fast
            const plate = webgpu ? e : e.timeline.find((x: { id: string }) => x.id === 'paperclips');
            if (t < plate.start || t + 0.5 >= plate.end) throw new Error(`t=${t} + 0.5 s leaves the plate (${plate.start}-${plate.end})`);
            // every frame of the excerpt once, so nothing in the timings is a first use
            for (let i = 0; i < 30; i++) e.render(t + i / 60);
            await complete();
            await gpuBurst(12);
            const gpu = [await gpuBurst(burst), await gpuBurst(burst), await gpuBurst(burst)].filter((x): x is number => x !== null);
            const wall = [await wallBurst(burst), await wallBurst(burst), await wallBurst(burst)];
            const intervals: number[] = [], cpu: number[] = [];
            let first = 0, last = 0, count = 0;
            await new Promise<void>((resolve) => {
              const tick = (now: number) => {
                if (count > 0) intervals.push(now - last); else first = now;
                last = now;
                const started = performance.now(); e.render(t + (count % 30) / 60); cpu.push(performance.now() - started); count++;
                if (now - first < seconds * 1000) requestAnimationFrame(tick); else resolve();
              };
              requestAnimationFrame(tick);
            });
            await complete();
            if (e.errors.length) throw new Error(JSON.stringify(e.errors));
            // how many refreshes each frame took: 1, 2, 3, 4 or more
            const refreshes = [0, 0, 0, 0];
            for (const x of intervals) refreshes[Math.min(4, Math.max(1, Math.round(x / refreshMs))) - 1]!++;
            cpu.sort((a, b) => a - b);
            const mean = (last - first) / (count - 1);
            const jitter = Math.sqrt(intervals.reduce((a, x) => a + (x - mean) ** 2, 0) / intervals.length);
            return { gpuBurstMs: gpu.length ? Math.min(...gpu) : null, gpuBursts: gpu, wallBurstMs: Math.min(...wall), wallBursts: wall,
              rafMeanMs: mean, rafJitterMs: jitter, rafFPS: (count - 1) * 1000 / (last - first), rafFrames: count, refreshes, cpuMedianMs: cpu[cpu.length >> 1] };
          }, { t, burst, seconds, webgpu, refreshMs: start.displayInfo.refreshMs });
          const { displayInfo, ...cold } = start;
          const row = { config, round: round + 1, t, ...m, cold, idle, visible: displayInfo.visible, focused: displayInfo.focused };
          results.push(row);
          console.log(JSON.stringify({ config, round: round + 1, t, gpu: m.gpuBurstMs && +m.gpuBurstMs.toFixed(2), wall: +m.wallBurstMs.toFixed(2), raf: +m.rafMeanMs.toFixed(2), fps: +m.rafFPS.toFixed(1),
            refreshes: m.refreshes.join('/'), prepare: Math.round(cold.prepareMs), idle: idle?.utilization }));
        }
        assert.deepEqual(pageErrors, []);
        const other = watch?.since(launched) ?? null;
        for (const row of results) if (row.config === config && row.round === round + 1) row.other = other;
        if (other) console.log(JSON.stringify({ config, round: round + 1, otherSoftwareGPU: other }));
      } finally { await browser.close(); }
    }
  }
} finally { server?.stop(); watch?.stop(); }

// ------------------------------------------------------------------ summary and gate
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
const spread = (a: number[]) => (Math.max(...a) - Math.min(...a)) / median(a);
const cell = (config: string, t: number, key: string) => results.filter((r) => r.config === config && r.t === t && r[key] !== null).map((r) => r[key] as number);
const summary = configs.flatMap((config) => times.map((t) => {
  const stat = (key: string) => { const a = cell(config, t, key); return a.length ? { median: +median(a).toFixed(3), spread: +spread(a).toFixed(3), rounds: a.map((x) => +x.toFixed(3)) } : null; };
  const refreshes = [0, 1, 2, 3].map((i) => results.filter((r) => r.config === config && r.t === t).reduce((a, r) => a + r.refreshes[i], 0));
  return { config, t, gpuBurstMs: stat('gpuBurstMs'), wallBurstMs: stat('wallBurstMs'), rafMeanMs: stat('rafMeanMs'), rafJitterMs: stat('rafJitterMs'), refreshes };
}));
const cold = Object.fromEntries(configs.map((config) => {
  const runs = results.filter((r) => r.config === config && r.t === times[0]).map((r) => r.cold);
  return [config, { prepareMs: +median(runs.map((c) => c.prepareMs)).toFixed(0), readyMs: +median(runs.map((c) => c.readyMs)).toFixed(0), frozenMs: +median(runs.map((c) => c.frozenMs)).toFixed(0),
    prepareRounds: runs.map((c) => Math.round(c.prepareMs)), gpu: runs[0]?.gpu }];
}));
// The gate (docs/WEBGPU.md), fixed before measuring: at both heavy times, burst GPU time and mean frame interval at
// least 10% lower than WebGL and by more than either side's spread between rounds. The WebGPU variant that stands
// for the backend is the fastest whose cold shader preparation is within 20% of WebGL's: the WebGL shader gave up
// frame time for compile time, and a variant may only take that back if it does not cost the compile time again.
const at = (config: string, t: number) => summary.find((s) => s.config === config && s.t === t)!;
let gate: Row | null = null;
if (configs.includes('webgl') && HEAVY.every((t) => times.includes(t))) {
  const eligible = configs.filter((c) => c !== 'webgl' && cold[c]!.prepareMs <= cold.webgl!.prepareMs * 1.2);
  const key = hdr ? 'wallBurstMs' : 'gpuBurstMs'; // (the WebGL timer cannot see the bridge's copy on the other device)
  const cost = (c: string) => HEAVY.reduce((a, t) => a + (at(c, t)[key]?.median ?? Infinity), 0);
  const chosen = eligible.sort((a, b) => cost(a) - cost(b))[0] ?? null;
  const compare = (c: string) => HEAVY.map((t) => {
    const one = (k: 'gpuBurstMs' | 'wallBurstMs' | 'rafMeanMs') => {
      const a = at('webgl', t)[k], b = at(c, t)[k];
      if (!a || !b) return null;
      const reduction = 1 - b.median / a.median, noise = Math.max(a.spread, b.spread);
      return { webgl: a.median, webgpu: b.median, reduction: +reduction.toFixed(3), noise: +noise.toFixed(3), pass: reduction >= 0.1 && reduction > noise };
    };
    return { t, gpuBurst: one('gpuBurstMs'), wallBurst: one('wallBurstMs'), rafMean: one('rafMeanMs') };
  });
  const comparisons = Object.fromEntries(configs.filter((c) => c !== 'webgl').map((c) => [c, compare(c)]));
  const pass = !!chosen && comparisons[chosen]!.every((r) => (hdr ? r.wallBurst?.pass : r.gpuBurst?.pass) && r.rafMean?.pass);
  gate = { pass, chosen, eligible, comparisons };
}
// a run counts as disturbed when the GPU was busy before it started, or other software used it while it ran
const disturbed = results.filter((r) => (r.idle && r.idle.utilization > 10) || (r.other && (r.other.mean > 3 || r.other.max > 20)))
  .map((r) => `${r.config} round ${r.round}${r.other?.top ? ` (${r.other.top} ${r.other.max}%)` : ''}`);
const output = { date: new Date().toISOString(), browser: browserVersion, hdr, config: { scale, rounds, burst, seconds, times, configs, grain, headless, chromeArgs },
  display, gpuProcesses: gpuProcesses(), disturbedRuns: [...new Set(disturbed)], cold, gate, summary, results };
if (!existsSync(out)) await mkdir(out, { recursive: true });
await Bun.write(`${out}/perf-results${hdr ? '-hdr' : ''}.json`, JSON.stringify(output, null, 2));

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`\n${browserVersion}, ${display?.screen?.join('x')} at ${(1000 / display?.refreshMs).toFixed(0)} Hz, ${hdr ? 'HDR preview' : 'SDR'}, ${1080 * scale}p, ${rounds} rounds`);
console.log('cold start (median): ' + configs.map((c) => `${c} ${cold[c]!.prepareMs} ms shaders, ${cold[c]!.readyMs} ms to ready, frozen ${cold[c]!.frozenMs} ms`).join(' | '));
for (const t of times) {
  console.log(`t=${t}: ` + configs.map((c) => { const s = at(c, t); return `${c} gpu ${s.gpuBurstMs?.median ?? '-'} wall ${s.wallBurstMs?.median} raf ${s.rafMeanMs?.median} ±${s.rafJitterMs?.median} [${s.refreshes.join('/')}]`; }).join(' | '));
}
if (gate) {
  for (const [c, rows] of Object.entries(gate.comparisons as Record<string, Row[]>)) {
    console.log(`${c} vs webgl: ` + rows.map((r) => `t=${r.t} gpu ${r.gpuBurst ? pct(r.gpuBurst.reduction) : '-'} (noise ${r.gpuBurst ? pct(r.gpuBurst.noise) : '-'}), wall ${pct(r.wallBurst.reduction)}, raf ${pct(r.rafMean.reduction)} (noise ${pct(r.rafMean.noise)})`).join('; '));
  }
  console.log(`gate: ${gate.pass ? 'PASSED' : 'not passed'} (variant: ${gate.chosen ?? 'none eligible'}; eligible by compile time: ${gate.eligible.join(', ') || 'none'})`);
}
console.log(disturbed.length ? `disturbed by other GPU load: ${[...new Set(disturbed)].join(', ')}` : 'no run was disturbed by other GPU load');
