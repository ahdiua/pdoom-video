# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A code-rendered music video ("I'm Upping My P(doom)") with word-synced karaoke typography. Every frame is a deterministic function of song time; the browser preview and the offline 60 fps export run the same scene code. This is a fork focused on real-time preview performance, plus experimental HDR and WebGPU paths.

Read these before non-trivial work; they are the source of truth and are kept current:

- `docs/ENGINE.md` — scene API, toolbox, typography helpers, 4K scale rules, motion-blur sampling rules.
- `docs/TREATMENT.md` — the style bible: palette, type system, karaoke rules, tone, and a per-scene description of what each plate shows and means. Update the scene's entry when you change what it depicts.
- `docs/WEBGPU.md` — the native WebGPU paperclips experiment. **Frozen**: a finished comparison, not a second renderer to keep in step (see "Frozen" there before touching `src/webgpu/` or the paperclips scene).
- `docs/DEPLOYMENT.md` — Cloudflare builds and deploys every push to `main` itself; the build settings live in the Cloudflare dashboard, not in this repository. There is no CI: nothing checks a push except what you ran before it.

## Commands

All renderer commands run from `app/` (bun + Vite; needs Google Chrome and ffmpeg on PATH for rendering).

```sh
bun install
bunx vite                                   # preview at http://localhost:5173/?t=85  (&scale=2 for 4K)
bun run typecheck                           # src/ and scripts/
bun run check                               # typecheck + every browser check, on a private server (~3 min); --only hdr,detail | --skip preview | --list
```

There is no unit-test suite or linter. Work is verified by rendering and looking at the result:

```sh
bun scripts/render.ts stills --t 85.3,86.0,87.3 --only leftturn --out ../out/wip/leftturn      # add --hdr for 16-bit PQ PNGs of the HDR grade
bun scripts/render.ts sheet --from 85 --to 89 --n 16 --cols 4 --only leftturn --out ../out/wip/sheet.png   # or --times a,b,c | --cuts
bun scripts/render.ts video --from 85 --to 89 --only leftturn --samples 4 --out ../out/wip/clip.mp4
bun scripts/render.ts video --samples auto --shutter 0.2 --out ../out/pdoom.mp4                            # full export
bun scripts/render.ts plates                # regenerate public/plates/ (stills used by the outro's rewind)
```

- After a visual change, render stills or a sheet and open the PNGs with the Read tool. `render.ts` prints `SCENE ERRORS` and browser console errors.
- `--only a,b` takes **timeline entry ids** (`prompt3`, `hook2`, ...), not module names; omit it near a cut to see both sides.
- `render.ts` reuses a dev server at `--url` (default `http://localhost:5173`) or starts a private one without HMR. If you render while editing against a live-reloading server, the page reloads mid-render; use `PDOOM_NO_HMR=1 bunx vite --port 5190` and `--url http://localhost:5190`.
- `plates.json` pins the time of each outro plate. Rerun `plates` only if a scene's look at its pinned time changed.
- Run `bun run check` before a push: nothing else stands between `main` and production except a typecheck. It runs the regression scripts one after another: `preview-check.ts` (all scene midpoints and cut boundaries, effect toggles, resolution switching), `warmup-check.ts`, `detail-check.ts`, `mobile-check.ts`, `hdr-check.ts`, `hdr-export-check.ts`, `determinism-check.ts` (the same time gives the same pixels whatever was rendered before it). Each is a standalone Playwright program and also runs alone against a server at `PDOOM_URL` (default `http://127.0.0.1:5173`).
- Not part of `check`: the `*-perf.ts` benchmarks (`preview-perf.ts`, `compile-perf.ts`, `hdr-perf.ts`) and the frozen experiment's `webgpu-*.ts`. Run GPU benchmarks sequentially, never in parallel.

Timing data (`data/*.json`) is committed and normally not regenerated; the Python tools in `analysis/` (uv) need stems that are not in the repo. See the README section "Regenerate the timing data".

## Architecture

- **Data in, frames out.** `data/lyrics.json` (word- and some syllable-level timings) and `data/audio.json` (beats, downbeats, sections, drum/vocal onsets, envelopes) are loaded into `Lyrics` and `AudioData` (`app/src/engine/`). Scenes never hard-code times: they look lines up by content (`ctx.lyrics.get('single CDR')`) and snap events to the grid (`audio.beatAt`, `timeOfBeat`, `downbeats`, `events('snare', t0, t1)`).
- **The edit** is `app/src/timeline.ts`: scene windows anchored to the first word of a lyric line and snapped to the previous beat. One module can serve several entries via `params` (`prompt` ×3, `hook` ×4). Scene modules are loaded lazily through `import.meta.glob('./scenes/*.ts')`.
- **Scenes** (`app/src/scenes/<name>.ts`) default-export a class extending `Scene` (`engine/scene.ts`): `init()` builds resources and precomputes the scene's own timing table from lyrics/audio; `render(f, out)` must fully overwrite a half-float linear-HDR target and returns post-processing overrides (bloom, shake, ca, fade, ...). Large scenes split helpers into `scenes/<name>-*.ts`; `_motifs.ts` holds the shared spark and mask so they look identical everywhere.
- **Engine** (`engine/engine.ts`) picks the active timeline entries, crossfades overlaps (or hands `f.under` to scenes with `handlesTransition`), accumulates export sub-frames, then runs post (`post.ts`: bloom, halation, CA, grain, vignette) and the HUD.
- **Typical scene rendering** combines `FSPass` fullscreen GLSL (with `GLSL_COMMON` palette/noise/SDF helpers), Canvas2D layers uploaded as textures (`Layer2D`), and `LineBatch` GPU line segments, composited with `ctx.comp`.
- **Export** (`scripts/render.ts`) drives the same page in headless Chrome with `?export=1`, pulls raw frames over a WebSocket and pipes them to ffmpeg. Preview-only optimisations (adaptive 3D detail, single spatial tap, startup shader warmup, cached sRGB canvas uploads) must not change export output.

## Rules that are easy to break

- **Determinism.** Output depends on `f.t` only: no `Math.random()`, `Date.now()`, or counting `render()` calls. Export sub-frames arrive out of order and in varying numbers. Use seeded `hash`/`mulberry32`, and `frameIdx(t)` (not `Math.floor(t * 60)`) for per-frame flicker. Simulation state needs `stateful = true` and cannot be exported with `--samples auto`.
- **Logical vs physical pixels.** Scenes lay out in 1920×1080 logical px at every output scale. In GLSL use `FRAG_PX`, `PX_SCALE` and `pxLine()` instead of raw `gl_FragCoord`/`fwidth` hairlines; offscreen canvases used as textures must be made `SCALE`× larger. Details in `docs/ENGINE.md` ("Output scale").
- **Raymarch loops.** A loop that calls a distance function starts at `ZERO` (a uniform that is always 0), not at `0`: the compiler then keeps it as a loop instead of compiling the function once per iteration, which is what made the heavy scenes take seconds to compile. Write normals and occlusion taps as such loops too. Check a change with the scene's cold compile time (`bun scripts/compile-perf.ts --only <id>`), not only its frame time (`preview-perf.ts --burst 40`): unrolled code can be a little faster to run. Numbers and rejected ideas: "Raymarcher compile time and preview cost" in `docs/ENGINE.md`.
- **Colour.** Linear HDR; only signal/ember orange may exceed ~0.85 (bloom). Use palette names only (`rgba('signal', a)` in Canvas2D, `C_SIGNAL` in GLSL, `LIN.signal` in TS). No hues outside the palette.
- **Karaoke.** Every lyric word is readable and synced: it highlights at its `start` and completes by its `end` (`Lyrics.wordProgress`); dim anticipation up to ~0.4 s early is fine, running ahead of the voice is not. Lyrics are part of the image, integrated differently in each plate, not subtitles.
- **Typography.** Archivo for lyrics, IBM Plex Mono for the machine voice, Cormorant Garamond rarely. Glyph-by-glyph drawing goes through `layout()`/`glyphX()` so kerning survives. No glyphs from outside the bundled fonts (draw missing symbols), no outlined or haloed type.
- **Scene hand-offs.** Adjacent scenes often match on the cut: an element of one lands exactly where the next one starts (for example `leftturn` folds its empty cdr field into the `prompt3` caret position, hard-coded as `CARET`). When changing the end of a scene, render the frames either side of the cut.
- **Meaning matters.** The lyrics are dense with AI-safety and computing references, and each plate stages its line's actual meaning (documented per scene in `docs/TREATMENT.md`). Check a reference before designing around it; e.g. "CDR" is the Lisp `cdr` (an obsolete architecture, paired with von Neumann), not a Critical Design Review.

## Working on Windows

The working copy uses CRLF line endings. Multi-line string matching against file contents must account for `\r\n`, and tools such as `sed -i` in Git Bash rewrite files with LF; restore with `unix2dos` afterwards.
