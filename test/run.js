// Test harness: exercises the numeric core and the two scenes end-to-end with
// assertions. Run with `node test/run.js` (no browser needed for these).
import { TPS, invertPoint } from '../src/core/spline.js';
import { delaunay, triSignedArea } from '../src/core/triangulate.js';
import { polylineIntersections } from '../src/core/geometry.js';
import { buildHandSceneData, buildStitchSceneData } from '../src/assets/scenes.js';
import { makeEngineFromSceneData } from '../src/assets/loader.js';
import { renderFrame, mapPointThroughMesh, rasteriseObject } from '../src/core/engine.js';
import { solvePhase } from '../src/core/mesh.js';
import { areaOnlyAmbiguity, splitVsLimitDemo } from '../src/eval/experiments.js';

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push({ name, ok: true }); }
  else { fail++; results.push({ name, ok: false, detail }); console.log(`FAIL  ${name}`, detail ?? ''); }
}

// ---------------------------------------------------------------------------
// 1) Numeric core
// ---------------------------------------------------------------------------
{
  // TPS interpolates its own control points to machine precision.
  const pts = [[0, 0], [100, 0], [0, 100], [100, 100], [50, 30], [20, 80]];
  const dst = pts.map(([x, y]) => [x + 12 * Math.sin(y / 40), y - 9 * Math.cos(x / 40)]);
  const tps = new TPS(pts, dst, { lambda: 1e-9 });
  let maxErr = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = tps.apply(pts[i][0], pts[i][1]);
    maxErr = Math.max(maxErr, Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]));
  }
  check('TPS interpolates control points', maxErr < 1e-8, { maxErr });

  // Inverse via Newton recovers the source point.
  const target = tps.apply(37, 61);
  const inv = invertPoint(tps, target[0], target[1], { guess: [37, 61] });
  check('TPS inverse recovers point', inv.ok && Math.hypot(inv.p[0] - 37, inv.p[1] - 61) < 1e-3, inv);
}
{
  // Delaunay of a square grid: every triangle CCW and total area equals the box.
  const grid = [];
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) grid.push([x * 10, y * 10]);
  const { triangles } = delaunay(grid.map(([x, y]) => ({ x, y })));
  let area = 0, allCCW = true;
  const gpts = grid.map(([x, y]) => ({ x, y }));
  for (const [i, j, k] of triangles) {
    const a = triSignedArea(gpts, [i, j, k]);
    area += a; if (a <= 0) allCCW = false;
  }
  check('Delaunay triangles are CCW', allCCW);
  check('Delaunay covers the box exactly', Math.abs(area - 40 * 40) < 1e-6, { area });
}

// ---------------------------------------------------------------------------
// 2) Experiments
// ---------------------------------------------------------------------------
{
  const demo = splitVsLimitDemo();
  check('fold signal appears at t=0.5 in baseline', Math.abs(demo.foldSignal.baselineFirstFoldT - 0.5) < 0.02, demo.foldSignal);
  check('limit keeps a fold-free sheet', demo.limit.negativeQuads === 0, demo.limit);
  check('limit misses the frame-B endpoint', demo.limit.endpointErrorPx > 1, demo.limit);
  check('split reaches frame B exactly', demo.split.endpointErrorPx === 0, demo.split);
  check('split becomes two sheets', demo.split.components === 2, demo.split);
  check('baseline folds (signed area negative after crossing)', demo.foldSignal.baselineMinSignedArea < 0, demo.foldSignal);
}

// ---------------------------------------------------------------------------
// 3) Scenes end-to-end
// ---------------------------------------------------------------------------
{
  const hands = buildHandSceneData();
  const buffers = {};
  for (const [id, pair] of Object.entries(hands.layers)) { buffers[`${id}:A`] = pair.A; buffers[`${id}:B`] = pair.B; }
  const engine = makeEngineFromSceneData(hands, buffers);

  // Endpoint exactness: at t=0 and 1 the solved mesh must reproduce the object's
  // landmarks exactly.
  let endpointErr = 0;
  for (const obj of hands.objects) {
    const mesh = engine.meshes[obj.id];
    const V0 = solvePhase(mesh, 0, {}).V, V1 = solvePhase(mesh, 1, {}).V;
    for (const lm of obj.landmarks || []) {
      if (!lm.enabled) continue;
      const p0 = mapPointThroughMesh(mesh, V0, lm.a);
      const p1 = mapPointThroughMesh(mesh, V1, lm.a);
      if (p0) endpointErr = Math.max(endpointErr, Math.hypot(p0[0] - lm.a[0], p0[1] - lm.a[1]));
      if (p1) endpointErr = Math.max(endpointErr, Math.hypot(p1[0] - lm.b[0], p1[1] - lm.b[1]));
    }
  }
  check('hands: landmarks exact at endpoints', endpointErr < 1e-6, { endpointErr });

  // No folds at any phase.
  let foldCount = 0;
  for (let k = 0; k <= 10; k++) {
    for (const [id, mesh] of Object.entries(engine.meshes)) {
      const solved = solvePhase(mesh, k / 10, {});
      foldCount += solved.folded.length;
    }
  }
  check('hands: no folds at any phase', foldCount === 0, { foldCount });

  // Occlusion provenance flips across the midpoint.
  const W = engine.width;
  const before = renderFrame(engine, 0.49);
  const after = renderFrame(engine, 0.51);
  const cx = Math.round(hands.truth.overlapCentroid[0]), cy = Math.round(hands.truth.overlapCentroid[1]);
  const idBefore = before.diagnostics.objectIds[before.provenance.object[cy * W + cx]];
  const idAfter = after.diagnostics.objectIds[after.provenance.object[cy * W + cx]];
  check('hands: occlusion flips across midpoint', idBefore !== idAfter, { idBefore, idAfter, at: [cx, cy] });

  // Out-of-frame samples never contribute (no unrelated-border copy).
  const mid = renderFrame(engine, 0.5);
  check('hands: no out-of-frame source pixels at midpoint', mid.diagnostics.outOfFramePixels === 0, { oof: mid.diagnostics.outOfFramePixels });

  // Endpoint frames match the source layers (alpha MAE small).
  const recon = layerReconError(engine, 0);
  check('hands: t=0 reconstructs source layers', Object.values(recon).every((v) => v.mae < 0.5), recon);
}
{
  const stitch = buildStitchSceneData();
  const buffers = {};
  for (const [id, pair] of Object.entries(stitch.layers)) { buffers[`${id}:A`] = pair.A; buffers[`${id}:B`] = pair.B; }
  const engine = makeEngineFromSceneData(stitch, buffers);

  // Threads cross exactly once per frame.
  const red = engine.objById.get('thread_red').curves[0];
  const blue = engine.objById.get('thread_blue').curves[0];
  check('stitch: threads cross once in frame A', polylineIntersections(red.a, blue.a).length === 1);
  check('stitch: threads cross once in frame B', polylineIntersections(red.b, blue.b).length === 1);

  // No folds at any phase (this is why we split the scene into three objects).
  let foldCount = 0;
  for (let k = 0; k <= 10; k++) {
    for (const mesh of Object.values(engine.meshes)) {
      foldCount += solvePhase(mesh, k / 10, {}).folded.length;
    }
  }
  check('stitch: no folds at any phase', foldCount === 0, { foldCount });

  // Endpoint restoration: thread tip landmarks are exact at t=0 and t=1.
  let tipErr = 0;
  for (const th of ['red', 'blue']) {
    const obj = stitch.objects.find((o) => o.id === `thread_${th}`);
    const mesh = engine.meshes[`thread_${th}`];
    const V0 = solvePhase(mesh, 0, {}).V, V1 = solvePhase(mesh, 1, {}).V;
    for (const lm of obj.landmarks) {
      const p0 = mapPointThroughMesh(mesh, V0, lm.a);
      const p1 = mapPointThroughMesh(mesh, V1, lm.a);
      tipErr = Math.max(tipErr, Math.hypot(p0[0] - lm.a[0], p0[1] - lm.a[1]), Math.hypot(p1[0] - lm.b[0], p1[1] - lm.b[1]));
    }
  }
  check('stitch: thread endpoints exact at t=0/1', tipErr < 1e-6, { tipErr });

  // Area-only experiment is available and mirror-ambiguous.
  const amb = areaOnlyAmbiguity(engine);
  check('stitch: area-only criterion is mirror-ambiguous', amb.available && amb.areaMagnitudeEqual, amb);
}

// split/limit demo also gets a direct self-intersection sanity check
{
  const demo = splitVsLimitDemo();
  check('split-vs-limit demo is self-consistent', demo.split.negativeQuads === 0 && demo.split.endpointErrorPx === 0 && demo.limit.endpointErrorPx > 0, demo);
}

// ---------------------------------------------------------------------------
function layerReconError(engine, t) {
  const out = {};
  const { width: W, height: H } = engine;
  for (const id of Object.keys(engine.meshes)) {
    const solved = solvePhase(engine.meshes[id], t, {});
    const L = rasteriseObject(engine, id, solved, t);
    const src = engine.layerImages[id][t === 0 ? 'A' : 'B'];
    let sum = 0, max = 0, n = 0;
    for (let p = 0; p < W * H; p++) {
      const a = L.prem[p * 4 + 3];
      const b = src.data[p * 4 + 3] / 255;
      const d = Math.abs(a - b) * 255;
      sum += d; max = Math.max(max, d); n++;
    }
    out[id] = { mae: sum / n, max };
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
