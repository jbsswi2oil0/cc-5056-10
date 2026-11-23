# Dual-material shape-morph compositor

A shape-morphing compositor for two hand-drawn / photographic frames **A** and
**B**. You mark corresponding structures in the two images (landmarks and
curves), the program solves the intermediate geometry, and each output pixel is
reverse-sampled from **both** sources through the deformation. It is shape
interpolation, not an alpha cross-dissolve.

Everything is zero-dependency pure JavaScript (ES modules), shared by the
browser editor and the Node CLI/evaluator. PNG encoding/decoding uses only
`node:zlib` (Node) and `CompressionStream` (browser).

## Quick start

```bash
npm install                 # only playwright, used by the headless UI test
node src/assets/build.js    # write both scenes to out/ (frames + layers + truth)
node src/cli/render.js hands --t 0.5
node src/cli/render.js hands --seq 25 --contact
node src/cli/evaluate.js hands      # verification report + PASS/FAIL checks
node src/cli/evaluate.js stitch
node test/run.js                    # 21 numeric + end-to-end assertions
node web/server.js 8787             # open http://localhost:8787/
```

## The two ground-truth scenes

Both scenes ship **only** frames A and B plus authoring data. No intermediate
frame is pre-drawn; every intermediate is produced by the engine.

### hands — occlusion across a crossing
Two hands; in frame A the front hand occludes the back hand, in frame B the
occlusion **order flips**. Each hand is its own morphable object with its own
mesh, so the visible surface of each hand is solved independently. A declared
`occlusion` crossing names which object is in front before/after a switch phase
`switchT`, and the back object's alpha is split away wherever the front object
covers it (`keep = 1 - frontAlpha`). Drag past the midpoint and the back-of-hand
pixels visibly come from the other hand's source.

### stitch — two threads that must stay continuous
A card with two embroidery threads that **cross**. To keep each thread a single
connected stroke across the morph (and avoid folds that a single combined mesh
would force), the scene is decomposed into three objects: `paper`,
`thread_red`, `thread_blue`. A `thread_cross` occlusion crossing keeps red over
blue; a `thread_link` **continuity** crossing pins the two threads' crossing
point as a shared node so the visual crossing moves but neither stroke tears.
Pick both ends along each thread to verify the tips are restored exactly.

## The three explicit contracts

### 1. Correspondence
Correspondence is a set of **landmark pairs** and **curve pairs** (with matching
sample counts) per object. The mesh nodes *are* the correspondence: every
control becomes a pinned vertex, and pinned vertices move along the interpolation
below. Curve pairs contribute one pinned node per sample. In the editor you can
drag any landmark dot at `t=0` (edits its frame-A position) or `t=1` (frame-B);
the object's mesh rebuilds and the render updates. A deliberately swapped pair
of landmarks measurably raises residual exactly at those constraints — errors
are traceable to a named constraint, not smeared.

### 2. Frame boundary
The source canvas is the boundary. A sample that falls outside a source frame is
**unknown** and contributes nothing; it is never filled from unrelated edge
pixels. Diagnostics report `outOfFramePixels`; the editor's provenance probe
flags any such pixel. Both scenes report 0 out-of-frame source pixels at t=0.5.

### 3. Deformation model
Per object, a fixed-topology triangle mesh whose topology is identical in A and
B. Mid geometry is an **intrinsic similarity homotopy**:

```
V(t) = H_t( (1-t)·H_0^-1(a) + t·H_1^-1(b) )
```

where `H_t` is a global similarity (translation, scale `s^t`, rotation `t·θ`).
This is exact at `t=0` and `t=1` for **every** node (not just controls), so
endpoints restore fully, and it produces the natural half-turn instead of
collapsing toward B the way a componentwise median would. Rendering maps each
mid triangle back to both source frames by barycentric coordinates and blends
the two premultiplied samples under the same `(1-t, t)` semantics.

## Folding: diagnose, split, or limit

Triangle **signed area** is the fold indicator. A triangle whose mid signed area
is <= 0 (or whose ratio to its source area is below `FOLD_EPS`) is *folded*; it
is reported with its nearest correspondence constraint and is **never
rasterised** — no negative-area region is used to generate random pulls.

When the correspondence itself would fold — two correspondence lines (the A→B
trajectories of two control points) crossing mid-morph — `src/cli/evaluate.js`
demonstrates the two named resolutions:

* **LIMIT** — cap each line's displacement so it never reaches the crossing. One
  fold-free sheet, but it does not reach the frame-B targets (nonzero endpoint
  error).
* **SPLIT** — let both lines reach frame B and cut the ribbon into two sheets
  that pass each other; endpoints are exact, but the surface is two components.

The report prints the signed-area fold signal (it goes negative at `t=0.5`),
plus each policy's fold count, component count, and endpoint error.

## Why area-preservation alone is not enough

At the thread crossing there are two candidate correspondences: the authored
one and the "swapped-branch" one that sends each thread across onto the other's
branch. They have **equal |signed area|** (the swapped patch is the mirror), so
an area-magnitude criterion accepts both and can choose the wrong branch.
`areaOnlyAmbiguity()` computes both and shows equal magnitudes with opposite
sign; the signed area (orientation) distinguishes them, and a sign flip is the
same fold signal the mesh uses to refuse a negative-area face.

## Verification (`src/cli/evaluate.js`)

* endpoint exactness — t=0 reconstructs the frame-A layers, t=1 the frame-B
  layers (alpha MAE / max).
* correspondence motion — landmark trajectories through the mesh.
* mid continuity — maximum sample-gap ratio of each thread across phases
  (ratio ~1 means stretched smoothly, not torn).
* occlusion provenance — which source object back-of-hand pixels come from
  before vs after the midpoint, and the flip.
* thread endpoints — thread tip restoration in both frames.
* fold diagnosis — per-phase fold counts with constraint attribution.
* wrong-correspondence traceability — swapped landmarks raise residual at those
  exact constraints.
* the two experiments above.

All checks pass for both scenes; `test/run.js` asserts the same at the numeric
level.

### Two checks the brief calls out, concretely

* **Where do the back-of-hand pixels come from?** In the editor, scrub just past
  the midpoint and hover a pixel in the overlap: the probe prints
  `object=… srcA=(…) srcB=(…)`. Before `switchT` the top object is the frame-A
  front hand; after it is the other hand, and its `srcB` coordinate lands inside
  that hand's own frame-B footprint. `evaluate.js` does the same over a patch at
  the overlap centroid and reports the dominant object before and after
  (`flipObserved: true`).
* **Pick both ends along the threads.** `evaluate.js` reports each thread's two
  tip landmark positions in both frames and confirms the engine restores them
  exactly at `t=0`/`t=1` (`t0_maxErr`, `t1_maxErr` ~ 0); the mid-phase tip
  provenance is also printed (`endsProvenance`). The blue and red thread each
  cross exactly once in each frame, and the crossing stays a single point across
  phases.

## Editor

`node web/server.js` serves the repo root; `web/index.html` imports the same
engine modules the CLI uses (no bundler). Features:

* phase slider (scrub across the midpoint) and play/pause ping-pong.
* overlay toggles: deformation **mesh**, **correspondence** curves + dots,
  **provenance** colouring (which source object owns each pixel), **folds**.
* local correspondence editing: drag landmark dots at t=0/t=1.
* provenance probe: hover any pixel to read its `srcA`/`srcB` source coordinates
  and out-of-frame status.
* export: current frame (PNG), full sequence (ZIP of PNG frames + manifest),
  and a self-contained **APNG** animation that plays in any browser.

## Layout

```
src/core/      util, spline (TPS), triangulate (Delaunay), geometry,
               mesh (per-object deformation + fold diagnosis),
               engine (build, render, provenance, diagnostics)
src/assets/    softraster, hands, card, scenes, build, loader (synthetic truth)
src/eval/      experiments (area ambiguity, split-vs-limit)
src/cli/       render, evaluate
src/node/      png (PNG/APNG codec), loadScene
web/           server, index, app, style
test/          run.js, ui-check.mjs, seq-export-check.mjs, apng-check.mjs
out/           generated scenes, renders, sequences, UI screenshots
```

## Anti-cheating note

No Gaussian blur or pre-drawn intermediate frame is used anywhere. Ghosting
from a bad correspondence stays visible and is measured (residual per constraint
and per pixel), so it cannot be hidden by softening the image.
