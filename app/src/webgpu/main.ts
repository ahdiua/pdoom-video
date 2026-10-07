// The player of the native WebGPU Paperclips experiment (docs/WEBGPU.md).
//   ?map=loop|unrolled|flat   how the lattice shader is written (same picture)
//   ?hdr=1|test               present on an extended-range canvas with the HDR grade (?hdr-headroom= etc. as in the WebGL preview)
import { PaperclipsGPU } from './renderer';
import { MAP_VARIANTS, type MapVariant } from './paperclips-shaders';
import { hdrGradeFrom } from '../engine/hdr-color';
import { SCALE } from '../engine/scale';

const params = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const map = MAP_VARIANTS.find((m) => m === params.get('map')) ?? ('loop' satisfies MapVariant);
const hdr = ['1', 'test'].includes(params.get('hdr') ?? '') ? hdrGradeFrom((key) => params.get(`hdr-${key}`)) : null;
const engine = new PaperclipsGPU(canvas, { map, hdr, timers: params.get('timers') !== '0' });
const audio = new Audio(new URL('audio/pdoom.m4a', document.baseURI).href);
audio.preload = 'auto';
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const seekBar = document.getElementById('seek') as HTMLInputElement;
const status = document.getElementById('status')!;
const loading = document.getElementById('loading')!;
let t = Number(params.get('t') ?? 100);
let playing = false, loop = params.get('loop') !== '0', dirty = true, failed = false;
const stored = (name: string, fallback: boolean) => {
  if (params.has(name)) return params.get(name) === '1';
  try { return sessionStorage.getItem(`pdoom-webgpu-${name}`) === '1' || (sessionStorage.getItem(`pdoom-webgpu-${name}`) === null && fallback); }
  catch { return fallback; }
};
engine.effects.grain = stored('grain', false); engine.effects.motionBlur = stored('blur', false);

function fallback(reason: string) {
  if (failed) return;
  failed = true; playing = false; audio.pause(); engine.dispose();
  const url = new URL('./', location.href);
  url.searchParams.set('t', String(Number.isFinite(t) ? t : 100));
  url.searchParams.set('scale', String(SCALE)); url.searchParams.set('detail', 'full');
  url.searchParams.set('loop', loop ? '1' : '0');
  url.searchParams.set('only', 'paperclips'); url.searchParams.set('webgpu-fallback', reason);
  // Match the existing player's effect persistence when returning to WebGL.
  try { sessionStorage.setItem('pdoom-preview-v2', JSON.stringify({ grain: engine.effects.grain, blur: engine.effects.motionBlur, detail: 'full' })); } catch { /* optional persistence */ }
  location.replace(url.href);
}
engine.onFailure = fallback;
window.__pdoom = { ready: false, backend: 'webgpu', engine };
try {
  await engine.init();
  t = Number.isFinite(t) ? Math.max(engine.start, Math.min(engine.end - .001, t)) : 100;
  if (params.get('warmup') !== '0') await engine.warmup((done, total) => {
    const progress = document.getElementById('progress') as HTMLProgressElement;
    progress.max = total; progress.value = done;
    document.getElementById('loading-text')!.textContent = `Preparing WebGPU Paperclips · ${done}/${total}`;
  });
  seekBar.min = String(engine.start); seekBar.max = String(engine.end - .001);
  const seek = (time: number) => {
    t = Math.max(engine.start, Math.min(engine.end - .001, time));
    if (!Number.isFinite(t)) t = engine.start;
    audio.currentTime = t; dirty = true; update();
  };
  function update() {
    seekBar.value = String(t);
    button('play').textContent = playing ? 'Pause' : 'Play';
    button('resolution').textContent = SCALE === 2 ? '2160p (Switch to 1080p)' : '1080p (Switch to 2160p)';
    for (const [id, label, on] of [['grain', 'Film grain', engine.effects.grain], ['motion-blur', 'Motion blur', engine.effects.motionBlur], ['loop', 'Loop', loop]] as const) {
      button(id).textContent = `${label}: ${on ? 'On' : 'Off'}`; button(id).setAttribute('aria-pressed', String(on));
    }
    status.textContent = `WebGPU experiment · Paperclips · ${hdr ? 'HDR' : 'SDR'} · Full detail · ${map} map · ${t.toFixed(2)}s`;
    const url = new URL('./', location.href);
    url.searchParams.set('only', 'paperclips'); url.searchParams.set('detail', 'full'); url.searchParams.set('scale', String(SCALE)); url.searchParams.set('t', String(t));
    (document.getElementById('webgl') as HTMLAnchorElement).href = url.href;
  }
  async function play() {
    if (playing) { playing = false; audio.pause(); update(); return; }
    if (t >= engine.end - .002) seek(engine.start);
    audio.currentTime = t;
    try { await audio.play(); if (failed) { audio.pause(); return; } playing = true; }
    catch (error) { status.textContent = `Playback unavailable: ${String(error)}`; return; }
    update();
  }
  const toggle = (key: 'grain' | 'motionBlur') => {
    engine.effects[key] = !engine.effects[key]; dirty = true;
    try { sessionStorage.setItem(`pdoom-webgpu-${key === 'grain' ? 'grain' : 'blur'}`, engine.effects[key] ? '1' : '0'); } catch { /* optional persistence */ }
    update();
  };
  const changeResolution = () => {
    const url = new URL(location.href); url.searchParams.set('scale', SCALE === 2 ? '1' : '2');
    url.searchParams.set('t', String(t)); url.searchParams.set('loop', loop ? '1' : '0');
    url.searchParams.set('grain', engine.effects.grain ? '1' : '0'); url.searchParams.set('blur', engine.effects.motionBlur ? '1' : '0');
    if (playing) url.searchParams.set('play', '1'); else url.searchParams.delete('play');
    location.href = url.href;
  };
  button('play').onclick = play;
  button('grain').onclick = () => toggle('grain'); button('motion-blur').onclick = () => toggle('motionBlur');
  button('loop').onclick = () => { loop = !loop; update(); };
  button('resolution').onclick = changeResolution;
  button('fullscreen').onclick = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.getElementById('wrap')!.requestFullscreen(); }
    catch { status.textContent = 'Fullscreen unavailable in this browser.'; }
  };
  seekBar.oninput = () => seek(Number(seekBar.value));
  document.addEventListener('keydown', event => {
    if (event.code === 'Space') { event.preventDefault(); void play(); }
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); seek(t + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1)); }
    else if (event.key.toLowerCase() === 'g') toggle('grain');
    else if (event.key.toLowerCase() === 'b') toggle('motionBlur');
    else if (event.key.toLowerCase() === 'r') changeResolution();
    else if (event.key.toLowerCase() === 'f') button('fullscreen').click();
  });
  window.__pdoom = { ready: false, backend: 'webgpu', engine, width: engine.width, height: engine.height, scale: SCALE,
    start: engine.start, end: engine.end, seek, get time() { return t; }, get playing() { return playing; },
    still(time: number) { engine.render(time); }, png() { return engine.png(); } };
  engine.render(t); await engine.settled(); dirty = false; update();
  // Grid's intrinsic canvas dimensions can exceed the space above the controls.
  // Fit the CSS box explicitly; retain the physical render target resolution.
  const wrap = document.getElementById('wrap')!;
  const fit = () => {
    const scale = Math.min(wrap.clientWidth / engine.width, wrap.clientHeight / engine.height);
    canvas.style.width = `${engine.width * scale}px`;
    canvas.style.height = `${engine.height * scale}px`;
  };
  const observer = new ResizeObserver(fit); observer.observe(wrap); fit();
  loading.hidden = true; document.getElementById('ui')!.inert = false;
  window.__pdoom.ready = true;
  if (params.get('export') === '1') document.body.classList.add('export');
  function tick() {
    if (failed) return;
    if (playing) {
      t = audio.currentTime;
      if (t >= engine.end) { if (loop) seek(engine.start); else { t = engine.end - .001; playing = false; audio.pause(); } }
      dirty = true;
    }
    if (dirty) { try { engine.render(t); dirty = false; update(); } catch (error) { fallback(String(error)); return; } }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  if (params.get('play') === '1') void play();
  window.addEventListener('pagehide', () => { observer.disconnect(); audio.pause(); engine.dispose(); }, { once: true });
} catch (error) { fallback(String(error)); }
