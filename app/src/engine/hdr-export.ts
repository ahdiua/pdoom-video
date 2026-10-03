import * as THREE from 'three';
import { FSPass, makeRT, W, H, PW, PH } from './gl';
import { HDR_PQ_GLSL } from './hdr-color';

export interface HdrExportOptions { whiteNits: number; peakNits: number }

/** Pack each RGB PQ16 pixel into two RGBA8 texels. Readback is rgba64le:
 * Rlo Rhi Glo Ghi | Blo Bhi Alo Ahi. This keeps all 16 bits without float
 * readback, CPU conversion, or an 8-bit SDR intermediate. Rows remain bottom-up. */
export class HdrExport {
  readonly pixelFormat = 'rgba64le';
  readonly bytesPerPixel = 8;
  readonly headroom: number;
  private target: THREE.WebGLRenderTarget;
  private pack: FSPass;

  constructor(renderer: THREE.WebGLRenderer, readonly options: HdrExportOptions) {
    const { whiteNits, peakNits } = options;
    if (!Number.isFinite(whiteNits) || !Number.isFinite(peakNits) || whiteNits <= 0 || peakNits < whiteNits || peakNits > 10000) {
      throw new Error('HDR requires 0 < whiteNits <= peakNits <= 10000.');
    }
    if (PW * 2 > renderer.capabilities.maxTextureSize) throw new Error(`HDR packing needs a ${PW * 2}-pixel-wide texture; reduce --scale for this GPU.`);
    this.headroom = peakNits / whiteNits;
    this.target = makeRT(W * 2, H, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.pack = new FSPass(/* glsl */ `
      uniform sampler2D src;
      uniform float whiteNits, peakNits;
      ${HDR_PQ_GLSL}
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        // The post pass stores extended sRGB; recover linear light before
        // changing primaries or scaling by the reference-white luminance.
        vec3 rgb = toLinear(max(texelFetch(src, ivec2(p.x / 2, p.y), 0).rgb, 0.0));
        vec3 pq = toPQ(clamp(toRec2020(rgb) * whiteNits, 0.0, peakNits));
        uvec3 q = uvec3(round(pq * 65535.0));
        uvec4 bytes = (p.x & 1) == 0
          ? uvec4(q.r & 255u, q.r >> 8u, q.g & 255u, q.g >> 8u)
          : uvec4(q.b & 255u, q.b >> 8u, 255u, 255u);
        fragColor = vec4(bytes) / 255.0;
      }`, { src: { value: null }, whiteNits: { value: whiteNits }, peakNits: { value: peakNits } });
  }

  render(renderer: THREE.WebGLRenderer, source: THREE.Texture) {
    this.pack.u.src!.value = source;
    const gl = renderer.getContext(), dither = gl.isEnabled(gl.DITHER);
    gl.disable(gl.DITHER); // these channels are bytes, not display colors
    try { this.pack.render(renderer, this.target); }
    finally { if (dither) gl.enable(gl.DITHER); }
  }

  async readPixelsAsync(renderer: THREE.WebGLRenderer, buffer: Uint8Array = new Uint8Array(PW * PH * this.bytesPerPixel)) {
    if (buffer.byteLength !== PW * PH * this.bytesPerPixel) throw new Error('Incorrect HDR frame buffer size.');
    await renderer.readRenderTargetPixelsAsync(this.target, 0, 0, PW * 2, PH, buffer);
    return buffer;
  }

  dispose() { this.target.dispose(); this.pack.mat.dispose(); }
}
