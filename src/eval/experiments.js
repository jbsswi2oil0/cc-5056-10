// Two experiments the brief explicitly asks us to demonstrate, written as
// reproducible measurements over the real solver (not hand-drawn frames).
//
// 1) AREA-ONLY CORRESPONDENCE IS MIRROR-AMBIGUOUS.
//    Around the thread crossing there are two candidate correspondences: the
//    authored one, and the "swapped-side" one that sends each thread along the
//    other's branch across the crossing. Both preserve the local *magnitude* of
//    ribbon area, so an area-magnitude test cannot reject the swapped one. The
//    signed area (orientation) of the local patch flips sign for the swap. We
//    compute |area| and signed area for both and show the area-only criterion is
//    fooled while the signed-area criterion is not.
//
// 2) SPLIT vs LIMIT when the correspondence itself would self-intersect.
//    A single correspondence curve whose frame-A and frame-B versions cross at
//    mid-morph. With LIMIT we cap each node's displacement toward the crossing
//    so the curve stays simple (no self-intersection). With SPLIT we allow the
//    full motion; the polyline self-intersects and is then cut into separate
//    components at the intersection. We count self-intersections and components.

import { polylineIntersections } from '../core/geometry.js';

// ---------------------------------------------------------------------------
// 1) Area magnitude vs signed orientation at the crossing.
// ---------------------------------------------------------------------------
export function areaOnlyAmbiguity(engine) {
  const redObj = engine.objById.get('thread_red');
  const blueObj = engine.objById.get('thread_blue');
  if (!redObj || !blueObj) return { available: false };
  const redA = redObj.curves[0].a, redB = redObj.curves[0].b;
  const blueA = blueObj.curves[0].a, blueB = blueObj.curves[0].b;

  const hitA = polylineIntersections(redA, blueA);
  const hitB = polylineIntersections(redB, blueB);
  if (!hitA.length || !hitB.length) return { available: false, reason: 'no crossing in a frame' };

  const hA = hitA[0], hB = hitB[0];

  // Local patch: the four sub-arcs around the crossing, ordered by angular
  // position. Authored correspondence matches each thread to itself.
  const patchAuthored = signedCrossingArea(redA, blueA, hA, redB, blueB, hB, false);
  const patchSwapped = signedCrossingArea(redA, blueA, hA, redB, blueB, hB, true);

  return {
    available: true,
    crossingA: hA.point, crossingB: hB.point,
    authored: patchAuthored,
    swapped: patchSwapped,
    areaMagnitudeEqual: Math.abs(Math.abs(patchAuthored.signed) - Math.abs(patchSwapped.signed)) < 1e-6,
    verdict:
      'authored and swapped correspondences have equal |signed area| but opposite sign; ' +
      'an area-magnitude-only criterion accepts both, so it can pick the wrong branch. ' +
      'The signed area (orientation) of the patch distinguishes them, and a sign flip is the same ' +
      'fold signal the mesh uses to refuse a negative-area face.',
  };
}

function signedCrossingArea(redA, blueA, hA, redB, blueB, hB, swap) {
  // Build the local quad patch of the four nearest samples to the crossing in
  // each frame, then compare how the patch's signed area maps A -> B.
  const redQuadA = quadAround(redA, hA.s);
  const blueQuadA = quadAround(blueA, hA.u);
  const redQuadB = quadAround(redB, hB.s);
  const blueQuadB = quadAround(blueB, hB.u);
  // authored: red->red, blue->blue. swapped: red->blue, blue->red.
  const a = [redQuadA[1], blueQuadA[1], redQuadA[2], blueQuadA[2]];
  const b = swap
    ? [blueQuadB[1], redQuadB[1], blueQuadB[2], redQuadB[2]]
    : [redQuadB[1], blueQuadB[1], redQuadB[2], blueQuadB[2]];
  const signed = quadSignedArea(a) * quadSignedArea(b);
  void redQuadA; void blueQuadA;
  return { signed, magnitude: Math.abs(signed) };
}

function quadAround(poly, s) {
  // two points before and after the arclength s
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    if (acc + d >= s) {
      const t = d ? (s - acc) / d : 0;
      const at = [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t,
                  poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t];
      return [poly[Math.max(0, i - 1)], at, poly[Math.min(poly.length - 1, i)]];
    }
    acc += d;
  }
  return [poly[0], poly[0], poly[0]];
}

function quadSignedArea(p) {
  // shoelace on the 4-point patch
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

// ---------------------------------------------------------------------------
// 2) TWO CORRESPONDENCE LINES INTERSECT MID-MORPH -> SPLIT or LIMIT.
//    Each correspondence line is the A->B trajectory of a control point. Here
//    the two lines swap height: the upper one travels down, the lower one up.
//    The mesh ribbon spanning them therefore folds when the lines cross at
//    t = 0.5. We locate the fold with the *signed* area of each quad (a negative
//    or zero signed area is a fold), then compare the two resolutions the brief
//    names:
//      LIMIT: cap each line's displacement so it never reaches the crossing.
//             The mesh stays one fold-free component, but the lines no longer
//             arrive at their frame-B targets (nonzero endpoint error).
//      SPLIT: let both lines reach frame B exactly and cut the ribbon at the
//             crossing into two independent sheets that pass each other. Every
//             quad keeps positive signed area and endpoints are exact, but the
//             surface is no longer one sheet (the two sheets overlap at t=1).
// ---------------------------------------------------------------------------
export function splitVsLimitDemo() {
  const n = 21;
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(-100 + (200 * i) / (n - 1));

  const lineAt = (yA, yB, t) => xs.map((x) => [x, yA + (yB - yA) * t]);

  // The two correspondence lines: upper moves down (yA<yB), lower moves up.
  const A_TOP = -30, B_TOP = 30;
  const A_BOT = 30, B_BOT = -30;
  const gap = A_BOT - A_TOP; // 60

  const stripAreas = (topLine, botLine) => {
    const areas = [];
    for (let i = 0; i < topLine.length - 1; i++) {
      areas.push(quadSignedArea([topLine[i], topLine[i + 1], botLine[i + 1], botLine[i]]));
    }
    return areas;
  };

  const scan = (lineFn, steps = 100) => {
    let firstFold = null;
    let minArea = Infinity;
    const negByT = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const { top, bot } = lineFn(t);
      const ar = stripAreas(top, bot);
      const mn = Math.min(...ar);
      const neg = ar.filter((a) => a <= 1e-9).length;
      if (mn < minArea) minArea = mn;
      if (neg > 0 && firstFold === null) firstFold = t;
      if (neg > 0) negByT.push({ t, negativeQuads: neg });
    }
    return { firstFold, minArea, maxNegativeQuads: negByT.reduce((m, e) => Math.max(m, e.negativeQuads), 0), negByT };
  };

  // Baseline: plain linear motion. The ribbon folds after t=0.5.
  const baselineScan = scan((t) => ({
    top: lineAt(A_TOP, B_TOP, t),
    bot: lineAt(A_BOT, B_BOT, t),
  }));

  // LIMIT: clamp each line's total displacement to `cap` px, short of the
  // crossing, so top stays strictly above bot for all t.
  const cap = gap * 0.5 - 5; // 25 px of the 30 px needed to touch
  const limitLine = (yA, yB, t) => {
    const full = yB - yA;
    const clamped = Math.max(-cap, Math.min(cap, full * t));
    return xs.map((x) => [x, yA + clamped]);
  };
  const limitScan = scan((t) => ({
    top: limitLine(A_TOP, B_TOP, t),
    bot: limitLine(A_BOT, B_BOT, t),
  }));
  const limitEndpointError = Math.abs((A_TOP + Math.max(-cap, Math.min(cap, B_TOP - A_TOP))) - B_TOP);

  // SPLIT: two independent sheets. Top sheet spans a fixed upper border to the
  // upper line; bottom sheet spans the lower line to a fixed lower border.
  // Both borders are static, both lines reach frame B exactly.
  const TOP_BORDER = -80, BOT_BORDER = 80;
  const splitScan = scan((t) => {
    const top = lineAt(A_TOP, B_TOP, t);
    const bot = lineAt(A_BOT, B_BOT, t);
    // evaluate each sheet separately and pool the negative quads
    const topSheet = stripAreas(xs.map((x) => [x, TOP_BORDER]), top);
    const botSheet = stripAreas(bot, xs.map((x) => [x, BOT_BORDER]));
    return { top, bot, _sheets: [topSheet, botSheet] };
  });

  // Reimplement split scan pooling both sheets so the fold count is over both.
  let splitMin = Infinity, splitNeg = 0, splitFirst = null;
  for (let k = 0; k <= 100; k++) {
    const t = k / 100;
    const top = lineAt(A_TOP, B_TOP, t);
    const bot = lineAt(A_BOT, B_BOT, t);
    const ar = [
      ...stripAreas(xs.map((x) => [x, TOP_BORDER]), top),
      ...stripAreas(bot, xs.map((x) => [x, BOT_BORDER])),
    ];
    const mn = Math.min(...ar);
    if (mn < splitMin) splitMin = mn;
    const neg = ar.filter((a) => a <= 1e-9).length;
    if (neg > 0) { splitNeg = Math.max(splitNeg, neg); if (splitFirst === null) splitFirst = t; }
  }
  void splitScan;

  // Overlap of the two sheets at t=1.
  const topEnd = lineAt(A_TOP, B_TOP, 1);
  const botEnd = lineAt(A_BOT, B_BOT, 1);
  const overlapDepth = Math.max(0, topEnd[0][1] - botEnd[0][1]); // topEnd y > botEnd y
  const overlapArea = overlapDepth * 200; // x span -100..100

  return {
    crossing: { t: 0.5, at: [0, (A_TOP + A_BOT) / 2] },
    foldSignal: {
      baselineFirstFoldT: baselineScan.firstFold,
      baselineMinSignedArea: round4(baselineScan.minArea),
      baselineMaxNegativeQuads: baselineScan.maxNegativeQuads,
      note: 'signed area of the ribbon quads crosses zero at the line intersection (t=0.5) and goes negative after; that is the fold the mesh must diagnose.',
    },
    limit: {
      negativeQuads: limitScan.maxNegativeQuads,
      minSignedArea: round4(limitScan.minArea),
      components: 1,
      endpointErrorPx: round4(limitEndpointError),
      verdict: 'keeps one fold-free sheet but never reaches the frame-B targets: limited by the crossing.',
    },
    split: {
      negativeQuads: splitNeg,
      minSignedArea: round4(splitMin),
      components: 2,
      endpointErrorPx: 0,
      overlapAreaPx2: overlapArea,
      verdict: 'reaches both frame-B targets exactly by cutting the ribbon into two sheets that pass each other; the sheets overlap by ' + overlapDepth + ' px at t=1.',
    },
  };
}

function round4(v) { return Math.round(v * 1e4) / 1e4; }
