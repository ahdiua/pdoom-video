import * as THREE from 'three';
import { FSPass, isCompilingFrame, makeRT } from './gl';

export const DETAIL_MODES = ['auto', 'full', 'performance'] as const;
export type DetailMode = typeof DETAIL_MODES[number];
export function isDetailMode(value: unknown): value is DetailMode { return DETAIL_MODES.some((m) => m === value); }

interface PassTiming {
  scale: number;
  min: number;
  samples: number;
  slow: number;
  fast: number;
  frames: number;
  ms: number;
  pending?: { query: WebGLQuery; scale: number; submitted: number };
}
interface GPUTimer { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

/** Only expensive 3D passes adapt. Typography, overlays and output size stay native.
 * Asynchronous GPU queries never wait/readPixels; a cadence fallback covers browsers
 * without timer queries. Export callers always disable this controller. */
export class PreviewQuality {
  enabled = false;
  mode: DetailMode = 'auto';
  warming = false;
  private gl: WebGL2RenderingContext;
  private timer: GPUTimer | null;
  private passes = new Map<string, PassTiming>();
  private active = '';
  private fallbackFrames = 0;
  private fallbackMs = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.timer = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.timer = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.passes.clear(); this.active = '';
    });
  }

  private adjust(p: PassTiming, ms: number, scale: number) {
    p.ms = ms;
    // The first draw includes allocation/uploads; don't grade the GPU on it.
    if (++p.samples === 1 || scale !== p.scale || !Number.isFinite(ms) || ms <= 0) return;
    p.slow = ms > 10 ? p.slow + 1 : 0;
    p.fast = ms < 5 ? p.fast + 1 : 0;
    // Require consecutive slow samples even during warm-up: driver work or
    // transient contention must not lower detail on an otherwise fast GPU.
    if (p.slow >= 2) {
      // Leave ~9 ms of a 60 Hz frame for composition, post and CPU work: a steady frame rate reads
      // as quality before the last step of 3D resolution does.
      p.scale = Math.max(p.min, Math.floor(p.scale * Math.sqrt(7.5 / ms) * 12) / 12);
      p.slow = p.fast = 0;
    } else if (p.fast >= 15 && p.scale < 1) {
      p.scale = Math.min(1, p.scale + 1 / 12);
      p.slow = p.fast = 0;
    }
  }

  poll(discard = false) {
    if (!this.timer || this.gl.isContextLost()) return;
    if (![...this.passes.values()].some((p) => p.pending)) return;
    const gl = this.gl, disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    for (const p of this.passes.values()) {
      const pending = p.pending;
      if (!pending) continue;
      const available = gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE);
      if (!available && !disjoint && performance.now() - pending.submitted < 2000) continue;
      if (available && !disjoint && !discard) this.adjust(p, gl.getQueryParameter(pending.query, gl.QUERY_RESULT) / 1e6, pending.scale);
      gl.deleteQuery(pending.query); p.pending = undefined;
    }
  }

  render(id: string, nativeHeight: number, minHeight: number, performanceHeight: number, draw: (scale: number) => void) {
    if (!this.enabled || this.mode === 'full' || isCompilingFrame(this.renderer)) { draw(1); return; }
    this.poll();
    let p = this.passes.get(id);
    if (!p) {
      const min = Math.min(1, minHeight / nativeHeight);
      // No GPU timer (e.g. some mobile browsers): start touch devices at 720p
      // detail, then use sustained playback cadence to adjust further.
      const scale = !this.timer && matchMedia('(pointer: coarse)').matches ? Math.min(1, performanceHeight / nativeHeight) : 1;
      p = { scale, min, samples: 0, slow: 0, fast: 0, frames: 0, ms: 0 };
      this.passes.set(id, p);
    }
    if (this.active !== id) { this.active = id; this.fallbackFrames = this.fallbackMs = 0; }
    const scale = this.mode === 'performance' ? Math.min(1, performanceHeight / nativeHeight) : p.scale;
    let query: WebGLQuery | null = null;
    const gl = this.gl, timer = this.timer;
    if (this.mode === 'auto' && timer && !p.pending && (this.warming || p.frames++ % 12 === 0) && !gl.isContextLost()) {
      // External benchmark/profiler queries must never be nested.
      if (!gl.getQuery(timer.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) query = gl.createQuery();
    }
    if (query) gl.beginQuery(timer!.TIME_ELAPSED_EXT, query);
    try { draw(scale); }
    finally {
      if (query) {
        gl.endQuery(timer!.TIME_ELAPSED_EXT);
        p.pending = { query, scale, submitted: performance.now() };
      }
    }
  }

  /** Playback only; seeks, pauses and background tabs must not lower quality. */
  observeFrame(scene: string, ms: number) {
    if (this.timer || !this.enabled || this.mode !== 'auto' || document.hidden || !this.active.startsWith(`${scene}:`)) return;
    if (ms <= 0 || ms > 1000) { this.fallbackFrames = this.fallbackMs = 0; return; }
    this.fallbackMs += ms;
    // React within ~400 ms even at very low FPS; a fixed 24-frame window
    // would consume most of a short scene on a struggling phone.
    if (++this.fallbackFrames < 4 || (this.fallbackFrames < 12 && this.fallbackMs < 400)) return;
    const p = this.passes.get(this.active)!;
    const average = this.fallbackMs / this.fallbackFrames;
    if (average > 22) p.scale = Math.max(p.min, Math.floor(p.scale * Math.sqrt(16 / average) * 12) / 12);
    this.fallbackFrames = this.fallbackMs = 0;
  }

  get stats() {
    return { mode: this.mode, gpuTimer: !!this.timer, passes: Object.fromEntries([...this.passes].map(([id, p]) => [id, { scale: p.scale, gpuMs: p.ms, samples: p.samples }])) };
  }
}

/** Fullscreen 3D shader with a reusable lower-resolution HDR target. */
export class DetailPass extends FSPass {
  private detailTarget?: THREE.WebGLRenderTarget;
  private resolve = new FSPass('uniform sampler2D src; void main() { fragColor = texture(src, vUv); }', { src: { value: null } });

  renderDetail(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, quality: PreviewQuality | undefined, id: string) {
    const draw = (scale: number) => {
      if (scale === 1 && !isCompilingFrame(renderer)) { super.render(renderer, target); return; }
      this.detailTarget ??= makeRT(1, 1, { depthBuffer: false, pxScale: 1 });
      this.detailTarget.setSize(Math.max(1, Math.round(target.width * scale)), Math.max(1, Math.round(target.height * scale)));
      // Analytic line AA uses the actual ray footprint when detail is reduced.
      if (this.u.detailScale) this.u.detailScale.value = scale;
      try { super.render(renderer, this.detailTarget); }
      finally { if (this.u.detailScale) this.u.detailScale.value = 1; }
      this.resolve.u.src!.value = this.detailTarget.texture;
      this.resolve.render(renderer, target);
    };
    if (quality) quality.render(id, target.height, 540, 720, draw);
    else draw(1);
  }

  dispose() { this.detailTarget?.dispose(); this.resolve.mat.dispose(); this.mat.dispose(); }
}
