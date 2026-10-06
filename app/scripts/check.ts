#!/usr/bin/env bun
// Everything that should pass before a push, in one run: both typechecks, then the browser checks against
// a private preview server (no live reload), one after another because they share the GPU.
//   bun run check                      all of it
//   bun run check --only hdr,detail    just these (names as below, without -check)
//   bun run check --skip preview       all but these
//   bun run check --list
// Needs Google Chrome and a GPU; the HDR checks need WebGPU. Benchmarks (*-perf.ts) are not checks, and the
// frozen WebGPU experiment's checks (webgpu-*.ts, see docs/WEBGPU.md) are run by hand when that code is touched.
import path from 'node:path';
import { startServer } from './server';

const APP = path.resolve(import.meta.dir, '..');
const argv = process.argv.slice(2);
const list = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : (argv[i + 1] ?? '').split(',').filter(Boolean); };

const steps: { name: string; command: string[]; browser: boolean; onRequest?: boolean }[] = [
  { name: 'types', command: ['bunx', '--no-install', 'tsc', '--noEmit', '-p', '.'], browser: false },
  { name: 'script-types', command: ['bunx', '--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.scripts.json'], browser: false },
  ...['preview', 'warmup', 'detail', 'mobile', 'hdr', 'hdr-export', 'determinism'].map((name) => ({ name, command: ['bun', `scripts/${name}-check.ts`], browser: true })),
  // opens a visible window and depends on this machine's display: only with --only hdr-display
  { name: 'hdr-display', command: ['bun', 'scripts/hdr-display-check.ts'], browser: true, onRequest: true },
];
if (argv.includes('--list')) { console.log(steps.map((s) => s.name + (s.onRequest ? '  (only with --only)' : '')).join('\n')); process.exit(0); }
const only = list('only'), skip = list('skip') ?? [];
const unknown = [...(only ?? []), ...skip].filter((name) => !steps.some((s) => s.name === name));
if (unknown.length) throw new Error(`Unknown check: ${unknown.join(', ')} (see --list).`);
const selected = steps.filter((s) => (only ? only.includes(s.name) : !s.onRequest) && !skip.includes(s.name));

const server = selected.some((s) => s.browser) ? await startServer() : null;
const results: { name: string; ok: boolean; seconds: number }[] = [];
try {
  for (const step of selected) {
    console.log(`\n=== ${step.name}`);
    const t0 = performance.now();
    const proc = Bun.spawn(step.command, { cwd: APP, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...(server ? { PDOOM_URL: server.url } : {}) } });
    results.push({ name: step.name, ok: (await proc.exited) === 0, seconds: (performance.now() - t0) / 1000 });
  }
} finally { server?.stop(); }

console.log('\n=== summary');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(14)} ${r.seconds.toFixed(1)}s`);
const failed = results.filter((r) => !r.ok);
if (failed.length) { console.error(`\n${failed.length} failed: ${failed.map((r) => r.name).join(', ')}`); process.exit(1); }
