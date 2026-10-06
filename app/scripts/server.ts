// The preview server the scripts drive. Check scripts load BASE; `check.ts` and `render.ts` start a
// private server (no live reload: a file saved mid-run must not reload the page) when they need one.
import path from 'node:path';

const APP = path.resolve(import.meta.dir, '..');

/** Where the check scripts find the app: PDOOM_URL, or a server started by hand on the default port. */
export const BASE = (process.env.PDOOM_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');

export async function reachable(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

export async function startServer(): Promise<{ url: string; stop: () => void }> {
  const port = 5300 + Math.floor(Math.random() * 500);
  const proc = Bun.spawn(['bunx', '--bun', 'vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: APP, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, PDOOM_NO_HMR: '1' } });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !(await reachable(url)); i++) await Bun.sleep(100);
  if (!(await reachable(url))) { proc.kill(); throw new Error(`Vite did not start at ${url}`); }
  return { url, stop: () => proc.kill() };
}
