// Shared display/export HDR grade. Expects shoulder() to be declared first.
export const HDR_GRADE_GLSL = /* glsl */ `
vec3 hdrGrade(vec3 color, float headroom) {
  vec3 base = shoulder(color);
  if (headroom <= 1.0) return base;
  float room = headroom - 1.0;
  float peak = max(color.r, max(color.g, color.b));
  return base * (1.0 + room * (1.0 - exp(-max(peak - 1.0, 0.0) / room)));
}`;

export const HDR_PQ_GLSL = /* glsl */ `
// Linear sRGB/BT.709 (D65) -> linear BT.2020 (D65), BEFORE PQ encoding.
vec3 toRec2020(vec3 rgb) {
  return mat3(0.62740390, 0.06909729, 0.01639144,
              0.32928304, 0.91954040, 0.08801331,
              0.04331306, 0.01136231, 0.89559525) * rgb;
}
// ST 2084 OETF: absolute luminance in cd/m², normalized against 10,000 nits.
vec3 toPQ(vec3 nits) {
  vec3 y = pow(clamp(nits / 10000.0, 0.0, 1.0), vec3(2610.0 / 16384.0));
  return pow((3424.0 / 4096.0 + (2413.0 / 128.0) * y) / (1.0 + (2392.0 / 128.0) * y), vec3(2523.0 / 32.0));
}`;
