/// <reference types="@webgpu/types" />
import type * as THREE from 'three';
import { AudioData } from '../engine/audio';
import { Lyrics } from '../engine/lyrics';
import { loadFonts } from '../engine/type';
import { Hud, PDoom } from '../engine/hud';
import { DEFAULT_POST } from '../engine/post';
import { PW, PH, W, H, SCALE } from '../engine/gl';
import { makeTimeline } from '../timeline';
import { PaperclipsState } from '../scenes/paperclips-state';
import { TOP_WGSL, MARCH_WGSL, SCENE_FIELDS, SCENE_BYTES } from './paperclips-shaders';
import { DECODE, OVERLAY, BLIT, PREFILTER, DOWN, UP, FINAL, LINES } from './post-shaders';

interface Target { texture: GPUTexture; view: GPUTextureView; width: number; height: number }
interface Pass { pipeline: GPURenderPipeline; buffer: GPUBuffer; bindings: GPUBindGroup; values: Float32Array }

/** Native WGSL experiment: no WebGL renderer/context, GPU-to-GPU bridge, or
 * per-frame readback. Async readback and GPU waits are diagnostics/warmup only. */
export class PaperclipsGPU {
  readonly effects = { grain: false, motionBlur: false };
  readonly errors: string[] = [];
  readonly width = PW;
  readonly height = PH;
  readonly quality = { mode: 'full' as const };
  model!: PaperclipsState;
  audio!: AudioData;
  lyrics!: Lyrics;
  hud!: Hud;
  start = 0;
  end = 0;
  lastTime = 0;
  frames = 0;
  pipelineCount = 0;
  warmupFrames = 0;
  adapterInfo: Record<string, string> = {};
  onFailure: (reason: string) => void = () => {};
  device!: GPUDevice;
  private context!: GPUCanvasContext;
  private scene!: Target;
  private overlayRaw!: Target;
  private overlayLinear!: Target;
  private hudRaw!: Target;
  private hudLinear!: Target;
  private output!: Target;
  private mips: Target[] = [];
  private ups: Target[] = [];
  private targets: Target[] = [];
  private buffers: GPUBuffer[] = [];
  private passes: Pass[] = [];
  private sceneBuffer!: GPUBuffer;
  private sceneValues = new Float32Array(SCENE_BYTES / 4);
  private sceneInts = new Int32Array(this.sceneValues.buffer);
  private topPipeline!: GPURenderPipeline;
  private marchPipeline!: GPURenderPipeline;
  private sceneBinding!: GPUBindGroup;
  private linePipeline!: GPURenderPipeline;
  private lineBuffer!: GPUBuffer;
  private lineBinding!: GPUBindGroup;
  private overlayDecode!: Pass;
  private hudDecode!: Pass;
  private composite!: Pass;
  private prefilter!: Pass;
  private down: Pass[] = [];
  private up: Pass[] = [];
  private final!: Pass;
  private blit!: Pass;
  private hudVersion = -1;
  private disposed = false;
  private postLayout!: GPUBindGroupLayout;
  private postPipelineLayout!: GPUPipelineLayout;
  private sampler!: GPUSampler;
  private queries: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  private queryRead: GPUBuffer | null = null;
  private measuring = false;

  constructor(readonly canvas: HTMLCanvasElement) {}

  async init() {
    if (!isSecureContext || !navigator.gpu) throw new Error('WebGPU requires HTTPS/localhost and a supported browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter available.');
    const timers = adapter.features.has('timestamp-query') && new URLSearchParams(location.search).get('timers') !== '0';
    this.device = await adapter.requestDevice({ requiredFeatures: timers ? ['timestamp-query'] : [] });
    const d = this.device;
    this.adapterInfo = { vendor: adapter.info.vendor, device: adapter.info.device, description: adapter.info.description };
    void d.lost.then(info => { if (!this.disposed) this.fail(`WebGPU device lost: ${info.message || info.reason}`); });
    d.addEventListener('uncapturederror', event => { if (!this.disposed) this.fail(event.error.message); });
    d.pushErrorScope('validation');
    try {
      if (PW > d.limits.maxTextureDimension2D || PH > d.limits.maxTextureDimension2D) throw new Error('Requested resolution exceeds WebGPU texture limits.');
      const context = this.canvas.getContext('webgpu');
      if (!context) throw new Error('WebGPU canvas unavailable.');
      this.context = context;
      this.canvas.width = PW; this.canvas.height = PH;
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device: d, format, colorSpace: 'srgb', alphaMode: 'opaque' });
      [this.audio, this.lyrics] = await Promise.all([AudioData.load(), Lyrics.load(), loadFonts()]) as [AudioData, Lyrics, void];
      const timeline = makeTimeline(this.lyrics, this.audio);
      const entry = timeline.find(e => e.id === 'paperclips')!;
      this.start = entry.start; this.end = entry.end;
      this.model = new PaperclipsState({ audio: this.audio, lyrics: this.lyrics, start: this.start, end: this.end });
      this.model.init();
      this.hud = new Hud(new PDoom(this.lyrics), timeline.filter(e => e.caption).map(e => {
        const start = e.start + (e.caption!.delay ?? .15);
        return { start, end: start + (e.caption!.dur ?? 4.5), fig: e.caption!.fig, text: e.caption!.text };
      }));
      this.scene = this.target(PW, PH);
      this.overlayRaw = this.target(PW, PH, 'rgba8unorm'); this.overlayLinear = this.target(PW, PH);
      this.hudRaw = this.target(PW, PH, 'rgba8unorm'); this.hudLinear = this.target(PW, PH);
      this.output = this.target(PW, PH, 'rgba8unorm');
      for (let i = 0, w = W >> 1, h = H >> 1; i < 7; i++, w >>= 1, h >>= 1) {
        this.mips.push(this.target(Math.max(2, w), Math.max(2, h)));
        this.ups.push(this.target(Math.max(2, w), Math.max(2, h)));
      }
      this.sceneBuffer = this.buffer(SCENE_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const sceneLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      const scenePipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [sceneLayout] });
      this.sceneBinding = d.createBindGroup({ layout: sceneLayout, entries: [{ binding: 0, resource: { buffer: this.sceneBuffer } }] });
      [this.topPipeline, this.marchPipeline] = await Promise.all([
        this.pipeline('Paperclips top', TOP_WGSL, 'rgba16float', scenePipelineLayout),
        this.pipeline('Paperclips lattice', MARCH_WGSL, 'rgba16float', scenePipelineLayout),
      ]);
      this.sampler = d.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      this.postLayout = d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ...[2, 3, 4, 5].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' as const } })),
      ] });
      this.postPipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] });
      const normal: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
      const shaders = [DECODE, OVERLAY, PREFILTER, DOWN, UP, FINAL, BLIT];
      const pipelines = await Promise.all(shaders.map((s, i) => this.pipeline(['decode', 'overlay', 'prefilter', 'down', 'up', 'final', 'present'][i]!, s,
        i === 5 ? 'rgba8unorm' : i === 6 ? format : 'rgba16float', this.postPipelineLayout, i === 1 ? normal : undefined)));
      this.overlayDecode = this.pass(pipelines[0]!, this.overlayRaw);
      this.hudDecode = this.pass(pipelines[0]!, this.hudRaw);
      this.composite = this.pass(pipelines[1]!, this.overlayLinear);
      this.prefilter = this.pass(pipelines[2]!, this.scene);
      for (let i = 1; i < 7; i++) this.down.push(this.pass(pipelines[3]!, this.mips[i - 1]!));
      for (let i = 0; i < 6; i++) this.up.push(this.pass(pipelines[4]!, i === 5 ? this.mips[6]! : this.ups[i + 1]!, this.mips[i]!));
      this.final = this.pass(pipelines[5]!, this.scene, this.ups[0], this.hudLinear, this.ups[3]);
      this.blit = this.pass(pipelines[6]!, this.output);
      const lineUniform = this.buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      d.queue.writeBuffer(lineUniform, 0, new Float32Array([W, H, SCALE, 0]));
      const lineLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
      this.lineBinding = d.createBindGroup({ layout: lineLayout, entries: [{ binding: 0, resource: { buffer: lineUniform } }] });
      this.lineBuffer = this.buffer(this.model.sparks.data.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
      this.linePipeline = await this.pipeline('spark capsules', LINES, 'rgba16float', d.createPipelineLayout({ bindGroupLayouts: [lineLayout] }),
        { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } }, [
          { arrayStride: 48, stepMode: 'instance', attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32' }, { shaderLocation: 3, offset: 32, format: 'float32x4' },
          ] },
        ]);
      const error = await d.popErrorScope();
      if (error) throw new Error(error.message);
    } catch (error) {
      // Pop even when asynchronous shader compilation rejects, so a later
      // failure isn't silently captured by a stale initialization scope.
      try { await d.popErrorScope(); } catch { /* already popped */ }
      this.dispose(); throw error;
    }
  }

  private fail(reason: string) { this.errors.push(reason); this.onFailure(reason); }
  private buffer(size: number, usage: GPUBufferUsageFlags) {
    const b = this.device.createBuffer({ size, usage }); this.buffers.push(b); return b;
  }
  private target(width: number, height: number, format: GPUTextureFormat = 'rgba16float') {
    const texture = this.device.createTexture({ size: [width, height], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    const t = { texture, view: texture.createView(), width, height }; this.targets.push(t); return t;
  }
  private async pipeline(label: string, code: string, format: GPUTextureFormat, layout: GPUPipelineLayout, blend?: GPUBlendState, buffers?: GPUVertexBufferLayout[]) {
    const module = this.device.createShaderModule({ label, code });
    const p = await this.device.createRenderPipelineAsync({ label, layout, vertex: { module, entryPoint: 'vertex', buffers },
      fragment: { module, entryPoint: 'fragment', targets: [{ format, blend }] }, primitive: { topology: 'triangle-list' } });
    this.pipelineCount++; return p;
  }
  private pass(pipeline: GPURenderPipeline, src: Target, prev = src, hud = src, halo = src): Pass {
    const buffer = this.buffer(128, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const bindings = this.device.createBindGroup({ layout: this.postLayout, entries: [
      { binding: 0, resource: { buffer } }, { binding: 1, resource: this.sampler },
      ...[src, prev, hud, halo].map((t, i) => ({ binding: i + 2, resource: t.view })),
    ] });
    const p = { pipeline, buffer, bindings, values: new Float32Array(32) }; this.passes.push(p); return p;
  }
  private draw(encoder: GPUCommandEncoder, p: Pass, target: Target | GPUTextureView, loadOp: GPULoadOp = 'clear', timestamp?: GPURenderPassTimestampWrites) {
    const view = 'view' in target ? target.view : target;
    const pass = encoder.beginRenderPass({ label: p.pipeline.label, colorAttachments: [{ view, loadOp, storeOp: 'store', clearValue: [0, 0, 0, 0] }], timestampWrites: timestamp });
    pass.setPipeline(p.pipeline); pass.setBindGroup(0, p.bindings); pass.draw(3); pass.end();
  }
  private upload(canvas: HTMLCanvasElement, target: Target) {
    this.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: target.texture, colorSpace: 'srgb', premultipliedAlpha: false }, [PW, PH]);
  }

  render(t: number) {
    if (this.disposed) throw new Error('WebGPU renderer is disposed.');
    if (!Number.isFinite(t) || t < this.start || t >= this.end) throw new RangeError('Time is outside the Paperclips experiment.');
    this.lastTime = t;
    const overrides = this.model.prepare({ t, a: this.audio.sample(t) });
    const post = { ...DEFAULT_POST, ...overrides };
    if (!this.effects.grain) post.grain = 0;
    const uniforms: Record<string, THREE.IUniform> = (t < this.model.T.tilt0 ? this.model.top : this.model.march).u;
    this.sceneValues.fill(0);
    Object.entries(SCENE_FIELDS).forEach(([name, type], i) => {
      const value = uniforms[name]?.value;
      if (value === undefined) return;
      if (type === 'i32') this.sceneInts[i * 4] = value;
      else if (typeof value === 'number') this.sceneValues[i * 4] = value;
      else this.sceneValues.set(value.toArray(), i * 4);
    });
    const items = this.model.top.u.items.value, offset = Object.keys(SCENE_FIELDS).length * 4;
    if (t < this.model.T.tilt0) items.forEach((v, i) => this.sceneValues.set(v.toArray(), offset + i * 4));
    const d = this.device;
    d.queue.writeBuffer(this.sceneBuffer, 0, this.sceneValues);
    this.upload(this.model.layer.canvas, this.overlayRaw);
    const hudTexture = this.hud.draw(t, { opacity: post.hud, frame: post.frame, readout: post.pdoom, paper: post.paper });
    const hudChanged = hudTexture.version !== this.hudVersion;
    if (hudChanged) { this.upload(this.hud.layer.canvas, this.hudRaw); this.hudVersion = hudTexture.version; }
    this.prefilter.values.set([1 / W, 1 / H, post.bloomThreshold, post.bloomKnee]);
    d.queue.writeBuffer(this.prefilter.buffer, 0, this.prefilter.values);
    for (let i = 0; i < 6; i++) {
      const s = this.mips[i]!; this.down[i]!.values.set([1 / s.width, 1 / s.height]);
      d.queue.writeBuffer(this.down[i]!.buffer, 0, this.down[i]!.values);
      const small = i === 5 ? this.mips[6]! : this.ups[i + 1]!;
      this.up[i]!.values.set([1 / small.width, 1 / small.height, .5 + post.bloomRadius]);
      d.queue.writeBuffer(this.up[i]!.buffer, 0, this.up[i]!.values);
    }
    this.final.values.set([W, H, t, post.zoom, ...post.shake, post.exposure, post.bloom / 3,
      post.halation, post.ca, post.grain, post.vignette, post.hud, post.fade, post.flash, post.invert]);
    d.queue.writeBuffer(this.final.buffer, 0, this.final.values);
    const { count, data } = this.model.sparks;
    if (count) d.queue.writeBuffer(this.lineBuffer, 0, data.buffer, 0, count * 48);
    const encoder = d.createCommandEncoder({ label: 'Paperclips frame' });
    const scenePass = encoder.beginRenderPass({ label: 'scene', colorAttachments: [{ view: this.scene.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: this.measuring ? { querySet: this.queries!, beginningOfPassWriteIndex: 0 } : undefined });
    scenePass.setPipeline(t < this.model.T.tilt0 ? this.topPipeline : this.marchPipeline);
    scenePass.setBindGroup(0, this.sceneBinding); scenePass.draw(3);
    if (count) { scenePass.setPipeline(this.linePipeline); scenePass.setBindGroup(0, this.lineBinding); scenePass.setVertexBuffer(0, this.lineBuffer); scenePass.draw(6, count); }
    scenePass.end();
    this.draw(encoder, this.overlayDecode, this.overlayLinear);
    if (hudChanged) this.draw(encoder, this.hudDecode, this.hudLinear);
    this.draw(encoder, this.composite, this.scene, 'load');
    this.draw(encoder, this.prefilter, this.mips[0]!);
    for (let i = 0; i < 6; i++) this.draw(encoder, this.down[i]!, this.mips[i + 1]!);
    for (let i = 5; i >= 0; i--) this.draw(encoder, this.up[i]!, this.ups[i]!);
    this.draw(encoder, this.final, this.output);
    this.draw(encoder, this.blit, this.context.getCurrentTexture().createView(), 'clear',
      this.measuring ? { querySet: this.queries!, endOfPassWriteIndex: 1 } : undefined);
    if (this.measuring) {
      encoder.resolveQuerySet(this.queries!, 0, 2, this.queryResolve!, 0);
      encoder.copyBufferToBuffer(this.queryResolve!, 0, this.queryRead!, 0, 16);
    }
    d.queue.submit([encoder.finish()]); this.frames++;
  }

  async warmup(progress: (done: number, total: number) => void = () => {}) {
    const times = this.model.warmupTimes().filter(t => t >= this.start && t < this.end);
    for (const [i, t] of times.entries()) {
      this.render(t); await this.settled(); this.warmupFrames++; progress(i + 1, times.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  async settled() { await this.device.queue.onSubmittedWorkDone(); }
  get gpuTimer() { return this.device.features.has('timestamp-query'); }
  /** Serialized diagnostic measurements. Never called by the player. */
  async measureGPU(t: number) {
    if (!this.gpuTimer) throw new Error('timestamp-query unavailable; GPU timing cannot be compared.');
    if (this.measuring) throw new Error('GPU measurements must run sequentially.');
    if (!this.queries) {
      this.queries = this.device.createQuerySet({ type: 'timestamp', count: 2 });
      this.queryResolve = this.buffer(16, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
      this.queryRead = this.buffer(16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    }
    this.measuring = true;
    try {
      this.render(t); await this.queryRead!.mapAsync(GPUMapMode.READ);
      const q = new BigUint64Array(this.queryRead!.getMappedRange());
      return Number(q[1]! - q[0]!) / 1e6;
    } finally { if (this.queryRead?.mapState === 'mapped') this.queryRead.unmap(); this.measuring = false; }
  }
  /** Diagnostic output is top-down RGBA8, independent of swapchain lifetime. */
  async readPixelsAsync() {
    const bytesPerRow = Math.ceil(PW * 4 / 256) * 256;
    const buffer = this.device.createBuffer({ size: bytesPerRow * PH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: this.output.texture }, { buffer, bytesPerRow }, [PW, PH]);
      this.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(buffer.getMappedRange()), output = new Uint8Array(PW * PH * 4);
      for (let y = 0; y < PH; y++) output.set(source.subarray(y * bytesPerRow, y * bytesPerRow + PW * 4), y * PW * 4);
      return output;
    } finally { buffer.destroy(); }
  }
  async png() {
    const pixels = await this.readPixelsAsync(), canvas = new OffscreenCanvas(PW, PH);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), PW, PH), 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s);
  }
  diagnostics() { return { frames: this.frames, pipelines: this.pipelineCount, textures: this.targets.length, buffers: this.buffers.length,
    warmupFrames: this.warmupFrames, gpuTimer: this.gpuTimer, adapter: this.adapterInfo, errors: [...this.errors] }; }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.queries?.destroy(); this.targets.forEach(t => t.texture.destroy()); this.buffers.forEach(b => b.destroy());
    this.model?.layer.texture.dispose(); this.hud?.layer.texture.dispose(); this.context?.unconfigure(); this.device?.destroy();
  }
}
