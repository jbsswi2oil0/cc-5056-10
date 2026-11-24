// Garment project generator.
//
// One master geometry rig (garment.js) is expanded into TWO practice projects
// whose endpoint poses are identical and whose occlusion choreography differs:
//
//   flapfront  — the lapel flap passes in front of the arm
//   armfront   — the arm passes in front of the lapel flap
//
// The generator is deterministic: layer images, outline correspondence,
// landmark/vertex identity, protection faces and keyframe metadata all derive
// from the same spec, so re-running it after an edit regenerates every piece
// together (the "material project that regenerates layers, correspondence and
// keyframes"). Nothing here produces an intermediate frame.

import {
  masterGarmentSpec, makePose, armLocalContour, cuffLocalPolygon,
  renderRobeLayers, renderArmLayer, renderGarmentBackground, composeFrame,
  toUint8, toStraightUint8,
} from './garment.js';
import { resampleClosed, polyAreaSigned, makeRGBA } from './softraster.js';

const TAU = Math.PI * 2;
const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Outline correspondence: closed contours resampled to equal counts. The arm
// contour comes from the SAME local capsule vertices under both rigid poses,
// so vertex identity is exact material correspondence, not a guess.
// ---------------------------------------------------------------------------
function outlineCurve(id, name, ptsA, ptsB, n) {
  const a = resampleClosed(ptsA, n);
  const b = resampleClosed(ptsB, n);
  // keep winding consistent: both CCW
  const ccwA = polyAreaSigned(a) >= 0 ? a : a.slice().reverse();
  const ccwB = polyAreaSigned(b) >= 0 ? b : b.slice().reverse();
  return {
    id, name, kind: 'outline', enabled: true,
    a: ccwA.map((p) => [round2(p[0]), round2(p[1])]),
    b: ccwB.map((p) => [round2(p[0]), round2(p[1])]),
  };
}

// Material-point landmarks: named points whose identity survives the morph.
function landmark(id, label, a, b) {
  return { id, label, kind: 'landmark', enabled: true, a: a.map(round2), b: b.map(round2) };
}

// ---------------------------------------------------------------------------
// Build both project scene-data bundles from one spec.
// ---------------------------------------------------------------------------
export function buildGarmentProjects(spec = masterGarmentSpec()) {
  const { width: W, height: H } = spec.frame;

  // -- layers: geometry is rendered once; both projects share the PNG bytes --
  const robeA = renderRobeLayers(spec, 'A');
  const robeB = renderRobeLayers(spec, 'B');
  const armA = renderArmLayer(spec, 'A');
  const armB = renderArmLayer(spec, 'B');
  const bg = toUint8(renderGarmentBackground(W, H, spec.backgroundSeed));

  // Independent object layers keep straight (un-premultiplied) alpha because
  // the engine composites straight RGBA; fully transparent pixels carry black
  // so the standalone PNGs have no white fringe.
  const layers = {
    torso: { A: toStraightUint8(robeA.torso), B: toStraightUint8(robeB.torso) },
    flap: { A: toStraightUint8(robeA.flap), B: toStraightUint8(robeB.flap) },
    arm: { A: toStraightUint8(armA.image), B: toStraightUint8(armB.image) },
  };
  const layerRefs = {
    torso: { A: 'torso_A.png', B: 'torso_B.png' },
    flap: { A: 'flap_A.png', B: 'flap_B.png' },
    arm: { A: 'arm_A.png', B: 'arm_B.png' },
  };

  // -- full frames: ONE shared endpoint composite for both branches ---------
  // The two projects share endpoint poses, so frames A and B are identical
  // bytes in both. The branch difference lives only in the occlusion crossing
  // and therefore in the middle visible domain, never in the authored ends.
  const bgImg = renderGarmentBackground(W, H, spec.backgroundSeed);
  const frameA = composeFrame(bgImg, [robeA.torso, armA.image, robeA.flap]);
  const frameB = composeFrame(bgImg, [robeB.torso, armB.image, robeB.flap]);
  const frames = {
    flapfront: { A: frameA, B: frameB },
    armfront: { A: frameA, B: frameB },
  };

  // -- outline curves --------------------------------------------------------
  const n = spec.outlineSamples;
  const poseA = makePose(spec.arm.pivotA, spec.arm.angleADeg);
  const poseB = makePose(spec.arm.pivotB, spec.arm.angleBDeg);
  const armLocal = armLocalContour(spec);

  const armCurve = outlineCurve(
    'arm_outline', 'sleeve outline',
    armLocal.map(poseA.apply), armLocal.map(poseB.apply), n
  );
  const flapCurve = outlineCurve(
    'flap_outline', 'lapel flap outline',
    spec.robe.flap, spec.robe.flapB, n
  );
  const torsoCurve = outlineCurve(
    'torso_outline', 'robe torso outline',
    spec.robe.torso, spec.robe.torso, n
  );

  // -- landmarks -------------------------------------------------------------
  // Three identity-tracked cuff vertices, plus shoulder + flap corners so each
  // object has a well-constrained mesh.
  const cuffLandmarks = spec.cuffIds.map((c) =>
    landmark(c.id, c.id, poseA.apply(c.local), poseB.apply(c.local))
  );
  const shoulderLocal = [0, 0];
  const armLandmarks = [
    ...cuffLandmarks,
    landmark('arm_shoulder', 'shoulder pivot', poseA.apply(shoulderLocal), poseB.apply(shoulderLocal)),
    landmark('arm_elbow_top', 'elbow top', poseA.apply([spec.arm.length * 0.45, -spec.arm.radius]),
      poseB.apply([spec.arm.length * 0.45, -spec.arm.radius])),
  ];
  const flapLandmarks = spec.robe.flap.map((p, i) =>
    landmark(`flap_corner_${i}`, `flap corner ${i}`, p, spec.robe.flapB[i])
  );
  const torsoLandmarks = [0, 1, 3].map((i) =>
    landmark(`torso_corner_${i}`, `torso corner ${i}`, spec.robe.torso[i], spec.robe.torso[i])
  );

  // -- action tracks: the phase trajectories of the named material points ----
  // The engine solves these through the mesh; the track is recorded here as the
  // authored straight-line reference (per-object similarity homotopy restores
  // both ends exactly, so tracks are checkable end to end).
  const tracks = {
    cuff: spec.cuffIds.map((c) => ({
      id: c.id, object: 'arm',
      A: poseA.apply(c.local).map(round2),
      B: poseB.apply(c.local).map(round2),
      // keyframes at quarters, straight authored reference in world space
      keys: [0, 0.25, 0.5, 0.75, 1].map((t) => ({
        t,
        pos: [
          round2(poseA.apply(c.local)[0] + (poseB.apply(c.local)[0] - poseA.apply(c.local)[0]) * t),
          round2(poseA.apply(c.local)[1] + (poseB.apply(c.local)[1] - poseA.apply(c.local)[1]) * t),
        ],
      })),
    })),
  };

  // -- protection surfaces ---------------------------------------------------
  // The cuff band is the protected surface: its correspondence is declared
  // legal only while every cuff triangle keeps positive signed area and the
  // three cuff identities remain in their authored order (no reversal). When
  // the correspondence loses legality the engine's fold pass refuses those
  // faces and the audit reports a GAP rather than inventing cloth.
  const cuffPolyA = cuffLocalPolygon(spec).map(poseA.apply);
  const cuffPolyB = cuffLocalPolygon(spec).map(poseB.apply);
  const protection = {
    object: 'arm',
    id: 'cuff_band',
    polygonA: cuffPolyA.map((p) => p.map(round2)),
    polygonB: cuffPolyB.map((p) => p.map(round2)),
    identityOrder: spec.cuffIds.map((c) => c.id), // top -> mid -> bot, expected order
  };

  const baseObjects = [
    {
      id: 'torso', name: 'robe torso', depthA: 0, depthB: 0,
      gridStep: spec.gridStep + 6, protected: false,
      curves: [torsoCurve], landmarks: torsoLandmarks,
    },
    {
      id: 'flap', name: 'front lapel flap', depthA: 1, depthB: 1,
      gridStep: spec.gridStep, protected: false,
      curves: [flapCurve], landmarks: flapLandmarks,
    },
    {
      id: 'arm', name: 'sleeved arm', depthA: 2, depthB: 2,
      gridStep: spec.gridStep, protected: true, protectionId: 'cuff_band',
      curves: [armCurve], landmarks: armLandmarks,
    },
  ];

  const build = (projectId, branch) => {
    const occ = spec.occlusion.handoff[branch];
    const crossings = [{
      id: spec.occlusion.id, type: 'occlusion',
      objectA: spec.occlusion.objectA, objectB: spec.occlusion.objectB,
      front: occ.front, switchT: occ.switchT, switchTo: occ.switchTo,
      handoffDraggable: true,
      note: branch === 'flapfront'
        ? 'lapel flap passes in front of the arm for the whole shot'
        : 'arm passes in front of the lapel flap for the whole shot',
    }];
    return {
      id: projectId,
      branch,
      frame: { width: W, height: H },
      background: { A: bg, B: bg },
      layers,
      layerRefs,
      objects: JSON.parse(JSON.stringify(baseObjects)),
      crossings,
      frames: { A: frames[branch].A, B: frames[branch].B },
      truth: {
        sharedGeometry: true,
        branch,
        contours: {
          arm: { A: armCurve.a, B: armCurve.b },
          flap: { A: flapCurve.a, B: flapCurve.b },
        },
        cuffTracks: tracks.cuff,
        protection,
        occlusionOrder: branch === 'flapfront'
          ? { front: 'flap', back: 'arm' }
          : { front: 'arm', back: 'flap' },
        // overlap region centroid, used to prove the visible domain differs
        overlapCentroid: overlapCentroid(layers.flap.A, layers.arm.A, W, H),
      },
    };
  };

  return {
    flapfront: build('flapfront', 'flapfront'),
    armfront: build('armfront', 'armfront'),
  };
}

function overlapCentroid(flapImg, armImg, W, H) {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < W * H; i++) {
    if (flapImg.data[i * 4 + 3] > 128 && armImg.data[i * 4 + 3] > 128) {
      sx += i % W; sy += (i / W) | 0; n++;
    }
  }
  return n ? [round2(sx / n), round2(sy / n)] : [W / 2, H / 2];
}

// Editable project spec (JSON-serialisable, no pixel buffers): the file an
// author edits. buildGarmentProjects(masterSpec) turns it back into a full
// project, so exports from this document reproduce the modification.
export function editableProjectSpec(spec = masterGarmentSpec()) {
  const projects = buildGarmentProjects(spec);
  return {
    version: 1,
    generator: 'garment-project',
    frame: spec.frame,
    master: spec,
    projects: Object.fromEntries(
      Object.entries(projects).map(([k, p]) => [k, {
        id: p.id,
        branch: p.branch,
        crossings: p.crossings,
        objects: p.objects.map((o) => ({
          id: o.id, depthA: o.depthA, depthB: o.depthB,
          gridStep: o.gridStep, protected: o.protected,
        })),
      }])
    ),
  };
}

// Re-exported for the audit module and tests.
export { armLocalContour, cuffLocalPolygon, makePose, TAU, makeRGBA };
