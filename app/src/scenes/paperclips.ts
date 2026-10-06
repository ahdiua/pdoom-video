// WebGL adapter. CPU animation, lyrics and particles are shared with WebGPU.
import { Scene, type Frame } from '../engine/scene';
import { DetailPass } from '../engine/preview-quality';
import { LineBatch } from '../engine/lines';
import { PaperclipsState } from './paperclips-state';
import { FRAG_TOP, FRAG_MARCH } from './paperclips-glsl';
import type * as THREE from 'three';

export default class Paperclips extends Scene {
  readonly model = new PaperclipsState(this.ctx);
  readonly top = new DetailPass(FRAG_TOP, this.model.top.u);
  // (the two extra uniforms belong to this WebGL shader only, not to the state shared with the frozen WebGPU port)
  readonly march = new DetailPass(FRAG_MARCH, { ...this.model.march.u, marchSteps: { value: 128 }, deepLayers: { value: 4.5 } });
  readonly sparks = new LineBatch(3000);
  override init() { this.model.init(); }
  override warmupTimes() { return this.model.warmupTimes(); }
  override render(f: Frame, out: THREE.WebGLRenderTarget) {
    const post = this.model.prepare(f), { renderer, comp, quality } = this.ctx;
    const top = f.t < this.model.T.tilt0;
    // Auto and Performance previews trim what does not show (see FRAG_MARCH); Full detail and the export do not.
    const lean = quality.enabled && quality.mode !== 'full';
    this.march.u.marchSteps!.value = lean ? 80 : 128;
    this.march.u.deepLayers!.value = lean ? 2.6 : 4.5;
    (top ? this.top : this.march).renderDetail(renderer, out, quality, top ? 'paperclips:top' : 'paperclips:lattice');
    this.sparks.clear();
    const { data, count } = this.model.sparks;
    for (let i = 0; i < count * 12; i += 12) {
      this.sparks.seg2(data[i]!, data[i+1]!, data[i+2]!, data[i+3]!, data[i+4]!, [data[i+8]!, data[i+9]!, data[i+10]!], data[i+11]!);
    }
    if (count) this.sparks.render(renderer, out);
    comp.draw(renderer, this.model.layer.upload(), out);
    return post;
  }
  override dispose() {
    this.top.dispose(); this.march.dispose();
    this.sparks.geo.dispose(); this.sparks.mat.dispose(); this.model.layer.texture.dispose();
  }
}
