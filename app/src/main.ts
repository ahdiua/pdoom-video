// Entry: preview player (default) or export mode (?export=1, driven by scripts/render.ts).
import { Engine, type AdaptiveSampling } from './engine/engine';
import { PW, PH, SCALE } from './engine/gl';
import { makeTimeline } from './timeline';
import { setupFullscreen } from './engine/fullscreen';
import { DETAIL_MODES, isDetailMode } from './engine/preview-quality';
import { HDR_LOOK, HDR_LOOK_KEYS, HDR_MAX_HEADROOM, HDR_PEAK_NITS, HDR_WHITE_NITS, hdrGradeFrom } from './engine/hdr-color';

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
if (!EXPORT) {
  let detail: unknown;
  try { detail = JSON.parse(sessionStorage.getItem('pdoom-preview-v2') ?? '{}')?.detail; } catch { /* private browsing */ }
  detail = params.get('detail') ?? detail;
  if (isDetailMode(detail)) engine.quality.mode = detail;
}

function fallbackToSDR(reason: string) {
  engine.setHdrDisplay(null);
  hdrState.active = false;
  hdrState.reason = reason;
  refreshHdrUI();
}

async function prepareHdr() {
  if (!HDR_MODE) return;
  hdrState.displayHDR = hdrScreen.matches; // may only turn true a moment after load
  if (!hdrState.displayHDR && !hdrState.diagnostic) {
    hdrState.reason = 'This browser does not report an HDR display. Using SDR.';
    return;
  }
  try {
    const { HdrDisplay } = await import('./engine/hdr-display');
    // ?hdr-headroom= is the display's peak as a multiple of its SDR white; ?hdr-gamut=, ?hdr-hue=, ?hdr-glow= are 0..1
    const grade = HDR_MODE === 'bridge' ? null : hdrGradeFrom((key) => params.get(`hdr-${key}`));
    const display = await HdrDisplay.create(canvas, engine.renderer.getContext() as WebGL2RenderingContext, grade ? 'display-p3' : 'srgb');
    display.onFailure = fallbackToSDR;
    engine.hdrGrade = grade;
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
  if (params.get('output') === 'hdr10') {
    engine.configureHdrExport({ whiteNits: Number(params.get('hdr-white') ?? HDR_WHITE_NITS), peakNits: Number(params.get('hdr-peak') ?? HDR_PEAK_NITS),
      look: Object.fromEntries(HDR_LOOK_KEYS.map((key) => [key, Number(params.get(`hdr-${key}`) ?? HDR_LOOK[key])])) as typeof HDR_LOOK });
  }
  window.__pdoom = {
    engine,
    duration: engine.duration,
    errors: engine.errors,
    /** Output size in px; stream() sends width*height*bytesPerPixel bytes per frame. */
    scale: SCALE,
    width: PW,
    height: PH,
    pixelFormat: engine.hdrExport?.pixelFormat ?? 'rgba',
    bytesPerPixel: engine.hdrExport?.bytesPerPixel ?? 4,
    hdrExport: engine.hdrExport?.options ?? null,
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
     * HDR10 static light levels of [from, to) at fps, in nits: MaxCLL (brightest pixel) and MaxFALL (brightest
     * frame average). One sample per frame: motion blur only lowers peaks, so these are upper bounds.
     */
    async light(opts: { from: number; to: number; fps: number }) {
      const dt = 1 / opts.fps;
      const n0 = Math.round(opts.from * opts.fps), n1 = Math.round(opts.to * opts.fps);
      if (n0 > 0) engine.render((n0 - 1) * dt, dt, false);
      let maxCLL = 0, maxFALL = 0;
      for (let n = n0; n < n1; n++) {
        engine.render(n * dt, dt, false);
        const { max, average } = engine.measureHdrLight();
        maxCLL = Math.max(maxCLL, max); maxFALL = Math.max(maxFALL, average);
        if (n % 30 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      return { maxCLL, maxFALL, frames: n1 - n0 };
    },
    /**
     * Render [from, to) at fps and stream raw frames (bottom-up) over a WebSocket:
     * rgba for SDR, rgba64le/PQ/BT.2020 for explicit HDR video export.
     * Returns when all frames were sent, with a histogram of sub-frames per frame. With `inflight`, the
     * receiver acknowledges each frame it has handed on (a text message with its running count) and at
     * most `inflight` frames are unacknowledged:
     * backpressure from the encoder, so a slow encode (4K) cannot pile frames up in the receiver's memory.
     * `times` sends those frames instead of the range (stills: each one is a seek).
     */
    async stream(opts: { from: number; to: number; fps: number; ws: string; samples?: number | AdaptiveSampling; shutter?: number; inflight?: number; times?: number[] }) {
      const ws = new WebSocket(opts.ws);
      ws.binaryType = 'arraybuffer';
      let acked = 0;
      ws.onmessage = (e) => { if (typeof e.data === 'string') acked = Math.max(acked, +e.data || 0); };
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error('Could not connect to the export receiver.'));
        ws.onclose = () => rej(new Error('Export receiver closed before the connection opened.'));
      });
      const waitFor = async (pending: () => boolean) => {
        while (pending()) {
          if (ws.readyState !== WebSocket.OPEN) throw new Error('Export connection closed before the encoder acknowledged all frames.');
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      };
      const dt = 1 / opts.fps;
      const n0 = Math.round(opts.from * opts.fps), n1 = Math.round(opts.to * opts.fps);
      const frames = opts.times ?? Array.from({ length: Math.max(0, n1 - n0) }, (_, i) => (n0 + i) * dt);
      const buf = new Uint8Array(PW * PH * (engine.hdrExport?.bytesPerPixel ?? 4));
      // warm-up: render one frame before the range so the first frame is sequential for stateful scenes
      const S = opts.samples ?? 1, SH = opts.shutter ?? 0.5;
      // (adaptive sampling only runs stateless scenes: one sample is enough for the warm-up)
      if (!opts.times && n0 > 0) engine.render((n0 - 1) * dt, dt, false, typeof S === 'number' ? S : 1, SH);
      const used: Record<number, number> = {}; // sub-frames per frame -> frames
      for (let i = 0; i < frames.length; i++) {
        const k = engine.render(frames[i]!, dt, false, S, SH);
        used[k] = (used[k] ?? 0) + 1;
        await engine.readExportPixelsAsync(buf);
        if (opts.inflight) await waitFor(() => i - acked >= opts.inflight!);
        await waitFor(() => ws.bufferedAmount > 64 * 1024 * 1024);
        if (ws.readyState !== WebSocket.OPEN) throw new Error('Export connection closed.');
        ws.send(buf);
        if (i % 30 === 0) await new Promise((r) => setTimeout(r, 0)); // let the socket flush
      }
      await waitFor(() => ws.bufferedAmount > 0);
      if (opts.inflight) await waitFor(() => acked < frames.length);
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
  if (params.has('webgpu-fallback')) status.textContent = `WebGPU unavailable: ${params.get('webgpu-fallback')}. Using WebGL.`;
  const hdrButton = button('hdr');
  const detailButton = button('detail');
  const storageKey = 'pdoom-preview-v2';
  let saved: { blur?: boolean; grain?: boolean; hidden?: boolean; subs?: boolean } = {};
  try { saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}') ?? {}; } catch { /* storage may be unavailable */ }
  engine.effects.motionBlur = typeof saved.blur === 'boolean' ? saved.blur : false;
  engine.effects.grain = typeof saved.grain === 'boolean' ? saved.grain : false;
  document.body.classList.toggle('ui-hidden', saved.hidden === true);
  let subsOn = params.get('subs') ? params.get('subs') !== '0' : saved.subs === true;
  const save = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify({ blur: engine.effects.motionBlur, grain: engine.effects.grain, subs: subsOn, detail: engine.quality.mode, hidden: document.body.classList.contains('ui-hidden') })); } catch { /* private browsing */ }
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
  let cadenceReset = true;
  let loop: [number, number] | null = null;
  let lastAudioT = 0, lastPerf = 0;
  let raf: number | null = null, dirty = true, lastInfo = -Infinity;
  let frames = 0, fpsT = performance.now(), fps = 0;
  const schedule = () => { if (raf === null) raf = requestAnimationFrame(tick); };
  const invalidate = () => { dirty = true; lastInfo = -Infinity; schedule(); };
  const seek = (x: number) => {
    cadenceReset = true;
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
    cadenceReset = true;
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
  const syncDetail = () => {
    const mode = engine.quality.mode;
    detailButton.textContent = `3D detail: ${mode === 'auto' ? 'Auto' : mode === 'full' ? 'Full' : 'Performance'}`;
    detailButton.title = 'Cycle Auto / Full / Performance (Q). Adjusts complex 3D detail; lyrics and output resolution stay sharp.';
  };
  const toggleDetail = () => {
    engine.quality.mode = DETAIL_MODES[(DETAIL_MODES.indexOf(engine.quality.mode) + 1) % DETAIL_MODES.length]!;
    const url = new URL(location.href); url.searchParams.delete('detail'); history.replaceState(null, '', url);
    syncDetail(); save(); invalidate();
  };
  // Chinese subtitles: a DOM overlay (preview only, never in the canvas or the export), one translation per lyric line.
  const subsButton = button('subs'), subtitle = document.getElementById('subtitle')!;
  let subtitles: string[] | null = null, subsShown = '';
  const SUB_LEAD = 0.1, SUB_HOLD = 0.5; // appear just before the line is sung, linger briefly after it ends
  const updateSubs = () => {
    let text = '';
    if (subsOn && subtitles) {
      const l = engine.lyrics.lastLine(t + SUB_LEAD);
      if (l && t < l.end + SUB_HOLD) text = subtitles[l.i] ?? '';
    }
    if (text === subsShown) return;
    subsShown = text;
    if (text) subtitle.textContent = text; // when it empties, keep the old text so the fade-out has something to show
    subtitle.classList.toggle('on', !!text);
  };
  const syncSubs = () => {
    subsButton.textContent = `中文字幕: ${subsOn ? 'On' : 'Off'}`;
    subsButton.setAttribute('aria-pressed', String(subsOn));
  };
  const toggleSubs = () => {
    subsOn = !subsOn;
    const url = new URL(location.href); url.searchParams.delete('subs'); history.replaceState(null, '', url); // the choice now lives in the session
    syncSubs(); save(); updateSubs();
  };
  void fetch('data/subtitles.zh.json').then((r) => r.json()).then((j: { lines: { i: number; zh: string }[] }) => {
    subtitles = [];
    for (const x of j.lines) subtitles[x.i] = x.zh;
    if (subtitles.length !== engine.lyrics.lines.length) console.warn(`subtitles.zh.json has ${subtitles.length} lines, lyrics.json has ${engine.lyrics.lines.length}`);
    updateSubs();
  }).catch(() => { subsButton.disabled = true; subsButton.title = 'data/subtitles.zh.json not found'; });
  subsButton.onclick = toggleSubs; syncSubs();
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
  // The grade is live: it is tuned by eye on the display at hand, one slider per setting, and kept in the URL.
  const hdrTune = document.getElementById('hdr-tune')!;
  const hdrKeys = ['headroom', ...HDR_LOOK_KEYS] as const;
  const hdrInput = (key: string) => document.getElementById(`hdr-${key}`) as HTMLInputElement;
  hdrInput('headroom').max = String(HDR_MAX_HEADROOM);
  const syncHdrTune = () => {
    const grade = hdrState.active ? engine.hdrGrade : null;
    hdrTune.hidden = !grade;
    if (!grade) return;
    for (const key of hdrKeys) {
      hdrInput(key).value = String(grade[key]);
      document.getElementById(`hdr-${key}-value`)!.textContent = key === 'headroom' ? `${grade[key].toFixed(2)}×` : `${Math.round(grade[key] * 100)}%`;
    }
  };
  const tuneHdr = () => {
    if (!engine.hdrGrade) return;
    const grade = engine.hdrGrade = hdrGradeFrom((key) => hdrInput(key).value);
    const url = new URL(location.href);
    for (const key of hdrKeys) url.searchParams.set(`hdr-${key}`, String(grade[key]));
    history.replaceState(null, '', url);
    syncHdrTune(); invalidate();
  };
  const hdrCard = button('hdr-card');
  hdrCard.onclick = () => {
    engine.hdrTestCard = !engine.hdrTestCard;
    hdrCard.setAttribute('aria-pressed', String(engine.hdrTestCard));
    invalidate();
  };
  for (const key of hdrKeys) {
    hdrInput(key).oninput = tuneHdr;
    hdrInput(key).addEventListener('keydown', (ev) => ev.stopPropagation()); // arrows adjust the slider, not the playhead
  }
  refreshHdrUI = () => {
    syncHdrTune();
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
  detailButton.onclick = toggleDetail; syncDetail();
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
      h: hideUI, f: () => { void toggleFullscreen(); }, b: toggleBlur, g: toggleGrain, c: toggleSubs, r: switchResolution, q: toggleDetail,
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

  let previousTick = 0;
  function tick() {
    raf = null;
    const now = performance.now();
    if (playing) {
      const entry = TIMELINE.find((x) => t >= x.start && t < x.end);
      if (previousTick && !cadenceReset && entry) engine.quality.observeFrame(entry.id, now - previousTick);
      // smooth the coarse audio clock with performance.now()
      if (audio.currentTime !== lastAudioT) { lastAudioT = audio.currentTime; lastPerf = now; }
      t = Math.min(engine.duration - 0.001, lastAudioT + (audio.paused ? 0 : (now - lastPerf) / 1000));
      if (loop && t >= loop[1]) seek(loop[0]);
      if (audio.ended) playing = false;
    }
    // A display failure may invalidate the frame during render(); keep that
    // request so a paused player also repaints its SDR fallback immediately.
    if (playing || dirty) { dirty = false; engine.render(t, 1 / 60); frames++; }
    previousTick = playing ? now : 0; cadenceReset = false;
    if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
    updateSubs();
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
  document.addEventListener('visibilitychange', () => { cadenceReset = true; if (!document.hidden) invalidate(); });
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
