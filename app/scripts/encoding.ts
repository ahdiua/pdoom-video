// Encoder-independent raw input and color conversion, plus encoder-specific
// defaults. Extra output arguments are appended as argv entries, never a shell.
export interface VideoEncoding {
  hdr: boolean;
  codec?: string;
  preset?: string;
  crf?: string;
  cq?: string;
  x264?: string;
  x265?: string;
  width: number;
  height: number;
  fps: number;
  from: number;
  to: number;
  audio?: string;
  output: string;
  whiteNits: number;
  peakNits: number;
  inputHdrMetadata?: boolean;
  extra: string[];
}

export function videoEncodingArgs(o: VideoEncoding) {
  const codec = o.codec ?? (o.hdr ? 'libx265' : 'libx264');
  if (o.hdr && ['libx264', 'h264_nvenc', 'libopenh264'].includes(codec)) throw new Error('--hdr requires a 10-bit HEVC or AV1 encoder (for example hevc_nvenc or libx265).');
  if (!Number.isFinite(o.fps) || o.fps <= 0 || !Number.isFinite(o.from) || !Number.isFinite(o.to) || o.from < 0 || o.to <= o.from) throw new Error('Require fps > 0 and 0 <= from < to.');
  if (o.hdr && (!Number.isFinite(o.whiteNits) || !Number.isFinite(o.peakNits) || o.whiteNits <= 0 || o.peakNits < o.whiteNits || o.peakNits > 10000)) throw new Error('Require 0 < --hdr-white <= --hdr-peak <= 10000.');
  if (o.extra.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Custom FFmpeg arguments must be strings without NUL bytes.');
  const nvenc = codec.endsWith('_nvenc');
  const pixelFormat = o.hdr ? 'rgba64le' : 'rgba';
  const outFormat = o.hdr ? (nvenc ? 'p010le' : 'yuv420p10le') : 'yuv420p';
  const mastering = `G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(${Math.round(o.peakNits * 10000)},1)`;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', pixelFormat,
    '-s', `${o.width}x${o.height}`, '-r', String(o.fps)];
  if (o.hdr && o.inputHdrMetadata) args.push('-mastering_display', mastering, '-content_light', `${Math.ceil(o.peakNits)},0`);
  args.push('-i', 'pipe:0');
  if (o.audio) args.push('-ss', String(o.from), '-t', String(o.to - o.from), '-i', o.audio);
  args.push('-map', '0:v:0');
  if (o.audio) args.push('-map', '1:a:0');
  const filter = o.hdr
    // Input is already full-range PQ/BT.2020 RGB16, not linear RGB and not SDR.
    ? 'vflip,format=gbrp16le,zscale=pin=bt2020:tin=smpte2084:min=gbr:rin=full:p=bt2020:t=smpte2084:m=bt2020nc:r=limited:d=error_diffusion,format=yuv420p10le'
    : 'vflip,scale=out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709';
  args.push('-vf', filter, '-c:v', codec, '-pix_fmt', outFormat);
  if (nvenc) {
    args.push('-preset', o.preset ?? 'p6', '-rc', 'vbr', '-cq', o.cq ?? o.crf ?? '18', '-b:v', '0');
    if (o.hdr && codec === 'hevc_nvenc') args.push('-profile:v', 'main10');
  } else if (codec === 'libx264' || codec === 'libx265') {
    args.push('-preset', o.preset ?? 'slow', '-crf', o.crf ?? (o.hdr ? '18' : '16'));
    if (codec === 'libx264') args.push('-tune', 'grain', '-x264-params', o.x264 ?? 'aq-mode=3');
    else {
      // Nominal BT.2020/D65 mastering volume. MaxFALL is left unknown (0),
      // rather than inventing a measured average luminance for the content.
      const hdrParams = `hdr10=1:repeat-headers=1:master-display=${mastering}:max-cll=${Math.ceil(o.peakNits)},0`;
      args.push('-x265-params', [o.hdr ? hdrParams : '', o.x265 ?? ''].filter(Boolean).join(':') || 'aq-mode=3');
    }
  } else {
    if (o.preset) args.push('-preset', o.preset);
    if (o.crf) args.push('-crf', o.crf);
  }
  if (o.hdr) args.push('-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv');
  if (o.audio) args.push('-c:a', 'copy', '-shortest');
  if (/\.(mp4|mov|m4v)$/i.test(o.output)) args.push('-movflags', '+faststart');
  args.push(...o.extra, o.output);
  return { args, codec, pixelFormat, bytesPerPixel: o.hdr ? 8 : 4 };
}
