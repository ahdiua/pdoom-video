#!/usr/bin/env bun
import { chromium, type Page } from 'playwright-core';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const i = args.indexOf('--url'), url = i < 0 ? 'http://127.0.0.1:5173' : args[i + 1]!;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function ready(page: Page) {
  await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 120000 });
  assert.equal(await page.evaluate(() => (window as any).__pdoom.error), undefined);
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/webgpu-preview.html?scale=1&t=100&grain=0&blur=0`);
  await ready(page);
  assert.equal(await page.evaluate(() => (window as any).__pdoom.backend), 'webgpu');
  assert.equal(await page.locator('#loading').isVisible(), false);
  assert.equal(await page.locator('#ui').evaluate(e => (e as HTMLElement).inert), false);
  const checkLayout = async () => {
    await page.waitForFunction(() => {
      const c = document.getElementById('c')!.getBoundingClientRect(), w = document.getElementById('wrap')!.getBoundingClientRect();
      return c.width <= w.width + .02 && c.height <= w.height + .02 && c.bottom <= w.bottom + .02 && Math.abs(c.width / c.height - 16 / 9) < .001;
    });
  };
  await checkLayout();
  await page.setViewportSize({ width: 390, height: 844 }); await checkLayout();
  await page.setViewportSize({ width: 1280, height: 720 }); await checkLayout();
  const count = await page.evaluate(() => (window as any).__pdoom.engine.frames);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => (window as any).__pdoom.engine.frames), count, 'Paused preview should not redraw');
  // Production playback must never wait for completion, time the GPU, or read pixels.
  await page.evaluate(() => {
    const e = (window as any).__pdoom.engine;
    for (const key of ['settled', 'burstGPU', 'readPixelsAsync', 'floatPixels']) e[key] = () => { throw new Error(`Unexpected player call to ${key}`); };
  });
  await page.locator('#grain').click();
  await page.waitForFunction(count => (window as any).__pdoom.engine.frames > count, count);
  assert.equal(await page.locator('#grain').getAttribute('aria-pressed'), 'true');
  await page.locator('#motion-blur').click();
  assert.equal(await page.locator('#motion-blur').getAttribute('aria-pressed'), 'true');
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.evaluate(() => (window as any).__pdoom.seek(101));
  await page.waitForFunction(() => (window as any).__pdoom.engine.lastTime === 101);
  await page.locator('#play').click();
  await page.waitForFunction(() => (window as any).__pdoom.playing);
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => (window as any).__pdoom.time > 101));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !(window as any).__pdoom.playing);
  await page.locator('#resolution').click();
  await ready(page);
  assert.equal(await page.evaluate(() => (window as any).__pdoom.width), 3840);
  await checkLayout();
  assert.ok(await page.evaluate(() => (window as any).__pdoom.time > 101));
  assert.equal(await page.locator('#grain').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#motion-blur').getAttribute('aria-pressed'), 'true');
  // Exercise every deterministic frame three times, including all short branches.
  const stable = await page.evaluate(async () => {
    const e = (window as any).__pdoom.engine, before = e.diagnostics();
    for (let repeat = 0; repeat < 3; repeat++) {
      for (let t = e.start; t < e.end; t += 1 / 60) { e.render(t); await e.settled(); }
    }
    const after = e.diagnostics();
    return { before, after };
  });
  for (const key of ['pipelines', 'textures', 'buffers'] as const) assert.equal(stable.before[key], stable.after[key], `${key} grew during repeated scene rendering`);
  assert.deepEqual(stable.after.errors, []);
  const paused = await page.evaluate(() => (window as any).__pdoom.engine.frames);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => (window as any).__pdoom.engine.frames), paused);
  await page.evaluate(() => { const P = (window as any).__pdoom; P.seek(P.end - .08); });
  await page.locator('#play').click();
  await page.waitForFunction(() => { const P = (window as any).__pdoom; return P.playing && P.time < P.start + .5; });
  await page.locator('#play').click();
  await page.waitForFunction(() => !(window as any).__pdoom.playing);
  await page.locator('#loop').click();
  assert.equal(await page.locator('#loop').getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => { const P = (window as any).__pdoom; P.seek(P.end - .08); });
  await page.locator('#play').click();
  await page.waitForFunction(() => !(window as any).__pdoom.playing);
  await page.waitForFunction(() => { const P = (window as any).__pdoom; return P.time >= P.end - .01; });
  assert.deepEqual(errors, []);
  console.log('PASS: warmup, paused rendering, effects, seek, audio playback, loop/end behavior, fullscreen, resolution retention and three complete 4K scene traversals without resource growth.');
  // Unexpected device loss must return to a functioning WebGL preview.
  const lossTime = await page.evaluate(() => (window as any).__pdoom.time);
  await page.evaluate(() => (window as any).__pdoom.engine.device.destroy());
  await page.waitForURL(u => u.pathname.endsWith('/') && u.searchParams.has('webgpu-fallback'));
  await ready(page);
  assert.ok(Math.abs(await page.evaluate(() => (window as any).__pdoom.time) - lossTime) < .01);
  assert.ok((await page.locator('#status').textContent())!.includes('Using WebGL'));
  assert.deepEqual(await page.evaluate(() => (window as any).__pdoom.engine.errors), []);
  await page.close();
  for (const failure of ['missing', 'adapter'] as const) {
    const fallback = await browser.newPage();
    await fallback.addInitScript(failure => {
      if (failure === 'missing') Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
      else navigator.gpu.requestAdapter = async () => null;
    }, failure);
    await fallback.goto(`${url}/webgpu-preview.html?scale=1&t=100`);
    await fallback.waitForURL(u => u.searchParams.has('webgpu-fallback'));
    await ready(fallback);
    assert.equal(await fallback.evaluate(() => (window as any).__pdoom.time), 100);
    assert.deepEqual(await fallback.evaluate(() => (window as any).__pdoom.engine.errors), []);
    await fallback.close();
  }
  const noTimer = await browser.newPage();
  await noTimer.goto(`${url}/webgpu-preview.html?timers=0&t=100`); await ready(noTimer);
  assert.equal(await noTimer.evaluate(() => (window as any).__pdoom.engine.gpuTimer), false);
  await noTimer.evaluate(() => (window as any).__pdoom.still(101));
  assert.deepEqual(await noTimer.evaluate(() => (window as any).__pdoom.engine.errors), []);
  await noTimer.close();
  console.log('PASS: device loss, missing WebGPU, missing adapter and no-timestamp-query fallback cases.');
} finally { await browser.close(); }
