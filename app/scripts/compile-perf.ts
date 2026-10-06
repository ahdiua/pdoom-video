#!/usr/bin/env bun
// Cold shader-preparation time per scene: what a first visit waits for. Every launch here is a fresh
// Chrome profile, so nothing comes from the browser's shader cache. "compile" is the asynchronous
// compilation of a warm-up job's programs, "first draws" the real frame after it (which is where a
// driver compiles what it deferred, e.g. the variants of a multi-target pass).
//   bun scripts/compile-perf.ts [--scale 1] [--only paperclips,ilya] [--jobs]
// --jobs lists every warm-up job over 60 ms with the programs it added: a scene can pay for another's
// shader (loom draws Ilya's room, and compiles it first).
import { chromium } from 'playwright-core';
import { BASE } from './server';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1] ?? fallback; };
const scale = opt('scale', '1'), only = opt('only', '');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${BASE}/?warmup=0&scale=${scale}${only ? `&only=${only}` : ''}`);
  await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 180000 });
  const result = await page.evaluate(async () => {
    const P = (window as any).__pdoom, e = P.engine;
    if (P.error) throw new Error(P.error);
    const steps: { scene: string; phase: string; ms: number; programs: number }[] = [];
    let last = performance.now(), current: { scene: string; phase: string } | null = null, programs = e.renderer.info.programs.length;
    // the longest gap between animation frames: how long the loading screen itself froze
    let frame = performance.now(), frozen = 0, running = true;
    const tick = (now: number) => { frozen = Math.max(frozen, now - frame); frame = now; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const started = performance.now();
    await e.warmup((p: { scene: string; phase: string }) => {
      const now = performance.now(), count = e.renderer.info.programs.length;
      if (current) steps.push({ ...current, ms: now - last, programs: count - programs });
      last = now; programs = count;
      current = p.phase === 'ready' ? null : { scene: p.scene, phase: p.phase };
    });
    running = false;
    return { total: performance.now() - started, frozen, programs: e.warmupStats.programs, steps };
  });
  const scenes = new Map<string, { compile: number; render: number }>();
  for (const s of result.steps) {
    const row = scenes.get(s.scene) ?? { compile: 0, render: 0 };
    row[s.phase as 'compile' | 'render'] += s.ms;
    scenes.set(s.scene, row);
  }
  const seconds = (ms: number) => (ms / 1000).toFixed(2).padStart(6);
  console.log(`${1080 * +scale}p: ${(result.total / 1000).toFixed(1)} s in total, ${result.programs} programs, longest step ${(Math.max(...result.steps.map((s) => s.ms)) / 1000).toFixed(1)} s, loading screen frozen for at most ${(result.frozen / 1000).toFixed(1)} s`);
  for (const [scene, row] of [...scenes].sort((a, b) => b[1].compile + b[1].render - a[1].compile - a[1].render)) {
    if (row.compile + row.render >= 100) console.log(`  ${scene.padEnd(12)} compile ${seconds(row.compile)} s   first draws ${seconds(row.render)} s`);
  }
  if (argv.includes('--jobs')) {
    for (const s of result.steps) if (s.ms > 60) console.log(`  job  ${s.scene.padEnd(12)} ${s.phase.padEnd(7)} ${seconds(s.ms)} s  +${s.programs} programs`);
  }
} finally { await browser.close(); }
