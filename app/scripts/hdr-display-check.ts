#!/usr/bin/env bun
// The one HDR check that uses the real display: a visible Chrome window without Playwright's default
// --force-color-profile=srgb, which hides an HDR display from the page (the other checks force the
// pipeline with ?hdr=test and only see buffers). Skips when this machine's display is not HDR.
// Opens a window, so `bun run check` runs it only when asked: bun run check --only hdr-display
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BASE } from './server';

const browser = await chromium.launch({ channel: 'chrome', headless: false, ignoreDefaultArgs: ['--force-color-profile=srgb'] });
try {
  const page = await browser.newPage({ viewport: null });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?hdr=1&warmup=0&only=loss&t=13`);
  await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 120000 });
  // the display's dynamic range can be reported a moment after load
  const display = await page.waitForFunction(() => matchMedia('(dynamic-range: high)').matches, null, { timeout: 5000 }).then(() => true, () => false);
  const state = await page.evaluate(() => {
    const P = (window as any).__pdoom, e = P.engine;
    return { hdr: P.hdr, grade: e.hdrGrade, frames: e.hdrDisplay?.frames ?? 0, sceneErrors: e.errors,
      config: e.hdrDisplay?.canvas.getContext('webgpu').getConfiguration() as { colorSpace: string; format: string; toneMapping: { mode: string } } | undefined,
      button: document.getElementById('hdr')!.textContent, tune: !document.getElementById('hdr-tune')!.hidden,
      gamut: ['rec2020', 'p3', 'srgb'].find((g) => matchMedia(`(color-gamut: ${g})`).matches) };
  });
  if (!display) {
    assert.equal(state.hdr.active, false);
    console.log(`SKIP: this display is not reported as HDR (${state.hdr.reason || 'dynamic-range: standard'}); the preview stayed in SDR.`);
  } else {
    assert.equal(state.hdr.active, true, state.hdr.reason);
    assert.equal(state.hdr.diagnostic, false);
    assert.deepEqual([state.config?.colorSpace, state.config?.format, state.config?.toneMapping.mode], ['display-p3', 'rgba16float', 'extended']);
    assert.ok(state.frames > 0);
    assert.equal(state.button, 'HDR: On'); assert.equal(state.tune, true);
    assert.deepEqual(state.sceneErrors, []); assert.deepEqual(errors, []);
    console.log(`PASS: HDR preview active on the real display (${state.gamut} gamut, ${state.frames} frames presented, headroom ${state.grade.headroom.toFixed(2)}x). What it looks like is still for eyes to judge.`);
  }
} finally { await browser.close(); }
