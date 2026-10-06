#!/usr/bin/env bun
// Offline renderer. Drives the app in headless Chrome (?export=1) and either
//   stills:  bun scripts/render.ts stills --t 1.5,23,40.2 [--only id1,id2] [--out dir]
//   sheet:   bun scripts/render.ts sheet --from 20 --to 35 [--n 12] [--cols 4] [--only ids] [--out file.png]   (or --times a,b,c | --cuts)
//   plates:  bun scripts/render.ts plates   (renders one representative JPEG per plate into public/plates/ (used by the outro's rewind), times from plates.json or entry midpoints)
//   perf:    bun scripts/render.ts perf --from 20 --to 25 [--only ids] [--samples 1] [--shutter 0.5]   (avg ms per frame incl. GPU sync and the export's pixel readback)
//   video:   bun scripts/render.ts video [--from 0] [--to 156.65] [--fps 60] [--crf 16] [--x264 aq-mode=3] [--samples 1] [--shutter 0.5] [--out ../out/pdoom.mp4] [--noaudio]
//            --samples N averages N sub-frames per frame over shutter×(1/fps): motion blur + temporal AA;
//            --samples auto picks the count per frame (4, 12, 36, 108 or 324, see Engine.render)
//   HDR video: --hdr [--hdr-white 203] [--hdr-peak 1000] [--hdr-gamut 1] [--hdr-hue 0.6] [--hdr-glow 0.3] [--hdr-light auto|nominal|CLL,FALL] [--codec hevc_nvenc|av1_nvenc|libx265]
//   Encoding: --preset NAME --crf N / --cq N; extra FFmpeg output argv after --,
//             or --ffmpeg-args-file JSON. --ffmpeg PATH selects the executable.
//   --scale N (all modes): render at N× the 1920x1080 layout (--scale 2 = true 3840x2160); stills are then saved
//            full-res from the pixel buffer, videos are encoded at the physical size.
// Uses the Vite dev server at --url (default http://localhost:5173); starts a private one if unreachable.
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { videoEncodingArgs } from './encoding';
import { HDR_LOOK, HDR_LOOK_KEYS, HDR_PEAK_NITS, HDR_WHITE_NITS } from '../src/engine/hdr-color';

const rawArgs = process.argv.slice(2);
const separator = rawArgs.indexOf('--');
const argv = separator < 0 ? rawArgs : rawArgs.slice(0, separator);
const extraOutputArgs = separator < 0 ? [] : rawArgs.slice(separator + 1);
const mode = argv[0] ?? 'stills';
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(`--${k}`);
const HDR = flag('hdr');
const HDR_WHITE = Number(opt('hdr-white', String(HDR_WHITE_NITS)));
const HDR_PEAK = Number(opt('hdr-peak', String(HDR_PEAK_NITS)));
// --hdr-gamut, --hdr-hue, --hdr-glow: the preview's sliders, 0..1
const HDR_LOOK_ARGS = HDR_LOOK_KEYS.map((key) => [`hdr-${key}`, Number(opt(`hdr-${key}`, String(HDR_LOOK[key])))] as const);
// auto: measure MaxCLL/MaxFALL in a pass before encoding; nominal: the grading ceiling and unknown; or "CLL,FALL" in nits
const HDR_LIGHT = opt('hdr-light', 'auto')!;
const FFMPEG = opt('ffmpeg', 'ffmpeg')!;
if (HDR && mode !== 'video') throw new Error('--hdr is supported for video export only.');
if (HDR && (!Number.isFinite(HDR_WHITE) || !Number.isFinite(HDR_PEAK) || HDR_WHITE <= 0 || HDR_PEAK < HDR_WHITE || HDR_PEAK > 10000)) throw new Error('Require 0 < --hdr-white <= --hdr-peak <= 10000.');
for (const [name, value] of HDR_LOOK_ARGS) if (HDR && !(value >= 0 && value <= 1)) throw new Error(`Require 0 <= --${name} <= 1.`);
if (HDR && !/^(auto|nominal|\d+(\.\d+)?,\d+(\.\d+)?)$/.test(HDR_LIGHT)) throw new Error('--hdr-light takes auto, nominal, or MaxCLL,MaxFALL in nits.');
if (opt('ffmpeg-args-file')) {
  const extra: unknown = await Bun.file(opt('ffmpeg-args-file')!).json();
  if (!Array.isArray(extra) || extra.some((x) => typeof x !== 'string')) throw new Error('--ffmpeg-args-file must contain a JSON array of argument strings.');
  extraOutputArgs.unshift(...extra);
}
if (flag('help')) {
  console.log(`Video: bun scripts/render.ts video [--hdr] [--codec libx264|libx265|hevc_nvenc|av1_nvenc]
  --hdr-white 203 --hdr-peak 1000   Reference white / peak in nits
  --hdr-gamut 1 --hdr-hue 0.6 --hdr-glow 0.3   The preview's P3 glow / Hold hue / Trim glow sliders, 0 to 1
  --hdr-light auto                 MaxCLL/MaxFALL: auto (measured first), nominal, or CLL,FALL
  --preset NAME --crf N --cq N     Software CRF or NVENC CQ quality
  --x264 PARAMS --x265 PARAMS      Encoder-specific parameter strings
  --ffmpeg PATH                   Custom FFmpeg executable
  --ffmpeg-args-file FILE          JSON array of extra FFmpeg output arguments
  -- ARGS...                      Extra FFmpeg output arguments (override defaults)
  --print-ffmpeg                  Print the exact argument array
Existing --scale, --samples, --shutter, --fps, --from, --to and --noaudio remain available.`);
  process.exit(0);
}
const APP = path.resolve(import.meta.dir, '..');
const SCALE = Math.max(1, Math.round(+opt('scale', '1')!));
const OW = 1920 * SCALE, OH = 1080 * SCALE; // output size
// --samples N (fixed) or --samples auto [--min-samples 4] [--max-samples 324] [--tol 3] (adaptive, see Engine.render)
const SAMPLES = opt('samples', '1') === 'auto'
  ? { min: +opt('min-samples', '4')!, max: +opt('max-samples', '324')!, tol: +opt('tol', '3')! }
  : +opt('samples', '1')!;
const hist = (h: Record<string, number>) => Object.entries(h).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}:${v}`).join(' ');
const ROOT = path.resolve(APP, '..');
// Bun on Windows throws EEXIST for a recursive mkdir of an existing directory given as a relative path with `..`
const ensureDir = (dir: string) => mkdirSync(path.resolve(dir), { recursive: true });

async function reachable(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

async function ensureServer(): Promise<{ url: string; stop: () => void }> {
  const url = opt('url', 'http://localhost:5173')!;
  if (await reachable(url)) return { url, stop: () => {} };
  const port = 5300 + Math.floor(Math.random() * 500);
  // no live reload: a file saved mid-render must not reload the page
  const proc = Bun.spawn(['bunx', '--bun', 'vite', '--port', String(port), '--strictPort'], { cwd: APP, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, PDOOM_NO_HMR: '1' } });
  const u = `http://localhost:${port}`;
  for (let i = 0; i < 100 && !(await reachable(u)); i++) await Bun.sleep(100);
  if (!(await reachable(u))) { proc.kill(); throw new Error(`Vite did not start at ${u}`); }
  return { url: u, stop: () => proc.kill() };
}

async function openPage(url: string) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !flag('headed'),
    args: [...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const logs: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    const only = opt('only');
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('export', '1');
    if (only) pageUrl.searchParams.set('only', only);
    pageUrl.searchParams.set('scale', String(SCALE));
    if (HDR) {
      pageUrl.searchParams.set('output', 'hdr10');
      pageUrl.searchParams.set('hdr-white', String(HDR_WHITE));
      pageUrl.searchParams.set('hdr-peak', String(HDR_PEAK));
      for (const [name, value] of HDR_LOOK_ARGS) pageUrl.searchParams.set(name, String(value));
    } else pageUrl.searchParams.delete('output');
    await page.goto(pageUrl.href);
    await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 120000 });
    const err = await page.evaluate(() => (window as any).__pdoom.error);
    if (err) throw new Error(`app failed to boot:\n${err}\n${logs.join('\n')}`);
    const size: [number, number] = await page.evaluate(() => [(window as any).__pdoom.width ?? 1920, (window as any).__pdoom.height ?? 1080]);
    if (size[0] !== OW || size[1] !== OH) throw new Error(`app renders ${size[0]}x${size[1]}, expected ${OW}x${OH} (--scale ${SCALE})`);
    const sceneErrors: string[] = await page.evaluate(() => (window as any).__pdoom.errors);
    if (sceneErrors.length) console.error('SCENE ERRORS:\n' + sceneErrors.join('\n'));
    return { browser, page, logs };
  } catch (error) { await browser.close(); throw error; }
}

async function stills(page: Page, times: number[], outDir: string) {
  ensureDir(outDir);
  const files: string[] = [];
  for (const t of times) {
    const k: number = await page.evaluate(([t, s, sh]) => (window as any).__pdoom.still(t, s, sh), [t, SAMPLES, +opt('shutter', '0.5')!] as const);
    const f = path.join(outDir, `f_${t.toFixed(2).padStart(7, '0')}.png`);
    if (typeof SAMPLES !== 'number') console.log(`t=${t}: ${k} sub-frames`);
    // at scale > 1 the canvas is shown downscaled on the page: save the full-res pixel buffer instead
    if (SCALE !== 1) await Bun.write(f, Buffer.from(await page.evaluate(() => (window as any).__pdoom.png()), 'base64'));
    else await page.screenshot({ path: f, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    files.push(f);
  }
  return files;
}

async function sheet(page: Page, times: number[], cols: number, out: string) {
  const dataUrl: string = await page.evaluate(async ({ times, cols }) => {
    const P = (window as any).__pdoom;
    const cw = 480, ch = 270, pad = 4, lab = 18;
    const rows = Math.ceil(times.length / cols);
    const cv = document.createElement('canvas');
    cv.width = cols * (cw + pad) + pad; cv.height = rows * (ch + lab + pad) + pad;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#222'; c.fillRect(0, 0, cv.width, cv.height);
    const src = document.getElementById('c') as HTMLCanvasElement;
    times.forEach((t: number, i: number) => {
      P.still(t);
      const x = pad + (i % cols) * (cw + pad), y = pad + Math.floor(i / cols) * (ch + lab + pad);
      c.drawImage(src, x, y + lab, cw, ch);
      c.fillStyle = '#ddd'; c.font = '13px monospace'; c.fillText(`${t.toFixed(2)}s`, x + 2, y + 13);
    });
    return cv.toDataURL('image/png');
  }, { times, cols });
  ensureDir(path.dirname(out));
  await Bun.write(out, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

async function video(page: Page, from: number, to: number, fps: number, out: string) {
  ensureDir(path.dirname(out));
  let inputHdrMetadata = false;
  if (HDR) {
    const probe = Bun.spawn([FFMPEG, '-hide_banner', '-h', 'full'], { stdout: 'pipe', stderr: 'pipe' });
    const [help, diagnostics, code] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
    if (code) throw new Error(`FFmpeg capability check failed: ${diagnostics}`);
    inputHdrMetadata = /-mastering_display/.test(help) && /-content_light/.test(help);
  }
  // Static metadata has to be known before the encoder starts: measure it in a quick pass first.
  let maxCLL: number | undefined, maxFALL: number | undefined;
  if (HDR && HDR_LIGHT === 'auto') {
    const t0 = performance.now();
    const light: { maxCLL: number; maxFALL: number; frames: number } = await page.evaluate((o) => (window as any).__pdoom.light(o), { from, to, fps });
    ({ maxCLL, maxFALL } = light);
    console.log(`measured MaxCLL ${Math.ceil(maxCLL)} nits, MaxFALL ${Math.ceil(maxFALL)} nits (${light.frames} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  } else if (HDR && HDR_LIGHT !== 'nominal') [maxCLL, maxFALL] = HDR_LIGHT.split(',').map(Number);
  const encoding = videoEncodingArgs({ hdr: HDR, codec: opt('codec'), preset: opt('preset'), crf: opt('crf'), cq: opt('cq'),
    x264: opt('x264'), x265: opt('x265'), width: OW, height: OH, fps, from, to, output: out,
    audio: flag('noaudio') ? undefined : path.join(ROOT, 'audio/pdoom.m4a'),
    whiteNits: HDR_WHITE, peakNits: HDR_PEAK, maxCLL, maxFALL, inputHdrMetadata, extra: extraOutputArgs });
  const outputInfo = await page.evaluate(() => ({ format: (window as any).__pdoom.pixelFormat ?? 'rgba', bytes: (window as any).__pdoom.bytesPerPixel ?? 4 }));
  if (outputInfo.format !== encoding.pixelFormat || outputInfo.bytes !== encoding.bytesPerPixel) throw new Error('Browser/FFmpeg frame format mismatch. Restart the Vite server with the current source.');
  if (HDR && !inputHdrMetadata && encoding.codec !== 'libx265') console.warn('This FFmpeg lacks -mastering_display/-content_light. PQ/BT.2020 tags will be set, but use a newer FFmpeg or libx265 for static HDR mastering metadata.');
  const command = [FFMPEG, ...encoding.args];
  if (flag('print-ffmpeg')) console.log(JSON.stringify(command));
  console.log(`${HDR ? `HDR PQ/BT.2020 (${HDR_WHITE} nit white, ${HDR_PEAK} nit peak, ${HDR_LOOK_ARGS.map(([name, value]) => `${name.slice(4)} ${value}`).join(', ')})` : 'SDR BT.709'} -> ${encoding.codec}`);
  const total = Math.round(to * fps) - Math.round(from * fps);
  if (total <= 0) throw new Error('The selected interval contains no frames.');
  const ff = Bun.spawn(command, { stdin: 'pipe', stdout: 'inherit', stderr: 'pipe' });
  let frames = 0, stdinEnded = false, successful = false;
  let failure: Error | null = null;
  let rejectFailure!: (reason: Error) => void;
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failed.catch(() => {});
  let stderr = '';
  const stderrDone = (async () => {
    const reader = ff.stderr.getReader(), decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      stderr = (stderr + decoder.decode(chunk.value, { stream: true })).slice(-16000);
    }
  })();
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  const fail = (error: unknown) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    for (const ws of sockets) ws.close(1011, 'Encoder failed');
    rejectFailure(failure);
  };
  void ff.exited.then(async (code) => {
    await stderrDone;
    if (code !== 0) fail(new Error(`FFmpeg exited with code ${code}:\n${stderr}`));
    else if (!stdinEnded) fail(new Error(`FFmpeg stopped before all requested frames were sent (${frames}/${total}).`));
  }).catch(fail);
  const t0 = performance.now();
  const frameBytes = OW * OH * encoding.bytesPerPixel;
  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response('ws only', { status: 400 }); },
    websocket: {
      maxPayloadLength: Math.max(64 * 1024 * 1024, frameBytes + 1024),
      open(ws) { sockets.add(ws); if (failure) ws.close(1011, 'Encoder failed'); },
      close(ws) { sockets.delete(ws); },
      async message(ws, msg) {
        try {
          if (failure) return;
          if (typeof msg === 'string' || msg.byteLength !== frameBytes) throw new Error(`Invalid frame payload (expected ${frameBytes} bytes).`);
          ff.stdin.write(msg);
          await ff.stdin.flush();
          frames++;
          ws.send(String(frames));
          if (frames % 60 === 0 || frames === total) {
            const el = (performance.now() - t0) / 1000;
            process.stdout.write(`\r${frames}/${total} frames  ${(frames / el).toFixed(1)} fps  eta ${((total - frames) / (frames / el)).toFixed(0)}s   `);
          }
        } catch (error) {
          fail(new Error(`FFmpeg input failed: ${String(error)}\n${stderr}`));
          ff.kill();
        }
      },
    },
  });
  try {
    const used: Record<string, number> = await Promise.race([failed, page.evaluate((o) => (window as any).__pdoom.stream(o),
      { from, to, fps, ws: `ws://127.0.0.1:${server.port}`, samples: SAMPLES, shutter: +opt('shutter', '0.5')!, inflight: 4 })]);
    while (frames < total) await Promise.race([failed, Bun.sleep(20)]);
    stdinEnded = true;
    await ff.stdin.end();
    const code = await ff.exited; await stderrDone;
    if (code !== 0) throw new Error(`FFmpeg exited with code ${code}:\n${stderr}`);
    successful = true;
    console.log(`\nwrote ${out} (${frames} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    console.log(`sub-frames per frame (count:frames): ${hist(used)}`);
  } finally {
    server.stop(true);
    if (!successful) { ff.kill(); await ff.exited; }
    await stderrDone;
  }
}

const { url, stop } = await ensureServer();
const { browser, page, logs } = await openPage(url).catch((error) => { stop(); throw error; });
try {
  if (mode === 'gpu') {
    console.log(await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')!;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }));
  } else if (mode === 'stills') {
    const times = (opt('t') ?? '0').split(',').map(Number);
    const files = await stills(page, times, opt('out', path.join(ROOT, 'out/stills'))!);
    console.log(files.join('\n'));
  } else if (mode === 'sheet') {
    const from = +opt('from', '0')!, to = +opt('to', '10')!, n = +opt('n', '12')!;
    let times = Array.from({ length: n }, (_, i) => from + ((to - from) * i) / Math.max(1, n - 1));
    if (opt('times')) times = opt('times')!.split(',').map(Number);
    if (flag('cuts')) {
      // 4 frames around every timeline boundary: 2 frames before, 2 after
      const tl: { id: string; start: number }[] = await page.evaluate(() => (window as any).__pdoom.timeline);
      times = tl.slice(1).flatMap((e) => [e.start - 0.1, e.start - 1 / 60, e.start + 1 / 60, e.start + 0.1]);
    }
    const out = opt('out', path.join(ROOT, `out/sheets/sheet_${from}-${to}.png`))!;
    await sheet(page, times, +opt('cols', '4')!, out);
    console.log(out);
  } else if (mode === 'plates') {
    const tl: { id: string; start: number; end: number }[] = await page.evaluate(() => (window as any).__pdoom.timeline);
    const figs = ['open', 'loss', 'room', 'shoggoth', 'spacetime', 'ascent', 'bureau', 'leftturn', 'paperclips', 'fuse', 'stack', 'dense', 'loom', 'ilya'];
    const overrides: Record<string, number> = existsSync(path.join(APP, 'plates.json')) ? await Bun.file(path.join(APP, 'plates.json')).json() : {};
    const dir = path.join(APP, 'public/plates');
    ensureDir(dir);
    await page.evaluate(() => { (window as any).__pdoom.engine.hudOff = true; });
    for (let i = 0; i < figs.length; i++) {
      const e = tl.find((x) => x.id === figs[i]);
      if (!e) continue;
      const t = overrides[figs[i]!] ?? (e.start + e.end) / 2;
      await page.evaluate((t) => (window as any).__pdoom.still(t, 4, 0.2), t);
      const f = path.join(dir, `fig${String(i + 1).padStart(2, '0')}.jpg`);
      await page.screenshot({ path: f, type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
      console.log(f, t.toFixed(2));
    }
  } else if (mode === 'perf') {
    const from = +opt('from', '0')!, to = +opt('to', '5')!;
    const r = await page.evaluate(async ({ from, to, samples, shutter }) => {
      const P = (window as any).__pdoom;
      const ms: number[] = [];
      const buf = new Uint8Array(P.width * P.height * 4);
      P.still(from);
      const used: Record<number, number> = {};
      for (let t = from; t < to; t += 1 / 60) {
        const a = performance.now();
        const k = P.engine.render(t, 1 / 60, false, samples, shutter);
        used[k] = (used[k] ?? 0) + 1;
        await P.engine.readPixelsAsync(buf);
        ms.push(performance.now() - a);
      }
      ms.sort((a, b) => a - b);
      return { n: ms.length, avg: ms.reduce((a, b) => a + b, 0) / ms.length, p50: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1], used };
    }, { from, to, samples: SAMPLES, shutter: +opt('shutter', '0.5')! });
    console.log(`frames ${r.n}  avg ${r.avg.toFixed(1)}ms  p50 ${r.p50.toFixed(1)}  p95 ${r.p95.toFixed(1)}  max ${r.max.toFixed(1)}  sub-frames ${hist(r.used)}`);
  } else if (mode === 'video') {
    const dur: number = await page.evaluate(() => (window as any).__pdoom.duration);
    await video(page, +opt('from', '0')!, +opt('to', String(dur))!, +opt('fps', '60')!, path.resolve(opt('out', path.join(ROOT, 'out/pdoom.mp4'))!));
  }
  if (logs.length) console.error('BROWSER LOG:\n' + logs.slice(0, 40).join('\n'));
} finally {
  await browser.close();
  stop();
}
