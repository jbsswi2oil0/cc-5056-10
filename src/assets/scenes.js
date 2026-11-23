// Ground-truth scene builders.
//
// Both scenes ship:
//   * two full frames A and B (what the user sees)
//   * per-object RGBA layers and a separate background, so the engine can
//     reverse-sample each object independently (never blending unrelated pixels)
//   * the authoring data: landmark / curve correspondence per object, occlusion
//     crossings, continuity links
//   * truth: contour correspondence, material probes, curve endpoints, and the
//     expected occlusion order per phase.
//
// Nothing here is a pre-drawn intermediate frame: only A and B plus their
// authoring data are produced. Every intermediate is evaluated by the engine.

import { makeRGBA, toUint8, resampleClosed, polyAreaSigned } from './softraster.js';
import {
  makeHand, rig, renderHandLayer, canonicalContour, W as HW, H as HH,
} from './hands.js';
import { renderCard, threadCurveInFrame, CARD_BG } from './card.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// HAND SCENE
// ---------------------------------------------------------------------------
export function buildHandSceneData() {
  const W = HW, H = HH;
  const handF = makeHand('F', 0, false, [226, 182, 152]);
  const handG = makeHand('G', 1, true, [214, 162, 130]);

  // Distinct poses per frame so the morph is non-trivial, while the union
  // silhouette around the wrists stays consistent for the crossing.
  // Positions chosen so the two palms overlap across most of the frame; only
  // the occlusion ORDER flips between A and B.
  const F_A = rig(-14, 1.06, 272, 250);
  const G_A = rig(16, 1.04, 356, 246);
  const F_B = rig(-9, 1.03, 292, 258);
  const G_B = rig(12, 1.07, 340, 240);

  const layerF_A = renderHandLayer(handF, F_A, W, H, 2);
  const layerF_B = renderHandLayer(handF, F_B, W, H, 2);
  const layerG_A = renderHandLayer(handG, G_A, W, H, 2);
  const layerG_B = renderHandLayer(handG, G_B, W, H, 2);

  const bg = makeBackground(W, H, 11);
  const bgImg = toUint8(bg);

  const A = compose([layerG_A, layerF_A], bg);
  const B = compose([layerF_B, layerG_B], bg);

  const layerPng = (L) => toUint8(composeSingle(L));

  // Canonical contour (frame-A local coords, unmirrored) -> exact material
  // correspondence under either pose, because the body is rigid.
  const contourLocal_F = canonicalContour(handF, 64);
  const contourLocal_G = canonicalContour(handG, 64);
  const worldContour = (pose, hand, local) => local.map(([x, y]) => pose.apply(hand, x, y));

  const cvA_F = worldContour(F_A, handF, contourLocal_F);
  const cvB_F = worldContour(F_B, handF, contourLocal_F);
  const cvA_G = worldContour(G_A, handG, contourLocal_G);
  const cvB_G = worldContour(G_B, handG, contourLocal_G);

  // Landmarks: exact material points (mark centre, thumb tip, wrist pair).
  const marks = [
    { name: 'mark', local: [0, -8] },
    { name: 'thumb', local: [-58, 44] },
    { name: 'wristL', local: [-16, 62] },
    { name: 'wristR', local: [16, 62] },
    { name: 'index', local: [-10, -96] },
    { name: 'pinky', local: [28, -74] },
  ];
  const lmFor = (pose, hand, frameKey, idPrefix) => marks.map((m, i) => {
    // handG is mirrored in draw order; convert to mirrored local first
    const lx = hand.mirror ? -m.local[0] : m.local[0];
    const [x, y] = pose.apply(hand, m.local[0], m.local[1]);
    return { id: `${idPrefix}_${m.name}`, label: `${idPrefix}:${m.name}`, local: m.local, pos: [x, y] };
  });

  const objects = [
    {
      id: 'F', name: 'front hand (A) / back hand (B)',
      depthA: 1, depthB: 0, gridStep: 16,
      curves: [
        compactCurve('F_outline', 'outline', cvA_F, cvB_F),
      ],
      landmarks: lmFor(F_A, handF, 'A', 'F').map((m, i) => ({
        id: m.id, label: m.label, a: m.pos,
        b: lmFor(F_B, handF, 'B', 'F')[i].pos, enabled: i < 4,
        kind: 'landmark',
      })),
    },
    {
      id: 'G', name: 'back hand (A) / front hand (B)',
      depthA: 0, depthB: 1, gridStep: 16,
      curves: [
        compactCurve('G_outline', 'outline', cvA_G, cvB_G),
      ],
      landmarks: lmFor(G_A, handG, 'A', 'G').map((m, i) => ({
        id: m.id, label: m.label, a: m.pos,
        b: lmFor(G_B, handG, 'B', 'G')[i].pos, enabled: i < 4,
        kind: 'landmark',
      })),
    },
  ];

  const crossings = [
    {
      id: 'hands_occlusion', type: 'occlusion',
      objectA: 'F', objectB: 'G',
      front: 'F', switchT: 0.5, switchTo: 'G',
      note: 'frame A: F occludes G; frame B: G occludes F',
    },
  ];

  return {
    id: 'hands',
    frame: { width: W, height: H },
    background: { A: bgImg, B: bgImg },
    layers: {
      F: { A: layerPng(layerF_A), B: layerPng(layerF_B) },
      G: { A: layerPng(layerG_A), B: layerPng(layerG_B) },
    },
    objects, crossings,
    frames: { A, B },
    truth: buildHandTruth({
      W, H, handF, handG, F_A, F_B, G_A, G_B,
      cvA_F, cvB_F, cvA_G, cvB_G,
      layerF_A, layerF_B, layerG_A, layerG_B,
    }),
  };
}

function compactCurve(id, kind, a, b) {
  return { id, name: id, kind, a: a.map((p) => [round2(p[0]), round2(p[1])]), b: b.map((p) => [round2(p[0]), round2(p[1])]), enabled: true };
}
const round2 = (v) => Math.round(v * 100) / 100;

function makeBackground(W, H, seed) {
  const img = makeRGBA(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const t = (x / W + y / H) * 0.5;
    const vig = 1 - 0.35 * Math.hypot((x - W * 0.5) / W, (y - H * 0.55) / H);
    const grain = 3.5 * Math.sin(x * 0.31 + y * 0.17) * Math.cos(x * 0.07 - y * 0.43);
    img.data[i] = (44 + 26 * t) * vig / 255 + grain / 255;
    img.data[i + 1] = (48 + 24 * t) * vig / 255 + grain / 255;
    img.data[i + 2] = (58 + 22 * t) * vig / 255 + grain * 0.7 / 255;
    img.data[i + 3] = 1;
  }
  return img;
}

function composeSingle(L) {
  const img = makeRGBA(HW, HH);
  for (let i = 0; i < HW * HH; i++) {
    const a = L.cov[i];
    img.data[i * 4] = L.rgb[i * 3];
    img.data[i * 4 + 1] = L.rgb[i * 3 + 1];
    img.data[i * 4 + 2] = L.rgb[i * 3 + 2];
    img.data[i * 4 + 3] = a;
  }
  return img;
}

function compose(layersBackToFront, bg) {
  const img = makeRGBA(HW, HH);
  img.data.set(bg.data);
  for (const L of layersBackToFront) {
    for (let i = 0; i < HW * HH; i++) {
      const a = L.cov[i];
      if (a <= 1e-4) continue;
      for (let c = 0; c < 3; c++) img.data[i * 4 + c] = L.rgb[i * 3 + c] * a + img.data[i * 4 + c] * (1 - a);
    }
  }
  return toUint8(img);
}

function buildHandTruth(ctx) {
  const { W, H, handF, handG, F_A, F_B, G_A, G_B, cvA_F, cvB_F, cvA_G, cvB_G } = ctx;
  // material probes: local point -> canvas pos in each frame, plus visible flag
  const probes = [
    { name: 'F-mark', object: 'F', local: [0, -8] },
    { name: 'G-mark', object: 'G', local: [0, -8] },
    { name: 'F-thumbtip', object: 'F', local: [-58, 44] },
    { name: 'G-thumbtip', object: 'G', local: [-58, 44] },
  ].map((p) => {
    const hand = p.object === 'F' ? handF : handG;
    const poseA = p.object === 'F' ? F_A : G_A;
    const poseB = p.object === 'F' ? F_B : G_B;
    return {
      ...p,
      A: poseA.apply(hand, p.local[0], p.local[1]),
      B: poseB.apply(hand, p.local[0], p.local[1]),
    };
  });
  // Expected visible ownership inside the overlap, per frame (1=F,2=G,0=none).
  const topA = new Uint8Array(W * H), topB = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const af = ctx.layerF_A.cov[i] > 0.5, ag = ctx.layerG_A.cov[i] > 0.5;
    topA[i] = af && ag ? 1 : af ? 1 : ag ? 2 : 0;
    const bf = ctx.layerF_B.cov[i] > 0.5, bg2 = ctx.layerG_B.cov[i] > 0.5;
    topB[i] = bf && bg2 ? 2 : bf ? 1 : bg2 ? 2 : 0;
  }
  return {
    contours: {
      F: { A: cvA_F, B: cvB_F },
      G: { A: cvA_G, B: cvB_G },
    },
    probes,
    topA, topB,
    occlusion: { before: 'F', after: 'G', switchT: 0.5 },
    // overlap centroid where provenance is checked
    overlapCentroid: computeOverlapCentroid(ctx.layerF_A, ctx.layerG_A),
  };
}

function computeOverlapCentroid(lF, lG) {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < HW * HH; i++) {
    if (lF.cov[i] > 0.5 && lG.cov[i] > 0.5) { sx += i % HW; sy += (i / HW) | 0; n++; }
  }
  return n ? [sx / n, sy / n] : [HW / 2, HH / 2];
}

// ---------------------------------------------------------------------------
// STITCH SCENE
// ---------------------------------------------------------------------------
export function buildStitchSceneData() {
  const W = 620, H = 460, SS = 2;
  const { A, B, layers, background, truth } = renderCard(W, H, SS);

  const paperCurve = {
    id: 'paper_outline', name: 'paper outline', kind: 'outline',
    a: truth.paperContourA.map((p) => [round2(p[0]), round2(p[1])]),
    b: truth.paperContourB.map((p) => [round2(p[0]), round2(p[1])]),
    enabled: true,
  };
  const paperLandmarks = truth.landmarks.filter((l) => l.object === 'paper').map((lm) => ({
    id: lm.id, label: lm.label, kind: 'landmark',
    a: lm.a.map(round2), b: lm.b.map(round2), enabled: true,
  }));

  const threadObject = (th) => {
    const a = threadCurveInFrame(th, 'A'), b = threadCurveInFrame(th, 'B');
    return {
      id: `thread_${th}`, name: `${th} thread`, depthA: th === 'red' ? 2 : 1, depthB: th === 'red' ? 2 : 1,
      gridStep: 14,
      curves: [{
        id: `curve_${th}`, name: `${th} thread`, kind: 'stroke',
        a: a.map((p) => [round2(p[0]), round2(p[1])]),
        b: b.map((p) => [round2(p[0]), round2(p[1])]),
        enabled: true,
      }],
      landmarks: truth.landmarks.filter((l) => l.object === `thread_${th}`).map((lm) => ({
        id: lm.id, label: lm.label, kind: 'landmark',
        a: lm.a.map(round2), b: lm.b.map(round2), enabled: true,
      })),
    };
  };

  const objects = [
    { id: 'paper', name: 'paper card', depthA: 0, depthB: 0, gridStep: 24, curves: [paperCurve], landmarks: paperLandmarks },
    threadObject('blue'),
    threadObject('red'),
  ];

  // The two threads cross. The author declares red OVER blue in both frames,
  // and marks the crossing as a continuity link: both strokes stay connected
  // and the crossing itself may not split.
  const crossings = [
    {
      id: 'thread_cross', type: 'occlusion',
      objectA: 'blue', objectB: 'red',
      front: 'red', switchT: 2.0, switchTo: 'red',
      note: 'red thread is drawn over blue at their crossing in both frames',
    },
    {
      id: 'thread_link', type: 'continuity',
      object: 'paper', curveA: 'none', curveB: 'none',
      link: true, refA: truth.crossingA, refB: truth.crossingB,
      note: 'generative continuity: the visual crossing of the threads moves, but each stroke stays a single connected piece',
    },
  ];

  return {
    id: 'stitch',
    frame: { width: W, height: H },
    background: { A: background, B: background },
    layers: {
      paper: { A: layers.paper.A, B: layers.paper.B },
      thread_red: { A: layers.red.A, B: layers.red.B },
      thread_blue: { A: layers.blue.A, B: layers.blue.B },
    },
    objects, crossings,
    frames: { A, B },
    truth,
  };
}
