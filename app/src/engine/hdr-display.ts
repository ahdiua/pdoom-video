/// <reference types="@webgpu/types" />

/** Experimental presentation only: all scene rendering remains in WebGL. Each frame is one GPU copy of the
 * WebGL canvas into the WebGPU canvas's own texture; readback is diagnostic-only.
 * The WebGL post pass has already applied the sRGB transfer function, and its numbers are already in the
 * output canvas's primaries: converting gamma or gamut again on the way would change the picture. */
type FloatCanvasGL = WebGL2RenderingContext & {
  drawingBufferStorage?: (format: number, width: number, height: number) => void;
};

export class HdrDisplay {
  readonly canvas = document.createElement('canvas');
  private context!: GPUCanvasContext;
  private output: GPUTexture | null = null;
  private disposed = false;
  private floatBuffer = false;
  onFailure: (reason: string) => void = () => {};
  lastSubmitMs = 0;
  frames = 0;

  private constructor(private source: HTMLCanvasElement, private gl: FloatCanvasGL, private device: GPUDevice) {}

  /** `colorSpace` names the primaries of the frames the engine will present: Display-P3 for the HDR grade, sRGB for the SDR one. */
  static async create(source: HTMLCanvasElement, gl: WebGL2RenderingContext, colorSpace: PredefinedColorSpace = 'display-p3'): Promise<HdrDisplay> {
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
      context.configure({ device, format: 'rgba16float', colorSpace, alphaMode: 'opaque',
        // an external-image copy needs COPY_DST and RENDER_ATTACHMENT on its destination; COPY_SRC is for readPixel
        toneMapping: { mode: 'extended' }, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      const accepted = context.getConfiguration?.();
      if (accepted?.toneMapping?.mode !== 'extended' || accepted.colorSpace !== colorSpace) throw new Error('Extended-range canvas output was not accepted.');
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
      // Source and destination are both declared sRGB so the copy converts nothing,
      // whatever colour space the destination canvas is configured with.
      this.output = this.context.getCurrentTexture();
      this.device.queue.copyExternalImageToTexture({ source: this.source }, { texture: this.output, colorSpace: 'srgb' }, [this.source.width, this.source.height]);
      this.source.hidden = true;
      this.canvas.hidden = false;
      this.frames++;
      this.lastSubmitMs = performance.now() - start;
    } catch (error) { this.onFailure(String(error)); }
  }

  async settled() { await this.device.queue.onSubmittedWorkDone(); }

  /** Explicit testing only: a pixel of the presented canvas texture. Call in the same task as present(). */
  async readPixel(x: number, y: number) {
    const texture = this.output;
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
    this.device.destroy();
  }
}
