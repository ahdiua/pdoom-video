// WGSL for what `engine/post.ts`, `engine/lines.ts` and the compositor do in the WebGL renderer: the layer
// composite, spark capsules, the bloom pyramid and the final grade (SDR, or the HDR grade of `hdr-color.ts`).
import { UniformBlock } from './gpu';
import { COMMON, FULLSCREEN } from './common';
import { SCALE } from '../engine/scale';

/** What changes every frame, shared by all post passes. */
export const frameBlock = () => new UniformBlock('Frame', {
  res: 'vec2f', shake: 'vec2f', time: 'f32', zoom: 'f32', exposure: 'f32', bloom: 'f32', halation: 'f32', ca: 'f32',
  grain: 'f32', vignette: 'f32', hud: 'f32', fade: 'f32', flash: 'f32', invert: 'f32', threshold: 'f32', knee: 'f32', radius: 'f32',
  hdrHeadroom: 'f32', hdrGamut: 'f32', hdrHue: 'f32', // headroom 0: SDR output
});

// Binding 0 is the one thing fixed per pass: the texel size of the texture it filters.
const HEADER = FULLSCREEN + COMMON + /* wgsl */ `
struct Tap { texel: vec2f }
@group(0) @binding(0) var<uniform> tap: Tap;
${frameBlock().wgsl}
@group(0) @binding(1) var<uniform> f: Frame;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var src: texture_2d<f32>;
@group(0) @binding(4) var prev: texture_2d<f32>;
@group(0) @binding(5) var hud: texture_2d<f32>;
@group(0) @binding(6) var halo: texture_2d<f32>;
fn tex(t: texture_2d<f32>, uv: vec2f) -> vec4f { return textureSampleLevel(t, linearSampler, uv, 0.0); }
`;

/** A Canvas2D layer over the scene, texel for texel: straight alpha in, premultiplied out (blend one, 1 - a). */
export const OVERLAY = HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let c = textureLoad(src, vec2i(v.position.xy), 0);
  return vec4f(c.rgb * c.a, c.a);
}`;

export const PREFILTER = HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  // 4-tap box downsample + soft threshold on luminance
  var c = vec3f(0.0);
${SCALE === 1 ? `  c += tex(src, v.uv + tap.texel * vec2f(-1, -1)).rgb; c += tex(src, v.uv + tap.texel * vec2f(1, -1)).rgb;
  c += tex(src, v.uv + tap.texel * vec2f(-1, 1)).rgb; c += tex(src, v.uv + tap.texel * vec2f(1, 1)).rgb;
  c *= 0.25;` : `  // output scale > 1: the same 4x4-logical-px box from a SCALE x larger source, as 2x2-texel bilinear taps
  for (var j = 0; j < ${SCALE * 2}; j++) { for (var i = 0; i < ${SCALE * 2}; i++) {
    c += tex(src, v.uv + tap.texel * (vec2f(f32(i), f32(j)) * 2.0 - ${(SCALE * 2 - 1).toFixed(1)}) / PX_SCALE).rgb;
  } }
  c /= ${(SCALE * SCALE * 4).toFixed(1)};`}
  c = min(c, vec3f(40.0));
  let l = max(c.r, max(c.g, c.b));
  var rq = clamp(l - f.threshold + f.knee, 0.0, 2.0 * f.knee);
  rq = rq * rq / (4.0 * f.knee + 1e-5);
  let w = max(rq, l - f.threshold) / max(l, 1e-5);
  return vec4f(c * w, 1.0);
}`;

export const DOWN = HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  // 13-tap downsample (Jimenez 2014)
  let t = tap.texel;
  let a = tex(src, v.uv + t * vec2f(-2, -2)).rgb; let b = tex(src, v.uv + t * vec2f(0, -2)).rgb; let c = tex(src, v.uv + t * vec2f(2, -2)).rgb;
  let d = tex(src, v.uv + t * vec2f(-1, -1)).rgb; let e = tex(src, v.uv + t * vec2f(1, -1)).rgb;
  let g = tex(src, v.uv + t * vec2f(-2, 0)).rgb; let h = tex(src, v.uv).rgb; let i = tex(src, v.uv + t * vec2f(2, 0)).rgb;
  let j = tex(src, v.uv + t * vec2f(-1, 1)).rgb; let k = tex(src, v.uv + t * vec2f(1, 1)).rgb;
  let l = tex(src, v.uv + t * vec2f(-2, 2)).rgb; let m = tex(src, v.uv + t * vec2f(0, 2)).rgb; let n = tex(src, v.uv + t * vec2f(2, 2)).rgb;
  let o = (d + e + j + k) * 0.125 + (a + b + h + g) * 0.03125 + (b + c + i + h) * 0.03125 + (g + h + m + l) * 0.03125 + (h + i + n + m) * 0.03125;
  return vec4f(o, 1.0);
}`;

export const UP = HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  // 9-tap tent upsample of the smaller level (src), added to this level (prev)
  let o = tap.texel * f.radius;
  let s = tex(src, v.uv - o).rgb + 2.0 * tex(src, v.uv + vec2f(0.0, -o.y)).rgb + tex(src, v.uv + vec2f(o.x, -o.y)).rgb
    + 2.0 * tex(src, v.uv + vec2f(-o.x, 0.0)).rgb + 4.0 * tex(src, v.uv).rgb + 2.0 * tex(src, v.uv + vec2f(o.x, 0.0)).rgb
    + tex(src, v.uv + vec2f(-o.x, o.y)).rgb + 2.0 * tex(src, v.uv + vec2f(0.0, o.y)).rgb + tex(src, v.uv + o).rgb;
  return vec4f(tex(prev, v.uv).rgb + s / 16.0, 1.0);
}`;

/** src = the scene, prev = bloom (ups[0]), halo = ups[3], hud = the HUD layer. */
export const GRADE = HEADER + /* wgsl */ `
fn shoulder(x: vec3f) -> vec3f {
  // identity below k, smooth exponential shoulder above; very bright values desaturate toward white
  let k = 0.72;
  let y = select(x, k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k))), x >= vec3f(k));
  let over = max(max(x.r, x.g), x.b);
  return mix(y, vec3f(1.0), smoothstep(2.0, 12.0, over) * 0.85);
}
// The SDR shoulder with its ceiling raised to top (hdr-color.ts): top = 1 is exactly the SDR curve.
fn hdrCurve(x: vec3f, top: f32) -> vec3f {
  let k = 0.72;
  let span = top - k;
  return select(x, k + span * (1.0 - exp(-(x - k) / span)), x >= vec3f(k));
}
fn hdrGrade(color: vec3f, headroom: f32, keepHue: f32) -> vec3f {
  if (headroom <= 1.0) { return shoulder(color); }
  let peak = max(color.r, max(color.g, color.b));
  let drift = hdrCurve(color, headroom);
  let hue = color * (hdrCurve(vec3f(peak), headroom).x / max(peak, 1e-5));
  let y = mix(drift, hue, keepHue * (1.0 - 1.0 / headroom));
  return mix(y, vec3f(headroom), smoothstep(2.0 * headroom, 12.0 * headroom, peak) * 0.85);
}
// Linear BT.709 -> linear Display-P3 (both D65).
fn toP3(rgb: vec3f) -> vec3f {
  return mat3x3f(0.82246197, 0.03319420, 0.01708263, 0.17753803, 0.96680580, 0.07239744, 0.0, 0.0, 0.91051993) * rgb;
}
fn widenGamut(rgb: vec3f, amount: f32, headroom: f32) -> vec3f {
  let peak = max(rgb.r, max(rgb.g, rgb.b));
  let glow = smoothstep(1.0, 1.0 + max(0.5 * (headroom - 1.0), 1e-3), peak);
  return mix(toP3(rgb), rgb, amount * glow);
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  // The shake and the aberration are authored bottom-up; textures are top-down.
  let uvGL = (vec2f(v.uv.x, 1.0 - v.uv.y) - 0.5) / f.zoom + 0.5 - f.shake / f.res;
  let dc = uvGL - 0.5;
  let r2 = dot(dc * vec2f(f.res.x / f.res.y, 1.0), dc * vec2f(f.res.x / f.res.y, 1.0));
  let off = dc * r2 * f.ca / f.res.x * 4.0 * vec2f(1.0, -1.0);
  let uv = vec2f(uvGL.x, 1.0 - uvGL.y);
  var col = vec3f(tex(src, uv + off).r, tex(src, uv).g, tex(src, uv - off).b);
  col += tex(prev, uv).rgb * f.bloom;
  col += vec3f(1.0, 0.18, 0.04) * luma(tex(halo, uv).rgb) * f.halation;
  col *= f.exposure;
  // HUD is composited in linear space before the shoulder so it gets grain & vignette too
  let h = tex(hud, v.uv);
  col = mix(col, h.rgb / max(h.a, 1e-4), h.a * f.hud);
  // HDR output shares the SDR grade below the shoulder's knee and rolls off to the
  // headroom instead of to reference white. Inversion (ink <-> bone) stays an SDR effect.
  let base = shoulder(col);
  var extra = vec3f(0.0);
  if (f.hdrHeadroom > 0.0) { extra = hdrGrade(max(col, vec3f(0.0)), f.hdrHeadroom, f.hdrHue) - base; }
  let top = max(f.hdrHeadroom, 1.0);
  col = base;
  col = mix(col, vec3f(0.8515) - col * 0.84, f.invert);
  col += extra * (1.0 - f.invert);
  col += C_BONE * f.flash;
  let vig = reverseSmooth(0.95, 0.25, length(dc * vec2f(1.0, 0.8)));
  col *= mix(1.0, vig, f.vignette);
  col *= 1.0 - f.fade;
  // HDR output is Display-P3; SDR stays BT.709
  if (f.hdrHeadroom > 0.0) { col = widenGamut(max(col, vec3f(0.0)), f.hdrGamut, f.hdrHeadroom); }
  var s = toSRGB(clamp(col, vec3f(0.0), vec3f(top)));
  // gl_FragCoord of the WebGL renderer: physical px, y up
  let frag = vec2f(v.position.x, f.res.y * PX_SCALE - v.position.y);
  // film grain: two scales, stronger in mid-tones. The fine grain is per physical px with its amplitude
  // raised by PX_SCALE; the coarse grain keeps 2x2-logical-px cells.
  if (f.grain > 0.0) {
    let g1 = (hash12(frag + fract(f.time * 13.37) * 1000.0) - 0.5) * PX_SCALE;
    let g2 = hash12(floor(frag / (2.0 * PX_SCALE)) + fract(f.time * 7.13) * 1000.0) - 0.5;
    let lm = sat(luma(s));
    let amt = f.grain * (0.55 + 1.2 * lm * (1.0 - lm));
    s += (g1 * 0.6 + g2 * 0.4) * amt;
  }
  s += (hash12(frag * 1.37 + f.time) - 0.5) / 255.0; // dither
  return vec4f(clamp(s, vec3f(0.0), toSRGB(vec3f(top))), 1.0);
}`;

/** Spark capsules: `engine/lines.ts` in its 2D mode. One instance = A.xy, B.xy, width, 3 unused, linear RGBA. */
export const LINES = /* wgsl */ `
struct Screen { res: vec2f, scale: f32 }
@group(0) @binding(0) var<uniform> screen: Screen;
struct Vertex { @builtin(position) position: vec4f, @location(0) local: vec2f,
  @location(1) len: f32, @location(2) halfW: f32, @location(3) color: vec4f }
@vertex fn vertex(@builtin(vertex_index) i: u32, @location(0) a: vec2f, @location(1) b: vec2f, @location(2) width: f32, @location(3) color: vec4f) -> Vertex {
  let corners = array<vec2f, 6>(vec2f(0, -1), vec2f(1, -1), vec2f(1, 1), vec2f(0, -1), vec2f(1, 1), vec2f(0, 1));
  let q = corners[i];
  // physical pixels, centred, y up
  let sa = (a - 0.5 * screen.res) * vec2f(1, -1) * screen.scale;
  let sb = (b - 0.5 * screen.res) * vec2f(1, -1) * screen.scale;
  let w = width * screen.scale;
  let hw = max(w * 0.5, 0.35) + 1.0; // +1px for AA
  let d = sb - sa; let len = length(d);
  var dir = vec2f(1, 0);
  if (len > 1e-4) { dir = d / len; }
  let nrm = vec2f(-dir.y, dir.x);
  let along = mix(-hw, len + hw, q.x);
  let pos = sa + dir * along + nrm * q.y * hw;
  var o: Vertex;
  o.position = vec4f(pos / (0.5 * screen.res * screen.scale), 0, 1);
  o.local = vec2f(along, q.y * hw); o.len = len; o.halfW = max(w * 0.5, 0.35);
  // thin lines fade instead of shrinking below 0.7px (keeps hairlines smooth)
  o.color = color * vec4f(1, 1, 1, min(1.0, w / 0.7));
  return o;
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let x = clamp(v.local.x, 0.0, v.len);
  let d = length(vec2f(v.local.x - x, v.local.y)) - v.halfW; // capsule SDF in px
  let a = clamp(0.5 - d, 0.0, 1.0) * v.color.a;
  if (a <= 0.0) { discard; }
  return vec4f(v.color.rgb * a, a);
}`;
