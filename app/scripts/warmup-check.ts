#!/usr/bin/env bun
// Verify startup prewarming in a fresh Chrome context at both output resolutions.
// Requires Vite at --url (default: PDOOM_URL or http://127.0.0.1:5173).
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BASE } from './server';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1] ?? fallback;
};
const base = opt('url', BASE);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.addInitScript(() => {
      const state = { compiles: 0, links: 0, heartbeats: 0 };
      (window as any).__warmupTest = state;
      const proto = WebGL2RenderingContext.prototype;
      const compile = proto.compileShader, link = proto.linkProgram;
      proto.compileShader = function (shader) { state.compiles++; compile.call(this, shader); };
      proto.linkProgram = function (program) { state.links++; link.call(this, program); };
      setInterval(() => { if (!(window as any).__pdoom?.ready) state.heartbeats++; }, 16);
    });
    await page.goto(`${base}/?t=30&scale=${scale}`);
    assert.equal(await page.locator('#loading').isVisible(), true);
    assert.equal(await page.locator('#ui').evaluate((el) => (el as HTMLElement).inert), true);
    await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => (window as any).__pdoom.error), undefined);
    assert.equal(await page.locator('#loading').isVisible(), false);
    assert.equal(await page.evaluate(() => (window as any).__pdoom.time), 30);
    assert.equal(await page.evaluate(() => (window as any).__pdoom.playing), false);
    const stats = await page.evaluate(() => ({ ...(window as any).__pdoom.engine.warmupStats, ...(window as any).__warmupTest }));
    assert.ok(stats.frames > 0 && stats.programs > 0 && stats.heartbeats > 2);
    console.log(JSON.stringify({ scale, warmup: stats }));

    // Check more times than the warm-up visits, with both effect settings.
    // New programs here would mean a render branch was missed during preparation.
    const missed = await page.evaluate(async () => {
      const e = (window as any).__pdoom.engine;
      const counts = (window as any).__warmupTest;
      const missed: { t: number; scene: string; compiles: number; links: number }[] = [];
      for (const enabled of [false, true]) {
        e.effects.motionBlur = e.effects.grain = enabled;
        for (const entry of e.timeline) {
          const times = [entry.start + 0.001, entry.end - 0.001];
          for (let t = entry.start + 0.25; t < entry.end; t += 0.5) times.push(t);
          for (const t of times) {
            const c = counts.compiles, l = counts.links;
            e.render(t, 1 / 60, false);
            if (counts.compiles !== c || counts.links !== l) missed.push({ t, scene: entry.id, compiles: counts.compiles - c, links: counts.links - l });
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      return missed;
    });
    assert.deepEqual(missed, [], 'playback still compiles a new shader after warm-up');
    assert.deepEqual(errors, []);
    console.log(`PASS ${scale === 1 ? '1080p' : '2160p'}: no new shaders throughout both effect settings; loading UI and playhead preserved.`);
    await page.close();
  }

  // Export stays opt-in. Compare exact pixels before/after an explicit warm-up,
  // including static canvas textures whose upload flags must survive compile-only runs.
  const page = await browser.newPage();
  await page.goto(`${base}/?export=1&only=room,shoggoth,paperclips,loom,ilya`);
  await page.waitForFunction(() => (window as any).__pdoom?.ready, null, { timeout: 120000 });
  assert.equal(await page.evaluate(() => (window as any).__pdoom.engine.warmupStats), null);
  const comparison = await page.evaluate(async () => {
    const e = (window as any).__pdoom.engine, times = [27, 30, 98, 100, 130.5, 135];
    const before = times.map((t) => { e.render(t, 1 / 60, false); return e.readPixels(); });
    await e.warmup();
    return times.map((t, j) => {
      e.render(t, 1 / 60, false);
      const after = e.readPixels();
      let changed = 0;
      for (let i = 0; i < after.length; i++) if (after[i] !== before[j]![i]) changed++;
      return { t, changed };
    });
  });
  assert.ok(comparison.every((row) => row.changed === 0), JSON.stringify(comparison));
  console.log('PASS: export skips automatic warm-up; explicit warm-up preserves exact pixels.');
  await page.close();
} finally { await browser.close(); }
