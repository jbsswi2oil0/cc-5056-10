// Hand scene: two rigid hands, identical silhouettes under rigid motion, whose
// occlusion order flips between frame A and frame B. Ground truth includes
// canonical contours (exact material correspondence), per-structure visibility
// masks and marked "back of hand" probes.

import { makeRGBA, capsuleSDF, roundRectSDF, coverageFromSDF, marchingSquares, resampleClosed, toUint8 } from './softraster.js';

export const W = 640, H = 480;

const PALMS = {
  hw: 42, hh: 50, r: 20,
};
// fingers: [ax, ay, bx, by, r]
const FINGERS = [
  [-27, -34, -31, -92, 9.0],
  [-9, -38, -10, -100, 9.5],
  [9, -37, 10, -95, 9.0],
  [26, -32, 29, -78, 8.0],
];
// thumb from palm side
const THUMB = [38, -4, 61, -44, 10.5];
// wrist stub so the hand reads as an arm entering frame
const WRIST = [0, 46, 0, 78, 19];

function toLocal(hand, x, y) {
  return hand.mirror ? [-x, y] : [x, y];
}
function mirrored(hand, [x, y]) { return hand.mirror ? [-x, y] : [x, y]; }

export function handSDF(hand, lx, ly) {
  let d = roundRectSDF(lx, ly, 0, 0, PALMS.hw, PALMS.hh, PALMS.r);
  for (const [ax, ay, bx, by, r] of FINGERS) d = Math.min(d, capsuleSDF(lx, ly, ax, ay, bx, by, r));
  d = Math.min(d, capsuleSDF(lx, ly, THUMB[0], THUMB[1], THUMB[2], THUMB[3], THUMB[4]));
  d = Math.min(d, capsuleSDF(lx, ly, WRIST[0], WRIST[1], WRIST[2], WRIST[3], WRIST[4]));
  return d;
}

// knuckle + palm creases for shading (local coords)
function creaseShade(lx, ly) {
  let dark = 0;
  // finger base crease
  const baseY = -36;
  if (Math.abs(lx) < 32) {
    const d = Math.abs(ly - baseY - 0.06 * lx);
    if (d < 3.2) dark += 0.28 * (1 - d / 3.2);
  }
  // palm crease arc
  const d2 = Math.abs(Math.hypot(lx * 0.9, (ly - 6) * 1.05) - 30);
  if (d2 < 2.2) dark += 0.16 * (1 - d2 / 2.2);
  return dark;
}

function nailLayer(lx, ly, hand) {
  // nails sit near the tips of the four fingers
  let best = 1e9, tip = null;
  for (const [ax, ay, bx, by, r] of FINGERS) {
    const d = capsuleSDF(lx, ly, ax, ay, bx, by, r * 0.86);
    if (d < best) { best = d; tip = [bx, by]; }
  }
  if (!tip) return 0;
  const dx = lx - tip[0], dy = ly - tip[1];
  const rr = Math.hypot(dx, dy);
  if (rr > 11) return 0;
  return Math.max(0, 1 - rr / 11) * 0.55;
}

// Distinguishing "back of hand" mark, identical local position on both hands.
function handMark(lx, ly, variant) {
  const mx = 0, my = -8;
  const out = { rgb: null, a: 0 };
  if (variant === 0) {
    // mole trio, dark warm brown
    const dx = lx - mx, dy = ly - my;
    const dots = [[0, 0, 3.4], [7, 3, 2.2], [-5, 6, 2.0]];
    let cov = 0;
    for (const [ox, oy, r] of dots) {
      const d = Math.hypot(dx - ox, dy - oy) - r;
      cov = Math.max(cov, Math.max(0, Math.min(1, 0.5 - d)));
    }
    if (cov > 0) return { rgb: [92, 52, 40], a: cov };
  } else {
    // three teal "thread" strokes
    let cov = 0;
    for (let k = 0; k < 3; k++) {
      const s = -1 + k; // -1,0,1
      const px = mx + s * 4.5, py = my + s * 3.5;
      const d = Math.abs((lx - px) * 0.8 + (ly - py) * 0.6) - 0.9;
      const along = Math.abs((lx - px) * 0.6 - (ly - py) * 0.8);
      if (along < 5.5) cov = Math.max(cov, Math.max(0, Math.min(1, 0.5 - d)));
    }
    if (cov > 0) return { rgb: [40, 128, 122], a: cov };
  }
  return out;
}

export function handMaterial(hand, lx, ly) {
  // returns straight rgb 0..1 plus coverage-independent shade
  const base = hand.base;
  const n = hand.noise;
  const mott = 7 * (n(lx * 0.07 + 11, ly * 0.07 + 3) - 0.5) + 3 * (n(lx * 0.22, ly * 0.22) - 0.5);
  const dark = creaseShade(lx, ly);
  let r = base[0] + mott - dark * 70;
  let g = base[1] + mott * 0.8 - dark * 60;
  let b = base[2] + mott * 0.6 - dark * 50;
  const nail = nailLayer(lx, ly, hand);
  if (nail > 0) {
    r = r * (1 - nail) + (base[0] + 34) * nail;
    g = g * (1 - nail) + (base[1] + 26) * nail;
    b = b * (1 - nail) + (base[2] + 30) * nail;
  }
  const mark = handMark(lx, ly, hand.variant);
  if (mark.a > 0) {
    r = r * (1 - mark.a) + mark.rgb[0] * mark.a;
    g = g * (1 - mark.a) + mark.rgb[1] * mark.a;
    b = b * (1 - mark.a) + mark.rgb[2] * mark.a;
  }
  return [r / 255, g / 255, b / 255];
}

export function makeHand(id, variant, mirror, base) {
  let seed = variant === 0 ? 11 : 31;
  const noise = (x, y) => {
    // cheap deterministic hash-noise smooth enough for skin
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const h = (i, j) => {
      let n = Math.imul(i * 374761393 + j * 668265263 + seed * 1442695041, 1);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const t = fx * fx * (3 - 2 * fx), u = fy * fy * (3 - 2 * fy);
    return (h(ix, iy) * (1 - t) + h(ix + 1, iy) * t) * (1 - u) +
      (h(ix, iy + 1) * (1 - t) + h(ix + 1, iy + 1) * t) * u;
  };
  return { id, variant, mirror, base, noise, seed };
}

export function rig(angleDeg, scale, tx, ty) {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a) * scale, s = Math.sin(a) * scale;
  return {
    a, scale, tx, ty, c, s,
    apply(hand, lx, ly) {
      const [mx, my] = hand.mirror ? [-lx, ly] : [lx, ly];
      return [tx + c * mx - s * my, ty + s * mx + c * my];
    },
    // inverse: canvas -> local (unmirrored)
    invert(x, y) {
      const dx = x - tx, dy = y - ty;
      const inv = 1 / (c * c + s * s);
      const lx = (c * dx + s * dy) * inv;
      const ly = (-s * dx + c * dy) * inv;
      return [lx, ly];
    },
  };
}

// Render one hand's coverage+materials on a 2x supersampled basis.
export function renderHandLayer(hand, rg, w, h, ss = 2) {
  const cov = new Float32Array(w * h);
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0, csum = [0, 0, 0];
      for (let oy = 0; oy < ss; oy++) for (let ox = 0; ox < ss; ox++) {
        const sx = x + (ox + 0.5) / ss, sy = y + (oy + 0.5) / ss;
        const [lx, ly] = rg.invert(sx, sy);
        const sd = handSDF(hand, lx, ly);
        const c = coverageFromSDF(sd, 0.9);
        acc += c;
        if (c > 0) {
          const m = handMaterial(hand, lx, ly);
          csum[0] += m[0] * c; csum[1] += m[1] * c; csum[2] += m[2] * c;
        }
      }
      const a = acc / (ss * ss);
      if (a > 0) {
        rgb[(y * w + x) * 3] = csum[0] / acc;
        rgb[(y * w + x) * 3 + 1] = csum[1] / acc;
        rgb[(y * w + x) * 3 + 2] = csum[2] / acc;
      }
      cov[y * w + x] = a;
    }
  }
  return { cov, rgb };
}

// Canonical contour in local space (unmirrored), material correspondence by
// construction: every frame uses the same local contour under a rigid map.
export function canonicalContour(hand, n = 72) {
  const step = 0.5;
  const x0 = -75, x1 = 85, y0 = -125, y1 = 70;
  const w = Math.round((x1 - x0) / step), h = Math.round((y1 - y0) / step);
  const alpha = { width: w, height: h, data: new Float32Array(w * h * 4) };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const lx = x0 + (i + 0.5) * step, ly = y0 + (j + 0.5) * step;
    alpha.data[(j * w + i) * 4 + 3] = coverageFromSDF(handSDF(hand, lx, ly), 1.0);
  }
  const contours = marchingSquares(alpha, 0.5).map((poly) => poly.map(([px, py]) => [x0 + (px + 0.5) * step, y0 + (py + 0.5) * step]));
  if (!contours.length) throw new Error('no contour for ' + hand.id);
  let best = contours[0];
  // canonical start: point nearest to the thumb tip, then walk CCW
  const thumbTip = [THUMB[2] + (hand.mirror ? -1 : 1) * 0, THUMB[3]];
  const tipLocal = hand.mirror ? [-thumbTip[0], thumbTip[1]] : thumbTip;
  let bestIdx = 0, bd = Infinity;
  for (let i = 0; i < best.length; i++) {
    const d = (best[i][0] - tipLocal[0]) ** 2 + (best[i][1] - tipLocal[1]) ** 2;
    if (d < bd) { bd = d; bestIdx = i; }
  }
  best = best.slice(bestIdx).concat(best.slice(0, bestIdx));
  return resampleClosed(best, n);
}
