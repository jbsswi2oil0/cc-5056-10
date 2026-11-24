// Garment project assertions, runnable without a browser. Covers:
//   * the two branches share one geometry rig and identical endpoint frames
//   * endpoint landmarks restore exactly and no phase folds the mesh
//   * the occlusion handoff changes the visible domain when moved into range
//   * the three identity cuff vertices keep CCW order; a broken correspondence
//     flips that order and opens a protected-surface gap
//   * regenerating from the master spec reproduces the same spec hash
import { buildGarmentProjects, editableProjectSpec } from '../src/assets/garment-project.js';
import { makeEngineFromSceneData } from '../src/assets/loader.js';
import { renderFrame, mapPointThroughMesh, rasteriseObject } from '../src/core/engine.js';
import { buildEngine } from '../src/core/engine.js';
import { solvePhase } from '../src/core/mesh.js';
import { createHash } from 'node:crypto';
import {
  cuffWinding, cuffIdentityWinding, auditProject,
} from '../src/eval/garment-audit.js';
import { garmentTradeoffReport } from '../src/eval/garment-tradeoff.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push({ name, detail }); console.log('FAIL ', name, detail ?? ''); }
}

function buffers(scene) {
  const b = {};
  for (const [k, v] of Object.entries(scene.layers)) { b[`${k}:A`] = v.A; b[`${k}:B`] = v.B; }
  return b;
}

const projects = buildGarmentProjects();
const flap = projects.flapfront;
const arm = projects.armfront;

// 1) Shared geometry rig: same object/curve/landmark coordinates, same frames.
check('branches share outline geometry',
  JSON.stringify(flap.objects) === JSON.stringify(arm.objects));
check('branches share authored frame A bytes',
  Buffer.compare(Buffer.from(flap.frames.A.data), Buffer.from(arm.frames.A.data)) === 0);
check('branches share authored frame B bytes',
  Buffer.compare(Buffer.from(flap.frames.B.data), Buffer.from(arm.frames.B.data)) === 0);
check('branches differ only in occlusion front',
  flap.crossings[0].front !== arm.crossings[0].front);

// 2) Endpoint exactness and fold-free morph for both branches.
for (const scene of [flap, arm]) {
  const eng = makeEngineFromSceneData(scene, buffers(scene));
  let endpointErr = 0, foldCount = 0, gapCount = 0;
  for (const obj of scene.objects) {
    const mesh = eng.meshes[obj.id];
    for (const lm of obj.landmarks) {
      if (!lm.enabled) continue;
      const p0 = mapPointThroughMesh(mesh, solvePhase(mesh, 0).V, lm.a);
      const p1 = mapPointThroughMesh(mesh, solvePhase(mesh, 1).V, lm.a);
      endpointErr = Math.max(endpointErr,
        Math.hypot(p0[0] - lm.a[0], p0[1] - lm.a[1]),
        Math.hypot(p1[0] - lm.b[0], p1[1] - lm.b[1]));
    }
    for (let k = 0; k <= 10; k++) foldCount += solvePhase(mesh, k / 10).folded.length;
  }
  for (let k = 0; k <= 10; k++) gapCount += renderFrame(eng, k / 10).diagnostics.gapPixels;
  check(`${scene.id}: landmarks exact at endpoints`, endpointErr < 1e-6, { endpointErr });
  check(`${scene.id}: no folded triangles at any phase`, foldCount === 0, { foldCount });
  check(`${scene.id}: no protection gaps while correspondence is legal`, gapCount === 0, { gapCount });
}

// 3) Middle visible domains differ between the two branch orderings.
const engFlap = makeEngineFromSceneData(flap, buffers(flap));
const engArm = makeEngineFromSceneData(arm, buffers(arm));
{
  const r1 = renderFrame(engFlap, 0.5), r2 = renderFrame(engArm, 0.5);
  let diff = 0;
  for (let p = 0; p < r1.image.data.length; p += 4) {
    for (let c = 0; c < 3; c++) if (Math.abs(r1.image.data[p + c] - r2.image.data[p + c]) > 8) { diff++; break; }
  }
  check('branch mid frames differ in the overlap', diff > 1000, { diff });
}

// 4) Moving the handoff into range flips the front object across switchT.
{
  const moved = JSON.parse(JSON.stringify({
    frame: arm.frame, background: arm.background, layers: arm.layers,
    objects: arm.objects, crossings: arm.crossings,
    protection: [arm.truth.protection],
  }));
  const cr = moved.crossings.find((c) => c.handoffDraggable);
  cr.switchT = 0.4; cr.front = 'flap'; cr.switchTo = 'arm';
  const eng = buildEngine(moved, (ref) => (typeof ref === 'string' ? buffers(arm)[ref] : ref));
  const tBefore = 0.35, tAfter = 0.45;
  const before = renderFrame(eng, tBefore);
  const after = renderFrame(eng, tAfter);
  const W = arm.frame.width, H = arm.frame.height;
  // Find a pixel where BOTH objects' raw (pre-split) rasterisations cover at
  // both phases, so the ordering flip is observable. The frame-A overlap
  // centroid can be empty mid-morph because the arm swings away from it.
  const raw = (t) => ({
    flap: rasteriseObject(eng, 'flap', solvePhase(eng.meshes.flap, t), t),
    arm: rasteriseObject(eng, 'arm', solvePhase(eng.meshes.arm, t), t),
  });
  const rawB = raw(tBefore), rawA = raw(tAfter);
  let probe = -1;
  for (let p = 0; p < W * H; p++) {
    if (rawB.flap.prem[p * 4 + 3] > 0.6 && rawB.arm.prem[p * 4 + 3] > 0.6 &&
        rawA.flap.prem[p * 4 + 3] > 0.6 && rawA.arm.prem[p * 4 + 3] > 0.6) { probe = p; break; }
  }
  check('handoff: a mutually covered pixel exists', probe >= 0);
  const ownerAt = (res) => res.diagnostics.objectIds[res.provenance.object[probe]];
  check('handoff: front object flips across switchT',
    probe >= 0 && ownerAt(before) !== ownerAt(after),
    { before: probe >= 0 && ownerAt(before), after: probe >= 0 && ownerAt(after) });
}

// 5) Cuff identity winding stays legal; ownership audit is healthy.
for (const scene of [flap, arm]) {
  const eng = makeEngineFromSceneData(scene, buffers(scene));
  let anyReversal = false;
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    if (cuffWinding(eng, t).reversed || cuffIdentityWinding(eng, t).reversed) anyReversal = true;
  }
  check(`${scene.id}: cuff winding never reverses`, !anyReversal);
  const report = auditProject(eng);
  check(`${scene.id}: audit reports complete cuff cloth`, report.healthy, { diagnosis: report.diagnosis });
  check(`${scene.id}: three cuff identities tracked at both ends`,
    report.cuffIdentities.filter((v) => v.t === 0 || v.t === 1).length === 6);
}

// 6) Broken cuff correspondence: identity order flips and a gap opens.
{
  const broken = JSON.parse(JSON.stringify({
    frame: flap.frame, background: flap.background,
    objects: flap.objects, crossings: flap.crossings,
    protection: [flap.truth.protection],
  }));
  broken.layers = flap.layers;
  const armObj = broken.objects.find((o) => o.id === 'arm');
  const top = armObj.landmarks.find((l) => l.id === 'cuff_top');
  const bot = armObj.landmarks.find((l) => l.id === 'cuff_bot');
  const tmp = top.b; top.b = bot.b; bot.b = tmp;
  const eng = buildEngine(broken, (ref) => (typeof ref === 'string' ? buffers(flap)[ref] : ref));
  const report = auditProject(eng);
  check('broken cuff: audit detects failure', !report.healthy);
  check('broken cuff: identity winding reversal reported', report.windingReversals.length > 0,
    { phases: report.windingReversals.map((r) => r.t) });
  check('broken cuff: protection gap reported', report.gapPhases.length > 0,
    { phases: report.gapPhases.map((r) => r.t) });
  check('broken cuff: missing arm cloth named',
    report.missingClothPhases.some((p) => p.missingCloth.some((m) => m.object === 'arm')));
}

// 7) Regeneration is reproducible: same spec document -> same hash.
{
  const h1 = createHash('sha256').update(JSON.stringify(editableProjectSpec())).digest('hex');
  const h2 = createHash('sha256').update(JSON.stringify(editableProjectSpec())).digest('hex');
  check('master spec regenerates an identical hash', h1 === h2, { hash: h1.slice(0, 16) });
}

// 8) Trade-off report: exact endpoints, zero source endpoint diff, mid diff>0.
{
  const r = garmentTradeoffReport();
  check('tradeoff: endpoint error is zero', r.routes[0].metrics.maxEndpointError === 0);
  check('tradeoff: source endpoint frames identical',
    r.routes[1].metrics.sourceEndpointFrameDiffs === 0);
  check('tradeoff: mid visible-domain difference present',
    r.routes[1].metrics.pixelsThatDifferAtMid > 1000);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
