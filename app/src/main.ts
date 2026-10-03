// Entry: preview player (default) or export mode (?export=1, driven by scripts/render.ts).
import { Engine, type AdaptiveSampling } from './engine/engine';
import { PW, PH, SCALE } from './engine/gl';
import { makeTimeline } from './timeline';
import { setupFullscreen } from './engine/fullscreen';

const params = new URLSearchParams(location.search);
const EXPORT = params.has('export');
const ONLY = params.get('only'); // comma-separated scene ids to load (faster stills)
const FROM = params.get('t') ? parseFloat(params.get('t')!) : null;
const HDR_MODE = !EXPORT && ['1', 'test', 'bridge'].includes(params.get('hdr') ?? '') ? params.get('hdr')! : '';
const hdrScreen = matchMedia('(dynamic-range: high)');
const hdrState = { requested: !!HDR_MODE, active: false, displayHDR: hdrScreen.matches,
  diagnostic: HDR_MODE === 'test' || HDR_MODE === 'bridge', reason: '' };
let refreshHdrUI = () => {};

const canvas = document.getElementById('c') as HTMLCanvasElement;
// physical size: 1920x1080 times ?scale= (the page CSS keeps showing it at 1920x1080)
canvas.width = PW;
canvas.height = PH;

const engine = new Engine(canvas, makeTimeline, { hdrCapable: !!HDR_MODE });
engine.preview = !EXPORT;

function fallbackToSDR(reason: string) {
  engine.setHdrDisplay(null);
  hdrState.active = false;
  hdrState.reason = reason;
  refreshHdrUI();
}

async function prepareHdr() {
  if (!HDR_MODE) return;
  if (!hdrState.displayHDR && !hdrState.diagnostic) {
    hdrState.reason = 'This browser does not report an HDR display. Using SDR.';
    return;
  }
  try {
    const { HdrDisplay } = await import('./engine/hdr-display');
    const display = await HdrDisplay.create(canvas, engine.renderer.getContext() as WebGL2RenderingContext);
    display.onFailure = fallbackToSDR;
    engine.hdrHeadroom = HDR_MODE === 'bridge' ? 1 : 4;
    engine.setHdrDisplay(display);
    hdrState.active = true;
  } catch (error) { fallbackToSDR(`HDR unavailable: ${String(error)}`); }
}

declare global {
  interface Window { __pdoom: any }
}

let TIMELINE: typeof engine.timeline = [];

async function boot() {
  const loading = document.getElementById('loading')!;
  const loadingText = document.getElementById('loading-text')!;
  const loadingProgress = document.getElementById('loading-progress') as HTMLProgressElement;
  window.__pdoom = { engine, hdr: hdrState, ready: false };
  if (EXPORT) loading.hidden = true;
  const onlySet = ONLY ? new Set(ONLY.split(',')) : null;
  await engine.init(onlySet ? (e) => onlySet.has(e.id) : undefined);
  TIMELINE = engine.timeline;
  if (HDR_MODE) { loadingText.textContent = 'Preparing HDR display…'; await prepareHdr(); }
  if (!EXPORT && params.get('warmup') !== '0') {
    await engine.warmup(({ scene, completed, total, phase }) => {
      loadingProgress.max = Math.max(1, total);
      loadingProgress.value = completed;
      loadingText.textContent = phase === 'ready' ? 'Ready' : `${phase === 'compile' ? 'Preparing shaders' : 'Preparing graphics'} · ${scene} · ${completed}/${total}`;
    });
  }
  if (engine.hdrDisplay) {
    loadingText.textContent = 'Preparing HDR display…';
    engine.render(Number.isFinite(FROM) ? Math.max(0, Math.min(engine.duration - 0.001, FROM!)) : 0);
    try { await engine.hdrDisplay?.settled(); }
    catch (error) { fallbackToSDR(`HDR initialization failed: ${String(error)}`); }
  }
  loading.hidden = true;
  document.getElementById('ui')!.inert = false;
  if (EXPORT) setupExport();
  else setupPlayer();
}

// ------------------------------------------------------------------ export API
function setupExport() {
  document.body.classList.add('export');
  window.__pdoom = {
    engine,
    duration: engine.duration,
    errors: engine.errors,
    /** Output size in px (1920x1080 times scale); stream() sends frames of width*height*4 bytes. */
    scale: SCALE,
    width: PW,
    height: PH,
    timeline: TIMELINE.map(({ id, start, end }) => ({ id, start, end })),
    /** Render a single frame at t (seeks as needed). */
    still(t: number, samples: number | AdaptiveSampling = 1, shutter = 0.5) { return engine.render(t, 1 / 60, true, samples, shutter); },
    /** The last rendered frame as a full-resolution (PW x PH) PNG, base64 (for stills at scale > 1). */
    async png() {
      const px = await engine.readPixelsAsync(), row = PW * 4;
      const img = new ImageData(PW, PH);
      for (let y = 0; y < PH; y++) img.data.set(px.subarray((PH - 1 - y) * row, (PH - y) * row), y * row); // bottom-up -> top-down
      const oc = new OffscreenCanvas(PW, PH);
      oc.getContext('2d')!.putImageData(img, 0, 0);
      const b = new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    },
    /**
     * Render [from, to) at fps and stream raw RGBA frames (bottom-up) over a WebSocket.
     * Returns when all frames were sent, with a histogram of sub-frames per frame. With `inflight`, the
     * receiver acknowledges each frame it has handed on (a text message with its running count) and at
     * most `inflight` frames are unacknowledged:
     * backpressure from the encoder, so a slow encode (4K) cannot pile frames up in the receiver's memory.
     */
    async stream(opts: { from: number; to: number; fps: number; ws: string; samples?: number | AdaptiveSampling; shutter?: number; inflight?: number }) {
      const ws = new WebSocket(opts.ws);
      ws.binaryType = 'arraybuffer';
      let acked = 0;
      ws.onmessage = (e) => { if (typeof e.data === 'string') acked = Math.max(acked, +e.data || 0); };
      await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
      const dt = 1 / opts.fps;
      const n0 = Math.round(opts.from * opts.fps), n1 = Math.round(opts.to * opts.fps);
      const buf = new Uint8Array(PW * PH * 4);
      // warm-up: render one frame before the range so the first frame is sequential for stateful scenes
      const S = opts.samples ?? 1, SH = opts.shutter ?? 0.5;
      // (adaptive sampling only runs stateless scenes: one sample is enough for the warm-up)
      if (n0 > 0) engine.render((n0 - 1) * dt, dt, false, typeof S === 'number' ? S : 1, SH);
      const used: Record<number, number> = {}; // sub-frames per frame -> frames
      for (let n = n0; n < n1; n++) {
        const k = engine.render(n * dt, dt, false, S, SH);
        used[k] = (used[k] ?? 0) + 1;
        await engine.readPixelsAsync(buf);
        if (opts.inflight) while (n - n0 - acked >= opts.inflight) await new Promise((r) => setTimeout(r, 2));
        while (ws.bufferedAmount > 64 * 1024 * 1024) await new Promise((r) => setTimeout(r, 2));
        ws.send(buf);
        if (n % 30 === 0) await new Promise((r) => setTimeout(r, 0)); // let the socket flush
      }
      while (ws.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 5));
      ws.close();
      return used;
    },
  };
  window.__pdoom.ready = true;
}

// ------------------------------------------------------------------ preview player
function setupPlayer() {
  const audio = new Audio('audio/pdoom.m4a');
  audio.preload = 'auto';
  const scrub = document.getElementById('scrub') as HTMLInputElement;
  const info = document.getElementById('info')!;
  const marks = document.getElementById('marks')!;
  const errs = document.getElementById('errs')!;
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
  const playButton = button('play'), resolution = button('resolution');
  const fullscreen = button('fullscreen'), blur = button('motion-blur'), grain = button('grain');
  const status = document.getElementById('status')!;
  const hdrButton = button('hdr');
  const storageKey = 'pdoom-preview-v2';
  let saved: { blur?: boolean; grain?: boolean; hidden?: boolean } = {};
  try { saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}') ?? {}; } catch { /* storage may be unavailable */ }
  engine.effects.motionBlur = typeof saved.blur === 'boolean' ? saved.blur : false;
  engine.effects.grain = typeof saved.grain === 'boolean' ? saved.grain : false;
  document.body.classList.toggle('ui-hidden', saved.hidden === true);
  const save = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify({ blur: engine.effects.motionBlur, grain: engine.effects.grain, hidden: document.body.classList.contains('ui-hidden') })); } catch { /* private browsing */ }
  };
  scrub.max = String(engine.duration);
  scrub.step = '0.001';
  if (engine.errors.length) { errs.textContent = engine.errors.join('\n\n'); errs.style.display = 'block'; }

  for (const e of TIMELINE) {
    const m = document.createElement('div');
    m.className = 'mark';
    m.style.left = `${(e.start / engine.duration) * 100}%`;
    m.style.width = `${((e.end - e.start) / engine.duration) * 100}%`;
    m.title = `${e.id} ${e.start.toFixed(2)}–${e.end.toFixed(2)}`;
    m.textContent = e.id;
    m.onclick = () => seek(e.start);
    marks.appendChild(m);
  }

  let t = Number.isFinite(FROM) ? FROM! : 0;
  let playing = false;
  let loop: [number, number] | null = null;
  let lastAudioT = 0, lastPerf = 0;
  let raf: number | null = null, dirty = true, lastInfo = -Infinity;
  let frames = 0, fpsT = performance.now(), fps = 0;
  const schedule = () => { if (raf === null) raf = requestAnimationFrame(tick); };
  const invalidate = () => { dirty = true; lastInfo = -Infinity; schedule(); };
  const seek = (x: number) => {
    t = Math.max(0, Math.min(engine.duration - 0.001, x));
    audio.currentTime = t;
    lastAudioT = t; lastPerf = performance.now();
    invalidate();
  };
  seek(t);

  const toggle = () => {
    if (playing) { audio.pause(); return; }
    if (audio.ended || t >= engine.duration - 0.01) seek(0);
    audio.currentTime = t;
    status.textContent = '';
    void audio.play().catch(() => { status.textContent = 'Press Play to resume audio.'; audio.pause(); invalidate(); });
  };
  audio.addEventListener('play', () => {
    playing = true; frames = 0; fps = 0; fpsT = performance.now();
    lastAudioT = audio.currentTime; lastPerf = fpsT;
    playButton.textContent = 'Pause'; invalidate();
  });
  audio.addEventListener('pause', () => { playing = false; playButton.textContent = 'Play'; invalidate(); });
  audio.addEventListener('seeked', invalidate);
  const syncEffects = () => {
    blur.textContent = `Motion blur: ${engine.effects.motionBlur ? 'On' : 'Off'}`;
    blur.setAttribute('aria-pressed', String(engine.effects.motionBlur));
    grain.textContent = `Film grain: ${engine.effects.grain ? 'On' : 'Off'}`;
    grain.setAttribute('aria-pressed', String(engine.effects.grain));
  };
  const toggleBlur = () => { engine.effects.motionBlur = !engine.effects.motionBlur; syncEffects(); save(); invalidate(); };
  const toggleGrain = () => { engine.effects.grain = !engine.effects.grain; syncEffects(); save(); invalidate(); };
  const showUI = () => { document.body.classList.remove('ui-hidden'); save(); invalidate(); };
  const hideUI = () => {
    document.body.classList.toggle('ui-hidden'); save(); invalidate();
  };
  const toggleFullscreen = setupFullscreen(document.getElementById('player')!, fullscreen, status, invalidate);
  const reloadPreview = (url: URL) => {
    url.searchParams.set('t', String(t));
    if (playing) url.searchParams.set('play', '1'); else url.searchParams.delete('play');
    if (loop) url.searchParams.set('loop', '1'); else url.searchParams.delete('loop');
    save(); location.replace(url.href);
  };
  const switchResolution = () => {
    // Scale is compiled into scene shaders and canvas backing stores. Recreate the
    // page, retaining time/settings, instead of merely stretching a 1080p image.
    const url = new URL(location.href);
    url.searchParams.set('scale', SCALE === 2 ? '1' : '2');
    reloadPreview(url);
  };
  refreshHdrUI = () => {
    hdrButton.textContent = hdrState.active ? (hdrState.diagnostic ? 'HDR: Test' : 'HDR: On') : (HDR_MODE ? 'HDR: Unavailable' : 'HDR: Off');
    hdrButton.setAttribute('aria-pressed', String(hdrState.active));
    hdrButton.title = hdrState.reason || 'Experimental HDR display; switching reloads at the current time';
    if (hdrState.reason) status.textContent = hdrState.reason;
    else if (hdrState.diagnostic) status.textContent = `HDR pipeline test${hdrState.displayHDR ? '' : ' — browser reports SDR display'}`;
    invalidate();
  };
  hdrButton.onclick = () => {
    const url = new URL(location.href);
    if (HDR_MODE) url.searchParams.delete('hdr'); else url.searchParams.set('hdr', '1');
    reloadPreview(url);
  };
  hdrScreen.addEventListener('change', () => {
    hdrState.displayHDR = hdrScreen.matches;
    if (!hdrState.displayHDR && hdrState.active && !hdrState.diagnostic) fallbackToSDR('HDR display no longer available. Using SDR.');
  });
  canvas.addEventListener('webglcontextlost', () => { if (hdrState.active) fallbackToSDR('Graphics context lost. Returning to SDR.'); });
  refreshHdrUI();
  const curRes = `${PH}p`;
  const nextRes = SCALE === 2 ? '1080p' : '2160p';
  resolution.textContent = `${curRes} (Switch to ${nextRes})`;
  resolution.title = `Current resolution: ${curRes}. Click or press R to switch to ${nextRes}; reloads at the current time`;
  resolution.setAttribute('aria-label', `Current resolution: ${curRes}. Switch to ${nextRes}`);
  playButton.onclick = toggle;
  resolution.onclick = switchResolution;
  fullscreen.onclick = () => { void toggleFullscreen(); };
  blur.onclick = toggleBlur; grain.onclick = toggleGrain;
  button('hide-ui').onclick = hideUI;
  button('show-ui').onclick = () => { showUI(); button('hide-ui').focus({ preventScroll: true }); };
  syncEffects();
  // A tap on a clean picture restores controls without accidentally pausing it.
  document.getElementById('wrap')!.onclick = () => { if (document.body.classList.contains('ui-hidden')) showUI(); else toggle(); };
  scrub.oninput = () => seek(parseFloat(scrub.value));
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName) || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range'))) {
      return;
    }
    if (ev.key === ' ' || ev.key === 'Spacebar' || ev.code === 'Space') {
      ev.preventDefault();
      toggle();
      return;
    }
    const key = ev.key.toLowerCase();
    const actions: Record<string, () => void> = {
      ArrowRight: () => seek(t + (ev.shiftKey ? 5 : 1)), ArrowLeft: () => seek(t - (ev.shiftKey ? 5 : 1)),
      '.': () => seek(t + 1 / 60), ',': () => seek(t - 1 / 60),
      h: hideUI, f: () => { void toggleFullscreen(); }, b: toggleBlur, g: toggleGrain, r: switchResolution,
      l: () => {
        const e = TIMELINE.find((x) => t >= x.start && t < x.end);
        loop = loop ? null : e ? [e.start, e.end] : null;
        invalidate();
      },
      ']': () => { const e = TIMELINE.find((x) => x.start > t + 0.01); if (e) seek(e.start); },
      '[': () => { const es = TIMELINE.filter((x) => x.start < t - 0.3); const e = es[es.length - 1]; if (e) seek(e.start); },
    };
    const action = actions[ev.key] ?? actions[key];
    if (action) { ev.preventDefault(); action(); }
  });

  function tick() {
    raf = null;
    const now = performance.now();
    if (playing) {
      // smooth the coarse audio clock with performance.now()
      if (audio.currentTime !== lastAudioT) { lastAudioT = audio.currentTime; lastPerf = now; }
      t = Math.min(engine.duration - 0.001, lastAudioT + (audio.paused ? 0 : (now - lastPerf) / 1000));
      if (loop && t >= loop[1]) seek(loop[0]);
      if (audio.ended) playing = false;
    }
    // A display failure may invalidate the frame during render(); keep that
    // request so a paused player also repaints its SDR fallback immediately.
    if (playing || dirty) { dirty = false; engine.render(t, 1 / 60); frames++; }
    if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
    if (now - lastInfo >= 100 || !playing) {
      scrub.value = String(t);
      const e = TIMELINE.find((x) => t >= x.start && t < x.end);
      const l = engine.lyrics.lineAt(t);
      info.textContent = `${t.toFixed(2)}s  beat ${engine.audio.beatAt(t).toFixed(2)}  bar ${engine.audio.barAt(t).toFixed(2)}  [${e?.id ?? '—'}]  ${playing ? fps.toFixed(0) + 'fps' : 'paused'}   ${l ? '“' + l.text + '”' : ''}${loop ? '  LOOP' : ''}`;
      lastInfo = now;
    }
    if (playing) schedule();
  }
  // Paused previews render only on seeks/settings changes, including restoration
  // after a resize, tab switch or WebGL context loss.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) invalidate(); });
  canvas.addEventListener('webglcontextrestored', invalidate);
  if (params.get('loop') === '1') {
    const e = TIMELINE.find((x) => t >= x.start && t < x.end);
    if (e) loop = [e.start, e.end];
  }
  window.__pdoom = { ready: true, engine, hdr: hdrState, seek, get time() { return t; }, get playing() { return playing; } };
  if (params.get('play') === '1') {
    const url = new URL(location.href); url.searchParams.delete('play'); history.replaceState(null, '', url);
    toggle();
  }

  // Vite HMR: re-instantiate scenes whose module changed
  if (import.meta.hot) {
    import.meta.hot.on('vite:afterUpdate', (payload: any) => {
      for (const u of payload.updates ?? []) {
        const m = /scenes\/([\w-]+)\.ts/.exec(u.path ?? '');
        if (m) for (const e of TIMELINE) if (e.id === m[1] || (e as any).file === m[1]) void engine.reload(e.id).then(invalidate);
      }
    });
  }
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('loading-text')!.textContent = 'Preview preparation failed. Reload to try again.';
  const errors = document.getElementById('errs')!;
  errors.textContent = String(e?.stack ?? e);
  errors.style.display = 'block';
  window.__pdoom = { error: String(e?.stack ?? e) };
});
