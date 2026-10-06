# Native WebGPU Paperclips experiment

**Status: frozen (2026-10-07).** The experiment answered its question (a like-for-like WGSL port is not
faster, see Results) and is kept as a working comparison, not as a second renderer.

## Frozen

- **WebGL is the renderer.** Preview, export and every other scene are WebGL only. Nothing selects
  WebGPU automatically; `webgpu-preview.html` is reached by its URL alone.
- **The port is a snapshot of Paperclips as of commit `434d8af`.** Changes to the scene's look
  (`scenes/paperclips-glsl.ts`, `paperclips-geo.ts`) are made in GLSL only and are **not** ported to
  `src/webgpu/`. From the first such change the two pictures differ and `webgpu-check.ts` fails its
  image comparison; that is expected, not a regression to fix.
- **It must keep compiling, nothing more.** `src/webgpu/` shares `PaperclipsState` with the WebGL
  scene and is typechecked and built with everything else, so a change to that shared state has to
  leave it compiling. If that ever costs more than a few lines, delete `src/webgpu/`,
  `webgpu-preview.html`, the `webgpu-*.ts` scripts and the second Vite input instead: the measured
  results below are the deliverable.
- **Its checks are not part of `bun run check`.** `webgpu-check.ts`, `webgpu-player-check.ts` and
  `webgpu-perf.ts` are run by hand, and only while the snapshot still matches.
- **No new work goes here**: no further scenes, no native HDR, no export path.
- **The HDR preview's WebGPU canvas is unrelated** (`engine/hdr-display.ts`). It only presents WebGL's
  frames, because WebGL cannot present above 1.0, and it is maintained.
- **Reopening** takes new evidence against the continuation gate below (for example a browser or GPU
  where native WebGPU clearly wins), not a wish to modernise.

The branch `perf/webgpu-paperclips` is merged into `main` and has no commits of its own.

### Where Paperclips' time goes (WebGL, measured after the freeze)

4K preview, one tap, Full detail, RTX 4070 SUPER, GPU timer queries (`preview-perf.ts --preview --scale 2`),
with parts of the lattice shader switched off in turn:

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

Since then the WebGL lattice shader has diverged from this port in two ways. Its map is written as loops
(for compile time: 5.1 s to 1.0 s cold, at 4-18% more GPU time at Full detail; keeping the map unrolled
would have cost 2.8 s of compile and no GPU time), and Auto/Performance previews march 80 steps and three
layers. Export pixels are unchanged, so `webgpu-check.ts` still compares like with like at Full detail.

The experiment renders the complete Paperclips plate in native WebGPU/WGSL at
the existing **Full preview** quality. It includes the drawing pen, replication,
floor lattice, descending ceiling, particles, word-synced Canvas2D typography,
HUD, seven-level bloom/halation pyramid, chromatic aberration, vignette, grain,
and SDR presentation. It creates no WebGL context and copies no WebGL frame.

## Run

From `app/`, start `bunx --no-install vite`, then open:

- [4K experiment](http://localhost:5173/webgpu-preview.html?scale=2&t=100)
- [1080p experiment](http://localhost:5173/webgpu-preview.html?scale=1&t=100)
- [WebGL comparison](http://localhost:5173/?scale=2&t=100&only=paperclips&detail=full)

The experiment plays and loops the Paperclips time window using the original
AAC audio. Space plays/pauses; arrows seek; R changes resolution; G/B toggle the
existing effect settings; F opens fullscreen. Paused playback redraws only on
changes. Resolution reloads retain time, effects and loop settings. WebGPU
initialization failure and device loss return to the existing WebGL preview,
with the time and resolution retained and a reason shown in the controls.

Full detail is fixed: identical scene resolution, raymarch tolerances/iteration
limits, shadows, AO, fog, and one centred spatial tap. Full preview has one
temporal sample, as does the existing WebGL preview. Paperclips' deterministic
particle streaks are authored in its common CPU code; the motion-blur switch
does not add temporal samples. This experiment is SDR; it does not implement
native HDR, other scenes, transitions to other scenes, or offline export.

## Design

`PaperclipsState` owns the shared animation, camera, timing, uniforms, lyrics and
particle state. The existing scene is a WebGL adapter around this state; the
native renderer consumes it directly. Shared Canvas2D/Three.js math objects do
not create WebGL contexts. Existing export sampling remains in the WebGL engine.

WGSL ports retain the original shader algorithms. GLSL `mod` is implemented as
`x - y * floor(x / y)` to preserve negative cell indices; reverse `smoothstep`
ramps use increasing edges. Scene rays and grain use bottom-up GL coordinates,
while native textures and diagnostic RGBA readback use top-down rows.

Canvas textures are copied as RGBA8, then decoded into half-float linear targets
before filtering, matching the existing WebGL colour cache. The empty HUD is
reused. Pipelines, bind groups, frame targets, and uniform/vertex buffers are
reused. Shader compilation is asynchronous; representative frames are drawn and
completed before controls become available. Normal playback never maps buffers,
reads pixels, waits on GPU completion, or collects timestamp queries.

Both HTML entrypoints are included in the production Vite build. Neither the
default preview backend nor its export entrypoint selects WebGPU automatically.

## Repeatable checks

Run these **sequentially**, with other GPU workloads closed:

```sh
cd app
bun scripts/webgpu-check.ts
bun scripts/webgpu-player-check.ts
bun scripts/webgpu-perf.ts
bun scripts/preview-check.ts
bun scripts/warmup-check.ts
bun scripts/detail-check.ts
bunx --no-install tsc --noEmit -p tsconfig.json
bunx --no-install tsc --noEmit -p tsconfig.scripts.json
bunx --no-install vite build
```

`webgpu-check.ts` compares 20 representative times at both output resolutions.
It writes WebGL/WebGPU PNGs and `image-results.json` into `out/webgpu-eval/`.
When pre-refactor references exist, it also checks current WebGL preview and
four-tap export against them. Capture such references **before modifying the
shared scene** with `bun scripts/webgpu-check.ts --baseline`; a fresh checkout
can still compare current WebGL and WebGPU without those archived references.
Grain is disabled for image checks; deterministic dithering stays enabled.

Visual gates are mean absolute RGBA error <= 1/255 and no more than 1% of
channels differing by over 8/255. The pre-refactor WebGL regression uses a
stricter 0.01/255 mean limit and requires no channels differing by over 8/255.
Inspect the generated PNGs as well as the numerical results.

`webgpu-player-check.ts` covers readiness, paused redraw suppression, effect
switches, seeks, audio playback, resolution/state retention, three full 4K
scene traversals, resource counts, device loss, missing capabilities, and
preview without timestamp queries. `?timers=0` exercises the latter case.

`webgpu-perf.ts` measures 98s, 100s and 101s, at 4K Full, with effects off and
on. Each setting has three rounds, 12 discarded warmup frames and 120 timed
frames per point. Backend order reverses between rounds. Each point also uses
a three-second moving rAF excerpt and records CPU submission/queue completion
separately. Results and configuration are saved as `perf-results.json`.
Optional flags: `--scale 1`, `--frames N`, `--runs N`, `--times ...`,
`--effects 0|1|0,1`, `--headed`, `--url ...`, `--out ...`.

WebGL timer queries include work submitted during `engine.render`; native
timestamps bracket rendering passes and exclude external-image queue copies.
Queue completion and fence polling have different scheduling overhead, so
their difference is not pure GPU time. rAF throughput counts submitted frames,
not physical display scanout. Compare moving performance alongside GPU times.

The continuation gate is at least **20% lower GPU median and 10% lower moving
P95 frame interval at both 100s and 101s**, with visual checks passing. If it
fails, retain this experiment and optimize the existing heavy algorithms
before expanding the migration. The perf script reports the gate; failing it
is an experimental finding, not a correctness-test failure.

## Results

Measured on 2026-10-06, Windows Chrome **154.0.8037.93**, NVIDIA **RTX 4070
SUPER**. WebGL reported ANGLE/D3D11; the native adapter reported NVIDIA.
The browser did not report an HDR display. Measurements were sequential,
with the defaults documented above (three rounds, 120 GPU samples per point,
three-second moving excerpts). Values below are medians of the three rounds.

| Effects | Time | WebGL GPU ms | WebGPU GPU ms | WebGL / WebGPU rAF fps | WebGL / WebGPU P95 interval ms |
|---|---:|---:|---:|---:|---:|
| Off | 98s | 1.09 | 1.11 | 160.0 / 160.0 | 6.3 / 6.3 |
| Off | 100s | 11.98 | 11.73 | 97.0 / 88.8 | 12.6 / 12.6 |
| Off | 101s | 16.28 | 17.10 | 67.7 / 57.3 | 18.8 / 18.9 |
| On | 98s | 1.11 | 1.11 | 160.0 / 160.0 | 6.3 / 6.3 |
| On | 100s | 12.50 | 11.99 | 95.1 / 80.0 | 12.6 / 18.8 |
| On | 101s | 16.31 | 17.50 | 67.0 / 54.4 | 18.8 / 25.0 |

**The continuation gate failed.** At 100s, native GPU-pass medians improved by
only 2.1–4.1%; at 101s they regressed by 5.1–7.3%. Moving preview throughput
regressed in both heavy excerpts, and P95 intervals did not improve. Native
timestamp measurements exclude external-image queue copies, so the small
100s GPU-only improvement is not a whole-frame rendering speedup.

This demonstrates that an equivalent WGSL/API port does **not** justify a
broader performance migration on this machine. Keep WebGL as the main preview
and retain the native branch as a working comparison. Reduce expensive
raymarch/shadow/AO work or investigate texture-upload and queue/compositor
costs before migrating more scenes. The precise source of the native moving
preview regression has not been isolated by per-pass profiling; no claim is
made that WebGPU is universally slower or that these numbers apply to other
GPUs/browsers. Native HDR could remove the existing WebGL-to-WebGPU bridge,
but its net performance has not been tested here.

Image checks: **120/120 passed** across 1080p and 4K. The 80 pre-refactor WebGL
preview/export checks had maximum mean error **0.000158/255**, with no channel
differing by over 8/255. The 40 native/WebGL preview checks had maximum mean
error **0.097008/255**; the largest fraction of channels differing by over
8/255 was **0.00286%**, well below the 1% gate. Thin geometry, fog, text,
orientation and transparency also underwent screenshot inspection.

The native player checks passed, including complete 16:9 desktop/mobile canvas
layout above the controls, audio loop/end behavior, fullscreen,
three complete 4K traversals without growth in pipelines/textures/buffers, and
capability/device-loss fallbacks. Both TypeScript configurations and the
two-entrypoint production build passed. The existing preview and warmup checks
also passed across the original timeline and both resolutions. The existing
detail checks passed, including reversible native detail, no new shaders,
unchanged export/HDR bytes, and touch/no-timer adaptation.

Raw results and PNGs are generated under `out/webgpu-eval/` (ignored by Git).
The experimental implementation, scripts, and this report are the retained
deliverables; no other scenes have been migrated.
