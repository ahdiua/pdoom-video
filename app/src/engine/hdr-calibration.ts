import * as THREE from 'three';
import { FSPass, Layer2D } from './gl';
import { F, font } from './type';

/** Box brightness as multiples of SDR white. */
const LEVELS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6.5, 8, 10];
const BOX = 120, GAP = 20, X0 = (1920 - (LEVELS.length * (BOX + GAP) - GAP)) / 2, Y0 = 430, INNER = 44;

/**
 * A test card for finding a display's headroom, which the browser does not report. Each box is a
 * multiple of SDR white with a square 10% dimmer inside it: where the display clips, box and square
 * come out the same and the square disappears. It is drawn instead of the picture, ungraded.
 */
export class HdrCalibration {
  private labels = new Layer2D();
  private pass: FSPass;

  constructor() {
    const c = this.labels.ctx;
    this.labels.clear();
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.font = font(F.mono(500), 20);
    LEVELS.forEach((level, i) => c.fillText(`${level}×`, X0 + i * (BOX + GAP) + BOX / 2, Y0 + BOX + 56));
    c.font = font(F.mono(700), 26); c.letterSpacing = '6px';
    c.fillText('HDR HEADROOM', 960, Y0 - 150);
    c.font = font(F.mono(400), 20); c.letterSpacing = '0px';
    c.fillText('Set Headroom to the brightest box whose inner square you can still see.', 960, Y0 - 100);
    c.fillText('Boxes are multiples of SDR white; the bars mark the ones the current setting reaches.', 960, Y0 + BOX + 130);
    this.labels.upload();
    this.pass = new FSPass(/* glsl */ `
      uniform sampler2D labels; uniform float headroom;
      const float LEVELS[${LEVELS.length}] = float[](${LEVELS.map((l) => l.toFixed(2)).join(', ')});
      void main() {
        vec2 p = vec2(vUv.x * 1920.0, (1.0 - vUv.y) * 1080.0);
        float v = 0.0; // linear, 1 = SDR white
        for (int i = 0; i < ${LEVELS.length}; i++) {
          vec2 q = p - vec2(${X0.toFixed(1)} + float(i) * ${(BOX + GAP).toFixed(1)}, ${Y0.toFixed(1)});
          if (q.x < 0.0 || q.x >= ${BOX.toFixed(1)}) continue;
          if (q.y >= 0.0 && q.y < ${BOX.toFixed(1)}) {
            vec2 d = abs(q - ${(BOX / 2).toFixed(1)});
            v = LEVELS[i] / (max(d.x, d.y) < ${(INNER / 2).toFixed(1)} ? 1.1 : 1.0);
          } else if (q.y >= ${(BOX + 12).toFixed(1)} && q.y < ${(BOX + 18).toFixed(1)} && LEVELS[i] <= headroom + 1e-3) v = 0.5;
        }
        v = mix(v, 0.5, texture(labels, vUv).a);
        fragColor = vec4(toSRGB(vec3(v)), 1.0);
      }`, { labels: { value: this.labels.texture }, headroom: { value: 1 } });
  }

  /** Overwrites `out` with extended-sRGB-encoded neutral values (the same in any primaries). */
  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget | null, headroom: number) {
    this.pass.u.headroom!.value = headroom;
    this.pass.render(renderer, out);
  }

  dispose() { this.pass.mat.dispose(); this.labels.texture.dispose(); }
}
