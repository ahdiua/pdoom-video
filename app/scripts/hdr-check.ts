#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

declare global { interface Window { __pdoom: any } }
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const ready = async () => {
    await page.waitForFunction(() => window.__pdoom?.ready || window.__pdoom?.error, null, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.__pdoom.error), undefined);
    assert.deepEqual(await page.evaluate(() => window.__pdoom.engine.errors), []);
  };
  // Run the real shader warm-up too: compile-only passes must not present frames.
  await page.goto('http://127.0.0.1:5173/?hdr=test&only=loss,paperclips,shoggoth&t=10.64');
  await ready();
  assert.equal(await page.evaluate(() => window.__pdoom.hdr.active), true);
  // The graded picture is Display-P3 with the export's default headroom.
  assert.deepEqual(await page.evaluate(() => window.__pdoom.engine.hdrGrade), { headroom: 1000 / 203, gamut: 1, hue: 0.6, glow: 0.3 });
  assert.equal(await page.evaluate(() => window.__pdoom.engine.hdrDisplay.canvas.getContext('webgpu').getConfiguration().colorSpace), 'display-p3');
  assert.equal(await page.locator('#c').isVisible(), false);
  assert.equal(await page.locator('#hdr-c').isVisible(), true);
  const fixture = await page.evaluate(async () => {
    const e = window.__pdoom.engine, d = e.hdrDisplay, gl = e.renderer.getContext() as WebGL2RenderingContext;
    e.renderer.setRenderTarget(null);
    // Distinct top-left and bottom-left patches check both HDR range and Y origin.
    gl.clearColor(0.25, 0.5, 0.75, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, gl.drawingBufferHeight - 8, 8, 8); gl.clearColor(4, 2, 0.5, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.scissor(0, 0, 8, 8); gl.clearColor(0.125, 3, 0.25, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    d.present();
    // Enqueue output reads before yielding; swapchain textures expire on presentation.
    const reads = [d.readPixel(2, 2), d.readPixel(2, 2, 'output'), d.readPixel(2, gl.drawingBufferHeight - 2, 'output')];
    const pixels = await Promise.all(reads);
    e.renderer.resetState(); e.render(10.64);
    return pixels;
  });
  assert.deepEqual(fixture, [[4, 2, 0.5, 1], [4, 2, 0.5, 1], [0.125, 3, 0.25, 1]]);
  console.log('PASS: >1.0 values survive WebGL canvas, interop copy and final WebGPU output; vertical orientation is correct.');

  const scenePeaks = () => page.evaluate(() => {
    const e = window.__pdoom.engine, gl = e.renderer.getContext() as WebGL2RenderingContext;
    const pixels = new Float32Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    return [10.64, 13, 30, 100, 101].map((t) => {
      e.render(t); gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.FLOAT, pixels);
      let max = 0, overWhite = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const p = Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
        if (!Number.isFinite(p)) throw new Error(`Non-finite HDR output at ${t}`);
        max = Math.max(max, p); if (p > 1) overWhite++;
      }
      return { t, maxEncodedSRGB: max, overWhite };
    });
  });
  const encoded = (headroom: number) => 1.055 * headroom ** (1 / 2.4) - 0.055 + 2e-3; // sRGB encoding, half-float slack
  const peaks = await scenePeaks();
  assert.ok(peaks.some((row) => row.overWhite > 0));
  assert.ok(peaks.every((row) => row.maxEncodedSRGB <= encoded(1000 / 203)));
  console.log(JSON.stringify({ scenePeaks: peaks }));
  // The sliders regrade live, without a reload, and are kept in the URL.
  assert.equal(await page.locator('#hdr-tune').isVisible(), true);
  await page.locator('#hdr-headroom').fill('1.65');
  await page.locator('#hdr-gamut').fill('0.5'); await page.locator('#hdr-hue').fill('1'); await page.locator('#hdr-glow').fill('0');
  assert.deepEqual(await page.evaluate(() => window.__pdoom.engine.hdrGrade), { headroom: 1.65, gamut: 0.5, hue: 1, glow: 0 });
  assert.equal(new URL(page.url()).search.includes('hdr-headroom=1.65&hdr-gamut=0.5&hdr-hue=1&hdr-glow=0'), true);
  const lowered = await scenePeaks();
  assert.ok(lowered.some((row) => row.overWhite > 0) && lowered.every((row) => row.maxEncodedSRGB <= encoded(1.65)), JSON.stringify(lowered));
  console.log(`PASS: live headroom control: ${JSON.stringify({ scenePeaks: lowered })}`);
  await page.evaluate(() => window.__pdoom.seek(10.64));
  await page.locator('#hide-ui').click();
  await page.locator('#hdr-c').click();
  assert.equal(await page.locator('#ui').isVisible(), true);
  assert.equal(await page.evaluate(() => window.__pdoom.playing), false);
  // An unplanned GPU loss must restore a functioning SDR canvas.
  await page.evaluate(() => window.__pdoom.engine.hdrDisplay.device.destroy());
  await page.waitForFunction(() => !window.__pdoom.hdr.active && !window.__pdoom.engine.hdrDisplay);
  assert.equal(await page.locator('#c').isVisible(), true);
  await page.waitForFunction(() => window.__pdoom.engine.lastPost.grain === 0);
  console.log('PASS: visible canvas controls and device-loss SDR fallback.');
  assert.deepEqual(errors, []);
  await page.close();

  const bridge = await browser.newPage();
  await bridge.goto('http://127.0.0.1:5173/?hdr=bridge&warmup=0&only=loss&t=10.64');
  await bridge.waitForFunction(() => window.__pdoom?.ready);
  // The bridge shows the SDR grade: an sRGB canvas, and nothing to tune.
  assert.equal(await bridge.evaluate(() => window.__pdoom.engine.hdrDisplay.canvas.getContext('webgpu').getConfiguration().colorSpace), 'srgb');
  assert.equal(await bridge.locator('#hdr-tune').isVisible(), false);
  const compare = await bridge.evaluate(() => {
    const e = window.__pdoom.engine, gl = e.renderer.getContext() as WebGL2RenderingContext;
    e.render(10.64);
    const fp = new Float32Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.FLOAT, fp);
    e.setHdrDisplay(null); e.render(10.64);
    const sdr = e.readPixels(); let max = 0, total = 0;
    for (let i = 0; i < fp.length; i++) { const delta = Math.abs(Math.round(fp[i]! * 255) - sdr[i]); max = Math.max(max, delta); total += delta; }
    return { max, mean: total / fp.length };
  });
  assert.ok(compare.max <= 1, JSON.stringify(compare));
  console.log(`PASS: bridge SDR grading matches RGBA8 within one code value: ${JSON.stringify(compare)}`);
  await bridge.close();

  const failure = await browser.newPage();
  await failure.goto('http://127.0.0.1:5173/?hdr=test&warmup=0&only=loss&t=10.64');
  await failure.waitForFunction(() => window.__pdoom?.ready);
  await failure.evaluate(() => {
    window.__pdoom.engine.hdrDisplay.device.queue.copyExternalImageToTexture = () => { throw new Error('Simulated presentation failure'); };
    window.__pdoom.seek(10.65);
  });
  await failure.waitForFunction(() => !window.__pdoom.hdr.active);
  await failure.waitForFunction(() => {
    const px = window.__pdoom.engine.readPixels();
    for (let i = 0; i < px.length; i += 4) if (px[i] > 64) return true;
    return false;
  });
  assert.equal(await failure.locator('#c').isVisible(), true);
  console.log('PASS: synchronous presentation failure repaints SDR while paused.');
  await failure.close();

  for (const missing of ['display', 'webgpu'] as const) {
    const p = await browser.newPage();
    await p.addInitScript((missing) => {
      if (missing === 'webgpu') Object.defineProperty(navigator, 'gpu', { value: undefined });
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = original(query);
        if (query === '(dynamic-range: high)') Object.defineProperty(result, 'matches', { value: missing !== 'display' });
        return result;
      };
    }, missing);
    await p.goto('http://127.0.0.1:5173/?hdr=1&warmup=0&only=loss&t=10.64');
    await p.waitForFunction(() => window.__pdoom?.ready);
    assert.equal(await p.evaluate(() => window.__pdoom.hdr.active), false);
    assert.equal(await p.locator('#c').isVisible(), true);
    assert.ok(await p.evaluate(() => window.__pdoom.hdr.reason.length > 0));
    await p.close();
    console.log(`PASS: missing ${missing} stays in SDR.`);
  }
  const p = await browser.newPage();
  await p.goto('http://127.0.0.1:5173/?export=1&hdr=test&only=loss');
  await p.waitForFunction(() => window.__pdoom?.ready);
  assert.equal(await p.evaluate(() => window.__pdoom.engine.hdrDisplay), null);
  const length = await p.evaluate(() => { window.__pdoom.still(10.64); return window.__pdoom.engine.readPixels().length; });
  assert.equal(length, 1920 * 1080 * 4);
  console.log('PASS: export retains the SDR RGBA8 path.');
  await p.close();

  // Compare actual browser-composited screenshots, not just GPU buffer values,
  // to catch accidental gamma/color-space changes in the display bridge.
  const shots: string[] = [];
  for (const mode of ['', '&hdr=bridge']) {
    const view = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await view.goto(`http://127.0.0.1:5173/?warmup=0&only=loss&t=10.64${mode}`);
    await view.waitForFunction(() => window.__pdoom?.ready);
    await view.keyboard.press('h');
    await view.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    shots.push((await view.screenshot()).toString('base64'));
    await view.close();
  }
  const comparePage = await browser.newPage();
  const visual = await comparePage.evaluate(async (shots) => {
    const arrays = await Promise.all(shots.map(async (shot) => {
      const image = new Image(); image.src = `data:image/png;base64,${shot}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true })!; context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    }));
    let sum = 0, max = 0;
    for (let i = 0; i < arrays[0]!.length; i++) { const d = Math.abs(arrays[0]![i]! - arrays[1]![i]!); sum += d; max = Math.max(max, d); }
    return { mean: sum / arrays[0]!.length, max };
  }, shots);
  assert.ok(visual.mean < 0.5, JSON.stringify(visual));
  console.log(`PASS: browser-composited SDR/bridge image comparison: ${JSON.stringify(visual)}`);
  await comparePage.close();
} finally { await browser.close(); }
