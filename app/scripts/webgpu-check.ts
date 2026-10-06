#!/usr/bin/env bun
// Capture the pre-refactor WebGL reference, then compare both preview backends.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const root = option('out', '../out/webgpu-eval');
const url = option('url', 'http://127.0.0.1:5173');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const comparisons: { backend: string; scale: number; t: number; preview: boolean; mean: number; over8: number; pass: boolean }[] = [];
async function ensureDir(path: string) { if (!existsSync(path)) await mkdir(path, { recursive: true }); }
async function compare(page: import('playwright-core').Page, before: string, after: string) {
  return page.evaluate(async ({ before, after }) => {
    const pixels = async (png: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const a = await pixels(before), b = await pixels(after);
    if (a.length !== b.length) throw new Error('Image dimensions differ');
    let total = 0, over = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i]! - b[i]!); total += d; if (d > 8) over++; }
    return { mean: total / a.length, over8: over / a.length };
  }, { before, after });
}
try {
  for (const scale of option('scales', '1,2').split(',').map(Number)) {
    const page = await browser.newPage();
    await page.goto(`${url}/?export=1&only=paperclips&scale=${scale}`);
    await page.waitForFunction(() => (window as any).__pdoom?.ready, null, { timeout: 120000 });
    const times = await page.evaluate(() => {
      const e = (window as any).__pdoom.engine, s = e.loaded.get('paperclips').scene, T = s.T ?? s.model.T;
      return [...new Set([T.start + .01, T.db1 - .02, T.db1 + .08, ...T.splits.map((t: number) => t + .15), T.fill + .1,
        98, T.tilt0 - .01, T.tilt0 + .05, T.tilt1 + .05, 100, 101, ...T.slams.map((t: number) => t + .1), T.end - .08])].sort((a, b) => a - b);
    });
    const folder = `${root}/baseline-${scale}`;
    await ensureDir(folder);
    if (args.includes('--baseline')) {
      await Bun.write(`${folder}/times.json`, JSON.stringify(times));
      for (const t of times) {
        for (const preview of [true, false]) {
          const png = await page.evaluate(async ({ t, preview }) => {
            const P = (window as any).__pdoom;
            P.engine.preview = preview; P.engine.quality.mode = 'full'; P.engine.effects.grain = false;
            P.still(t); return P.png();
          }, { t, preview });
          await Bun.write(`${folder}/${preview ? 'preview' : 'export'}-${t}.png`, Buffer.from(png, 'base64'));
        }
      }
      console.log(`Captured ${times.length} preview/export reference pairs at scale ${scale}`);
    } else {
      // A fresh checkout can compare the two current backends without archived
      // images. When a pre-refactor baseline exists, also check export parity.
      for (const t of times) {
        for (const preview of [true, false]) {
          const png: string = await page.evaluate(async ({ t, preview }) => {
            const P = (window as any).__pdoom; P.engine.preview = preview; P.engine.quality.mode = 'full'; P.engine.effects.grain = false;
            P.still(t); return P.png();
          }, { t, preview });
          const reference = Bun.file(`${folder}/${preview ? 'preview' : 'export'}-${t}.png`);
          if (await reference.exists()) {
            const metrics = await compare(page, Buffer.from(await reference.arrayBuffer()).toString('base64'), png);
            comparisons.push({ backend: 'webgl-refactor', scale, t, preview, ...metrics, pass: metrics.mean <= .01 && metrics.over8 === 0 });
          }
          if (preview) {
            await ensureDir(`${root}/webgl-${scale}`);
            await Bun.write(`${root}/webgl-${scale}/${t}.png`, Buffer.from(png, 'base64'));
          }
        }
      }
      await page.close();
      const gpu = await browser.newPage();
      // Fail if the experimental renderer creates a WebGL context or calls
      // readback during normal preview. This catches accidental bridge paths.
      await gpu.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: any[]) {
          if (type.includes('webgl')) throw new Error('WebGPU preview must not create WebGL contexts');
          return (original as any).call(this, type, ...rest);
        } as any;
      });
      await gpu.goto(`${url}/webgpu-preview.html?scale=${scale}&t=100&export=1&grain=0`);
      await gpu.waitForFunction(() => (window as any).__pdoom?.ready, null, { timeout: 120000 });
      assert.equal(await gpu.evaluate(() => (window as any).__pdoom.backend), 'webgpu');
      await ensureDir(`${root}/webgpu-${scale}`);
      for (const t of times) {
        const png: string = await gpu.evaluate(async t => { const P = (window as any).__pdoom; P.still(t); return P.png(); }, t);
        await Bun.write(`${root}/webgpu-${scale}/${t}.png`, Buffer.from(png, 'base64'));
        const before = Buffer.from(await Bun.file(`${root}/webgl-${scale}/${t}.png`).arrayBuffer()).toString('base64');
        const metrics = await compare(gpu, before, png);
        const result = { backend: 'webgpu', scale, t, preview: true, ...metrics, pass: metrics.mean <= 1 && metrics.over8 <= .01 };
        comparisons.push(result); console.log(JSON.stringify(result));
      }
      assert.deepEqual(await gpu.evaluate(() => (window as any).__pdoom.engine.errors), []);
      await gpu.close();
      continue;
    }
    await page.close();
  }
  if (!args.includes('--baseline')) {
    await Bun.write(`${root}/image-results.json`, JSON.stringify(comparisons, null, 2));
    const failed = comparisons.filter(r => !r.pass);
    console.log(`Image checks: ${comparisons.length - failed.length}/${comparisons.length} passed`);
    assert.equal(failed.length, 0, `${failed.length} frames failed visual thresholds; see ${root}/image-results.json`);
  }
} finally { await browser.close(); }
