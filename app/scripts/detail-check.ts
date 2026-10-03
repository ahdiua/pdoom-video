#!/usr/bin/env bun
// Vite must be running. Simulated query latency verifies adaptation, not phone FPS.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const only = 'shoggoth,paperclips,ilya';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    const state = { compiles: 0, factor: 20 };
    (window as any).__detailTest = state;
    const proto = WebGL2RenderingContext.prototype;
    const compile = proto.compileShader, query = proto.getQueryParameter;
    proto.compileShader = function (shader) { state.compiles++; compile.call(this, shader); };
    proto.getQueryParameter = function (q, pname) {
      const result = query.call(this, q, pname);
      return pname === this.QUERY_RESULT ? result * state.factor : result;
    };
  });
  await page.goto(`${base}/?only=${only}&t=133`);
  await page.waitForFunction(() => (window as any).__pdoom?.ready, null, { timeout: 180000 });
  const adaptive = await page.evaluate(() => (window as any).__pdoom.engine.quality.stats);
  assert.equal(adaptive.gpuTimer, true, 'This test requires GPU timer queries');
  assert.ok(adaptive.passes['shoggoth:body'].scale < 1, JSON.stringify(adaptive));
  assert.ok(adaptive.passes['ilya:room'].scale < 1, JSON.stringify(adaptive));
  console.log('PASS warm-up adapts before playback under simulated slow GPU timings:', JSON.stringify(adaptive));

  const regression = await page.evaluate(async () => {
    const w = window as any, e = w.__pdoom.engine;
    w.__detailTest.factor = 1;
    const compiles = w.__detailTest.compiles;
    const changed: number[] = [];
    // Native -> reduced -> native must be reversible with no new shader compile.
    for (const t of [30, 34, 98, 100, 101, 133, 135, 138, 139]) {
      e.quality.mode = 'full'; e.render(t);
      const before = e.readPixels();
      e.quality.mode = 'performance'; e.render(t);
      const reduced = e.readPixels();
      let diff = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== reduced[i]) diff++;
      changed.push(diff);
      e.quality.mode = 'full'; e.render(t);
      const after = e.readPixels();
      for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) throw new Error(`Full detail did not restore at ${t}`);
    }
    // Preview settings must not affect offline renders.
    e.preview = false; e.quality.mode = 'full'; e.render(133);
    const before = e.readPixels();
    e.quality.mode = 'performance'; e.render(133);
    const after = e.readPixels();
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) throw new Error('Detail changed export pixels');
    e.preview = true; e.quality.mode = 'auto'; w.__pdoom.seek(133);
    return { changed, newShaders: w.__detailTest.compiles - compiles, errors: e.errors, glError: e.renderer.getContext().getError() };
  });
  assert.ok(regression.changed.every((n: number) => n > 0));
  assert.equal(regression.newShaders, 0);
  assert.equal(regression.glError, 0);
  assert.deepEqual(regression.errors, []);
  console.log('PASS detail switching restores exact native pixels, no new shaders, export unchanged.');

  await page.keyboard.press('q');
  assert.equal(await page.locator('#detail').innerText(), '3D detail: Full');
  await page.locator('#detail').click();
  assert.equal(await page.locator('#detail').innerText(), '3D detail: Performance');
  await page.reload();
  await page.waitForFunction(() => (window as any).__pdoom?.ready, null, { timeout: 180000 });
  assert.equal(await page.locator('#detail').innerText(), '3D detail: Performance');
  await page.screenshot({ path: '../out/detail-ilya-performance.png' });
  await page.evaluate(() => (window as any).__pdoom.seek(100));
  await page.waitForTimeout(150);
  await page.screenshot({ path: '../out/detail-paperclips-performance.png' });
  await page.evaluate(() => (window as any).__pdoom.seek(34));
  await page.waitForTimeout(150);
  await page.screenshot({ path: '../out/detail-shoggoth-performance.png' });
  await page.locator('#resolution').click();
  await page.waitForFunction(() => (window as any).__pdoom?.ready && (window as any).__pdoom.engine.canvas.width === 3840, null, { timeout: 180000 });
  assert.equal(await page.locator('#detail').innerText(), '3D detail: Performance');
  const sizes = await page.evaluate(() => {
    const e = (window as any).__pdoom.engine;
    const result: number[][] = [];
    for (const [id, t] of [['paperclips', 100], ['ilya', 133]] as const) {
      e.render(t);
      const scene = e.loaded.get(id).scene;
      const rt = id === 'paperclips' ? scene.march.detailTarget : scene.room.pass.detailTarget;
      result.push([rt.width, rt.height]);
    }
    return result;
  });
  assert.deepEqual(sizes, [[1280, 720], [1280, 720]], 'Performance detail must stay 720p with a 4K output');
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.close();

  const hdr = await browser.newPage();
  await hdr.goto(`${base}/?export=1&output=hdr10&only=ilya`);
  await hdr.waitForFunction(() => (window as any).__pdoom?.ready, null, { timeout: 120000 });
  const hdrSame = await hdr.evaluate(async () => {
    const e = (window as any).__pdoom.engine;
    e.quality.mode = 'full'; e.render(133);
    const a = await e.readExportPixelsAsync();
    e.quality.mode = 'performance'; e.render(133);
    const b = await e.readExportPixelsAsync();
    return !e.quality.enabled && a.length === b.length && a.every((v: number, i: number) => v === b[i]);
  });
  assert.equal(hdrSame, true, 'HDR export pixels must ignore preview detail');
  await hdr.close();
  console.log('PASS 4K retains 720p 3D detail; HDR export is byte-identical across detail modes.');

  // No timer extension: touch defaults and sustained slow playback still adapt.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.addInitScript(() => {
    const get = WebGL2RenderingContext.prototype.getExtension as (this: WebGL2RenderingContext, name: string) => any;
    WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, name: string) {
      return name === 'EXT_disjoint_timer_query_webgl2' ? null : get.call(this, name);
    } as typeof WebGL2RenderingContext.prototype.getExtension;
  });
  await mobile.goto(`${base}/?only=${only}&warmup=0&t=100`);
  await mobile.waitForFunction(() => (window as any).__pdoom?.ready, null, { timeout: 120000 });
  const fallback = await mobile.evaluate(() => {
    const e = (window as any).__pdoom.engine, q = e.quality;
    e.render(100);
    const before = q.stats.passes['paperclips:lattice'].scale;
    for (let i = 0; i < 24; i++) q.observeFrame('paperclips', 45);
    e.render(100);
    return { before, after: q.stats.passes['paperclips:lattice'].scale, gpuTimer: q.stats.gpuTimer, glError: e.renderer.getContext().getError() };
  });
  assert.equal(fallback.gpuTimer, false);
  assert.ok(fallback.before < 1 && fallback.after < fallback.before);
  assert.equal(fallback.glError, 0);
  await mobile.locator('#detail').click();
  assert.equal(await mobile.locator('#detail').innerText(), '3D detail: Full');
  await mobile.close();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS touch/no-timer fallback, Q/button controls and session persistence.');
} finally { await browser.close(); }
