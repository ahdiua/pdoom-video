// WGSL for FIG. 9 (paperclips), following `scenes/paperclips-glsl.ts` and `paperclips-geo.ts` function by
// function: the same arithmetic in the same order, at the preview's one centred tap.
import { CLIP, S_A1, S_B0, S_B1, S_C0, S_C1, S_D0 } from '../scenes/paperclips-geo';
import { UniformBlock } from './gpu';
import { COMMON, FULLSCREEN } from './common';

export const MAX_ITEMS = 64;
const CELL = 40;
const CELLF = CELL.toFixed(1), HALF = (CELL / 2).toFixed(1);

/**
 * How the lattice's map is written. The pictures are the same; compile time and frame time are not.
 *  loop      the stacks and layers are loops from `zero`, like the WebGL shader: one copy of the layer function
 *  unrolled  the four layers written out; only the normal and occlusion taps loop from `zero`
 *  flat      everything written out, as the scene was first authored
 */
export const MAP_VARIANTS = ['loop', 'unrolled', 'flat'] as const;
export type MapVariant = typeof MAP_VARIANTS[number];

/** One block for both passes. Fields are those of `PaperclipsState`'s uniforms plus the three of the WebGL adapter. */
export const sceneBlock = () => new UniformBlock('Scene', {
  camPos: 'vec3f', focal: 'f32', camR: 'vec3f', time: 'f32', camU: 'vec3f', detailScale: 'f32', camF: 'vec3f', keyI: 'f32',
  keyDir: 'vec3f', rimI: 'f32', rimDir: 'vec3f', lampI: 'f32', lampPos: 'vec3f', rad: 'f32', res: 'vec2f', groupHalf: 'vec2f',
  fillT: 'f32', sT0: 'f32', sH0: 'f32', rad0: 'f32', hot0: 'f32', pz: 'f32', ceilZ: 'f32', lowerOn: 'f32',
  fogK: 'f32', fogFar: 'f32', slitK: 'f32', slitH: 'f32', horizonY: 'f32', deepLayers: 'f32',
  nItems: 'i32', marchSteps: 'i32',
  // Always 0, but the compiler cannot know: a loop that starts here stays a loop (see "Raymarch loops" in CLAUDE.md).
  zero: 'i32',
}, { name: 'items', count: MAX_ITEMS });

const f = (x: number) => x.toFixed(5);
// The straight legs and the bends of clipFull, with or without the closest point.
const leg = (x0: string, x1: string, y: string, sign: string, closest: boolean) =>
  `o = p - vec2f(clamp(p.x, ${x0}, ${x1}), ${y}); d = dot(o, o); if (d < bd) { bd = d; bl = ${sign}o.y; ${closest ? 'closest = p - o; ' : ''}}`;
const bend = (c: string, R: string, side: string, closest: boolean) =>
  `v = p - ${c}; if (v.x ${side} 0.0) { r = length(v); d = abs(r - ${R}); if (d < bd) { bd = d; bl = ${R} - r; ${closest ? `closest = ${c} + v * (${R} / r); ` : ''}} }`;
const fullClip = (closest: boolean) => `
  var bd = 1e5; var bl = 0.0; var o: vec2f; var d: f32; var v: vec2f; var r: f32;
  ${leg('CL_XA0', 'CL_XR', 'CL_YA', '', closest)}
  ${leg('CL_XL', 'CL_XR', 'CL_YB', '-', closest)}
  ${leg('CL_XL', 'CL_XS', 'CL_YC', '', closest)}
  ${leg('CL_XD1', 'CL_XS', 'CL_YD', '-', closest)}
  bd = sqrt(bd);
  ${bend('vec2f(CL_XR, 0.0)', 'CL_R1', '>', closest)}
  ${bend('vec2f(CL_XL, CL_R2CY)', 'CL_R2', '<', closest)}
  ${bend('vec2f(CL_XS, CL_R3CY)', 'CL_R3', '>', closest)}`;

const GEOMETRY = /* wgsl */ `
${Object.entries(CLIP).map(([k, v]) => `const CL_${k} = ${f(v)};`).join(' ')}
const CL_SA1 = ${f(S_A1)}; const CL_SB0 = ${f(S_B0)}; const CL_SB1 = ${f(S_B1)}; const CL_SC0 = ${f(S_C0)}; const CL_SC1 = ${f(S_C1)}; const CL_SD0 = ${f(S_D0)};

// d = distance to the centreline, s = arc length of the closest point, lat = signed lateral offset, q = closest point
struct Closest { d: f32, s: f32, lat: f32, q: vec2f }
fn clSeg(p: vec2f, y: f32, x0: f32, x1: f32, dir: f32, s0: f32, sT: f32, sH: f32, best: Closest) -> Closest {
  let a = s0 + max(sT - s0, 0.0); let b = s0 + min(sH - s0, abs(x1 - x0));
  if (b < a) { return best; }
  let xa = x0 + (a - s0) * dir; let xb = x0 + (b - s0) * dir;
  let x = clamp(p.x, min(xa, xb), max(xa, xb));
  let o = p - vec2f(x, y);
  let d = length(o);
  if (d < best.d) { return Closest(d, s0 + (x - x0) * dir, o.y * dir, vec2f(x, y)); }
  return best;
}
fn clArc(p: vec2f, c: vec2f, R: f32, a0: f32, s0: f32, sT: f32, sH: f32, best: Closest) -> Closest {
  let lo = max(sT - s0, 0.0) / R; let hi = min(sH - s0, PI * R) / R;
  if (hi < lo) { return best; }
  let v = p - c;
  let mid = a0 + PI * 0.5;
  var rel = atan2(v.y, v.x) - mid; rel -= TAU * floor((rel + PI) / TAU);
  let u0 = clamp(rel + PI * 0.5, lo, hi);
  let aa = a0 + u0;
  let q = c + R * vec2f(cos(aa), sin(aa));
  let d = length(p - q);
  if (d < best.d) { return Closest(d, s0 + u0 * R, R - length(v), q); }
  return best;
}
/** The clip restricted to arc lengths [sT, sH] (the pen drawing it). */
fn clipD(p: vec2f, sT: f32, sH: f32) -> Closest {
  var c = Closest(1e5, 0.0, 0.0, vec2f(0.0));
  c = clSeg(p, CL_YA, CL_XA0 + min(sT, 0.0), CL_XR, 1.0, min(sT, 0.0), sT, sH, c);
  c = clArc(p, vec2f(CL_XR, 0.0), CL_R1, -PI * 0.5, CL_SA1, sT, sH, c);
  c = clSeg(p, CL_YB, CL_XR, CL_XL, -1.0, CL_SB0, sT, sH, c);
  c = clArc(p, vec2f(CL_XL, CL_R2CY), CL_R2, PI * 0.5, CL_SB1, sT, sH, c);
  c = clSeg(p, CL_YC, CL_XL, CL_XS, 1.0, CL_SC0, sT, sH, c);
  c = clArc(p, vec2f(CL_XS, CL_R3CY), CL_R3, -PI * 0.5, CL_SC1, sT, sH, c);
  return clSeg(p, CL_YD, CL_XS, CL_XD1, -1.0, CL_SD0, sT, sH, c);
}
/** Full clip: closest point without atan/sin/cos. */
fn clipFull(p: vec2f) -> Closest {
  var closest = vec2f(0.0);${fullClip(true)}
  return Closest(bd, 0.0, bl, closest);
}
/** Raymarching uses distance and lateral only: (d, lat). */
fn clipDL(p: vec2f) -> vec2f {${fullClip(false)}
  return vec2f(bd, bl);
}
`;

const SHADE = /* wgsl */ `
fn rotv(v: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * v.x - s * v.y, s * v.x + c * v.y); }
fn camRay(px: vec2f) -> vec3f { return normalize(u.camF * u.focal + u.camR * px.x + u.camU * px.y); }
/** The fragment in the scene's pixels: centred, y up, as the GLSL has it. */
fn scenePx(v: Vertex) -> vec2f { return vec2f(v.uv.x, 1.0 - v.uv.y) * u.res - 0.5 * u.res; }
/** Engraving line with an explicit footprint fw (lines per pixel): coverage of lines at integer x. */
fn hatchW(x: f32, darkness: f32, fw: f32) -> f32 {
  let d = abs(fract(x) - 0.5);
  let hw = 0.5 * clamp(darkness, 0.0, 1.0);
  let aa = max(fw, 1e-3);
  let l = 1.0 - smoothstep(hw - aa, hw + aa, 0.5 - d);
  return mix(l, clamp(darkness, 0.0, 1.0), smoothstep(0.3, 0.75, fw));
}
/** Engraved steel: see shadeWireL in paperclips-glsl.ts. */
fn shadeWireL(P: vec3f, N: vec3f, V: vec3f, theta: f32, wirePx: f32, shadow: f32, ao: f32) -> vec3f {
  let dif = max(dot(N, u.keyDir), 0.0) * shadow;
  let tone = u.keyI * (0.02 + 0.98 * pow(dif, 1.6)) * mix(0.35, 1.0, ao);
  let nl = 7.0;
  let x = theta / PI * nl + 0.5;
  let fw = nl / max(2.0 * wirePx * min(1.0, PX_SCALE * u.detailScale) * max(sin(theta), 0.2), 0.5);
  let cov = hatchW(x, pow(tone, 1.5) * 1.15, fw);
  let Hh = normalize(u.keyDir + V);
  let spec = pow(max(dot(N, Hh), 0.0), 60.0) * u.keyI * shadow;
  var col = C_BONE * 0.74 * cov + C_BONE * 0.85 * smoothstep(0.3, 0.6, spec);
  let nv = max(dot(N, V), 0.0);
  let rim = pow(sat(1.0 - nv), 5.0) * smoothstep(0.0, 0.7, dot(N, u.rimDir)) * u.rimI * smoothstep(3.0, 12.0, wirePx);
  col += C_SIGNAL * rim * 1.1;
  // the spark lamp: a little hot light on nearby wires
  var Lv = u.lampPos - P; let Ld = length(Lv); Lv /= Ld;
  let fall = u.lampI * 60.0 / (Ld * Ld + 60.0);
  col += (C_SIGNAL * max(dot(N, Lv), 0.0) * fall * 1.2 + C_EMBER * pow(max(dot(N, normalize(Lv + V)), 0.0), 30.0) * fall * 2.0) * mix(0.5, 1.0, ao);
  return col;
}
/** The spark lamp as seen by a ray (core + halo), in pixels from its projection. */
fn lampGlow(ro: vec3f, rd: vec3f, tMax: f32) -> vec3f {
  let lp = u.lampPos - ro; let tl = dot(lp, rd);
  if (tl <= 0.0 || tl > tMax) { return vec3f(0.0); }
  let apx = length(lp - rd * tl) / tl * u.focal;
  let core = exp(-apx * apx / 18.0) * 6.0;
  let halo = exp(-apx * apx / 700.0) * 0.45 + 0.025 / (1.0 + apx * apx / 12000.0);
  return (vec3f(1.0, 0.85, 0.7) * core + C_SIGNAL * halo) * u.lampI;
}
/** How far the flood has filled a cell; \`inside\` is the value within the CPU's group. */
fn fillK(cell: vec2f, inside: f32) -> f32 {
  let cc = (cell + 0.5) * ${CELLF};
  if (abs(cc.x) < u.groupHalf.x && abs(cc.y) < u.groupHalf.y) { return inside; }
  if (u.fillT < 0.0) { return 0.0; }
  let dist = max(abs(cc.x) - u.groupHalf.x, abs(cc.y) - u.groupHalf.y);
  let t0 = dist / 1100.0 + hash12(cell) * 0.1;
  let k = clamp((u.fillT - t0) / 0.22, 0.0, 1.0);
  return 1.0 - pow(1.0 - k, 3.0);
}
`;

// Phase A: the flat layer seen from above (items animated on the CPU) + the infinite lattice flooding in.
const TOP = /* wgsl */ `
fn topSample(px: vec2f) -> vec3f {
  let rd = camRay(px);
  let tp = -u.camPos.z / rd.z;
  let xy = (u.camPos + rd * tp).xy;
  let pxw = tp / u.focal; // world units per pixel on the plane
  var bd = 1e5; var br = u.rad; var bl = 0.0; var sHit = 0.0; var bo = vec2f(0.0); var who = -1;
  for (var i = 0; i < ${MAX_ITEMS}; i++) {
    if (i >= u.nItems) { break; }
    let it = u.items[i];
    let q = xy - it.xy;
    if (dot(q, q) > 420.0 && i > 0) { continue; }
    let lq = rotv(q, -it.z);
    let r = select(u.rad, u.rad0, i == 0) * it.w;
    var c: Closest;
    if (i == 0) { c = clipD(lq, u.sT0, u.sH0); } else { c = clipFull(lq); }
    if (c.d - r < bd - br) { bd = c.d; br = r; bl = select(1.0, -1.0, c.lat < 0.0) * c.d; bo = rotv(lq - c.q, it.z); sHit = c.s; who = i; }
  }
  // the flood: the infinite lattice beyond the group, cells popping in as a wave
  let cell = floor(xy / ${CELLF});
  let fk = fillK(cell, -1.0);
  if (fk > 0.0) {
    let cc = (cell + 0.5) * ${CELLF};
    let ang = select(0.0, PI * 0.5, glmod(cell.x + cell.y, 2.0) > 0.5);
    let lp = rotv(xy - cc, -ang);
    let m = clamp(floor(lp.y / 10.0 + 2.0), 0.0, 3.0);
    for (var j = 0; j < 2; j++) {
      let mm = clamp(m + f32(j) * select(-1.0, 1.0, fract(lp.y / 10.0) > 0.5), 0.0, 3.0);
      let lq = (lp - vec2f(0.0, (mm - 1.5) * 10.0)) / fk;
      let c = clipFull(lq);
      let d2 = c.d * fk;
      let r = u.rad * fk;
      if (d2 - r < bd - br) { bd = d2; br = r; bl = select(1.0, -1.0, c.lat < 0.0) * d2; bo = rotv((lq - c.q) * fk, ang); sHit = 0.0; who = 999; }
    }
  }
  let z = sqrt(max(br * br - bd * bd, 0.0));
  let N = normalize(vec3f(bo, z + 1e-4));
  let theta = atan2(z, bl);
  let cover = clamp(0.5 - (bd - br) / (pxw / min(1.0, PX_SCALE * u.detailScale)), 0.0, 1.0);
  var col = shadeWireL(vec3f(xy, z), N, -rd, theta, 2.0 * br / pxw, 1.0, 1.0);
  if (who == 0) {
    // item 0 while being drawn: white-hot at the pen, cooling fast to a dim orange hairline
    let behind = max(u.sH0 - sHit, 0.0);
    let hk = exp(-behind / 5.0);
    let hotc = heat(0.42 + 0.58 * hk) * (0.9 + 3.5 * hk);
    col = mix(col, hotc, u.hot0);
  }
  let bg = C_INK * (0.8 + 0.2 * reverseSmooth(1.1, 0.0, length(px / u.res.y)));
  return mix(bg, col, cover);
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  return vec4f(topSample(scenePx(v)), 1.0);
}
`;

// The four layers around p, nearest wins; a tie goes to the later one, as in the loop.
const MAP_UNROLLED = /* wgsl */ `
fn stackD(p: vec3f, h: f32, seed: f32) -> Hit {
  let k0 = max(floor(h / -u.pz), 0.0);
  let a = layerD(vec3f(p.xy, h + k0 * u.pz), k0 + seed);
  let b = layerD(vec3f(p.xy, h + (k0 + 1.0) * u.pz), k0 + 1.0 + seed);
  if (a.d < b.d) { return a; }
  return b;
}
fn map(p: vec3f) -> Hit {
  var a = stackD(p, p.z, 0.0);
  if (u.ceilZ < 900.0) { let b = stackD(p, u.ceilZ - p.z, 100.0); if (b.d < a.d) { a = b; } }
  return a;
}`;
// Both are loops from zero so that layerD is compiled once, not four times, in every place the map is evaluated.
const MAP_LOOP = /* wgsl */ `
fn map(p: vec3f) -> Hit {
  var best = Hit(1e9, vec4f(0.0));
  let stacks = select(1, 2, u.ceilZ < 900.0);
  for (var s = u.zero; s < stacks; s++) {
    let h = select(u.ceilZ - p.z, p.z, s == 0); let seed = select(100.0, 0.0, s == 0);
    let k0 = max(floor(h / -u.pz), 0.0);
    var stack = Hit(1e9, vec4f(0.0));
    for (var l = u.zero; l < 2; l++) {
      let k = k0 + f32(l);
      let layer = layerD(vec3f(p.xy, h + k * u.pz), k + seed);
      if (layer.d <= stack.d) { stack = layer; }
    }
    if (stack.d < best.d) { best = stack; }
  }
  return best;
}`;
// tetrahedral taps (+--, --+, -+-, +++) and the five occlusion taps
const TAPS = (loop: boolean) => /* wgsl */ `
fn calcN(p: vec3f, e: f32) -> vec3f {
  var n = vec3f(0.0);
  for (var i = ${loop ? 'u.zero' : '0'}; i < 4; i++) {
    var k = vec3f(1.0);
    if (i == 0) { k = vec3f(1.0, -1.0, -1.0); } else if (i == 1) { k = vec3f(-1.0, -1.0, 1.0); } else if (i == 2) { k = vec3f(-1.0, 1.0, -1.0); }
    n += k * mapD(p + k * e);
  }
  return normalize(n);
}
fn calcAO(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0; var sca = 1.0;
  for (var i = ${loop ? 'u.zero' : '0'}; i < 5; i++) {
    let h = 0.04 + 0.22 * f32(i);
    occ += (h - mapD(p + n * h)) * sca;
    sca *= 0.75;
  }
  return clamp(1.0 - 1.6 * occ, 0.0, 1.0);
}`;

// Phases B-D: raymarched infinite lattice (floor stack + optional ceiling stack), fog, lamp.
const MARCH = (variant: MapVariant) => /* wgsl */ `
struct Hit { d: f32, info: vec4f } // info = (lateral, height, -, layer index)
// one layer of basket-woven cells; q relative to the layer plane; k = layer index (seeds everything)
fn layerD(q: vec3f, k: f32) -> Hit {
  var info = vec4f(0.0, 0.0, 0.0, k);
  if (abs(q.z) > 1.3) { return Hit(abs(q.z) - 0.9, info); }
  var off = vec2f(0.0);
  if (k > 0.5) { off = floor(hash22(vec2f(k, 7.3)) * 4.0) * ${CELLF} + vec2f(0.0, ${HALF}) * glmod(k, 2.0); }
  let xy = q.xy + off;
  let cell = floor(xy / ${CELLF});
  let cc = (cell + 0.5) * ${CELLF};
  let ang = select(0.0, PI * 0.5, glmod(cell.x + cell.y + k, 2.0) > 0.5);
  let lp = rotv(xy - cc, -ang);
  let border = ${HALF} - max(abs(lp.x), abs(lp.y));
  var fk = 1.0;
  if (k < 0.5) { fk = fillK(cell, 1.0); }
  if (fk <= 0.0) { return Hit(max(border, 0.0) + 0.5, info); }
  let m = clamp(floor(lp.y / 10.0 + 2.0), 0.0, 3.0);
  var best = 1e5;
  let jit = select(0.0, 1.0, k > 0.5);
  for (var j = 0; j < 2; j++) {
    let mm = clamp(m + f32(j) * select(-1.0, 1.0, fract(lp.y / 10.0) > 0.5), 0.0, 3.0);
    let h = hash33(vec3f(cell, k * 7.0 + mm));
    if (jit > 0.5 && h.x < 0.1) { continue; } // a few missing clips in the deeper layers
    let cp = vec2f((h.y - 0.5) * 3.0 * jit, (mm - 1.5) * 10.0);
    let lq = rotv(lp - cp, -(h.z - 0.5) * 0.08 * jit) / fk;
    let zz = q.z - (h.x - 0.5) * 0.3 * jit;
    // cheap bounding-box bound first
    let bb = vec3f(abs(lq.x - 0.275) - 16.2, abs(lq.y) - 4.05, abs(zz / fk) - 0.45);
    let bx = length(max(bb, vec3f(0.0))) * fk;
    if (bx > 0.35) { best = min(best, bx); continue; }
    let c = clipDL(lq);
    let d2 = c.x * fk;
    let d = sqrt(d2 * d2 + zz * zz) - u.rad * fk;
    if (d < best) { best = d; info = vec4f(select(1.0, -1.0, c.y < 0.0) * d2, zz, 0.0, k); }
  }
  return Hit(min(best, max(border, 0.0) + 0.5), info);
}
// The floor stack (layers going down from z = 0) and, once it exists, the ceiling stack (going up from
// ceilZ, seeds 100+). Each stack is the nearer of the two layers around p.
${variant === 'loop' ? MAP_LOOP : MAP_UNROLLED}
fn mapD(p: vec3f) -> f32 { return map(p).d; }
${TAPS(variant !== 'flat')}
fn fogCol(rd: vec3f) -> vec3f { return C_INK * 0.9 + C_INK2 * 0.35 * exp(-abs(rd.z) * 18.0); }
fn softShadow(ro: vec3f, rd: vec3f, eps: f32) -> f32 {
  // start clear of the surface we hit (eps grows with distance: the hit tolerance does too)
  var res = 1.0; var t = 0.08 + 4.0 * eps;
  for (var i = 0; i < 28; i++) {
    let h = mapD(ro + rd * t);
    res = min(res, 8.0 * h / t);
    t += clamp(h, 0.04, 0.7);
    if (res < 0.02 || t > 14.0) { break; }
  }
  return smoothstep(0.0, 1.0, clamp(res, 0.0, 1.0));
}
fn shadeAt(ro: vec3f, rd: vec3f, t: f32) -> vec3f {
  let P = ro + rd * t;
  let info = map(P).info;
  let N = calcN(P, 0.002 + 0.0006 * t);
  let wirePx = 2.0 * u.rad * u.focal / t;
  let fogA = 1.0 - exp(-t * u.fogK);
  var sh = 1.0; var ao = 1.0;
  let eps = 0.1 * t / u.focal;
  // contact shadows and AO only where the wires are big enough on screen to read them
  let nearK = smoothstep(6.0, 16.0, wirePx);
  if (fogA < 0.97 && nearK > 0.0) {
    sh = mix(1.0, softShadow(P + N * (0.02 + 2.0 * eps), u.keyDir, eps), nearK);
    ao = mix(1.0, calcAO(P + N * eps, N), nearK);
  }
  var c = shadeWireL(P, N, -rd, atan2(info.y, info.x), wirePx, sh, ao);
  let k = select(info.w, info.w - 100.0, info.w >= 100.0);
  c *= pow(0.5, k) * select(1.0, u.lowerOn, k > 0.5 && info.w < 100.0);
  return mix(c, fogCol(rd), fogA);
}
fn trace(rd: vec3f) -> vec3f {
  let ro = u.camPos;
  let pa = 1.0 / u.focal;
  var hit = false;
  // skip the empty slab between the floor stack and the ceiling stack analytically
  let zTop = 0.75; let zBot = u.ceilZ - 0.75;
  var t = 0.02;
  if (ro.z > zTop && ro.z < zBot) {
    var te = 1e9;
    if (rd.z < -1e-5) { te = (ro.z - zTop) / -rd.z; } else if (rd.z > 1e-5) { te = (zBot - ro.z) / rd.z; }
    t = max(te - 0.05, 0.02);
  }
  let zDeep = -u.deepLayers * u.pz;
  for (var i = 0; i < u.marchSteps; i++) {
    if (t > u.fogFar) { break; }
    let p = ro + rd * t;
    let d = mapD(p);
    let pr = t * pa;
    if (d < 0.1 * pr) { hit = true; break; }
    t += max(d * 0.9, pr * (0.2 + t * 0.003));
    if (p.z < zDeep) { t = 1e5; break; }
  }
  var col = fogCol(rd);
  if (hit) { col = shadeAt(ro, rd, t); }
  return col + lampGlow(ro, rd, select(1e5, t, hit));
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let px = scenePx(v);
  // Once the slit has closed over a pixel its result is black regardless of the lattice.
  if (u.slitK >= 1.0 && abs(px.y - u.horizonY) >= u.slitH + 30.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var col = trace(camRay(px));
  let sm = reverseSmooth(u.slitH + 30.0, u.slitH, abs(px.y - u.horizonY));
  col *= mix(1.0, sm, u.slitK);
  return vec4f(col, 1.0);
}
`;

const head = () => `${FULLSCREEN}${COMMON}${sceneBlock().wgsl}\n@group(0) @binding(0) var<uniform> u: Scene;\n${GEOMETRY}${SHADE}`;
export const topShader = () => head() + TOP;
export const marchShader = (variant: MapVariant) => head() + MARCH(variant);
