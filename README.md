# I'm Upping My P(doom) — music video

> **This is a fork of [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video)** with preview performance optimizations, interactive controls, shader warmup and lossless audio handling. See [What's different in this fork](#whats-different-in-this-fork) below.

A generative, code-rendered music video with word-synced karaoke typography. Every frame is a deterministic function of song time. The browser preview and offline 1080p60 (or 4K60) export share the same scenes; preview uses lighter spatial sampling for real-time playback, while export retains full supersampling.

**Watch it in 4K on YouTube:** https://www.youtube.com/watch?v=5EoO5413dBY

The YouTube upload is an earlier render: it averages only 4 sub-frames per frame for motion blur, so fast motion shows stepped copies, and YouTube's compression smears the film grain. For the best version, render it locally (see [Render the video](#render-the-video)): the current code picks up to 324 sub-frames per frame where the motion needs them.

The video was made with Claude (Opus 5.5) in Claude Code: the concept and treatment, the lyric alignment and audio analysis, the renderer, every scene and the renders were all worked out in conversation with Claude.

The song is not ours: see [Credits](#credits) for who wrote and made it.

The concept, style bible and plate-by-plate treatment are in [`docs/TREATMENT.md`](docs/TREATMENT.md). The engine and scene API are documented in [`docs/ENGINE.md`](docs/ENGINE.md).

## What's different in this fork

This fork focuses on making the **browser preview genuinely real-time** and pleasant to work with — the upstream code renders beautiful exports but the preview could stall on first-use shader compilation and ran heavy GPU passes even when paused. The changes below are additive and do not alter export output.

### 🚀 Preview performance (100–200× GPU speedup at 4K)

The largest bottleneck was Canvas2D texture upload to `SRGB8_ALPHA8` via Chrome/ANGLE D3D11. `FSPass` now caches an RGBA8 upload and a half-float linear render target per sRGB canvas texture, decoding sRGB before filtering and mipmap generation. Unchanged textures and empty HUDs are reused; disposal and context restoration invalidate the cache. Other optimizations:

| Technique | Detail |
|---|---|
| **GPU sRGB conversion cache** | Each canvas texture is uploaded once as RGBA8 and decoded to a half-float linear RT via a shader pass; unchanged versions are reused |
| **Single spatial tap in preview** | Shaders that take 4 rotated-grid taps in export (`SS_TAP`) use 1 centred tap in preview — 4× cheaper with negligible quality loss at screen res |
| **Baked static geometry** | The loss terrain's vertex heights are computed once during `init()` instead of every frame |
| **Paused redraw suppression** | Paused previews skip `requestAnimationFrame` draws unless the user seeks, resizes, or restores the WebGL context |

Measured on Windows Chrome 154, RTX 4070 SUPER at true 3840×2160 with grain and blur enabled:

| Scene | Original GPU ms/frame | Optimized GPU ms/frame |
|---|---:|---:|
| loss chart (10.64 s) | 173.5 | 0.6 |
| loss terrain (13 s) | 185.9 | 1.5 |
| paperclips overhead (98 s) | 191.1 | 1.5 |
| paperclips lattice (100 s) | 198.8 | 12.5 |
| paperclips ceiling (101 s) | 221.9 | 15.8 |

### Adaptive 3D detail for slower GPUs

Shoggoth, paperclips and Ilya still contain expensive raymarching shaders. Preview now defaults to **3D detail: Auto**: asynchronous GPU timers measure these passes, including repeated draws during startup after initial compilation/uploads. A pass that takes over 10 ms reduces its internal resolution to target about 7.5 ms, leaving time for composition and post-processing: a steady frame rate reads as quality before the last step of 3D resolution does. Quality recovers slowly to avoid oscillating. Browsers without GPU timers start touch devices at reduced detail and can reduce it further after sustained slow playback.

Click **3D detail** or press **Q** to cycle:

- **Auto** — adapt only these expensive 3D layers; minimum detail is 540p for paperclips/Ilya and 270p for Shoggoth's geometry buffer.
- **Full** — use the original internal resolution and the export's step counts.

In Auto and Performance the paperclip lattice also marches 80 steps instead of 128 and stops below its third layer instead of its fifth. The steps saved were spent on grazing rays already deep in the fog, and the layers dropped are at most an eighth as bright and seen only through gaps, so the picture is the same to the eye and 5–16% cheaper (4K, RTX 4070 SUPER). Shortening its contact shadows was tried and rejected: light leaks under the ceiling. Shoggoth has no such slack: its cost is the primary march through 25 primitives, and fewer steps or a longer stride show before they save 3%.
- **Performance** — paperclips/Ilya render their 3D backgrounds at 720p; Shoggoth uses a 360p geometry buffer. Fine geometry becomes softer, but lyrics, overlays, particles, Shoggoth's analytic eyes/mask and output resolution stay native.

This setting persists across preview reloads. `?detail=full` or `?detail=performance` overrides it for a link. SDR and HDR offline exports always retain full detail. HDR preview can use any detail mode.

The shaders also avoid redundant work at full detail: Shoggoth evaluates engraving coordinates only at the final ray hit, completed paperclips use analytic closest points without trigonometry, and Ilya skips unlit haze samples and unnecessary shading of its emissive screen.

Example **current Full vs Performance**, Chrome / RTX 4070 SUPER, 1080p, median whole-frame GPU time over 30 measured frames after 12 warm-up frames (`preview-perf.ts --preview --detail full|performance`):

| Scene / time | Full | Performance |
|---|---:|---:|
| Shoggoth (34 s) | 2.27 ms | 1.51 ms |
| Paperclips (100 s) | 5.17 ms | 2.37 ms |
| Paperclips ceiling (101 s) | 6.33 ms | 3.45 ms |
| Ilya room (133 s) | 4.12 ms | 1.73 ms |

These desktop measurements are not phone/iGPU FPS predictions. `detail-check.ts` separately tests slow-GPU adaptation with simulated query costs, no-timer touch fallback, reversible quality switching, no new shader compilation and unchanged export pixels.

### 🎮 Interactive preview controls

- **Keyboard shortcuts** for resolution (`r`), fullscreen (`f`), motion blur (`b`) and film grain (`g`), plus a click-friendly control bar
- Resolution button shows both current and target (e.g. `1080p (Switch to 2160p)`) — no guessing
- Fullscreen button moved to the far right (standard placement)
- Space key always toggles play/pause, even when a button or the scrub bar has focus
- Motion blur and grain **default to off** in preview for lighter playback; preferences persist across resolution reloads via session storage
- Press `h` to hide controls; the preview fills the vacated space

### ⚡ Shader warmup system

`Engine.warmup()` runs before playback controls or audio are enabled. Each scene provides `warmupTimes()` — by default its start, middle and end; scenes with short internal transitions (paperclip lattice, outro rewind) add explicit times. For each time the engine:

1. Routes draw calls through `WebGLRenderer.compileAsync` (preserving real render targets, cameras and materials)
2. Renders a real offscreen frame and waits on a GPU fence, initializing texture uploads, geometry buffers and driver pipelines
3. Updates a progress bar and yields to the event loop to keep the loading screen responsive

With Auto 3D detail, the three expensive scenes also repeat their initialized frames to measure steady-state GPU cost before playback. Initial allocation and first-use driver work are excluded from this calibration.

Most of the wait is the raymarchers, and most of their compile time was the same distance function compiled over and over: once per normal tap, per occlusion tap, per layer. Their loops now start at a uniform that is always zero (`ZERO`), which the compiler cannot unroll, so the function is compiled once per loop; the paperclip lattice is also written as loops over its two stacks and two layers. The pictures are unchanged (paperclips bit for bit; Shoggoth and Ilya within rounding). Cold preparation on the test machine (a fresh Chrome profile, RTX 4070 SUPER, 1080p) went from 13.3 s to 7.4 s and the longest single stall from 5.2 s to 1.6 s: paperclips 5.4 s → 1.2 s, Ilya's room (first compiled by the loom scene, which shows it) 2.9 s → 1.7 s, Shoggoth 1.4 s → 1.0 s. Chrome caches compiled shaders, so this is the first visit's wait. The measurements, the trade-off taken for the paperclip lattice and what was tried and rejected are in [`docs/ENGINE.md`](docs/ENGINE.md#raymarcher-compile-time-and-preview-cost).

A `warmup-check.ts` script validates both 1080p and 2160p: it counts native shader compilations after readiness, verifies progress reporting, and compares exact pixels before/after preparation. `?warmup=0` is a dev escape hatch; `?export=1` never warms up.

### 🔊 Lossless AAC audio

The export pipeline copies the AAC track from `audio/pdoom.m4a` directly into the MP4 container without re-encoding, preserving the original audio quality. The M4A was losslessly remuxed from the supplied source AAC; the redundant raw AAC file is not retained in the working tree.

### 🧪 Validation scripts

From `app/`, `bun run check` runs both typechecks and then every check below, one after another, against a private preview server it starts itself (about three minutes; needs Chrome and a GPU). `--only hdr,detail` and `--skip preview` select checks, `--list` names them. Each script also runs on its own against a server at `PDOOM_URL` (default `http://127.0.0.1:5173`). Deployment does not run any of this: Cloudflare builds and publishes whatever is pushed to `main` ([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)), and there is no CI.

| Script | Purpose |
|---|---|
| `check.ts` | The runner behind `bun run check` |
| `determinism-check.ts` | Every timeline entry at three times gives the same pixels whether reached from far before, the previous frame or later in the song |
| `hdr-check.ts`, `hdr-export-check.ts` | The HDR preview path and the HDR export (described under those sections) |
| `hdr-display-check.ts` | The HDR preview on the real display, in a visible window (`bun run check --only hdr-display`; skips on an SDR display) |
| `preview-check.ts` | Regression tests: all scene midpoints + cut boundaries, both effect settings, paused rendering, grain, blur, fullscreen, resolution switching, playhead/settings retention |
| `warmup-check.ts` | Shader prep validation: 1080p + 2160p, post-readiness compilation counts, progress reporting, pixel-exact before/after comparison |
| `preview-perf.ts` | GPU benchmark: `EXT_disjoint_timer_query_webgl2`, discards warm-up and disjoint measurements, captures reference PNGs for image regression; `--burst` for comparing shader variants |
| `compile-perf.ts` | Cold shader-preparation time per scene (a fresh browser profile each run), `--jobs` for the slow steps |
| `mobile-check.ts` | Touch viewport checks: hidden-control recovery, landscape layout, orientation-lock fallback, and fullscreen exit |
| `detail-check.ts` | Adaptive 3D detail, slow-GPU simulation, no-timer touch fallback, native-detail restoration, controls and export isolation |

## Layout

- `audio/pdoom.m4a` — the playback/export song (the Claude-Pop version, see Credits), losslessly remuxed from the supplied source AAC without re-encoding.
- `audio/pdoom.mp3` — the original timing-analysis reference. The replacement AAC has the same duration and no measured alignment offset, so existing lyric/beat timings remain valid.
- `lyrics/lyrics.src.js` — the original line-level lyrics (approximate timings).
- `analysis/` — Python (uv) tools that produced the timing data: Demucs stem separation, CTC forced alignment cross-checked with Whisper, beat/downbeat/onset analysis. See `analysis/align.py` and `analysis/analyze.py`.
- `data/lyrics.json` — word-level (and some syllable-level) lyric timings.
- `data/audio.json` — tempo (132.007 BPM), beats, downbeats, sections, drum/vocal onsets and loudness envelopes.
- `app/` — the renderer: TypeScript + three.js, bun + Vite.
  - `src/engine/` — renderer core: timeline playback, post-processing (bloom, halation, grain), typography (Archivo, IBM Plex Mono, Cormorant Garamond, single-stroke plotter fonts), GPU line batches, HUD.
  - `src/scenes/` — one module per plate (`open`, `loss`, `prompt`, `hook`, `room`, `shoggoth`, `spacetime`, `ascent`, `bureau`, `leftturn`, `paperclips`, `fuse`, `stack`, `dense`, `loom`, `ilya`, `outro`) plus shared motifs.
  - `src/timeline.ts` — the edit: scene windows anchored to lyric lines and snapped to the beat grid.
  - `scripts/render.ts` — offline renderer (headless Chrome → raw frames over WebSocket → ffmpeg).
- `out/` — renders (not in the repo).

## Requirements

[bun](https://bun.sh), Google Chrome (the offline renderer drives it headless through playwright-core) and ffmpeg with libx264. The analysis tools need [uv](https://docs.astral.sh/uv/); the renderer doesn't.

## Preview

```sh
cd app
bun install
bunx vite
```

Open http://localhost:5173 and use the keys below. `?t=23` starts at a given time.

Before playback, a **Preparing preview** screen compiles shaders asynchronously and renders representative frames offscreen. This moves first-use shader/texture/buffer stalls (especially shoggoth and paperclips) into startup. The progress bar disappears when preparation finishes; the requested start time is preserved. New resolutions are prepared again after switching. First startup can take several seconds; browser/driver caches may make later visits faster. For development or cold-start profiling, `?warmup=0` bypasses preparation. Offline exports skip it automatically.

| Key | Action |
|---|---|
| space | play / pause |
| ← / → | seek ±1 s (±5 s with shift) |
| `,` / `.` | step one frame |
| `[` / `]` | previous / next scene |
| `l` | loop the current scene |
| `h` | hide the UI |
| `r` | switch 1080p / 2160p |
| `q` | cycle 3D detail: Auto / Full / Performance |
| `f` | enter / exit fullscreen |
| `b` | toggle scene motion blur |
| `g` | toggle film grain |

The control bar also has buttons for playback, resolution (clearly displaying the current and target resolution, e.g. `1080p (Switch to 2160p)`), 3D detail, motion blur, film grain, and a right-aligned fullscreen button. Press `h` again to restore hidden controls; the preview fills the space they occupied.

On phones, hidden controls can be restored with the floating **Show controls** button or by tapping the picture. Revealing controls does not pause playback. Fullscreen requests landscape orientation when supported; otherwise the player uses a rotated landscape layout until the device itself rotates. Browsers without page fullscreen use an **expanded view** inside the browser window, so browser toolbars may remain. The fullscreen/expanded-view button exits the mode and releases any orientation lock.

Resolution switching rebuilds the page at the selected physical resolution, retaining the playhead, loop and effect settings. Playback resumes when the browser permits it; fullscreen must be re-entered after a resolution change. Scene motion blur and film grain default to off in preview for lighter playback, and effect preferences persist across resolution reloads in the browser tab's session. Motion blur controls the scenes' authored camera/digit/geometry smears; the preview still uses one temporal sample. Export's multi-sample motion blur is controlled separately by `--samples` / `--shutter` and is unaffected by preview settings.

Paused previews redraw only when needed. Canvas text uploads use a GPU colour-conversion pass to avoid the slow Canvas2D-to-sRGB upload path observed on Chrome/ANGLE D3D11. Paperclips and other supersampled shaders use one centred spatial sample in preview, trading some edge smoothing for speed. Export keeps the original four spatial taps. See [performance validation](docs/ENGINE.md#preview-performance-validation) for measurements and checks.

### Native WebGPU experiment (frozen)

A separate native WebGPU/WGSL port of the Paperclips plate lives at
`/webgpu-preview.html?scale=2&t=100`. It renders the complete plate and
post-processing chain at fixed Full preview quality and falls back to the
WebGL preview. It was built to answer one question, whether a like-for-like
port is faster, and the answer on the test machine was no. It is **frozen**:
a snapshot kept compiling for comparison, not kept in step with the scene,
and WebGL remains the only renderer. See [the report](docs/WEBGPU.md) for
the results and for what frozen means in practice.

### Experimental HDR preview

The **HDR** button (or `?hdr=1`) enables an experimental display bridge: scenes keep rendering in WebGL, and a small WebGPU pass presents their floating-point output through an extended-range canvas. Switching reloads at the current playhead. It requires HTTPS/localhost, WebGPU, a floating-point WebGL drawing buffer, and a browser reporting `(dynamic-range: high)`. Unsupported configurations and GPU-device loss fall back to SDR. The default preview and default exports remain SDR; HDR video export has its own `--hdr` option below.

The HDR grade is the SDR grade with its ceiling raised: identical below the tone shoulder's knee, then one smooth roll-off to the display's headroom instead of to reference white. Hot orange keeps its hue instead of drifting to yellow, the glow is trimmed slightly, and the picture is output in **Display-P3**: flat colour (a word set in orange) keeps its SDR colour, and only light above reference white, the glow, becomes a purer orange than sRGB can show. Preview and export share the default: 1000-nit peak over 203-nit white, about **4.93× reference white**.

Four sliders appear with the HDR button and regrade live; all are kept in the URL:

- **Headroom** (`?hdr-headroom=`) is the display's peak brightness as a multiple of its SDR white. The browser does not report it, and everything above the real value clips. **Test card** shows boxes at 1× to 10× SDR white, each with a slightly dimmer square inside: set Headroom to the brightest box whose square you can still see. In Chrome, `chrome://gpu` lists it as *HDR relative maximum luminance*; it depends on the panel and on the system's SDR brightness setting (a 400-nit monitor with SDR white at 240 nits gives 1.67).
- **P3 glow** (`?hdr-gamut=`, default 100%) is how far the glow reaches into Display-P3; 0% keeps every colour as in SDR. Judge it on a spark or a fuse: too high and the glow looks redder and more neon than the flat orange next to it.
- **Hold hue** (`?hdr-hue=`, default 60%) sets the colour of the hottest orange. At 0% a spark's core turns yellow as it gets brighter, as in SDR; at 100% it stays the palette's orange.
- **Trim glow** (`?hdr-glow=`, default 30%) removes part of the soft halo around bright things. Raise it if dark areas next to a spark look foggy, lower it if sparks look like hard dots.

SDR screenshots and numerical buffer checks cannot establish the actual brightness or colour shown by an HDR monitor; judge the grade on the display.

For diagnostics, `?hdr=test` forces the HDR pipeline even on a reported SDR display, and `?hdr=bridge` uses the same bridge with SDR grading to isolate transport overhead. Both display **HDR: Test** and do not claim the screen is showing HDR. `bun scripts/hdr-check.ts` checks high-range pixels through the final output, orientation, the live headroom control, and fallback behavior; `bun scripts/hdr-perf.ts` compares warmed SDR/bridge/HDR previews at 1080p and 4K. Run GPU benchmarks sequentially.

## Render the video

```sh
cd app
bun scripts/render.ts video --samples auto --shutter 0.2 --out ../out/pdoom.mp4
```

- **Output:** 1920×1080 at 60 fps, x264 CRF 16. The source AAC audio is copied directly, without another lossy encode.
- **Motion blur:** every frame is the average of many sub-frames spread over a short shutter (`--shutter 0.2`, a fifth of the frame time), so fast motion leaves a continuous streak instead of a few stepped copies. `--samples auto` picks the count per frame: 12 for a still frame, 36 for ordinary camera motion, 108 or 324 for whips, slams and fast zooms. It stops once more sub-frames would no longer change the image by more than `--tol` levels of 255 (default 3). `--samples N` takes a fixed N instead (`--samples 4` makes a quick draft). How it works: "Motion blur and sampling" in [`docs/ENGINE.md`](docs/ENGINE.md).
- **Other modes:** `stills`, `sheet` (contact sheets, `--cuts` for every scene boundary), `perf`, and `plates` (regenerates `public/plates/`, the stills used by the outro's rewind montage; rerun it after changing a scene).

### 4K

```sh
cd app
bun scripts/render.ts video --scale 2 --samples auto --shutter 0.2 --x264 aq-mode=3:rc-lookahead=30 --out ../out/pdoom-4k.mp4
```

- **Output:** a true 3840×2160 render (not an upscale): every layer, line and shader is rendered at the physical resolution. Scenes are laid out in 1920×1080 logical pixels, so the 4K frame looks like the 1080p one, only sharper.
- **Cost:** GPU-bound. A frame takes from about 40 ms (a still frame) to over 10 s (the ray-marched rooms at 108–324 sub-frames). The whole song took about 2.5 hours on an M5 Pro, rendered as segments in two parallel pipelines (`--from`/`--to`, then a lossless concat). Each pipeline uses about 5 GB for headless Chrome plus about 4 GB for ffmpeg; the shorter x264 lookahead above keeps ffmpeg's memory down.
- **Encoding:** the film grain is rendered per 4K pixel, which is expensive to encode: at the default CRF 16 the file runs at about 670 Mbit/s (13 GB for the song, 8× the 1080p file), `--crf 18` gives about 450 Mbit/s and `--crf 20` about 230 Mbit/s.
- `--scale 2` works with every mode. `stills` then saves full-resolution PNGs, and `perf` measures 4K frame times. In the browser preview, add `&scale=2` to the URL.

## HDR video export and custom FFmpeg options

From `app/`, export a 4K HDR video using the NVIDIA HEVC encoder:

```sh
bun scripts/render.ts video --hdr --codec hevc_nvenc --scale 2 --preset p6 --cq 18 --samples auto --shutter 0.2 --out ../out/pdoom-hdr.mp4 -- -spatial-aq 1 -aq-strength 8
```

- `--hdr` also works with `stills`: `bun scripts/render.ts stills --hdr --t 4.14,13 --out ../out/wip/hdr` writes 16-bit PNGs tagged PQ / BT.2020 (a `cICP` chunk), graded exactly like the video. Chrome shows them as HDR; a viewer that ignores the tag shows them dark and flat. `sheet` stays SDR.
- `--hdr` outputs **10-bit PQ (ST 2084) / BT.2020** video. The frame stays floating-point through grading and is packed as 16-bit PQ RGB for FFmpeg, so this does not expand an already-clipped 8-bit SDR image. HDR export does not require WebGPU, an HDR display, or Windows HDR to be enabled.
- `--hdr-white 203` sets reference white in nits; `--hdr-peak 1000` sets the grading ceiling. Their ratio is the headroom, and the defaults match the preview's. To export what a tuned preview showed, set `--hdr-peak` to 203 × its headroom and copy the other three values. These are mastering targets, not measurements of your display.
- `--hdr-gamut 1`, `--hdr-hue 0.6` and `--hdr-glow 0.3` are the preview's P3 glow, Hold hue and Trim glow sliders (0 to 1). The colours stay inside Display-P3 and are carried in the BT.2020 container.
- `--hdr-light auto` (the default) measures MaxCLL and MaxFALL in a quick single-sample pass before encoding, because encoders need them up front. `--hdr-light nominal` skips the pass and writes the grading ceiling and an unknown average; `--hdr-light 950,120` supplies known values.
- Without `--codec`, HDR defaults to CPU `libx265`; SDR defaults to `libx264`. `--codec hevc_nvenc` and `--codec av1_nvenc` use NVENC when supported by the GPU/driver/FFmpeg build. NVENC accelerates encoding; scene rendering, temporal supersampling and readback still take time.
- NVENC defaults to preset `p6`, VBR, CQ 18; adjust with `--preset` and `--cq`. x264/x265 use `--crf`, with defaults 16/18 respectively for the usual SDR/HDR modes. `--x264` and `--x265` accept encoder-specific parameter strings.
- HDR requires an FFmpeg build with `zscale` and the chosen 10-bit encoder. Builds with `-mastering_display` and `-content_light` input options also pass static HDR metadata to hardware encoders (tested with FFmpeg 9.0.2). On older builds, x265 supplies its own metadata; other encoders retain PQ/BT.2020 color tags and print a warning about missing static mastering metadata.
- Mastering metadata describes a nominal P3-D65 display at the selected peak, not a measured one. The measured light levels come from single-sample frames; motion blur only lowers peaks, so they are upper bounds for the encoded video. AAC audio is still copied without re-encoding.

Everything after `--` is passed to FFmpeg as **individual output arguments**, after the generated defaults. For example:

```sh
bun scripts/render.ts video --hdr --codec av1_nvenc --preset p5 --cq 20 --out ../out/pdoom-av1-hdr.mp4 -- -rc vbr -b:v 0 -spatial-aq 1
```

For parameters containing spaces, or for reuse across shells, save a JSON array such as this as `encode-options.json`:

```json
["-rc", "vbr", "-cq", "20", "-b:v", "0", "-metadata", "comment=My HDR render"]
```

Then pass `--ffmpeg-args-file encode-options.json`. Arguments after `--` take precedence over the file. No shell is used to execute the argument strings. Select a custom binary with `--ffmpeg /path/to/ffmpeg`, or inspect the complete command array with `--print-ffmpeg`. Choose the encoder through `--codec` so the generated defaults match it; overriding `-vf` or `-pix_fmt` also replaces the default HDR color-conversion/bit-depth settings.

`bun scripts/hdr-export-check.ts` checks PQ reference levels, color-primary conversion, little-endian 16-bit packing, the grade curve (smoothness, ceiling, hue), measured light levels, actual scene highlights and adaptive sampling at 1080p/4K. Short HEVC NVENC, 4K AV1 NVENC, x265 and SDR exports have also been checked with ffprobe; invalid FFmpeg options fail explicitly instead of leaving the renderer waiting indefinitely.

## Regenerate the timing data

The committed `data/*.json` files are all the renderer needs. Regenerating them needs the stems and intermediates, which are not in the repo:

- **Stems:** Demucs `htdemucs_ft` into `analysis/stems/htdemucs_ft/pdoom/` (`uv run python -m demucs -n htdemucs_ft -o stems ../audio/pdoom.mp3`), plus the lead vocal from a mel-band-roformer karaoke model (audio-separator) in `analysis/stems/karaoke/lead.wav`.
- **Intermediates:** `ctc_emissions.py`, `whisper_run.py` and `vocal_feats.py` write them to `analysis/work/`. The pipeline is described at the top of `analysis/align.py`.

```sh
cd analysis
uv run python align.py      # data/lyrics.json
uv run python analyze.py    # data/audio.json
```

The models download about 4 GB of weights into `analysis/.cache/`; delete that folder afterwards.

## Credits

- **Song:** "I'm Upping My P(doom)". The lyrics are by [osmarks](https://docs.osmarks.net/hypha/p%28doom%29_song_objectively_correct_interpretation), built on an opening verse and chorus by [MusicPerson](https://www.udio.com/creators/MusicPerson), with lines suggested on the EleutherAI Discord and help from Claude on the outro and final chorus. The original was generated with Udio and released in November 2024 ([YouTube](https://www.youtube.com/watch?v=uEB5E67vcPA)). This video uses the "Claude-Pop" version made with Suno, posted by [deckard (@slimer48484)](https://x.com/slimer48484/status/2097752569212756134) in September 2026.
- **Fonts:** Archivo, IBM Plex Mono and Cormorant Garamond (SIL Open Font License). Single-stroke EMS and Hershey fonts via the `hersheytext` package (OFL / public domain).

## License

The code is released under the [MIT License](LICENSE). The fonts in `app/public/fonts/` keep their own licenses (see Credits), and the song and lyrics (`audio/`, `lyrics/`, `data/lyrics.json`) are not covered by it: they belong to their authors (see Credits).
