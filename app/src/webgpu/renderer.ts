/// <reference types="@webgpu/types" />
// The native WebGPU renderer for the Paperclips plate (docs/WEBGPU.md): the plate's animation, lyrics and
// sparks come from `PaperclipsState`, shared with the WebGL scene; everything drawn here is WGSL.
import type * as THREE from 'three';
import { AudioData } from '../engine/audio';
import { Lyrics } from '../engine/lyrics';
import { loadFonts } from '../engine/type';
import { Hud, PDoom } from '../engine/hud';
import { DEFAULT_POST } from '../engine/post';
import type { HdrGrade } from '../engine/hdr-color';
import { PW, PH, W, H, SCALE } from '../engine/gl';
import { makeTimeline } from '../timeline';
import { PaperclipsState } from '../scenes/paperclips-state';
import { Gpu, halfToFloat, type Target } from './gpu';
import { topShader, marchShader, sceneBlock, type MapVariant } from './paperclips-shaders';
import { OVERLAY, PREFILTER, DOWN, UP, GRADE, LINES, frameBlock } from './post-shaders';

const MIPS = 7;
const HALF = 'rgba16float';
interface Pass { pipeline: GPURenderPipeline; bindings: GPUBindGroup }
interface Pipelines { top: GPURenderPipeline; march: GPURenderPipeline; lines: GPURenderPipeline; overlay: GPURenderPipeline;
  prefilter: GPURenderPipeline; down: GPURenderPipeline; up: GPURenderPipeline; grade: GPURenderPipeline }

export interface GpuOptions {
  /** How the lattice's map is written (see MAP_VARIANTS). */
  map?: MapVariant;
  /** Present on an extended-range Display-P3 canvas with this grade instead of SDR. */
  hdr?: HdrGrade | null;
  /** Ask for timestamp queries (diagnostics only). */
  timers?: boolean;
}

/**
 * One frame is one command buffer: the plate, its sparks and its Canvas2D layer in a single pass, the bloom
 * pyramid, and the grade straight into the canvas. Playback never waits on the GPU or reads anything back;
 * `settled`, `burstGPU` and the readbacks are for the checks and benchmarks.
 */
export class PaperclipsGPU {
  readonly effects = { grain: false, motionBlur: false };
  readonly errors: string[] = [];
  readonly width = PW;
  readonly height = PH;
  readonly quality = { mode: 'full' as const };
  readonly map: MapVariant;
  /** The HDR grade, read every frame; null on an SDR canvas. */
  hdrGrade: HdrGrade | null;
  /** Milliseconds spent creating pipelines, and drawing the warm-up frames after it. */
  readonly timing = { compileMs: 0, warmupMs: 0 };
  model!: PaperclipsState;
  audio!: AudioData;
  lyrics!: Lyrics;
  hud!: Hud;
  start = 0;
  end = 0;
  lastTime = 0;
  frames = 0;
  warmupFrames = 0;
  onFailure: (reason: string) => void = () => {};
  private gpu!: Gpu;
  private context!: GPUCanvasContext;
  private canvasFormat: GPUTextureFormat = 'bgra8unorm';
  private timers: boolean;
  private disposed = false;
  private pipelines!: Pipelines;
  private sceneLayout!: GPUBindGroupLayout;
  private postLayout!: GPUPipelineLayout;
  private postBindings!: GPUBindGroupLayout;
  private lineLayout!: GPUBindGroupLayout;
  private scene!: Target;
  private overlayTexture!: Target;
  private hudTexture!: Target;
  private hudVersion = -1;
  private mips: Target[] = [];
  private ups: Target[] = [];
  private sceneUniforms = sceneBlock();
  private frameUniforms = frameBlock();
  private sceneBuffer!: GPUBuffer;
  private frameBuffer!: GPUBuffer;
  private sceneBinding!: GPUBindGroup;
  private lineBuffer!: GPUBuffer;
  private lineBinding!: GPUBindGroup;
  private overlay!: Pass;
  private prefilter!: Pass;
  private down: Pass[] = [];
  private up: Pass[] = [];
  private grade!: Pass;
  private offscreen = new Map<GPUTextureFormat, { pipeline: GPURenderPipeline; target: Target }>();
  private queries: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  private queryRead: GPUBuffer | null = null;
  private stamp: { begin: boolean; end: boolean } | null = null;

  constructor(readonly canvas: HTMLCanvasElement, options: GpuOptions = {}) {
    this.map = options.map ?? 'loop';
    this.hdrGrade = options.hdr ?? null;
    this.timers = options.timers ?? true;
  }

  get device() { return this.gpu.device; }
  get gpuTimer() { return this.gpu.device.features.has('timestamp-query'); }

  async init() {
    this.gpu = await Gpu.create(this.timers);
    const d = this.gpu.device;
    void d.lost.then((info) => { if (!this.disposed) this.fail(`WebGPU device lost: ${info.message || info.reason}`); });
    d.addEventListener('uncapturederror', (event) => { if (!this.disposed) this.fail(event.error.message); });
    d.pushErrorScope('validation');
    try {
      if (PW > d.limits.maxTextureDimension2D || PH > d.limits.maxTextureDimension2D) throw new Error('Requested resolution exceeds WebGPU texture limits.');
      this.configureCanvas();
      // Pipelines compile off the main thread while the data and fonts load.
      const compiled = this.compile();
      compiled.catch(() => {}); // reported by the await below; a failed load must not leave it unhandled
      [this.audio, this.lyrics] = await Promise.all([AudioData.load(), Lyrics.load(), loadFonts()]) as [AudioData, Lyrics, void];
      const timeline = makeTimeline(this.lyrics, this.audio);
      const entry = timeline.find((e) => e.id === 'paperclips')!;
      this.start = entry.start; this.end = entry.end;
      this.model = new PaperclipsState({ audio: this.audio, lyrics: this.lyrics, start: this.start, end: this.end });
      this.model.init();
      this.hud = new Hud(new PDoom(this.lyrics), timeline.filter((e) => e.caption).map((e) => {
        const start = e.start + (e.caption!.delay ?? 0.3);
        return { start, end: start + (e.caption!.dur ?? 4.5), fig: e.caption!.fig, text: e.caption!.text };
      }));
      this.pipelines = await compiled;
      this.build();
      const error = await d.popErrorScope();
      if (error) throw new Error(error.message);
    } catch (error) {
      // Pop even when asynchronous shader compilation rejects, so a later
      // failure isn't silently captured by a stale initialization scope.
      try { await d.popErrorScope(); } catch { /* already popped */ }
      this.dispose();
      throw error;
    }
  }

  private fail(reason: string) { this.errors.push(reason); this.onFailure(reason); }

  private configureCanvas() {
    const context = this.canvas.getContext('webgpu');
    if (!context) throw new Error('WebGPU canvas unavailable.');
    this.context = context;
    this.canvas.width = PW; this.canvas.height = PH;
    const device = this.gpu.device;
    if (!this.hdrGrade) {
      this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format: this.canvasFormat, colorSpace: 'srgb', alphaMode: 'opaque' });
      return;
    }
    // The grade writes extended-sRGB-encoded Display-P3, which is what such a canvas shows: no bridge, no copy.
    this.canvasFormat = HALF;
    context.configure({ device, format: HALF, colorSpace: 'display-p3', alphaMode: 'opaque', toneMapping: { mode: 'extended' } });
    const accepted = context.getConfiguration?.();
    if (accepted?.toneMapping?.mode !== 'extended' || accepted.colorSpace !== 'display-p3') throw new Error('Extended-range canvas output was not accepted.');
  }

  private async compile(): Promise<Pipelines> {
    const { gpu } = this, d = gpu.device, started = performance.now();
    const uniform = (binding: number, visibility = GPUShaderStage.FRAGMENT): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type: 'uniform' } });
    this.sceneLayout = d.createBindGroupLayout({ entries: [uniform(0)] });
    this.postBindings = d.createBindGroupLayout({ entries: [
      uniform(0), uniform(1), { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ...[3, 4, 5, 6].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' as const } })),
    ] });
    this.lineLayout = d.createBindGroupLayout({ entries: [uniform(0, GPUShaderStage.VERTEX)] });
    this.postLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postBindings] });
    const scene = d.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] });
    const over: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one' };
    const [top, march, lines, overlay, prefilter, down, up, grade] = await Promise.all([
      gpu.pipeline('paperclips top', topShader(), HALF, scene),
      gpu.pipeline(`paperclips lattice (${this.map})`, marchShader(this.map), HALF, scene),
      gpu.pipeline('spark capsules', LINES, HALF, d.createPipelineLayout({ bindGroupLayouts: [this.lineLayout] }), { color: add, alpha: add }, [
        { arrayStride: 48, stepMode: 'instance', attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' },
          { shaderLocation: 2, offset: 16, format: 'float32' }, { shaderLocation: 3, offset: 32, format: 'float32x4' },
        ] },
      ]),
      gpu.pipeline('layer', OVERLAY, HALF, this.postLayout, { color: over, alpha: over }),
      gpu.pipeline('bloom prefilter', PREFILTER, HALF, this.postLayout),
      gpu.pipeline('bloom down', DOWN, HALF, this.postLayout),
      gpu.pipeline('bloom up', UP, HALF, this.postLayout),
      gpu.pipeline('grade', GRADE, this.canvasFormat, this.postLayout),
    ]);
    this.timing.compileMs = performance.now() - started;
    return { top, march, lines, overlay, prefilter, down, up, grade };
  }

  /** Targets, buffers and bind groups: all made once, none per frame. */
  private build() {
    const { gpu } = this, d = gpu.device, p = this.pipelines;
    const sampler = d.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.scene = gpu.target(PW, PH);
    this.overlayTexture = gpu.canvasTexture(PW, PH);
    this.hudTexture = gpu.canvasTexture(PW, PH);
    // the bloom pyramid stays at the logical resolution at every output scale (same radii, same look)
    for (let i = 0, w = W >> 1, h = H >> 1; i < MIPS; i++, w >>= 1, h >>= 1) {
      this.mips.push(gpu.target(Math.max(2, w), Math.max(2, h)));
      if (i < MIPS - 1) this.ups.push(gpu.target(Math.max(2, w), Math.max(2, h)));
    }
    // Full detail, as the export marches (the WebGL preview trims these in Auto and Performance)
    this.sceneUniforms.set('marchSteps', 128);
    this.sceneUniforms.set('deepLayers', 4.5);
    this.sceneBuffer = gpu.uniform(this.sceneUniforms.data);
    this.frameBuffer = gpu.uniform(this.frameUniforms.data);
    this.sceneBinding = d.createBindGroup({ layout: this.sceneLayout, entries: [{ binding: 0, resource: { buffer: this.sceneBuffer } }] });
    this.lineBinding = d.createBindGroup({ layout: this.lineLayout, entries: [{ binding: 0, resource: { buffer: gpu.uniform(new Float32Array([W, H, SCALE, 0])) } }] });
    this.lineBuffer = gpu.buffer(this.model.sparks.data.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    // `texel` is what a pass's taps step by: by default a texel of the texture it filters
    const pass = (pipeline: GPURenderPipeline, src: Target, prev = src, hud = src, halo = src, texel = [1 / src.width, 1 / src.height]): Pass => ({ pipeline, bindings: d.createBindGroup({ layout: this.postBindings, entries: [
      { binding: 0, resource: { buffer: gpu.uniform(new Float32Array([texel[0]!, texel[1]!, 0, 0])) } },
      { binding: 1, resource: { buffer: this.frameBuffer } }, { binding: 2, resource: sampler },
      ...[src, prev, hud, halo].map((t, i) => ({ binding: i + 3, resource: t.view })),
    ] }) });
    this.overlay = pass(p.overlay, this.overlayTexture);
    // the prefilter's taps are in logical px of the scene, whatever its physical size
    this.prefilter = pass(p.prefilter, this.scene, undefined, undefined, undefined, [1 / W, 1 / H]);
    for (let i = 1; i < MIPS; i++) this.down.push(pass(p.down, this.mips[i - 1]!));
    // ups[i] = mips[i] + up(the level below: mips[6] at the bottom, ups[i + 1] above it)
    for (let i = 0; i < MIPS - 1; i++) this.up.push(pass(p.up, i === MIPS - 2 ? this.mips[MIPS - 1]! : this.ups[i + 1]!, this.mips[i]!));
    this.grade = pass(p.grade, this.scene, this.ups[0], this.hudTexture, this.ups[3]);
  }

  private draw(encoder: GPUCommandEncoder, p: Pass, view: GPUTextureView, timestampWrites?: GPURenderPassTimestampWrites) {
    const pass = encoder.beginRenderPass({ label: p.pipeline.label, colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }], timestampWrites });
    pass.setPipeline(p.pipeline); pass.setBindGroup(0, p.bindings); pass.draw(3); pass.end();
  }

  render(t: number) {
    if (this.disposed) throw new Error('WebGPU renderer is disposed.');
    if (!Number.isFinite(t) || t < this.start || t >= this.end) throw new RangeError('Time is outside the Paperclips plate.');
    this.lastTime = t;
    const { gpu, model } = this, d = gpu.device;
    const post = { ...DEFAULT_POST, ...model.prepare({ t, a: this.audio.sample(t) }) };
    if (!this.effects.grain) post.grain = 0;

    // the plate's uniforms, straight from the state the WebGL scene reads
    const top = t < model.T.tilt0, s = this.sceneUniforms;
    const uniforms: Record<string, THREE.IUniform> = (top ? model.top : model.march).u;
    for (const name of s.fields) {
      const value = uniforms[name]?.value;
      if (value !== undefined) s.set(name, typeof value === 'number' ? value : value.toArray());
    }
    if (top) model.top.u.items.value.forEach((item, i) => s.setItem(i, item.toArray()));
    d.queue.writeBuffer(this.sceneBuffer, 0, s.data);

    gpu.upload(model.layer.canvas, this.overlayTexture);
    const hud = this.hud.draw(t, { opacity: post.hud, frame: post.frame, readout: post.pdoom, paper: post.paper });
    if (hud.version !== this.hudVersion) { gpu.upload(this.hud.layer.canvas, this.hudTexture); this.hudVersion = hud.version; }

    const hdr = this.hdrGrade, f = this.frameUniforms;
    // the glow stands in for brightness SDR cannot show: less of it as the headroom grows
    const glow = hdr ? 1 - hdr.glow * (1 - 1 / Math.max(1, hdr.headroom)) : 1;
    f.set('res', [W, H]); f.set('shake', post.shake); f.set('time', t); f.set('zoom', post.zoom);
    f.set('exposure', post.exposure); f.set('bloom', post.bloom / 3 * glow); f.set('halation', post.halation * glow); f.set('ca', post.ca);
    f.set('grain', post.grain); f.set('vignette', post.vignette); f.set('hud', post.hud); f.set('fade', post.fade);
    f.set('flash', post.flash); f.set('invert', post.invert);
    f.set('threshold', post.bloomThreshold); f.set('knee', post.bloomKnee); f.set('radius', 0.5 + post.bloomRadius);
    f.set('hdrHeadroom', hdr ? Math.max(1, hdr.headroom) : 0); f.set('hdrGamut', hdr?.gamut ?? 0); f.set('hdrHue', hdr?.hue ?? 0);
    d.queue.writeBuffer(this.frameBuffer, 0, f.data);

    const { count, data } = model.sparks;
    if (count) d.queue.writeBuffer(this.lineBuffer, 0, data.buffer, 0, count * 48);

    const encoder = d.createCommandEncoder({ label: 'Paperclips frame' });
    const stamp = this.stamp, p = this.pipelines;
    // the plate, its sparks over it (additive), the Canvas2D layer over both
    const scene = encoder.beginRenderPass({ label: 'scene', colorAttachments: [{ view: this.scene.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: stamp?.begin ? { querySet: this.queries!, beginningOfPassWriteIndex: 0 } : undefined });
    scene.setPipeline(top ? p.top : p.march); scene.setBindGroup(0, this.sceneBinding); scene.draw(3);
    if (count) { scene.setPipeline(p.lines); scene.setBindGroup(0, this.lineBinding); scene.setVertexBuffer(0, this.lineBuffer); scene.draw(6, count); }
    scene.setPipeline(this.overlay.pipeline); scene.setBindGroup(0, this.overlay.bindings); scene.draw(3);
    scene.end();
    this.draw(encoder, this.prefilter, this.mips[0]!.view);
    for (let i = 0; i < MIPS - 1; i++) this.draw(encoder, this.down[i]!, this.mips[i + 1]!.view);
    for (let i = MIPS - 2; i >= 0; i--) this.draw(encoder, this.up[i]!, this.ups[i]!.view);
    this.draw(encoder, this.grade, this.context.getCurrentTexture().createView(), stamp?.end ? { querySet: this.queries!, endOfPassWriteIndex: 1 } : undefined);
    d.queue.submit([encoder.finish()]);
    this.frames++;
  }

  async warmup(progress: (done: number, total: number) => void = () => {}) {
    const times = this.model.warmupTimes().filter((t) => t >= this.start && t < this.end), started = performance.now();
    for (const [i, t] of times.entries()) {
      this.render(t); await this.settled(); this.warmupFrames++; progress(i + 1, times.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.timing.warmupMs = performance.now() - started;
  }

  // ------------------------------------------------------------------ diagnostics (never called by the player)

  async settled() { await this.device.queue.onSubmittedWorkDone(); }

  /**
   * GPU milliseconds per frame over `frames` back-to-back frames at t: one timestamp where the first
   * frame's first pass begins, one where the last frame's last pass ends. Timing frames one at a time
   * with a wait in between lets the GPU clock down (see "Measuring" in docs/ENGINE.md).
   */
  async burstGPU(t: number, frames: number) {
    if (!this.gpuTimer) throw new Error('timestamp-query unavailable; GPU timing cannot be compared.');
    if (this.stamp) throw new Error('GPU measurements must run sequentially.');
    const d = this.device;
    if (!this.queries) {
      this.queries = d.createQuerySet({ type: 'timestamp', count: 2 });
      this.queryResolve = this.gpu.buffer(16, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
      this.queryRead = this.gpu.buffer(16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    }
    try {
      for (let i = 0; i < frames; i++) { this.stamp = { begin: i === 0, end: i === frames - 1 }; this.render(t); }
      const encoder = d.createCommandEncoder();
      encoder.resolveQuerySet(this.queries, 0, 2, this.queryResolve!, 0);
      encoder.copyBufferToBuffer(this.queryResolve!, 0, this.queryRead!, 0, 16);
      d.queue.submit([encoder.finish()]);
      await this.queryRead!.mapAsync(GPUMapMode.READ);
      const q = new BigUint64Array(this.queryRead!.getMappedRange());
      return Number(q[1]! - q[0]!) / 1e6 / frames;
    } finally {
      if (this.queryRead?.mapState === 'mapped') this.queryRead.unmap();
      this.stamp = null;
    }
  }

  /** The last frame graded again into an offscreen target of `format`, read back as top-down rows. */
  private async readback(format: 'rgba8unorm' | 'rgba16float') {
    const d = this.device, bytes = format === 'rgba8unorm' ? 4 : 8;
    let off = this.offscreen.get(format);
    if (!off) {
      off = { pipeline: await this.gpu.pipeline(`grade (${format} readback)`, GRADE, format, this.postLayout),
        target: this.gpu.target(PW, PH, format, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC) };
      this.offscreen.set(format, off);
    }
    const bytesPerRow = Math.ceil(PW * bytes / 256) * 256;
    const buffer = d.createBuffer({ size: bytesPerRow * PH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = d.createCommandEncoder();
      this.draw(encoder, { pipeline: off.pipeline, bindings: this.grade.bindings }, off.target.view);
      encoder.copyTextureToBuffer({ texture: off.target.texture }, { buffer, bytesPerRow }, [PW, PH]);
      d.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(buffer.getMappedRange()), out = new Uint8Array(PW * PH * bytes);
      for (let y = 0; y < PH; y++) out.set(source.subarray(y * bytesPerRow, y * bytesPerRow + PW * bytes), y * PW * bytes);
      return out;
    } finally { buffer.destroy(); }
  }

  /** RGBA8 pixels of the last rendered frame, top-down rows. */
  readPixelsAsync() { return this.readback('rgba8unorm'); }

  async png() {
    const pixels = await this.readPixelsAsync(), canvas = new OffscreenCanvas(PW, PH);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), PW, PH), 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** The last frame as the canvas receives it, unclipped: RGBA at each of `points` (px from the top left) and the brightest channel anywhere. */
  async floatPixels(points: [number, number][]) {
    const half = new Uint16Array((await this.readback(HALF)).buffer);
    let max = 0;
    for (let i = 0; i < half.length; i += 4) for (let c = 0; c < 3; c++) max = Math.max(max, halfToFloat(half[i + c]!));
    return { max, samples: points.map(([x, y]) => Array.from(half.subarray((y * PW + x) * 4, (y * PW + x) * 4 + 4), halfToFloat)) };
  }

  diagnostics() {
    return { frames: this.frames, pipelines: this.gpu.pipelines, textures: this.gpu.targets.length, buffers: this.gpu.buffers.length,
      warmupFrames: this.warmupFrames, gpuTimer: this.gpuTimer, adapter: this.gpu.info, map: this.map, hdr: !!this.hdrGrade,
      canvasFormat: this.canvasFormat, timing: { ...this.timing }, errors: [...this.errors] };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queries?.destroy();
    this.model?.layer.texture.dispose(); this.hud?.layer.texture.dispose();
    this.context?.unconfigure();
    this.gpu?.destroy();
  }
}
