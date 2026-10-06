#!/usr/bin/env bun
// GPU timings without export readback/encoding. Requires the Vite server.
// bun scripts/preview-perf.ts --scale 2 --times 10.64,13,98,100,101
import { chromium } from 'playwright-core';
import { BASE } from './server';

declare global { interface Window { __pdoom: any } }

const args = process.argv.slice(2);
const opt = (key: string, fallback: string) => args[args.indexOf(`--${key}`) + 1] ?? fallback;
const get = (key: string, fallback: string) => args.includes(`--${key}`) ? opt(key, fallback) : fallback;
const times = get('times', '10.64,13,98,100,101').split(',').map(Number);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (err) => console.error(err));
  const url = new URL(get('url', BASE));
  url.searchParams.set('export', '1');
  url.searchParams.set('scale', get('scale', '1'));
  await page.goto(url.href);
  await page.waitForFunction(() => window.__pdoom?.ready || window.__pdoom?.error, null, { timeout: 120000 });
  const errors = await page.evaluate(() => window.__pdoom.error ?? window.__pdoom.errors);
  if (typeof errors === 'string' || errors.length) throw new Error(JSON.stringify(errors));
  await page.evaluate(({ preview, detail }) => {
    window.__pdoom.engine.preview = preview;
    window.__pdoom.engine.quality.mode = detail;
  }, { preview: args.includes('--preview'), detail: get('detail', 'full') });
  console.log(await page.evaluate(() => {
    const gl = window.__pdoom.engine.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), width: window.__pdoom.width, height: window.__pdoom.height };
  }));
  for (const t of times) {
    const capture = get('capture', '');
    const compare = get('compare', '');
    if (compare) {
      const before = Buffer.from(await Bun.file(`${compare}/${t}.png`).arrayBuffer()).toString('base64');
      const after = await page.evaluate(async (t) => { window.__pdoom.still(t); return window.__pdoom.png(); }, t);
      console.log(await page.evaluate(async ({ before, after, t }) => {
        const pixels = async (png: string) => {
          const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const c = canvas.getContext('2d', { willReadFrequently: true })!;
          c.drawImage(image, 0, 0); return c.getImageData(0, 0, image.width, image.height).data;
        };
        const a = await pixels(before), b = await pixels(after);
        if (a.length !== b.length) throw new Error('Image dimensions differ');
        let total = 0, max = 0, changed = 0;
        for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i]! - b[i]!); total += d; max = Math.max(max, d); if (d > 2) changed++; }
        return { t, meanAbsoluteError: total / a.length, maxError: max, fractionOver2: changed / a.length };
      }, { before, after, t }));
      continue;
    }
    if (capture) {
      const png = await page.evaluate(async (t) => { window.__pdoom.still(t); return window.__pdoom.png(); }, t);
      await Bun.write(`${capture}/${t}.png`, Buffer.from(png, 'base64'));
      console.log(`captured ${t}`);
      continue;
    }
    const result = await page.evaluate(async ({ t, count, preview, warmFrames }) => {
      const engine = window.__pdoom.engine;
      engine.preview = preview;
      const gl = engine.renderer.getContext() as WebGL2RenderingContext;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) throw new Error('EXT_disjoint_timer_query_webgl2 unavailable; cannot measure GPU time reliably.');
      const ms: number[] = [];
      for (let i = 0; i < count + warmFrames; i++) {
        const q = gl.createQuery()!;
        try {
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          engine.render(t);
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          gl.flush();
          const deadline = performance.now() + 30000;
          while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
            if (performance.now() > deadline) throw new Error('GPU timer query timed out');
            await new Promise((resolve) => setTimeout(resolve, 4));
          }
          if (i >= warmFrames && !gl.getParameter(ext.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        } finally { gl.deleteQuery(q); }
      }
      if (!ms.length) throw new Error('GPU timings were disjoint; retry the measurement');
      ms.sort((a, b) => a - b);
      return { t, gpuMeanMs: ms.reduce((a, b) => a + b) / ms.length, gpuMedianMs: ms[Math.floor(ms.length / 2)], samples: ms.length };
    }, { t, count: Number(get('frames', '20')), preview: args.includes('--preview'), warmFrames: Number(get('warmup-frames', '12')) });
    console.log(JSON.stringify(result));
  }
} finally { await browser.close(); }
