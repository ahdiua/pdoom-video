#!/usr/bin/env bun
// Sequential comparison of SDR, float bridge with SDR grading, and HDR grading.
// Completion time includes browser scheduling; it is NOT a GPU-only duration.
import { chromium } from 'playwright-core';
declare global { interface Window { __pdoom: any } }
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const scale of option('scales', '1,2').split(',').map(Number)) {
    for (const mode of option('modes', 'off,bridge,test').split(',')) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto(`http://127.0.0.1:5173/?warmup=0&only=loss,paperclips,shoggoth&t=10.64&scale=${scale}${mode === 'off' ? '' : '&hdr=' + mode}`);
      await page.waitForFunction(() => window.__pdoom?.ready || window.__pdoom?.error, null, { timeout: 120000 });
      for (const t of option('times', '10.64,13,30,100,101').split(',').map(Number)) {
        const result = await page.evaluate(async ({ t, mode, count }) => {
          const e = window.__pdoom.engine, gl = e.renderer.getContext() as WebGL2RenderingContext;
          if (mode !== 'off' && !e.hdrDisplay) throw new Error(window.__pdoom.hdr.reason);
          const complete = async () => {
            if (e.hdrDisplay) { await e.hdrDisplay.settled(); return; }
            const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!; gl.flush();
            try { while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 0)); }
            finally { gl.deleteSync(fence); }
          };
          const submit: number[] = [], completion: number[] = [], bridge: number[] = [];
          for (let i = 0; i < count + 10; i++) {
            const start = performance.now(); e.render(t); const sent = performance.now(); await complete();
            if (i >= 10) { submit.push(sent - start); completion.push(performance.now() - start); bridge.push(e.hdrDisplay?.lastSubmitMs ?? 0); }
          }
          const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
          // Exercise the complete moving excerpt before timing it (e.g. the
          // loss chart enters a different terrain shader just after 10.64s).
          for (let i = 0; i < 30; i++) { e.render(t + i / 60); await complete(); }
          // A warmed, moving 0.5-second excerpt in the real animation scheduler.
          let first = 0, last = 0, frames = 0;
          const intervals: number[] = [];
          await new Promise<void>((resolve) => {
            const tick = (now: number) => {
              if (frames > 0) intervals.push(now - last); else first = now;
              last = now; e.render(t + (frames % 30) / 60); frames++;
              if (now - first < 1500) requestAnimationFrame(tick); else resolve();
            };
            requestAnimationFrame(tick);
          });
          await complete();
          intervals.sort((a, b) => a - b);
          return { t, submitMedianMs: median(submit), bridgeSubmitMedianMs: median(bridge), completionMedianMs: median(completion), rafFPS: (frames - 1) * 1000 / (last - first), rafP95Ms: intervals[Math.floor(intervals.length * 0.95)] };
        }, { t, mode, count: +option('frames', '24') });
        console.log(JSON.stringify({ scale, mode, ...result }));
      }
      await page.close();
    }
  }
} finally { await browser.close(); }
