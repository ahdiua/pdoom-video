// Shared display/export HDR grade. Preview and export use the same defaults.
export const HDR_WHITE_NITS = 203;
export const HDR_PEAK_NITS = 1000;
export const HDR_DEFAULT_HEADROOM = HDR_PEAK_NITS / HDR_WHITE_NITS;
export const HDR_MAX_HEADROOM = 10;

export interface HdrGrade {
  /** Peak luminance as a multiple of reference white (>= 1). */
  headroom: number;
  /** 0..1: how far light above reference white reaches into Display-P3. 0 keeps the BT.709 colours exactly. */
  gamut: number;
  /** 0..1: 0 lets a hot orange drift to yellow as its red saturates (the SDR look), 1 holds its hue. */
  hue: number;
  /** 0..1: the share of bloom and halation removed (they fake brightness in SDR; here there is real headroom). */
  glow: number;
}

export const HDR_LOOK = { gamut: 1, hue: 0.6, glow: 0.3 };
/** The settings that are not a headroom, in the order of HDR_LOOK: URL and command-line names are `hdr-<key>`. */
export const HDR_LOOK_KEYS = ['gamut', 'hue', 'glow'] as const;

/** A grade from loose input (URL parameters, sliders): missing or malformed values take the defaults. */
export function hdrGradeFrom(get: (key: 'headroom' | (typeof HDR_LOOK_KEYS)[number]) => unknown, maxHeadroom = HDR_MAX_HEADROOM): HdrGrade {
  const number = (key: Parameters<typeof get>[0], fallback: number, max: number, min = 0) => {
    const raw = get(key), x = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
  };
  return { headroom: number('headroom', HDR_DEFAULT_HEADROOM, maxHeadroom, 1),
    gamut: number('gamut', HDR_LOOK.gamut, 1), hue: number('hue', HDR_LOOK.hue, 1), glow: number('glow', HDR_LOOK.glow, 1) };
}

// Expects shoulder() to be declared first.
export const HDR_GRADE_GLSL = /* glsl */ `
// The SDR shoulder with its ceiling raised to top: identity below the knee, then one smooth
// roll-off (no second knee at reference white). top = 1 is exactly the SDR curve.
vec3 hdrCurve(vec3 x, float top) {
  const float k = 0.72;
  float span = top - k;
  return mix(x, k + span * (1.0 - exp(-(x - k) / span)), step(k, x));
}
vec3 hdrGrade(vec3 color, float headroom, float keepHue) {
  if (headroom <= 1.0) return shoulder(color);
  float peak = max(color.r, max(color.g, color.b));
  // Per channel, a hot orange drifts to yellow as its red saturates (the SDR look); scaling by
  // the peak channel keeps its hue. The more headroom there is, the less of the drift is needed.
  vec3 drift = hdrCurve(color, headroom);
  vec3 hue = color * (hdrCurve(vec3(peak), headroom).x / max(peak, 1e-5));
  vec3 y = mix(drift, hue, keepHue * (1.0 - 1.0 / headroom));
  // white-hot only far beyond what the display can show
  return mix(y, vec3(headroom), smoothstep(2.0 * headroom, 12.0 * headroom, peak) * 0.85);
}`;

export const HDR_GAMUT_GLSL = /* glsl */ `
// Linear BT.709 -> linear Display-P3 (both D65).
vec3 toP3(vec3 rgb) {
  return mat3(0.82246197, 0.03319420, 0.01708263,
              0.17753803, 0.96680580, 0.07239744,
              0.00000000, 0.00000000, 0.91051993) * rgb;
}
// Graded BT.709 -> the P3 output. Up to reference white the conversion is colorimetric: flat
// fills (a word set in signal orange) keep their SDR colour. Light above it, the glow, is handed
// to the P3 primaries with the same numbers (a purer orange, neutrals unchanged), fully from
// halfway into the headroom.
vec3 widenGamut(vec3 rgb, float amount, float headroom) {
  float peak = max(rgb.r, max(rgb.g, rgb.b));
  float glow = smoothstep(1.0, 1.0 + max(0.5 * (headroom - 1.0), 1e-3), peak);
  return mix(toP3(rgb), rgb, amount * glow);
}`;

export const HDR_PQ_GLSL = /* glsl */ `
// Linear Display-P3 (D65) -> linear BT.2020 (D65), BEFORE PQ encoding.
vec3 p3ToRec2020(vec3 rgb) {
  return max(mat3(0.75383303, 0.04574385, -0.00121034,
                  0.19859737, 0.94177722, 0.01760172,
                  0.04756960, 0.01247893, 0.98360862) * rgb, 0.0);
}
// ST 2084 OETF: absolute luminance in cd/m², normalized against 10,000 nits.
vec3 toPQ(vec3 nits) {
  vec3 y = pow(clamp(nits / 10000.0, 0.0, 1.0), vec3(2610.0 / 16384.0));
  return pow((3424.0 / 4096.0 + (2413.0 / 128.0) * y) / (1.0 + (2392.0 / 128.0) * y), vec3(2523.0 / 32.0));
}`;
