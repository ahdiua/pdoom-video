#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { videoEncodingArgs, type VideoEncoding } from './encoding';

const base: VideoEncoding = { hdr: true, width: 1920, height: 1080, fps: 60, from: 0, to: 1,
  whiteNits: 203, peakNits: 1000, output: 'out.mp4', audio: 'song.m4a', extra: [], inputHdrMetadata: true };
const nvenc = videoEncodingArgs({ ...base, codec: 'hevc_nvenc', extra: ['-preset', 'p7', '-metadata', 'comment=spaces ; & stay literal'] });
assert.equal(nvenc.pixelFormat, 'rgba64le'); assert.equal(nvenc.bytesPerPixel, 8);
assert.ok(nvenc.args.indexOf('-mastering_display') < nvenc.args.indexOf('-i'));
assert.ok(nvenc.args.includes('p010le') && nvenc.args.includes('main10'));
assert.equal(nvenc.args[nvenc.args.lastIndexOf('-preset') + 1], 'p7');
assert.ok(nvenc.args.includes('comment=spaces ; & stay literal'));
assert.ok(!nvenc.args.includes('-x264-params') && !nvenc.args.includes('-crf'));
assert.throws(() => videoEncodingArgs({ ...base, codec: 'h264_nvenc' }), /10-bit/);
assert.throws(() => videoEncodingArgs({ ...base, peakNits: 100 }), /hdr-white/);
const sdr = videoEncodingArgs({ ...base, hdr: false, inputHdrMetadata: false });
assert.equal(sdr.codec, 'libx264'); assert.equal(sdr.bytesPerPixel, 4); assert.equal(sdr.pixelFormat, 'rgba');
assert.ok(!sdr.args.includes('-mastering_display'));
// P3-D65 mastering primaries; nominal light levels unless measured ones are supplied.
assert.ok(nvenc.args[nvenc.args.indexOf('-mastering_display') + 1]!.startsWith('G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)'));
assert.equal(nvenc.args[nvenc.args.indexOf('-content_light') + 1], '1000,0');
const measured = videoEncodingArgs({ ...base, codec: 'libx265', maxCLL: 811.2, maxFALL: 143.6 });
assert.equal(measured.args[measured.args.indexOf('-content_light') + 1], '812,144');
assert.ok(measured.args[measured.args.indexOf('-x265-params') + 1]!.endsWith('max-cll=812,144'));
assert.throws(() => videoEncodingArgs({ ...base, maxCLL: NaN }), /light levels/);
console.log('PASS: encoder-specific defaults, custom argv precedence, metadata placement and HDR input validation.');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // HDR export must work even when WebGPU and HDR display detection do not.
    await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
    await page.goto(`http://127.0.0.1:5173/?export=1&output=hdr10&only=loss&scale=${scale}`);
    await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 120000 });
    const result = await page.evaluate(async () => {
      const P = (window as any).__pdoom;
      if (P.error) throw new Error(P.error);
      const e = P.engine;
      const modulePath = '/src/engine/gl.ts';
      const { FSPass, makeRT } = await import(modulePath);
      const source = makeRT();
      const fixture = new FSPass(`void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec3 c = vec3(0.0);
        if (p == ivec2(1, 0)) c = vec3(1.0);
        if (p == ivec2(0, 1)) c = vec3(1000.0 / 203.0);
        if (p == ivec2(1, 1)) c = vec3(1.0, 0.0, 0.0);
        fragColor = vec4(toSRGB(c), 1.0);
      }`);
      fixture.render(e.renderer, source);
      e.hdrExport.render(e.renderer, source.texture);
      const data = await e.readExportPixelsAsync();
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const pixel = (x: number, y: number) => [0, 2, 4, 6].map((c) => view.getUint16((y * P.width + x) * 8 + c, true));
      const pixels = [pixel(0, 0), pixel(1, 0), pixel(0, 1), pixel(1, 1)];
      source.dispose(); fixture.mat.dispose();
      // The grade itself: grey and signal-orange ramps over 0..8x reference white, with the grey
      // slope computed in the shader (half-float storage is too coarse to difference).
      const postPath = '/src/engine/post.ts', colorPath = '/src/engine/hdr-color.ts';
      const { SHOULDER_GLSL } = await import(postPath);
      const { HDR_GRADE_GLSL } = await import(colorPath);
      const N = 256, ramp = makeRT(N, 3, { depthBuffer: false, pxScale: 1 });
      const curve = new FSPass(`uniform float headroom;
        ${SHOULDER_GLSL}
        ${HDR_GRADE_GLSL}
        void main() {
          float x = floor(gl_FragCoord.x) * 8.0 / ${N}.0, h = 1e-3;
          int row = int(gl_FragCoord.y);
          if (row == 0) fragColor = vec4(hdrGrade(vec3(x), headroom).r, (hdrGrade(vec3(x + h), headroom).r - hdrGrade(vec3(x), headroom).r) / h, 0.0, 1.0);
          else if (row == 1) fragColor = vec4(hdrGrade(C_SIGNAL * x, headroom), 1.0);
          else fragColor = vec4(hdrGrade(C_SIGNAL * x, 1.0) - shoulder(C_SIGNAL * x), 1.0);
        }`, { headroom: { value: 1 } });
      const gl = e.renderer.getContext() as WebGL2RenderingContext;
      const curves = [1.67, 1000 / 203].map((headroom) => {
        curve.u.headroom.value = headroom;
        curve.render(e.renderer, ramp);
        e.renderer.setRenderTarget(ramp);
        const px = new Float32Array(N * 3 * 4);
        gl.readPixels(0, 0, N, 3, gl.RGBA, gl.FLOAT, px);
        return { headroom, px: Array.from(px) };
      });
      e.renderer.setRenderTarget(null);
      ramp.dispose(); curve.mat.dispose();
      e.render(13, 1 / 60, false, { min: 4, max: 12, tol: 3 }, 0.2);
      const light = e.measureHdrLight(), samples = e.lastSamples;
      const realFrame = await e.readExportPixelsAsync();
      const realView = new DataView(realFrame.buffer, realFrame.byteOffset, realFrame.byteLength);
      let max = 0;
      for (let i = 0; i < realFrame.length; i += 8) for (const channel of [0, 2, 4]) max = Math.max(max, realView.getUint16(i + channel, true));
      const range = await P.light({ from: 13, to: 13.1, fps: 60 });
      return { pixels, max, light, range, curves, grade: e.hdrExport.grade, bytes: data.length, width: P.width, height: P.height, format: P.pixelFormat,
        samples, errors: e.errors, hdrDisplay: !!e.hdrDisplay };
    });
    const pq16 = (nits: number) => Math.round(65535 * ((3424 / 4096 + 2413 / 128 * (nits / 10000) ** (2610 / 16384)) / (1 + 2392 / 128 * (nits / 10000) ** (2610 / 16384))) ** (2523 / 32));
    const expected = [[0, 0, 0, 65535], [pq16(203), pq16(203), pq16(203), 65535],
      // the post output is Display-P3: its red primary inside BT.2020 (the slightly negative blue clips to 0)
      [pq16(1000), pq16(1000), pq16(1000), 65535], [pq16(203 * 0.75383303), pq16(203 * 0.04574385), pq16(0), 65535]];
    result.pixels.forEach((pixel, i) => pixel.forEach((value, c) => assert.ok(Math.abs(value - expected[i]![c]!) <= 10, JSON.stringify({ scale, i, c, value, expected: expected[i]![c] }))));
    assert.equal(result.bytes, result.width * result.height * 8);
    assert.equal(result.format, 'rgba64le'); assert.equal(result.hdrDisplay, false);
    assert.ok(result.max > pq16(203) && result.max <= pq16(1000) + 10);
    assert.ok(result.samples >= 4 && result.samples <= 12);
    assert.deepEqual(result.grade, { headroom: 1000 / 203, gamut: 1 });
    for (const { headroom, px } of result.curves) {
      const N = px.length / 12, x = (i: number) => i * 8 / N, grey = (i: number) => px[i * 4]!, slope = (i: number) => px[i * 4 + 1]!;
      const signal = (i: number) => [px[(N + i) * 4]!, px[(N + i) * 4 + 1]!, px[(N + i) * 4 + 2]!];
      for (let i = 0; i < N; i++) {
        const at = JSON.stringify({ scale, headroom, x: x(i) });
        assert.ok(grey(i) <= headroom + 1e-3 && Math.max(...signal(i)) <= headroom + 1e-3, at);
        if (x(i) < 0.7) assert.ok(Math.abs(grey(i) - x(i)) < 2e-3, at); // the SDR grade below the knee
        if (i) {
          assert.ok(grey(i) >= grey(i - 1) && signal(i)[0]! >= signal(i - 1)[0]!, at);
          assert.ok(Math.abs(slope(i) - slope(i - 1)) < 0.05, at); // one smooth roll-off, no knee at reference white
        }
        for (let c = 0; c < 3; c++) assert.ok(Math.abs(px[(2 * N + i) * 4 + c]!) < 1e-4, at); // headroom 1 is the SDR shoulder
      }
      // signal orange at 3x: the SDR shoulder triples its green/red ratio (the drift to yellow). With the
      // default headroom the hue stays within a quarter of the palette's; a dim display keeps some drift.
      const [r, g] = signal(Math.round(3 * N / 8)), [r0, g0] = signal(Math.round(0.5 * N / 8));
      assert.ok(g! / r! < (headroom > 4 ? 1.25 : 2) * g0! / r0!, JSON.stringify({ scale, headroom, ratio: g! / r!, palette: g0! / r0! }));
    }
    // measured light levels agree with the packed frame and stay inside the grading ceiling
    assert.ok(Math.abs(pq16(result.light.max) - result.max) <= 10, JSON.stringify({ light: result.light, max: result.max }));
    assert.ok(result.light.average > 0 && result.light.average < result.light.max);
    assert.equal(result.range.frames, 6);
    assert.ok(result.range.maxCLL > 203 && result.range.maxCLL <= 1000 && result.range.maxFALL > 0 && result.range.maxFALL < result.range.maxCLL, JSON.stringify(result.range));
    assert.deepEqual(result.errors, []); assert.deepEqual(errors, []);
    console.log(`PASS ${result.width}x${result.height}: PQ reference levels, P3 -> BT.2020 conversion, byte order, grade continuity and hue, light levels, high-range scene data, adaptive sampling and no WebGPU dependency.`);
    await page.close();
  }
} finally { await browser.close(); }
