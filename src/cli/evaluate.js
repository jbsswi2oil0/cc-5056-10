// Verification CLI. Produces a machine-checkable report that the brief asks
// for, using only frames A/B and the engine:
//
//   * endpoint exactness      t=0 equals frame A, t=1 equals frame B
//   * correspondence motion   each landmark travels a straight, monotone path
//   * mid continuity          curves keep their samples connected (no gaps)
//   * occlusion provenance    which source object the back-of-hand pixels come from
//   * thread endpoints        the two thread ends are restored exactly
//   * fold diagnosis          any folded triangle, attributed to a constraint
//   * the two experiments     area-magnitude ambiguity, split-vs-limit
//
//   node src/cli/evaluate.js <scene> [--json]
import { loadSceneByName } from '../node/loadScene.js';
import { renderFrame, mapPointThroughMesh, mapPointThroughMeshB, midCurve, rasteriseObject } from '../core/engine.js';
import { solvePhase } from '../core/mesh.js';
import { polylineDistance, polylineIntersections } from '../core/geometry.js';
import { areaOnlyAmbiguity, splitVsLimitDemo } from '../eval/experiments.js';

function main() {
  const argv = process.argv.slice(2);
  const sceneName = argv.find((a) => !a.startsWith('--')) || 'hands';
  const asJson = argv.includes('--json');
  const { engine, meta, loadImage } = loadSceneByName(sceneName);

  const report = sceneName === 'hands' ? evalHands(engine, meta, loadImage) : evalStitch(engine, meta);
  report.experiments = {
    areaOnlyAmbiguity: safe(() => areaOnlyAmbiguity(engine)),
    splitVsLimit: splitVsLimitDemo(),
  };
  report.pass = judge(report);

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }
  printHuman(report);
}

function safe(fn) { try { return fn(); } catch (e) { return { error: String(e) }; } }

// ---------------------------------------------------------------------------
// Hands scene
// ---------------------------------------------------------------------------
function evalHands(engine, meta, loadImage) {
  const truth = meta.truth;
  const { width: W, height: H } = engine;

  // 1) Endpoint exactness: reconstruct each object at t=0/t=1 and compare its
  //    alpha raster to that object's own source layer. Exact interpolation must
  //    give ~0 error except on anti-aliased edges.
  const endpoints = {
    layerA: layerReconError(engine, 0),
    layerB: layerReconError(engine, 1),
  };

  // 2) Correspondence motion for material probes: track the probe through the
  //    object's mesh and compare to the straight line between its A and B truth.
  const motion = [];
  for (const p of truth.probes) {
    const mesh = engine.meshes[p.object];
    const vals = [];
    let maxDev = 0;
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const solved = engine.solvedCache?.[t];
      const V = solved ? solved[p.object].V : solvePhase(mesh, t, {}).V;
      const mapped = mapPointThroughMesh(mesh, V, p.A);
      if (!mapped) { vals.push(null); continue; }
      vals.push(mapped);
      const line = [p.A[0] + (p.B[0] - p.A[0]) * t, p.A[1] + (p.B[1] - p.A[1]) * t];
      // deviation from the straight material line, only meaningful if the mesh
      // enforces this probe as a pinned landmark. Report honestly either way.
      maxDev = Math.max(maxDev, Math.hypot(mapped[0] - line[0], mapped[1] - line[1]));
    }
    const err0 = vals[0] ? Math.hypot(vals[0][0] - p.A[0], vals[0][1] - p.A[1]) : null;
    const err1 = vals[10] ? Math.hypot(vals[10][0] - p.B[0], vals[10][1] - p.B[1]) : null;
    motion.push({ name: p.name, object: p.object, endpointErrA: round4(err0), endpointErrB: round4(err1), maxDevFromLine: round4(maxDev) });
  }

  // 3) Occlusion provenance across the midpoint: at t just above switchT the
  //    back-of-hand pixels must come from the FRONT object's B source, and its
  //    world point must sit inside that object's frame-B footprint.
  const c = truth.overlapCentroid;
  const before = renderFrame(engine, 0.49);
  const after = renderFrame(engine, 0.51);
  const pAt = (res, x, y) => {
    const xi = Math.round(x), yi = Math.round(y), p = yi * W + xi;
    return { object: res.diagnostics.objectIds[res.provenance.object[p]] || null, srcA: [res.provenance.srcA[p * 2], res.provenance.srcA[p * 2 + 1]], srcB: [res.provenance.srcB[p * 2], res.provenance.srcB[p * 2 + 1]] };
  };
  // sample a 5x5 patch centroid of the overlap region
  const patch = samplePatch(before, after, c[0], c[1], 6);
  const occlusion = {
    overlapCentroid: c.map(round2),
    expected: { before: truth.occlusion.before, after: truth.occlusion.after },
    observedBefore: patch.before.objects,
    observedAfter: patch.after.objects,
    flipObserved: patch.before.dominant !== patch.after.dominant,
    backOfHandPixelsFromSource: patch.after.sources,
  };

  // 4) Folds and attribution, at several phases.
  const folds = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    const res = renderFrame(engine, t);
    folds.push({ t, count: res.diagnostics.folds.length, attributed: res.diagnostics.folds.slice(0, 5) });
  }

  // 5) A deliberate wrong correspondence, to show the error is traceable.
  const badCorrespondence = wrongCorrespondenceProbe(engine, meta, loadImage);

  return {
    scene: 'hands', frame: { width: W, height: H },
    endpoints, motion, occlusion, folds,
    badCorrespondence,
    splits: { atMidpoint: renderFrame(engine, 0.5).diagnostics.splitPixels },
  };
}

function evalStitch(engine, meta) {
  const truth = meta.truth;
  const { width: W, height: H } = engine;

  // Endpoint exactness for the two threads: the stroke END material points must
  // land exactly on the truth endpoints in each frame.
  const endpoints = [];
  for (const th of ['red', 'blue']) {
    const obj = engine.objById.get(`thread_${th}`);
    const curve = obj.curves[0];
    const a0 = curve.a[0], aN = curve.a[curve.a.length - 1];
    const b0 = curve.b[0], bN = curve.b[curve.b.length - 1];
    const te = truth.threadEndpoints[th];
    endpoints.push({
      thread: th,
      A: { start: dist(a0, te.a[0]), end: dist(aN, te.a[1]) },
      B: { start: dist(b0, te.b[0]), end: dist(bN, te.b[1]) },
    });
  }

  // Endpoint restoration through the engine at t=0 and 1: render, then confirm
  // the stroke tips are where the truth says (provenance srcB matches).
  const restore = [];
  for (const th of ['red', 'blue']) {
    const mesh = engine.meshes[`thread_${th}`];
    const obj = engine.scene.objects.find((o) => o.id === `thread_${th}`);
    const curve = obj.curves[0];
    const solved0 = solvePhase(mesh, 0, {});
    const solved1 = solvePhase(mesh, 1, {});
    const midA = midCurve(engine, `thread_${th}`, curve.id, 0).points;
    const midB = midCurve(engine, `thread_${th}`, curve.id, 1).points;
    restore.push({
      thread: th,
      t0_maxErr: round4(maxErr(midA, curve.a)),
      t1_maxErr: round4(maxErr(midB, curve.b)),
    });
  }

  // Mid continuity: sample the mid curve densely. The maximum gap between
  // consecutive samples must look like a smooth resample of the original stroke
  // length, not a torn break.
  const continuity = [];
  for (const th of ['red', 'blue']) {
    const obj = engine.scene.objects.find((o) => o.id === `thread_${th}`);
    const curve = obj.curves[0];
    const origGapA = polylineDistance(curve.a, curve.a); // reference spacing
    let worstRatio = 0, worstT = 0, maxGap = 0;
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const pts = midCurve(engine, `thread_${th}`, curve.id, t).points;
      let mg = 0;
      for (let i = 1; i < pts.length; i++) mg = Math.max(mg, dist(pts[i - 1], pts[i]));
      const ref = medianGap(curve.a);
      const ratio = ref > 0 ? mg / ref : 0;
      if (ratio > worstRatio) { worstRatio = ratio; worstT = t; }
      maxGap = Math.max(maxGap, mg);
    }
    void origGapA;
    continuity.push({ thread: th, worstGapRatio: round3(worstRatio), atT: worstT, maxGapPx: round2(maxGap), note: 'gap ratio ~1 means the stroke is stretched smoothly, not torn' });
  }

  // Crossing correspondence: the authored crossing point in each frame is a
  // continuity link. Check the link geometry and that the two strokes actually
  // cross in both frames.
  const redObj = engine.objById.get('thread_red').curves[0];
  const blueObj = engine.objById.get('thread_blue').curves[0];
  const xA = polylineIntersections(redObj.a, blueObj.a);
  const xB = polylineIntersections(redObj.b, blueObj.b);
  const crossing = {
    crossingA: xA.length ? xA[0].point.map(round2) : null,
    crossingB: xB.length ? xB[0].point.map(round2) : null,
    truthA: truth.crossingA.map(round2), truthB: truth.crossingB.map(round2),
    singlePointA: xA.length, singlePointB: xB.length,
    linkResolution: engine.crossings.filter((c) => c.type === 'continuity').map((c) => ({ id: c.id, link: c.link, splitPolicy: c.splitPolicy, interA: c.interA, interB: c.interB })),
  };

  // Folds across phases.
  const folds = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    const res = renderFrame(engine, t);
    folds.push({ t, count: res.diagnostics.folds.length, attributed: res.diagnostics.folds.slice(0, 5) });
  }

  // Pick both ends along the thread: report provenance at the two ends at mid
  // phase, i.e. where the tip pixels are sourced from.
  const mid = renderFrame(engine, 0.5);
  const endsProvenance = [];
  for (const th of ['red', 'blue']) {
    const te = truth.threadEndpoints[th];
    const midStart = lerp(te.a[0], te.b[0], 0.5);
    const midEnd = lerp(te.a[1], te.b[1], 0.5);
    endsProvenance.push({
      thread: th,
      end0: provenanceAt(mid, W, H, midStart),
      end1: provenanceAt(mid, W, H, midEnd),
    });
  }

  return {
    scene: 'stitch', frame: { width: W, height: H },
    endpoints, restore, continuity, crossing, folds, endsProvenance,
    splits: { atMidpoint: mid.diagnostics.splitPixels },
  };
}

function provenanceAt(res, W, H, xy) {
  const x = Math.round(xy[0]), y = Math.round(xy[1]);
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const p = y * W + x;
  const objIdx = res.provenance.object[p];
  return {
    at: [x, y],
    object: objIdx >= 0 ? res.diagnostics.objectIds[objIdx] : null,
    srcA: [round2(res.provenance.srcA[p * 2]), round2(res.provenance.srcA[p * 2 + 1])],
    srcB: [round2(res.provenance.srcB[p * 2]), round2(res.provenance.srcB[p * 2 + 1])],
    outOfFrame: !!res.provenance.outOfFrame[p],
  };
}

function samplePatch(resBefore, resAfter, cx, cy, r) {
  const W = resBefore.image.width;
  const objs = { before: {}, after: {} };
  const sources = [];
  for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
    const x = Math.round(cx + dx), y = Math.round(cy + dy);
    const p = y * W + x;
    const bIdx = resBefore.provenance.object[p];
    const aIdx = resAfter.provenance.object[p];
    const bId = bIdx >= 0 ? resBefore.diagnostics.objectIds[bIdx] : 'none';
    const aId = aIdx >= 0 ? resAfter.diagnostics.objectIds[aIdx] : 'none';
    objs.before[bId] = (objs.before[bId] || 0) + 1;
    objs.after[aId] = (objs.after[aId] || 0) + 1;
    if (aId !== 'none') {
      sources.push({ object: aId, srcA: [round2(resAfter.provenance.srcA[p * 2]), round2(resAfter.provenance.srcA[p * 2 + 1])], srcB: [round2(resAfter.provenance.srcB[p * 2]), round2(resAfter.provenance.srcB[p * 2 + 1])] });
    }
  }
  const dom = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0];
  return { before: { objects: objs.before, dominant: dom(objs.before) }, after: { objects: objs.after, dominant: dom(objs.after) }, sources };
}

// Deliberately swap two landmark correspondences and show the error lands next
// to exactly those constraints (traceability requirement).
function wrongCorrespondenceProbe(engine, meta, loadImage) {
  const obj = engine.scene.objects.find((o) => o.id === 'F');
  const lm = obj.landmarks.filter((l) => l.enabled).slice(0, 2);
  if (lm.length < 2) return { available: false };
  const swapped = JSON.parse(JSON.stringify(engine.scene));
  const so = swapped.objects.find((o) => o.id === 'F');
  const a = so.landmarks.find((l) => l.id === lm[0].id);
  const b = so.landmarks.find((l) => l.id === lm[1].id);
  const tmp = a.b; a.b = b.b; b.b = tmp;
  try {
    const badEngine = buildEngine(swapped, loadImage);
    const res = renderFrame(badEngine, 0.5);
    return {
      swappedLandmarks: [lm[0].id, lm[1].id],
      residualPixels: res.diagnostics.residualPixels,
      residualSum: round2(res.diagnostics.residualSum),
      topAttribution: res.diagnostics.residualByConstraint.slice(0, 6).map((r) => ({
        object: r.object,
        constraint: r.constraint && { id: r.constraint.id, label: r.constraint.label, kind: r.constraint.kind },
        pixels: r.pixels,
      })),
      attributedToSwapped:
        res.diagnostics.residualByConstraint.some((r) => r.constraint && lm.some((l) => l.id === r.constraint.id)),
    };
  } catch (e) {
    return { available: false, error: String(e) };
  }
}

import { buildEngine } from '../core/engine.js';

// ---------------------------------------------------------------------------
// pixel helpers
// ---------------------------------------------------------------------------
// Reconstruct each object at t=0 / t=1 and compare to its own layer. Since the
// mesh interpolates exactly at the endpoints, this must be ~0 except on AA edges.
function layerReconError(engine, t) {
  const out = {};
  for (const id of Object.keys(engine.meshes)) {
    const solved = solvePhase(engine.meshes[id], t, {});
    const L = rasteriseObject(engine, id, solved, t);
    const src = engine.layerImages[id][t === 0 ? 'A' : 'B'];
    let sum = 0, max = 0, n = 0;
    for (let p = 0; p < src.width * src.height; p++) {
      const a = L.prem[p * 4 + 3]; // premultiplied alpha in 0..1
      const b = src.data[p * 4 + 3] / 255;
      const d = Math.abs(a - b) * 255;
      sum += d; max = Math.max(max, d); n++;
    }
    out[id] = { mae: round4(sum / n), max: round4(max) };
  }
  return out;
}

function maxErr(pts, truth) {
  let m = 0;
  for (let i = 0; i < Math.min(pts.length, truth.length); i++) m = Math.max(m, dist(pts[i], truth[i]));
  return m;
}
function medianGap(pts) {
  const g = [];
  for (let i = 1; i < pts.length; i++) g.push(dist(pts[i - 1], pts[i]));
  g.sort((a, b) => a - b);
  return g.length ? g[Math.floor(g.length / 2)] : 0;
}
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function lerp(a, b, t) { return a + (b - a) * t; }
function round2(v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; }
function round3(v) { return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v; }
function round4(v) { return typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v; }

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------
function judge(report) {
  const checks = [];
  if (report.scene === 'hands') {
    for (const [id, e] of Object.entries(report.endpoints.layerA || {})) {
      checks.push({ name: `endpoint exact t=0 (${id})`, pass: e.mae < 0.5 && e.max < 40, value: e });
    }
    for (const [id, e] of Object.entries(report.endpoints.layerB || {})) {
      checks.push({ name: `endpoint exact t=1 (${id})`, pass: e.mae < 0.5 && e.max < 40, value: e });
    }
    checks.push({ name: 'occlusion order flips across midpoint', pass: report.occlusion.flipObserved, value: report.occlusion });
    checks.push({ name: 'no folds at any phase', pass: report.folds.every((f) => f.count === 0), value: report.folds.map((f) => f.count) });
    checks.push({ name: 'wrong correspondence attributed to swapped constraints', pass: !!report.badCorrespondence.attributedToSwapped, value: report.badCorrespondence.topAttribution });
  } else {
    for (const e of report.endpoints) {
      checks.push({ name: `thread ${e.thread} endpoints match truth`, pass: e.A.start < 0.5 && e.A.end < 0.5 && e.B.start < 0.5 && e.B.end < 0.5, value: e });
    }
    for (const r of report.restore) {
      checks.push({ name: `thread ${r.thread} restored exactly at t=0/1`, pass: r.t0_maxErr < 0.01 && r.t1_maxErr < 0.01, value: r });
    }
    checks.push({ name: 'mid continuity: no torn gaps', pass: report.continuity.every((c) => c.worstGapRatio < 1.6), value: report.continuity });
    checks.push({ name: 'both threads cross exactly once in each frame', pass: report.crossing.singlePointA === 1 && report.crossing.singlePointB === 1, value: report.crossing });
    checks.push({ name: 'no folds at any phase', pass: report.folds.every((f) => f.count === 0), value: report.folds.map((f) => f.count) });
  }
  const exp = report.experiments;
  if (exp.areaOnlyAmbiguity && exp.areaOnlyAmbiguity.available !== false) {
    checks.push({ name: 'area-only criterion is mirror-ambiguous', pass: !!exp.areaOnlyAmbiguity.areaMagnitudeEqual, value: exp.areaOnlyAmbiguity });
  } else if (report.scene === 'stitch') {
    checks.push({ name: 'area-only criterion is mirror-ambiguous', pass: false, value: exp.areaOnlyAmbiguity });
  }
  checks.push({ name: 'split reaches B exactly, limit does not', pass: exp.splitVsLimit.split.endpointErrorPx === 0 && exp.splitVsLimit.limit.endpointErrorPx > 0, value: exp.splitVsLimit });
  return { checks, allPass: checks.every((c) => c.pass) };
}

function printHuman(report) {
  console.log(`\n=== ${report.scene.toUpperCase()} SCENE VERIFICATION ===`);
  console.log(JSON.stringify(report, null, 2));
  console.log('\n=== CHECKS ===');
  for (const c of report.pass.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`\n${report.pass.allPass ? 'ALL CHECKS PASS' : 'SOME CHECKS FAILED'}`);
}

main();
