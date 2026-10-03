/// <reference types="@webgpu/types" />

/** Experimental presentation only: all scene rendering remains in WebGL.
 * The copy and final draw stay in browser GPU APIs; readback is diagnostic-only. */
type FloatCanvasGL = WebGL2RenderingContext & {
  drawingBufferStorage?: (format: number, width: number, height: number) => void;
};

const SHADER = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
  // Both canvases are tagged sRGB. The WebGL post pass has already encoded
  // extended sRGB; converting gamma again here would change the picture.
  return vec4f(textureLoad(source, vec2i(p.xy), 0).rgb, 1.0);
}`;

export class HdrDisplay {
  readonly canvas = document.createElement('canvas');
  private context!: GPUCanvasContext;
  private texture!: GPUTexture;
  private pipeline!: GPURenderPipeline;
  private binding!: GPUBindGroup;
  private output: GPUTexture | null = null;
  private disposed = false;
  private floatBuffer = false;
  onFailure: (reason: string) => void = () => {};
  lastSubmitMs = 0;
  frames = 0;

  private constructor(private source: HTMLCanvasElement, private gl: FloatCanvasGL, private device: GPUDevice) {}

  static async create(source: HTMLCanvasElement, gl: WebGL2RenderingContext): Promise<HdrDisplay> {
    if (!isSecureContext || !navigator.gpu) throw new Error('WebGPU requires a supported browser and HTTPS or localhost.');
    const floatGL = gl as FloatCanvasGL;
    if (!floatGL.drawingBufferStorage || !gl.getContextAttributes()?.alpha || !gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This browser cannot provide a floating-point WebGL canvas.');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice();
    const display = new HdrDisplay(source, floatGL, device);
    try {
      display.canvas.id = 'hdr-c';
      display.canvas.width = source.width;
      display.canvas.height = source.height;
      display.canvas.hidden = true;
      const context = display.canvas.getContext('webgpu');
      if (!context) throw new Error('WebGPU canvas is unavailable.');
      display.context = context;
      device.pushErrorScope('validation');
      context.configure({ device, format: 'rgba16float', colorSpace: 'srgb', alphaMode: 'opaque',
        toneMapping: { mode: 'extended' }, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      display.texture = device.createTexture({ label: 'WebGL HDR frame', size: [source.width, source.height], format: 'rgba16float',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      const module = device.createShaderModule({ label: 'HDR presentation', code: SHADER });
      display.pipeline = await device.createRenderPipelineAsync({ layout: 'auto',
        vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] } });
      display.binding = device.createBindGroup({ layout: display.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: display.texture.createView() }] });
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      if (context.getConfiguration?.()?.toneMapping?.mode !== 'extended') throw new Error('Extended-range canvas output was not accepted.');
      // WebGL specifies INVALID_OPERATION here for alpha:false contexts.
      display.floatBuffer = true;
      floatGL.drawingBufferStorage!(gl.RGBA16F, source.width, source.height);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Floating-point WebGL drawing buffer allocation failed.');
      source.after(display.canvas);
      void device.lost.then((info) => { if (!display.disposed) display.onFailure(`HDR device lost: ${info.message || info.reason}`); });
      device.addEventListener('uncapturederror', (event) => { if (!display.disposed) display.onFailure(`HDR GPU error: ${event.error.message}`); });
      return display;
    } catch (error) { display.dispose(); throw error; }
  }

  present() {
    if (this.disposed) return;
    const start = performance.now();
    try {
      if (this.gl.isContextLost()) throw new Error('WebGL context was lost.');
      // Issue immediately after WebGL draws, before the browser presents/clears
      // its drawing buffer. This is not a guaranteed zero-copy operation.
      this.device.queue.copyExternalImageToTexture({ source: this.source }, { texture: this.texture, colorSpace: 'srgb' }, [this.source.width, this.source.height]);
      const encoder = this.device.createCommandEncoder();
      this.output = this.context.getCurrentTexture();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.binding); pass.draw(3); pass.end();
      this.device.queue.submit([encoder.finish()]);
      this.source.hidden = true;
      this.canvas.hidden = false;
      this.frames++;
      this.lastSubmitMs = performance.now() - start;
    } catch (error) { this.onFailure(String(error)); }
  }

  async settled() { await this.device.queue.onSubmittedWorkDone(); }

  /** Explicit testing only. Call in the same task as present() for output reads. */
  async readPixel(x: number, y: number, which: 'input' | 'output' = 'input') {
    const texture = which === 'input' ? this.texture : this.output;
    if (!texture) throw new Error('No presented frame to read.');
    const buffer = this.device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer, bytesPerRow: 256 }, [1, 1]);
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      return Array.from(new Uint16Array(buffer.getMappedRange()).slice(0, 4), (bits) => {
        const exponent = (bits >> 10) & 31, mantissa = bits & 1023;
        return (bits & 32768 ? -1 : 1) * (exponent === 31 ? (mantissa ? NaN : Infinity) : exponent === 0 ? mantissa / 1024 * 2 ** -14 : (1 + mantissa / 1024) * 2 ** (exponent - 15));
      });
    } finally { buffer.destroy(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.remove();
    this.source.hidden = false;
    if (this.floatBuffer && !this.gl.isContextLost()) this.gl.drawingBufferStorage!(this.gl.RGBA8, this.source.width, this.source.height);
    this.context?.unconfigure();
    this.texture?.destroy();
    this.device.destroy();
  }
}
