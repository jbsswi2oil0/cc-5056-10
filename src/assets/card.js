// Stitch-card scene.
//
// One paper card bearing embroidered threads. Two threads cross, and the
// crossing point is at a different place in A than in B. The threads are
// continuous in BOTH frames, so the crossing must remain a single connected
// stroke at every intermediate phase: the author marks it as a continuity link,
// which turns into a hard "limit displacement of the crossing" constraint.
//
// As the correspondence is dragged across the midpoint the two threads would
// naturally meet and swap sides. We show that the *area-preserving* choice is
// wrong for this case: forcing the crossing alone to preserve local area picks
// the other side of the other thread, giving a false correspondence, whereas the
// link constraint keeps both strokes connected and pinned to the same material
// crossing. See test/evaluate for the demonstration.

import {
  makeRGBA, toUint8, capsuleSDF, coverageFromSDF, roundRectSDF,
  marchingSquares, resampleClosed, ensureCCW, compositeOver,
} from './softraster.js';

export const CARD_BG = [86, 74, 62];

const PAPER = { hw: 205, hh: 158, r: 14 };

// Thread centre-lines are defined in card-local coordinates. Frame A and frame B
// use different local coordinates for the SAME material segments, so the crossing
// moves while endpoints stay material-identical.
const RED_PTS = [
  [-180, -78], [-120, -40], [-64, 6], [-8, 44], [56, 66], [128, 58], [182, 30],
];
const BLUE_PTS = [
  [-172, 74], [-112, 44], [-58, 8], [6, -22], [74, -50], [140, -64], [186, -42],
];

// Frame-B versions: material endpoints unchanged, interior bent so that the
// crossing of red and blue lands elsewhere.
const RED_PTS_B = [
  [-180, -78], [-124, -26], [-70, 20], [-10, 52], [52, 60], [124, 46], [182, 30],
];
const BLUE_PTS_B = [
  [-172, 74], [-108, 36], [-54, -6], [4, -30], [70, -46], [138, -62], [186, -42],
];

function catmullRom(pts, samplesPerSeg = 24) {
  // open Catmull-Rom through pts
  const out = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
      const t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  const last = P[P.length - 2];
  out.push([last[0], last[1]]);
  return out;
}

function cardPose(frame) {
  // slight rotation / shift of the whole card between frames
  if (frame === 'A') return { angle: -2.5 * Math.PI / 180, tx: 0, ty: 0, s: 1 };
  return { angle: 2.0 * Math.PI / 180, tx: 6, ty: -4, s: 1.01 };
}

function cardLocalToFrame(frame, x, y) {
  const p = cardPose(frame);
  const c = Math.cos(p.angle) * p.s, s = Math.sin(p.angle) * p.s;
  return [p.tx + c * x - s * y + 310, p.ty + s * x + c * y + 230];
}

export function threadCurveInFrame(th, frame) {
  const base = th === 'red' ? (frame === 'A' ? RED_PTS : RED_PTS_B) : (frame === 'A' ? BLUE_PTS : BLUE_PTS_B);
  const pts = catmullRom(base);
  // material correspondence: the same parameter corresponds. Resample evenly so
  // A and B have the same count.
  const n = 40;
  return resampleEven(pts, n).map(([x, y]) => cardLocalToFrame(frame, x, y));
}

function resampleEven(pts, n) {
  const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); total += d; }
  const out = []; let si = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = total * k / (n - 1);
    while (si < seg.length - 1 && acc + seg[si] < target) { acc += seg[si]; si++; }
    const t = seg[si] ? (target - acc) / seg[si] : 0;
    out.push([pts[si][0] + (pts[si + 1][0] - pts[si][0]) * t, pts[si][1] + (pts[si + 1][1] - pts[si][1]) * t]);
  }
  return out;
}

const THREAD_STYLE = {
  red: { color: [176, 44, 52], r: 4.6, highlight: [222, 128, 128] },
  blue: { color: [40, 84, 150], r: 4.2, highlight: [120, 168, 222] },
};

function renderCardLayers(W, H, ss) {
  const bg = makeRGBA(W, H);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    const vig = 1 - 0.18 * Math.hypot((x - W / 2) / W, (y - H / 2) / H);
    bg.data[i * 4] = CARD_BG[0] * vig / 255;
    bg.data[i * 4 + 1] = CARD_BG[1] * vig / 255;
    bg.data[i * 4 + 2] = CARD_BG[2] * vig / 255;
    bg.data[i * 4 + 3] = 1;
  }

  // Each morphable element is its OWN object layer, so no single mesh ever has
  // to represent a self-intersecting surface. Visible-surface splitting at the
  // thread crossing is then done by the author-declared occlusion order.
  const paper = { A: makeRGBA(W, H), B: makeRGBA(W, H) };
  for (const [frame, out] of [['A', paper.A], ['B', paper.B]]) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let cov = 0, sum = [0, 0, 0];
      for (let oy = 0; oy < ss; oy++) for (let ox = 0; ox < ss; ox++) {
        const sx = x + (ox + 0.5) / ss, sy = y + (oy + 0.5) / ss;
        const [lx, ly] = frameToLocal(frame, sx, sy);
        const sd = roundRectSDF(lx, ly, 0, 0, PAPER.hw, PAPER.hh, PAPER.r);
        const c = coverageFromSDF(sd, 0.9);
        if (c > 0) {
          const fibre = 5 * Math.sin(lx * 0.33 + ly * 0.11) + 4 * Math.cos(lx * 0.09 - ly * 0.27);
          sum[0] += (240 + fibre) / 255 * c;
          sum[1] += (232 + fibre * 0.8) / 255 * c;
          sum[2] += (214 + fibre * 0.5) / 255 * c;
        }
        cov += c;
      }
      const a = cov / (ss * ss);
      if (a > 0) { out.data[i] = sum[0] / cov; out.data[i + 1] = sum[1] / cov; out.data[i + 2] = sum[2] / cov; out.data[i + 3] = a; }
    }
    drawHoles(out, frame, ss);
  }

  const threads = {};
  for (const th of ['red', 'blue']) {
    const style = THREAD_STYLE[th];
    threads[th] = { A: makeRGBA(W, H), B: makeRGBA(W, H) };
    for (const [frame, out] of [['A', threads[th].A], ['B', threads[th].B]]) {
      const curve = threadCurveInFrame(th, frame);
      drawThread(out, curve, style, ss);
      drawThreadHighlight(out, curve, style, ss);
    }
  }
  return { paper, threads, bg };
}

function frameToLocal(frame, x, y) {
  const p = cardPose(frame);
  const dx = x - 310 - p.tx, dy = y - 230 - p.ty;
  const c = Math.cos(p.angle) * p.s, s = Math.sin(p.angle) * p.s;
  const inv = 1 / (c * c + s * s);
  return [(c * dx + s * dy) * inv, (-s * dx + c * dy) * inv];
}

function polylineMinDist(curve, x, y) {
  let best = Infinity;
  for (let i = 1; i < curve.length; i++) {
    const ax = curve[i - 1][0], ay = curve[i - 1][1], bx = curve[i][0], by = curve[i][1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let u = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
    u = Math.max(0, Math.min(1, u));
    const d = Math.hypot(x - (ax + dx * u), y - (ay + dy * u));
    if (d < best) best = d;
  }
  return best;
}

function drawThread(img, curve, style, ss) {
  const { width: w, height: h, data } = img;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of curve) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
  const pad = style.r + 3;
  const x0 = Math.max(0, Math.floor(minx - pad)), x1 = Math.min(w - 1, Math.ceil(maxx + pad));
  const y0 = Math.max(0, Math.floor(miny - pad)), y1 = Math.min(h - 1, Math.ceil(maxy + pad));
  // thread with a twisted-fibre shading along its length
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    let cov = 0, shade = 0, cnt = 0;
    for (let oy = 0; oy < ss; oy++) for (let ox = 0; ox < ss; ox++) {
      const sx = x + (ox + 0.5) / ss, sy = y + (oy + 0.5) / ss;
      const d = polylineMinDist(curve, sx, sy);
      const c = coverageFromSDF(d - style.r, 0.8);
      if (c > 0) {
        // fibre twist: high-frequency stripes across the thread
        const tw = 0.5 + 0.5 * Math.sin((sx + sy) * 1.7);
        shade += c * tw; cov += c; cnt++;
      }
    }
    if (cov <= 0) continue;
    const a = Math.min(1, cov / (ss * ss));
    const i = (y * w + x) * 4;
    const fib = 0.82 + 0.18 * (shade / (cov || 1));
    const col = [style.color[0] * fib, style.color[1] * fib, style.color[2] * fib];
    // over existing (paper) content
    const pa = data[i + 3];
    const oa = a + pa * (1 - a);
    for (let c = 0; c < 3; c++) data[i + c] = (col[c] / 255 * a + data[i + c] * pa * (1 - a)) / (oa || 1);
    data[i + 3] = oa;
  }
}

function drawThreadHighlight(img, curve, style, ss) {
  // thin specular line offset from the thread centre, along its normal
  const { width: w, height: h, data } = img;
  const off = -style.r * 0.35;
  const shifted = [];
  for (let i = 0; i < curve.length; i++) {
    const a = curve[Math.max(0, i - 1)], b = curve[Math.min(curve.length - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    shifted.push([curve[i][0] - ty * off, curve[i][1] + tx * off]);
  }
  for (let i = 1; i < shifted.length; i++) {
    const ax = shifted[i - 1][0], ay = shifted[i - 1][1], bx = shifted[i][0], by = shifted[i][1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let k = 0; k <= steps; k++) {
      const px = ax + (bx - ax) * (k / steps), py = ay + (by - ay) * (k / steps);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(px + dx), y = Math.round(py + dy);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i2 = (y * w + x) * 4;
        if (data[i2 + 3] < 0.4) continue;
        const aL = 0.22;
        for (let c = 0; c < 3; c++) data[i2 + c] = data[i2 + c] * (1 - aL) + (style.highlight[c] / 255) * aL;
      }
    }
  }
  void ss;
}

function drawHoles(img, frame, ss) {
  const { width: w, height: h, data } = img;
  for (let k = -6; k <= 6; k++) {
    const lx = k * 30, ly = PAPER.hh - 12;
    const [cx, cy] = cardLocalToFrame(frame, lx, ly);
    for (let y = Math.floor(cy - 4); y <= cy + 4; y++) for (let x = Math.floor(cx - 4); x <= cx + 4; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const d = Math.hypot(x - cx, y - cy) - 3.0;
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (a <= 0) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = data[i + c] * (1 - a) + (60 / 255) * a;
    }
  }
  void ss;
}

// ---------------------------------------------------------------------------
export function renderCard(W, H, ss) {
  const { paper, threads, bg } = renderCardLayers(W, H, ss);
  // Full frames: background, then paper, then threads in draw order (red over
  // blue where they meet). This is the only place full-frame pixels are built.
  const A = makeRGBA(W, H); A.data.set(bg.data);
  compositeOver(A, paper.A); compositeOver(A, threads.blue.A); compositeOver(A, threads.red.A);
  const B = makeRGBA(W, H); B.data.set(bg.data);
  compositeOver(B, paper.B); compositeOver(B, threads.blue.B); compositeOver(B, threads.red.B);

  const paperContourA = paperContourInFrame('A');
  const paperContourB = paperContourInFrame('B');
  const redA = threadCurveInFrame('red', 'A'), blueA = threadCurveInFrame('blue', 'A');
  const redB = threadCurveInFrame('red', 'B'), blueB = threadCurveInFrame('blue', 'B');
  const crossA = crossingOf(redA, blueA);
  const crossB = crossingOf(redB, blueB);

  const landmarks = [];
  const cornerLocal = [[-PAPER.hw, -PAPER.hh], [PAPER.hw, -PAPER.hh], [PAPER.hw, PAPER.hh], [-PAPER.hw, PAPER.hh]];
  cornerLocal.forEach((c, i) => {
    landmarks.push({
      id: `corner${i}`, label: `paper corner ${i}`,
      a: cardLocalToFrame('A', c[0], c[1]), b: cardLocalToFrame('B', c[0], c[1]), object: 'paper',
    });
  });
  // extra paper landmarks along the border so the paper mesh is well-conditioned
  const borderLocal = [
    [0, -PAPER.hh], [0, PAPER.hh], [-PAPER.hw, 0], [PAPER.hw, 0],
    [-PAPER.hw * 0.6, PAPER.hh], [PAPER.hw * 0.6, -PAPER.hh],
  ];
  borderLocal.forEach((c, i) => {
    landmarks.push({
      id: `edge${i}`, label: `paper edge ${i}`,
      a: cardLocalToFrame('A', c[0], c[1]), b: cardLocalToFrame('B', c[0], c[1]), object: 'paper',
    });
  });
  for (const th of ['red', 'blue']) {
    const ca = threadCurveInFrame(th, 'A'), cb = threadCurveInFrame(th, 'B');
    landmarks.push({ id: `${th}_start`, label: `${th} endpoint 0`, a: ca[0], b: cb[0], object: `thread_${th}` });
    landmarks.push({ id: `${th}_end`, label: `${th} endpoint 1`, a: ca[ca.length - 1], b: cb[cb.length - 1], object: `thread_${th}` });
  }

  return {
    A: toUint8(A), B: toUint8(B),
    layers: {
      paper: { A: toUint8(paper.A), B: toUint8(paper.B) },
      red: { A: toUint8(threads.red.A), B: toUint8(threads.red.B) },
      blue: { A: toUint8(threads.blue.A), B: toUint8(threads.blue.B) },
    },
    background: toUint8(bg),
    truth: {
      paperContourA, paperContourB,
      redA, redB, blueA, blueB,
      crossingA: crossA, crossingB: crossB,
      landmarks,
      threadEndpoints: {
        red: { a: [redA[0], redA[redA.length - 1]], b: [redB[0], redB[redB.length - 1]] },
        blue: { a: [blueA[0], blueA[blueA.length - 1]], b: [blueB[0], blueB[blueB.length - 1]] },
      },
      threadCurves: { redA, redB, blueA, blueB },
    },
  };
}

function crossingOf(P, Q) {
  for (let i = 1; i < P.length; i++) for (let j = 1; j < Q.length; j++) {
    const p1 = P[i - 1], p2 = P[i], p3 = Q[j - 1], p4 = Q[j];
    const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
    const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) continue;
    const ux = p3[0] - p1[0], uy = p3[1] - p1[1];
    const t = (ux * d2y - uy * d2x) / den, u = (ux * d1y - uy * d1x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return [p1[0] + d1x * t, p1[1] + d1y * t];
    }
  }
  return null;
}

function paperContourInFrame(frame) {
  const step = 1.0;
  const w = Math.round((PAPER.hw * 2 + 40) / step), h = Math.round((PAPER.hh * 2 + 40) / step);
  const alpha = { width: w, height: h, data: new Float32Array(w * h * 4) };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const lx = -PAPER.hw - 20 + (i + 0.5) * step, ly = -PAPER.hh - 20 + (j + 0.5) * step;
    alpha.data[(j * w + i) * 4 + 3] = coverageFromSDF(roundRectSDF(lx, ly, 0, 0, PAPER.hw, PAPER.hh, PAPER.r), 1.0);
  }
  const contours = marchingSquares(alpha, 0.5);
  if (!contours.length) throw new Error('no paper contour');
  const local = contours[0].map(([px, py]) => [-PAPER.hw - 20 + (px + 0.5) * step, -PAPER.hh - 20 + (py + 0.5) * step]);
  // canonical start: top-left corner, CCW
  let best = 0, bd = Infinity;
  const startLocal = [-PAPER.hw, -PAPER.hh];
  for (let i = 0; i < local.length; i++) {
    const d = (local[i][0] - startLocal[0]) ** 2 + (local[i][1] - startLocal[1]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  const rotated = local.slice(best).concat(local.slice(0, best));
  const ccw = ensureCCW(rotated);
  const sampled = resampleClosed(ccw, 64);
  return sampled.map(([x, y]) => cardLocalToFrame(frame, x, y));
}

export { RED_PTS, BLUE_PTS, PAPER };
