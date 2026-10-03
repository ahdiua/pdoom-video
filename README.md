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

A `warmup-check.ts` script validates both 1080p and 2160p: it counts native shader compilations after readiness, verifies progress reporting, and compares exact pixels before/after preparation. `?warmup=0` is a dev escape hatch; `?export=1` never warms up.

### 🔊 Lossless AAC audio

The export pipeline copies the AAC track from `audio/pdoom.m4a` directly into the MP4 container without re-encoding, preserving the original audio quality. The M4A was losslessly remuxed from the supplied source AAC; the redundant raw AAC file is not retained in the working tree.

### 🧪 Validation scripts

| Script | Purpose |
|---|---|
| `preview-check.ts` | Regression tests: all scene midpoints + cut boundaries, both effect settings, paused rendering, grain, blur, fullscreen, resolution switching, playhead/settings retention |
| `warmup-check.ts` | Shader prep validation: 1080p + 2160p, post-readiness compilation counts, progress reporting, pixel-exact before/after comparison |
| `preview-perf.ts` | GPU benchmark: `EXT_disjoint_timer_query_webgl2`, discards warm-up and disjoint measurements, captures reference PNGs for image regression |
| `mobile-check.ts` | Touch viewport checks: hidden-control recovery, landscape layout, orientation-lock fallback, and fullscreen exit |

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
| `f` | enter / exit fullscreen |
| `b` | toggle scene motion blur |
| `g` | toggle film grain |

The control bar also has buttons for playback, resolution (clearly displaying the current and target resolution, e.g. `1080p (Switch to 2160p)`), motion blur, film grain, and a right-aligned fullscreen button. Press `h` again to restore hidden controls; the preview fills the space they occupied.

On phones, hidden controls can be restored with the floating **Show controls** button or by tapping the picture. Revealing controls does not pause playback. Fullscreen requests landscape orientation when supported; otherwise the player uses a rotated landscape layout until the device itself rotates. Browsers without page fullscreen use an **expanded view** inside the browser window, so browser toolbars may remain. The fullscreen/expanded-view button exits the mode and releases any orientation lock.

Resolution switching rebuilds the page at the selected physical resolution, retaining the playhead, loop and effect settings. Playback resumes when the browser permits it; fullscreen must be re-entered after a resolution change. Scene motion blur and film grain default to off in preview for lighter playback, and effect preferences persist across resolution reloads in the browser tab's session. Motion blur controls the scenes' authored camera/digit/geometry smears; the preview still uses one temporal sample. Export's multi-sample motion blur is controlled separately by `--samples` / `--shutter` and is unaffected by preview settings.

Paused previews redraw only when needed. Canvas text uploads use a GPU colour-conversion pass to avoid the slow Canvas2D-to-sRGB upload path observed on Chrome/ANGLE D3D11. Paperclips and other supersampled shaders use one centred spatial sample in preview, trading some edge smoothing for speed. Export keeps the original four spatial taps. See [performance validation](docs/ENGINE.md#preview-performance-validation) for measurements and checks.

### Experimental HDR preview

The **HDR** button (or `?hdr=1`) enables an experimental display bridge: scenes keep rendering in WebGL, and a small WebGPU pass presents their floating-point output through an extended-range canvas. Switching reloads at the current playhead. It requires HTTPS/localhost, WebGPU, a floating-point WebGL drawing buffer, and a browser reporting `(dynamic-range: high)`. Unsupported configurations and GPU-device loss fall back to SDR. The default preview and all exports remain SDR.

The experimental grade keeps the original SDR treatment below reference white and gives bright emission up to **4× reference-white luminance**. This is a relative limit, not a calibrated peak-nits setting. SDR screenshots and numerical buffer checks cannot establish the actual brightness shown by an HDR monitor.

For diagnostics, `?hdr=test` forces the HDR pipeline even on a reported SDR display, and `?hdr=bridge` uses the same bridge with SDR grading to isolate transport overhead. Both display **HDR: Test** and do not claim the screen is showing HDR. `bun scripts/hdr-check.ts` checks high-range pixels through the final output, orientation, and fallback behavior; `bun scripts/hdr-perf.ts` compares warmed SDR/bridge/HDR previews at 1080p and 4K. Run GPU benchmarks sequentially.

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
