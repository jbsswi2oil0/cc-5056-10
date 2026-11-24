// Trade-off analysis for the garment practice material.
//
// Two ways to produce occlusion-reveal morph practice assets:
//
//  A. paired-contour generation — drive every layer from paired outline
//     polylines (A/B) with matching sample counts, build one fixed-topology
//     mesh per cloth piece. Gives exact, nameable vertex correspondence and
//     deterministic regeneration, but on its own says nothing about which
//     piece is on top when outlines cross.
//
//  B. occlusion-event choreography — keep the geometry rig fixed and author
//     the shot as ordered depth events (which object is front, where the
//     handoff switch sits in phase space). Gives correct visible domains for
//     both branch orderings from ONE geometry set, but relies on (A) for the
//     correspondence it moves around.
//
// This project combines them: A generates the shared practice assets, B
// orchestrates the two layered animatics (flapfront / armfront). The metrics
// below make the trade measurable rather than a matter of taste.

import { buildGarmentProjects } from '../assets/garment-project.js';
import { makeEngineFromSceneData } from '../assets/loader.js';
import { renderFrame } from '../core/engine.js';
import { solvePhase } from '../core/mesh.js';

const round3 = (v) => Math.round(v * 1000) / 1000;

export function garmentTradeoffReport() {
  const projects = buildGarmentProjects();

  // --- Route A metrics: correspondence quality from paired outlines --------
  const routeA = { name: 'paired-contour generation', metrics: {} };
  const first = projects.flapfront;
  let pinCount = 0, nodeCount = 0, triCount = 0, endpointErr = 0, foldPhases = 0;
  const buffers = bufferMap(first);
  const engine = makeEngineFromSceneData(first, buffers);
  for (const obj of first.objects) {
    const mesh = engine.meshes[obj.id];
    pinCount += mesh.pins.length;
    nodeCount += mesh.points.length;
    triCount += mesh.T.length;
    for (const lm of obj.landmarks) {
      if (!lm.enabled) continue;
      const pin = mesh.pins.find((p) => p.id === lm.id);
      if (!pin) continue;
      const V0 = solvePhase(mesh, 0).V, V1 = solvePhase(mesh, 1).V;
      // pins move with the homotopy, so their solved positions equal the
      // authored A/B targets to machine precision at the endpoints
      endpointErr = Math.max(endpointErr,
        Math.hypot(V0[pin.v * 2] - lm.a[0], V0[pin.v * 2 + 1] - lm.a[1]),
        Math.hypot(V1[pin.v * 2] - lm.b[0], V1[pin.v * 2 + 1] - lm.b[1]));
    }
    for (let k = 0; k <= 10; k++) foldPhases += solvePhase(mesh, k / 10).folded.length;
  }
  routeA.metrics = {
    pinnedCorrespondences: pinCount,
    meshNodes: nodeCount,
    triangles: triCount,
    maxEndpointError: round3(endpointErr),
    foldedTrianglesAcrossPhases: foldPhases,
    regeneration: 'deterministic: same master spec -> identical layers + meshes',
  };

  // --- Route B metrics: visible-domain difference from occlusion events ----
  const routeB = { name: 'occlusion-event choreography', metrics: {} };
  const engFlap = makeEngineFromSceneData(projects.flapfront, bufferMap(projects.flapfront));
  const engArm = makeEngineFromSceneData(projects.armfront, bufferMap(projects.armfront));
  const W = first.frame.width, H = first.frame.height;
  const diffs = [];
  // Endpoint POSES are shared geometry: the authored frame A/B bytes are
  // identical between branches. The occlusion ordering still changes who is
  // on top inside the overlap at the ends, so engine renders differ there;
  // measure the source-frame identity separately from the solved difference.
  let sourceEndpointDiffs = 0;
  const fA1 = projects.flapfront.frames.A.data, fA2 = projects.armfront.frames.A.data;
  const fB1 = projects.flapfront.frames.B.data, fB2 = projects.armfront.frames.B.data;
  for (let i = 0; i < fA1.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(fA1[i + c] - fA2[i + c]) > 8 || Math.abs(fB1[i + c] - fB2[i + c]) > 8) { sourceEndpointDiffs++; break; }
    }
  }
  let solvedEndpointDiffs = 0;
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    const r1 = renderFrame(engFlap, t);
    const r2 = renderFrame(engArm, t);
    let diff = 0;
    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < 3; c++) {
        if (Math.abs(r1.image.data[p * 4 + c] - r2.image.data[p * 4 + c]) > 8) { diff++; break; }
      }
    }
    diffs.push({ t, differingPixels: diff });
    if (t === 0 || t === 1) solvedEndpointDiffs += diff;
  }
  const midDiff = diffs.find((d) => d.t === 0.5)?.differingPixels;
  routeB.metrics = {
    geometryRigs: 1,
    occlusionBranches: 2,
    pixelsThatDifferAtMid: midDiff,
    sourceEndpointFrameDiffs: sourceEndpointDiffs,
    solvedEndpointDiffsFromOrdering: solvedEndpointDiffs,
    perPhase: diffs,
    note: 'authored endpoint frames are identical bytes; branch events change the solved visible domain, most strongly mid-morph',
  };

  return {
    routes: [routeA, routeB],
    decision: [
      'Route A alone guarantees exact correspondence but cannot express reveal order.',
      'Route B alone gives both reveals from one rig but has no geometry without A.',
      'Combined: A builds the shared layers/vertices/keyframes; B authors the two occlusion branches on top, so the projects share endpoints and differ only in the middle visible domain.',
    ],
  };
}

function bufferMap(sceneData) {
  const bufs = {};
  for (const [id, pair] of Object.entries(sceneData.layers)) {
    bufs[`${id}:A`] = pair.A; bufs[`${id}:B`] = pair.B;
  }
  return bufs;
}
