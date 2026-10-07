/// <reference types="@webgpu/types" />
// WebGPU plumbing for the native renderer: the device, render targets, uniform blocks, shader
// pipelines and Canvas2D uploads. Nothing here knows about a scene.

export interface Target { texture: GPUTexture; view: GPUTextureView; width: number; height: number }

export type FieldType = 'f32' | 'i32' | 'vec2f' | 'vec3f' | 'vec4f';
const LAYOUT: Record<FieldType, { align: number; size: number }> = {
  f32: { align: 4, size: 4 }, i32: { align: 4, size: 4 }, vec2f: { align: 8, size: 8 }, vec3f: { align: 16, size: 12 }, vec4f: { align: 16, size: 16 },
};

/**
 * A uniform struct described once: `wgsl` declares it and `set` writes a field at the offset WGSL
 * gives it, so the two cannot drift apart. `array` appends a trailing `array<vec4f, count>`.
 */
export class UniformBlock<K extends string> {
  readonly wgsl: string;
  readonly data: ArrayBuffer;
  readonly fields: K[];
  private f32: Float32Array;
  private i32: Int32Array;
  private at = new Map<string, { index: number; type: FieldType }>();
  private arrayIndex = 0;

  constructor(struct: string, fields: Record<K, FieldType>, array?: { name: string; count: number }) {
    this.fields = Object.keys(fields) as K[];
    let offset = 0;
    const up =(x: number, align: number) => Math.ceil(x / align) * align;
    for (const [name, type] of Object.entries(fields) as [K, FieldType][]) {
      offset = up(offset, LAYOUT[type].align);
      this.at.set(name, { index: offset / 4, type });
      offset += LAYOUT[type].size;
    }
    if (array) { offset = up(offset, 16); this.arrayIndex = offset / 4; offset += array.count * 16; }
    this.data = new ArrayBuffer(up(offset, 16));
    this.f32 = new Float32Array(this.data);
    this.i32 = new Int32Array(this.data);
    this.wgsl = `struct ${struct} {\n${Object.entries(fields).map(([name, type]) => `  ${name}: ${type},`).join('\n')}\n${array ? `  ${array.name}: array<vec4f, ${array.count}>,\n` : ''}}`;
  }

  set(name: K, value: number | ArrayLike<number>) {
    const { index, type } = this.at.get(name)!;
    if (typeof value !== 'number') this.f32.set(value, index);
    else if (type === 'i32') this.i32[index] = value;
    else this.f32[index] = value;
  }
  setItem(i: number, value: ArrayLike<number>) { this.f32.set(value, this.arrayIndex + i * 4); }
}

/** The device and what was made on it. Counts are kept so a check can tell that nothing grows while playing. */
export class Gpu {
  readonly targets: Target[] = [];
  readonly buffers: GPUBuffer[] = [];
  pipelines = 0;
  readonly info: Record<string, string>;
  private constructor(readonly device: GPUDevice, adapter: GPUAdapter) {
    this.info = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description };
  }

  static async create(timers: boolean) {
    if (!isSecureContext || !navigator.gpu) throw new Error('WebGPU requires HTTPS/localhost and a supported browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter available.');
    const device = await adapter.requestDevice({ requiredFeatures: timers && adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
    return new Gpu(device, adapter);
  }

  target(width: number, height: number, format: GPUTextureFormat = 'rgba16float', usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING) {
    const texture = this.device.createTexture({ size: [width, height], format, usage });
    const t = { texture, view: texture.createView(), width, height };
    this.targets.push(t);
    return t;
  }

  buffer(size: number, usage: GPUBufferUsageFlags) {
    const b = this.device.createBuffer({ size, usage });
    this.buffers.push(b);
    return b;
  }

  /** A uniform buffer holding `data` (rewrite it with `queue.writeBuffer` when it changes). */
  uniform(data: ArrayBuffer | Float32Array) {
    const b = this.buffer(data.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(b, 0, data);
    return b;
  }

  /**
   * A Canvas2D layer as a texture. The canvas holds sRGB bytes and the format is sRGB, so sampling
   * returns linear light with no decode pass; alpha stays straight, as the WebGL renderer keeps it.
   */
  canvasTexture(width: number, height: number) {
    return this.target(width, height, 'rgba8unorm-srgb', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
  }
  upload(canvas: HTMLCanvasElement, into: Target) {
    this.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: into.texture, colorSpace: 'srgb', premultipliedAlpha: false }, [into.width, into.height]);
  }

  /** Compiles off the main thread; a shader error rejects with the compiler's messages. */
  async pipeline(label: string, code: string, format: GPUTextureFormat, layout: GPUPipelineLayout, blend?: GPUBlendState, buffers?: GPUVertexBufferLayout[]) {
    const module = this.device.createShaderModule({ label, code });
    try {
      const p = await this.device.createRenderPipelineAsync({
        label, layout, vertex: { module, entryPoint: 'vertex', buffers },
        fragment: { module, entryPoint: 'fragment', targets: [{ format, blend }] }, primitive: { topology: 'triangle-list' },
      });
      this.pipelines++;
      return p;
    } catch (error) {
      const messages = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
      throw new Error(`${label}: ${messages.length ? messages.join('; ') : String(error)}`);
    }
  }

  destroy() {
    this.targets.forEach((t) => t.texture.destroy());
    this.buffers.forEach((b) => b.destroy());
    this.device.destroy();
  }
}

/** Half-float bits to a number (diagnostic readback of float targets). */
export function halfToFloat(bits: number) {
  const exponent = (bits >> 10) & 31, mantissa = bits & 1023;
  return (bits & 32768 ? -1 : 1) * (exponent === 31 ? (mantissa ? NaN : Infinity) : exponent === 0 ? mantissa / 1024 * 2 ** -14 : (1 + mantissa / 1024) * 2 ** (exponent - 15));
}
