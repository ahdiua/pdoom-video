#!/usr/bin/env bun
// A frame is a function of song time only: the same t must give the same pixels whatever was rendered
// before it. Export sub-frames arrive out of order, so a scene that caches by "last frame" shows up here.
// Each timeline entry is sampled at three times, each reached from far before, from the previous frame
// and from later in the song.
//   bun scripts/determinism-check.ts [--only id1,id2] [--times 75.46,60]
//
// Rasteriser noise is reported but tolerated: a few dozen channels, one or two levels, along thin
// antialiased Canvas2D strokes (seen in `bureau`'s annex). The scene's inputs are the same there; which
// frames are affected changes with Chrome's Canvas2D backend (--disable-accelerated-2d-canvas moves them),
// so it comes from the browser's raster caches, not from scene state. Scene state shows up far larger.
const NOISE = { channels: 500, max: 2 };
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BASE } from './server';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const only = opt('only'), times = opt('times')?.split(',').map(Number);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?export=1${only ? `&only=${only}` : ''}`);
  await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 180000 });
  const result = await page.evaluate((times) => {
    const P = (window as any).__pdoom, e = P.engine;
    if (P.error) throw new Error(P.error);
    const entries = P.timeline as { id: string; start: number; end: number }[];
    const at = (t: number) => entries.filter((s) => t >= s.start && t < s.end).map((s) => s.id).join('+');
    const samples = times ?? entries.flatMap((s) => [0.25, 0.5, 0.75].map((f) => s.start + (s.end - s.start) * f));
    const last = P.duration - 0.01;
    const failures: unknown[] = [];
    for (const t of samples) {
      const shot = (before: number) => { P.still(Math.min(last, Math.max(0, before))); P.still(t); return e.readPixels().slice() as Uint8Array; };
      const reference = shot(t - 20);
      for (const [route, before] of [['previous frame', t - 1 / 60], ['5 s later', t + 5], ['the end', last]] as const) {
        const other = shot(before);
        let channels = 0, max = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        for (let i = 0; i < other.length; i++) {
          const d = Math.abs(other[i]! - reference[i]!);
          if (!d) continue;
          channels++; if (d > max) max = d;
          const p = i >> 2, x = p % P.width, y = P.height - 1 - Math.floor(p / P.width);
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        if (channels) failures.push({ t: +t.toFixed(3), entry: at(t), reachedFrom: route, channels, max, box: [x0, y0, x1, y1] });
      }
    }
    return { samples: samples.length, failures, sceneErrors: e.errors };
  }, times);
  assert.deepEqual(result.sceneErrors, []); assert.deepEqual(errors, []);
  const differing = result.failures as { channels: number; max: number }[];
  const noise = differing.filter((f) => f.channels <= NOISE.channels && f.max <= NOISE.max), real = differing.filter((f) => !noise.includes(f));
  for (const f of noise) console.log(`NOTE rasteriser noise: ${JSON.stringify(f)}`);
  assert.deepEqual(real, [], `frames depend on what was rendered before them:\n${real.map((f) => JSON.stringify(f)).join('\n')}`);
  console.log(`PASS: ${result.samples} times give the same pixels reached from far before, the previous frame, 5 s later and the end${noise.length ? ` (${noise.length} within rasteriser noise)` : ''}.`);
} finally { await browser.close(); }
