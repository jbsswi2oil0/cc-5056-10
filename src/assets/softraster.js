// Small software rasteriser used only to synthesise the two ground-truth scenes.
// Not used by the morph engine, which consumes the finished PNGs.

import { clamp, smoothstep, lerp, mulberry32, valueNoise2, fbm } from '../core/util.js';

export function makeRGBA(w, h) {
  return { width: w, height: h, data: new Float32Array(w * h * 4) }; // straight RGBA 0..1
}

export function sampleBilinear(img, x, y) {
  const { width: w, height: h, data } = img;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const o = [];
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    o[c] = lerp(
      lerp(data[i00 + c], data[i10 + c], fx),
      lerp(data[i01 + c], data[i11 + c], fx),
      fy
    );
  }
  return o;
}

export function compositeOver(dst, src) {
  // both straight alpha; src over dst
  for (let i = 0; i < dst.data.length; i += 4) {
    const sa = src.data[i + 3];
    if (sa <= 0) continue;
    const da = dst.data[i + 3];
    const oa = sa + da * (1 - sa);
    if (oa <= 1e-8) { dst.data[i + 3] = 0; continue; }
    for (let c = 0; c < 3; c++) {
      dst.data[i + c] = (src.data[i + c] * sa + dst.data[i + c] * da * (1 - sa)) / oa;
    }
    dst.data[i + 3] = oa;
  }
}

// Signed distance to a capsule (segment with radius). Positive outside.
export function capsuleSDF(px, py, ax, ay, bx, by, r) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let u = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  u = clamp(u, 0, 1);
  return Math.hypot(px - (ax + dx * u), py - (ay + dy * u)) - r;
}
export function ellipseSDF(px, py, cx, cy, rx, ry) {
  const nx = (px - cx) / rx, ny = (py - cy) / ry;
  return (Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
}
export function roundRectSDF(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Union of SDFs (min).
export function sdfMin(...ds) { return Math.min(...ds); }

export function coverageFromSDF(sdf, aa = 1) {
  return smoothstep(aa, -aa, sdf); // 1 inside, 0 outside, linear-ish band
}

// Extract closed contours from an alpha image using marching squares.
// Returns arrays of [x,y] (frame pixel coordinates) sorted by descending length.
export function marchingSquares(alpha, thresh = 0.5) {
  const w = alpha.width, h = alpha.height, d = alpha.data;
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3]);
  const segs = [];
  const edgePoint = (x0, y0, x1, y1) => {
    const a0 = A(x0, y0), a1 = A(x1, y1);
    const t = (thresh - a0) / (a1 - a0 || 1e-9);
    return [x0 + (x1 - x0) * t + 0.0, y0 + (y1 - y0) * t + 0.0];
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const c0 = A(x, y) >= thresh, c1 = A(x + 1, y) >= thresh;
      const c2 = A(x + 1, y + 1) >= thresh, c3 = A(x, y + 1) >= thresh;
      const idx = (c0 ? 1 : 0) | (c1 ? 2 : 0) | (c2 ? 4 : 0) | (c3 ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const top = () => edgePoint(x, y, x + 1, y);
      const right = () => edgePoint(x + 1, y, x + 1, y + 1);
      const bottom = () => edgePoint(x + 1, y + 1, x, y + 1);
      const left = () => edgePoint(x, y + 1, x, y);
      switch (idx) {
        case 1: segs.push([left(), top()]); break;
        case 2: segs.push([top(), right()]); break;
        case 3: segs.push([left(), right()]); break;
        case 4: segs.push([right(), bottom()]); break;
        case 5: segs.push([left(), top()]); segs.push([right(), bottom()]); break;
        case 6: segs.push([top(), bottom()]); break;
        case 7: segs.push([left(), bottom()]); break;
        case 8: segs.push([bottom(), left()]); break;
        case 9: segs.push([top(), bottom()]); break;
        case 10: segs.push([bottom(), left()]); segs.push([top(), right()]); break;
        case 11: segs.push([right(), bottom()]); break;
        case 12: segs.push([left(), right()]); break;
        case 13: segs.push([top(), right()]); break;
        case 14: segs.push([left(), top()]); break;
        case 15: break;
      }
    }
  }
  // stitch segments into polylines using a spatial hash of endpoints (1e-3 grid)
  const key = (p) => `${Math.round(p[0] * 64)}_${Math.round(p[1] * 64)}`;
  const map = new Map();
  for (const s of segs) {
    const k0 = key(s[0]), k1 = key(s[1]);
    if (!map.has(k0)) map.set(k0, []);
    if (!map.has(k1)) map.set(k1, []);
    map.get(k0).push(s);
    map.get(k1).push(s);
  }
  const used = new Set();
  const contours = [];
  for (const s of segs) {
    if (used.has(s)) continue;
    used.add(s);
    const poly = [s[0], s[1]];
    // extend forward from end
    for (let dir = 0; dir < 2; dir++) {
      while (true) {
        const end = dir === 0 ? poly[poly.length - 1] : poly[0];
        const cands = map.get(key(end)) || [];
        let next = null;
        for (const c of cands) {
          if (used.has(c)) continue;
          next = c; break;
        }
        if (!next) break;
        used.add(next);
        const other = key(next[0]) === key(end) ? next[1] : next[0];
        if (dir === 0) poly.push(other);
        else poly.unshift(other);
        if (key(other) === key(poly[0]) && poly.length > 3) break;
      }
    }
    if (poly.length > 8) contours.push(poly);
  }
  contours.sort((a, b) => b.length - a.length);
  return contours;
}

// Resample a closed polyline to n evenly spaced points.
export function resampleClosed(poly, n) {
  const pts = poly.slice();
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
  const m = pts.length;
  let total = 0;
  const seg = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const d = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
    seg.push(d); total += d;
  }
  const out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n;
    while (acc + seg[i] < target) { acc += seg[i]; i++; }
    const t = seg[i] ? (target - acc) / seg[i] : 0;
    const j = (i + 1) % m;
    out.push([pts[i][0] + (pts[j][0] - pts[i][0]) * t, pts[i][1] + (pts[j][1] - pts[i][1]) * t]);
  }
  return out;
}

export function polyAreaSigned(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a / 2;
}

export function ensureCCW(poly) {
  return polyAreaSigned(poly) < 0 ? poly.slice().reverse() : poly;
}

export function toUint8(img) {
  const w = img.width, h = img.height;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h * 4; i++) out[i] = Math.round(clamp(img.data[i], 0, 1) * 255);
  return { width: w, height: h, data: out };
}

export function fromUint8(img) {
  const w = img.width, h = img.height;
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h * 4; i++) out[i] = img.data[i] / 255;
  return { width: w, height: h, data: out };
}

export function blurAlpha(img, radius = 1) {
  const w = img.width, h = img.height, src = img.data;
  const dst = new Float32Array(src.length);
  const r = Math.round(radius);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      s += src[(yy * w + xx) * 4 + 3]; n++;
    }
    for (let c = 0; c < 3; c++) dst[(y * w + x) * 4 + c] = src[(y * w + x) * 4 + c];
    dst[(y * w + x) * 4 + 3] = s / n;
  }
  return { width: w, height: h, data: dst };
}

export { mulberry32, valueNoise2, fbm, clamp, smoothstep, lerp };
