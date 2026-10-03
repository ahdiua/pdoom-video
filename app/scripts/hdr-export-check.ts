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
      e.render(13, 1 / 60, false, { min: 4, max: 12, tol: 3 }, 0.2);
      const realFrame = await e.readExportPixelsAsync();
      const realView = new DataView(realFrame.buffer, realFrame.byteOffset, realFrame.byteLength);
      let max = 0;
      for (let i = 0; i < realFrame.length; i += 8) for (const channel of [0, 2, 4]) max = Math.max(max, realView.getUint16(i + channel, true));
      return { pixels, max, bytes: data.length, width: P.width, height: P.height, format: P.pixelFormat,
        samples: e.lastSamples, errors: e.errors, hdrDisplay: !!e.hdrDisplay };
    });
    const pq16 = (nits: number) => Math.round(65535 * ((3424 / 4096 + 2413 / 128 * (nits / 10000) ** (2610 / 16384)) / (1 + 2392 / 128 * (nits / 10000) ** (2610 / 16384))) ** (2523 / 32));
    const expected = [[0, 0, 0, 65535], [pq16(203), pq16(203), pq16(203), 65535],
      [pq16(1000), pq16(1000), pq16(1000), 65535], [pq16(203 * 0.62740390), pq16(203 * 0.06909729), pq16(203 * 0.01639144), 65535]];
    result.pixels.forEach((pixel, i) => pixel.forEach((value, c) => assert.ok(Math.abs(value - expected[i]![c]!) <= 10, JSON.stringify({ scale, i, c, value, expected: expected[i]![c] }))));
    assert.equal(result.bytes, result.width * result.height * 8);
    assert.equal(result.format, 'rgba64le'); assert.equal(result.hdrDisplay, false);
    assert.ok(result.max > pq16(203) && result.max <= pq16(1000) + 10);
    assert.ok(result.samples >= 4 && result.samples <= 12);
    assert.deepEqual(result.errors, []); assert.deepEqual(errors, []);
    console.log(`PASS ${result.width}x${result.height}: PQ reference levels, BT.709 -> BT.2020 conversion, byte order, high-range scene data, adaptive sampling and no WebGPU dependency.`);
    await page.close();
  }
} finally { await browser.close(); }
