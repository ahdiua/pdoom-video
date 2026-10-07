# Native WebGPU Paperclips experiment

**Status: measured twice, frozen again (2026-10-07).** The second run rewrote the port and the way it is
measured. Native WebGPU came out a little ahead where the first run had it level: 3–10% less GPU time per
heavy frame, shaders ready in a third to a half of the time, and no bridge for HDR. That is below what
would justify moving the renderer (see "The gate"), so WebGL stays and this is kept as a working comparison.

## Results (2026-10-07)

Windows Chrome 154.0.8037.98, NVIDIA RTX 4070 SUPER (WebGL: ANGLE on Direct3D 11; WebGPU: the same
adapter), a visible window on a 3840×2160 display at 160 Hz. 4K output, Full detail, effects off. Medians
of five rounds whose order reverses each round; every heavy-frame figure repeated within 3% between rounds.
No other process used more than 1% of the GPU during any run, and it idled below 7% before each.

The three WebGPU columns are the same picture from three ways of writing the lattice's map (`?map=`):
`loop` is how the WebGL shader is written today, `unrolled` writes the four layers out, `flat` also
writes out the normal and occlusion taps, as the scene was first authored.

| | WebGL | WebGPU `loop` | WebGPU `unrolled` | WebGPU `flat` |
|---|---:|---:|---:|---:|
| **GPU ms per frame** (40 back-to-back frames) | | | | |
| 98 s (overhead view) | 1.10 | 1.28 | 1.27 | 1.26 |
| 99.5 s | 17.06 | 16.00 | 15.43 | 15.45 |
| 100 s | 12.03 | 11.51 | 11.03 | 11.02 |
| 101 s | 17.06 | 16.53 | 15.34 | 15.33 |
| 101.5 s | 18.22 | 17.70 | 16.36 | 16.36 |
| **Frame interval on screen, ms** (mean ± standard deviation) | | | | |
| 99.5 s | 13.37 ± 5.9 | 13.68 ± 2.8 | 13.18 ± 3.0 | 13.19 ± 2.9 |
| 100 s | 11.58 ± 4.9 | 11.84 ± 2.2 | 11.35 ± 2.5 | 11.38 ± 2.6 |
| 101 s | 17.29 ± 5.1 | 17.97 ± 2.7 | 16.69 ± 3.3 | 16.65 ± 3.3 |
| 101.5 s | 18.12 ± 8.2 | 18.59 ± 2.4 | 17.17 ± 3.1 | 17.15 ± 3.1 |
| **Cold start** (a fresh profile each launch) | | | | |
| Shaders prepared, ms | 1082 | 345 | 597 | 590 |
| Page ready, ms | 1385 | 766 | 1037 | 1021 |

Wall-clock time per frame (the same bursts, waiting for the GPU at the end, uploads included) follows the
GPU column within 0.2 ms except for WebGL at 99.5 s and 100 s, where it is 0.3–0.6 ms lower.

HDR preview (`?hdr=test` on both, three rounds; the display reported HDR): WebGL grades into a float
drawing buffer and copies it into a WebGPU canvas, the native renderer grades straight into its own.

| | WebGL + bridge | WebGPU `loop` | WebGPU `flat` |
|---|---:|---:|---:|
| Wall ms per frame, 100 s | 13.25 | 11.69 | 11.21 |
| Wall ms per frame, 101 s | 18.32 | 16.68 | 15.57 |
| Frame interval ms, 100 s | 12.79 | 12.33 | 11.85 |
| Frame interval ms, 101 s | 18.59 | 18.50 | 17.24 |

### What they say

- **Other software was not the reason for the first result.** With the GPU otherwise idle and watched, the
  like-for-like comparison is again close: `loop` against the WebGL loops is 3–6% less GPU time. The first
  run's numbers were also steady across its three interleaved rounds (WebGL at 100 s: 11.97, 11.98, 12.09 ms).
- **The same shader costs about the same on either API.** Nearly all of a heavy frame is the lattice's
  fragment shader, and that arithmetic does not change with the API. Where the 0.5–1 ms comes from was not
  isolated: at 98 s, where there is almost nothing to shade, WebGPU is not the faster one (1.28 against
  1.10 ms), so it is not a lower fixed cost per frame.
- **Compile time is where WebGPU is clearly better, and it can be spent on frame time.** The WebGL shader
  was rewritten as loops because unrolled it took 2.8–5.1 s to compile (docs/ENGINE.md), at 4–18% more GPU
  time. WebGPU has the fully unrolled shader ready in 0.6 s, less than WebGL needs for the loops, so it can
  keep the faster form: 8–10% less GPU time than today's WebGL.
- **On screen the gain mostly disappears, because frames land on refreshes.** WebGPU presents on a steadier
  cadence (deviation 2–3 ms against 5–8 ms) but almost every frame takes a whole number of refreshes of its
  own: at 101 s, 1201 of 1393 `loop` frames took exactly three. WebGL's frames spread over one to four
  refreshes and their mean follows its GPU time. So `loop` is 2–4% *slower* on screen than WebGL despite
  less GPU time, and `flat` 1–5% faster. A GPU saving only shows where it carries a frame under the next
  refresh boundary. Why the two present differently was not investigated.
- **HDR is the one structural win.** Without the bridge a frame takes 9–15% less wall time, and the frame
  interval is 0.5–7% shorter.

### The gate

Fixed before measuring: at both 100 s and 101 s, GPU time per frame **and** mean frame interval at least
10% lower than WebGL and by more than the spread between rounds, in SDR. The WebGPU variant that stands for
the backend is the fastest whose cold shader preparation is within 20% of WebGL's (all three were).

| `flat` against WebGL | GPU time | Frame interval |
|---|---:|---:|
| 100 s | −8.4% | −1.7% |
| 101 s | −10.1% | −3.7% |

**Not passed.** Rewriting about 25,000 lines, every scene's GLSL and the export for a few percent on screen
is not worth it, and the export gains nothing from faster presentation. What would reopen this: HDR preview
becoming the normal way to watch, a display or browser where frames are not held to whole refreshes, or
shader preparation time mattering more than it does now (the whole timeline takes 7.4 s in WebGL).

## Frozen

- **WebGL is the renderer.** Preview, export and every other scene are WebGL only. Nothing selects
  WebGPU automatically; `webgpu-preview.html` is reached by its URL alone.
- **The port follows Paperclips as of commit `2b5b597`.** Changes to the scene's look
  (`scenes/paperclips-glsl.ts`, `paperclips-geo.ts`) are made in GLSL only and are **not** ported to
  `src/webgpu/`. From the first such change the two pictures differ and `webgpu-check.ts` fails its
  image comparison; that is expected, not a regression to fix.
- **It must keep compiling, nothing more.** `src/webgpu/` shares `PaperclipsState` with the WebGL
  scene and is typechecked and built with everything else, so a change to that shared state has to
  leave it compiling. If that ever costs more than a few lines, delete `src/webgpu/`,
  `webgpu-preview.html`, the `webgpu-*.ts` scripts, `gpu-watch.ps1` and the second Vite input instead:
  the measured results above are the deliverable.
- **Its checks are not part of `bun run check`.** `webgpu-check.ts`, `webgpu-player-check.ts` and
  `webgpu-perf.ts` are run by hand, and only while the port still matches.
- **No new work goes here**: no further scenes, no export path.
- **The WebGL HDR preview's WebGPU canvas is unrelated** (`engine/hdr-display.ts`). It only presents WebGL's
  frames, because WebGL cannot present above 1.0, and it is maintained.

## Run

From `app/`, start `bunx --no-install vite`, then open:

- [4K experiment](http://localhost:5173/webgpu-preview.html?scale=2&t=100)
- [The unrolled shader](http://localhost:5173/webgpu-preview.html?scale=2&t=100&map=flat)
- [Native HDR](http://localhost:5173/webgpu-preview.html?scale=2&t=100&hdr=1) (`hdr=test` on an SDR display; `hdr-headroom=` and the other grade parameters as in the WebGL preview)
- [WebGL comparison](http://localhost:5173/?scale=2&t=100&only=paperclips&detail=full)

The experiment plays and loops the Paperclips time window using the original
AAC audio. Space plays/pauses; arrows seek; R changes resolution; G/B toggle the
existing effect settings; F opens fullscreen. Paused playback redraws only on
changes. Resolution reloads retain time, effects and loop settings. WebGPU
initialization failure and device loss return to the existing WebGL preview,
with the time and resolution retained and a reason shown in the controls.

Full detail is fixed: the export's 128 march steps and 4.5 layers, shadows, AO, fog, and the preview's one
centred spatial tap and one temporal sample. It does not render other scenes, transitions or the export.

## Design

`PaperclipsState` owns the animation, camera, timing, uniforms, lyrics and particles, and both renderers
read it. `src/webgpu/` is:

- `gpu.ts`: the device, render targets, pipelines, and `UniformBlock`, which declares a WGSL struct and
  writes its fields at the offsets WGSL gives them from one table.
- `paperclips-shaders.ts`, `post-shaders.ts`, `common.ts`: WGSL following the GLSL function by function,
  with the same arithmetic in the same order. GLSL `mod` is `x - y * floor(x / y)` so negative cell
  indices keep their parity; falling `smoothstep` ramps are written with increasing edges. Scene rays,
  shake, aberration and grain keep GL's bottom-up coordinates; textures are top-down.
- `renderer.ts`: one command buffer per frame. The plate, its sparks and the Canvas2D layer share a render
  pass; the bloom pyramid follows; the grade writes straight into the canvas texture.
- `main.ts`: the player.

What differs from the WebGL frame, with the same pixels:

- **Canvas2D layers are sRGB textures.** The lyric layer and the HUD are copied into `rgba8unorm-srgb`
  and sampled as linear light, alpha still straight. WebGL uploads RGBA8 and decodes into a half-float
  target in a pass of its own, because the sRGB upload was slow in ANGLE.
- **No final target and blit.** The preview has nothing to read back, so the grade is the last draw. The
  checks grade the frame again into an offscreen target when they ask for pixels.
- **Uniforms are two buffer writes a frame**; a pass's texel size is written once.
- **Pipelines compile while the data and fonts load**, off the main thread.
- **HDR is a canvas format.** `rgba16float`, Display-P3, extended tone mapping; the grade of
  `engine/hdr-color.ts` is in the same final shader.

## Checks

Run these **sequentially**, with other GPU workloads closed:

```sh
cd app
bun scripts/webgpu-check.ts            # [--scales 1,2] [--maps loop,unrolled,flat] [--no-hdr]
bun scripts/webgpu-player-check.ts
bun scripts/webgpu-perf.ts             # opens Chrome windows for about 20 minutes: leave the machine alone
bun scripts/webgpu-perf.ts --hdr --rounds 3 --configs webgl,webgpu-loop,webgpu-flat
bun run typecheck
bunx --no-install vite build
```

`webgpu-check.ts` compares 20 times across the plate at both output resolutions, for each map variant,
against the WebGL preview at Full detail, and writes the PNGs and `image-results.json` into
`out/webgpu-eval/`. Grain is off; the dither stays. The gates are a mean absolute RGBA error of at most
1/255 and at most 1% of channels differing by more than 8/255. When references captured before a change
to the shared scene exist (`--baseline`), it also holds the WebGL preview and export to them (0.01/255, no
channel over 8). Last, it compares the native HDR canvas with what the WebGL preview hands its bridge, at
40 points in five frames, as floats. **2026-10-07: 205/205 passed**; WebGPU against WebGL at most
0.107/255 mean and 0.0029% of channels over 8/255, HDR within 0.36% of the value, and the three map
variants give the same figures to four decimals. Look at the PNGs too.

`webgpu-player-check.ts` covers readiness, paused redraw suppression, effect switches, seeks, audio
playback, resolution and state retention, three full 4K traversals without growth in pipelines, textures
or buffers, device loss, missing capabilities, and a device without timestamp queries (`?timers=0`).

`webgpu-perf.ts` is the measurement above. For each configuration and round it launches a fresh visible
Chrome and, at each time:

- **burst GPU**: one GPU timer around 40 back-to-back frames, best of three (`TIME_ELAPSED` in WebGL; in
  WebGPU a timestamp where the first frame's first pass begins and one where the last frame's last pass ends);
- **burst wall**: the same burst, then waiting for the GPU, per frame;
- **rAF**: five seconds of a looping 0.5-second excerpt: mean interval, deviation, and how many refreshes
  each frame took.

It records the time to a ready page and the shader preparation inside it, samples the idle GPU with
`nvidia-smi` before each launch, and runs `gpu-watch.ps1` alongside to see what other processes used the GPU
meanwhile; a disturbed run is named in the output. It reports the gate. Raw results: `perf-results.json`
and `perf-results-hdr.json` in `out/webgpu-eval/` (ignored by Git).

## The first run (2026-10-06)

The first port was a direct translation, snapshot `434d8af`, compared with the WebGL shader of that day
(its map still unrolled). Three rounds, headless Chrome 154.0.8037.93, each frame timed on its own:

| Effects | Time | WebGL GPU ms | WebGPU GPU ms | WebGL / WebGPU rAF fps |
|---|---:|---:|---:|---:|
| Off | 100s | 11.98 | 11.73 | 97.0 / 88.8 |
| Off | 101s | 16.28 | 17.10 | 67.7 / 57.3 |
| On | 100s | 12.50 | 11.99 | 95.1 / 80.0 |
| On | 101s | 16.31 | 17.50 | 67.0 / 54.4 |

Its gate (20% less GPU time and a 10% lower P95 frame interval) failed, and that conclusion stands. Its
method was replaced because:

- frames were timed one at a time with a wait in between, which lets the GPU clock down, and the two
  backends waited differently (a 4 ms poll against a buffer map). The same shader reads up to 15% apart
  that way; bursts repeat within 1%;
- frame intervals were measured in a headless browser, which does not present to a display;
- a P95 of intervals on a 160 Hz display can only be 6.3, 12.6, 18.8 or 25 ms;
- the WebGL shader has since become loops, so the old port was no longer its counterpart.

## Where Paperclips' time goes (WebGL)

4K preview, one tap, Full detail, RTX 4070 SUPER, GPU timer queries (`preview-perf.ts --preview --scale 2`),
with parts of the lattice shader switched off in turn (measured before the map became loops):

| | 99.5 s | 100 s | 101 s | 102 s |
|---|---:|---:|---:|---:|
| Whole frame | 15.7 ms | 11.4 ms | 15.0 ms | 17.4 ms |
| Without contact shadows | 12.6 | 9.6 | 12.0 | 14.1 |
| Without shadows and AO | 10.5 | 8.1 | 10.3 | 12.2 |
| Primary march only (flat shading) | 9.7 | 7.3 | 9.2 | 11.2 |

So the primary march is about 62% of the frame, contact shadows 20%, ambient occlusion 13%, and normals
with shading the rest. No output-preserving saving was found: hoisting the layer slab test out of
`layerD` (so a far layer never enters the function) gave identical pixels and identical timings, which
says the existing early-outs already branch. What is left changes the picture (fewer march, shadow or
AO steps), which is a look decision; the preview's adaptive 3D detail already trades resolution for it.
