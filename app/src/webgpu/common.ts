import { LIN } from '../engine/palette';
import { SCALE } from '../engine/scale';

// Textures use WebGPU's top-down storage. Scene rays and grain retain the
// original GL bottom-up coordinates; image flip happens only at this boundary.
export const FULLSCREEN = /* wgsl */ `
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: Vertex; o.position = vec4f(p[i], 0, 1);
  o.uv = p[i] * vec2f(0.5, -0.5) + 0.5; return o;
}`;

export const COMMON = /* wgsl */ `
const PI = 3.14159265359; const TAU = 6.28318530718;
const PX_SCALE = ${SCALE.toFixed(1)};
${Object.entries(LIN).map(([key, rgb]) => `const C_${key.toUpperCase()} = vec3f(${rgb.map(x => x.toFixed(5)).join(',')});`).join('\n')}
fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn modf(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(p.xyx * .1031); p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(p.xyx * vec3f(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
fn hash33(p: vec3f) -> vec3f {
  var p3 = fract(p * vec3f(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(.2126, .7152, .0722)); }
fn toSRGB(c: vec3f) -> vec3f {
  return select(12.92 * c, 1.055 * pow(max(c, vec3f(0)), vec3f(1.0 / 2.4)) - .055, c >= vec3f(.0031308));
}
fn toLinear(c: vec3f) -> vec3f {
  return select(c / 12.92, pow((c + .055) / 1.055, vec3f(2.4)), c >= vec3f(.04045));
}
fn heat(x0: f32) -> vec3f {
  let x = sat(x0); var c = mix(C_INK, C_BLOOD, smoothstep(0.0, .3, x));
  c = mix(c, C_SIGNAL, smoothstep(.25, .55, x)); c = mix(c, C_EMBER, smoothstep(.55, .8, x));
  return mix(c, vec3f(1, .93, .85), smoothstep(.8, 1.0, x));
}
// WGSL requires increasing smoothstep edges. This also reproduces the authored
// reverse ramps, whose implementation happens to work in the WebGL drivers.
fn reverseSmooth(a: f32, b: f32, x: f32) -> f32 { return 1.0 - smoothstep(b, a, x); }
`;
