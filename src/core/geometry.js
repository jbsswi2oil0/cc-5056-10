// 2D geometry helpers: polylines, intersections, barycentric coordinates,
// signed areas and frame clipping. Coordinates are continuous pixel space
// where pixel (i,j)'s centre is exactly (i,j).

export const EPS = 1e-9;

export function polyLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}


// Closest point on polyline: {t (global arclength), point, segIndex, segT, dist}
export function projectPointOnPolyline(p, pts) {
  let best = { dist2: Infinity, point: null, segIndex: 0, segT: 0, arclen: 0 };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1];
    const bx = pts[i][0], by = pts[i][1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(L2);
    let u = L2 > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2 : 0;
    u = Math.max(0, Math.min(1, u));
    const qx = ax + dx * u, qy = ay + dy * u;
    const d2 = (p[0] - qx) ** 2 + (p[1] - qy) ** 2;
    if (d2 < best.dist2) best = { dist2: d2, point: [qx, qy], segIndex: i - 1, segT: u, arclen: acc + segLen * u };
    acc += segLen;
  }
  best.dist = Math.sqrt(best.dist2);
  return best;
}

export function segIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const ux = p3[0] - p1[0], uy = p3[1] - p1[1];
  const t = (ux * d2y - uy * d2x) / den;
  const u = (ux * d1y - uy * d1x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)), point: [p1[0] + d1x * t, p1[1] + d1y * t] };
}

// All intersections between two polylines, with arclength positions on each.
export function polylineIntersections(P, Q) {
  const out = [];
  const lenP = polyLength(P), lenQ = polyLength(Q);
  // accumulate segment arclengths
  const segP = [], segQ = [];
  let a = 0;
  for (let i = 1; i < P.length; i++) {
    const d = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    segP.push([a, a + d]); a += d;
  }
  a = 0;
  for (let i = 1; i < Q.length; i++) {
    const d = Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]);
    segQ.push([a, a + d]); a += d;
  }
  for (let i = 1; i < P.length; i++) {
    for (let j = 1; j < Q.length; j++) {
      const hit = segIntersect(P[i - 1], P[i], Q[j - 1], Q[j]);
      if (!hit) continue;
      out.push({
        point: hit.point,
        s: segP[i - 1][0] + (segP[i - 1][1] - segP[i - 1][0]) * hit.t,
        u: segQ[j - 1][0] + (segQ[j - 1][1] - segQ[j - 1][0]) * hit.u,
        sNorm: lenP ? (segP[i - 1][0] + (segP[i - 1][1] - segP[i - 1][0]) * hit.t) / lenP : 0,
        uNorm: lenQ ? (segQ[j - 1][0] + (segQ[j - 1][1] - segQ[j - 1][0]) * hit.u) / lenQ : 0,
        i, j,
      });
    }
  }
  return out;
}

export function orient2d(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export function triangleSignedArea2(a, b, c) {
  return orient2d(a[0], a[1], b[0], b[1], c[0], c[1]);
}
export function triangleSignedArea(a, b, c) {
  return 0.5 * triangleSignedArea2(a, b, c);
}

// Barycentric coordinates of p in triangle (a,b,c). Returns [wa,wb,wc] or null if degenerate.
export function barycentric(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-12) return null;
  const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  const wc = 1 - wa - wb;
  return [wa, wb, wc];
}

// Point in triangle including boundary (eps in area units).
export function pointInTriangle(px, py, a, b, c, eps = 1e-7) {
  const ab = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
  const bc = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
  const ca = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
  const total = triangleSignedArea2(a, b, c);
  if (Math.abs(total) < 1e-12) return false;
  if (total > 0) return ab >= -eps && bc >= -eps && ca >= -eps;
  return ab <= eps && bc <= eps && ca <= eps;
}

export function clampToFrame(p, w, h) {
  return [Math.max(0, Math.min(w - 1, p[0])), Math.max(0, Math.min(h - 1, p[1]))];
}

export function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let u = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  u = Math.max(0, Math.min(1, u));
  const qx = ax + dx * u, qy = ay + dy * u;
  return Math.hypot(px - qx, py - qy);
}

// Minimum distance between two polylines (sampled on segments endpoints only is
// insufficient; use segment-segment closest distance).
export function segSegDistance(a, b, c, d) {
  const hit = segIntersect(a, b, c, d);
  if (hit) return 0;
  return Math.min(
    distPointSeg(a[0], a[1], c[0], c[1], d[0], d[1]),
    distPointSeg(b[0], b[1], c[0], c[1], d[0], d[1]),
    distPointSeg(c[0], c[1], a[0], a[1], b[0], b[1]),
    distPointSeg(d[0], d[1], a[0], a[1], b[0], b[1])
  );
}

export function polylineDistance(P, Q) {
  let m = Infinity;
  for (let i = 1; i < P.length; i++)
    for (let j = 1; j < Q.length; j++)
      m = Math.min(m, segSegDistance(P[i - 1], P[i], Q[j - 1], Q[j]));
  return m;
}

export function polylineSideSign(P, Q) {
  // +1 if Q's midpoint lies left of P's local direction, -1 if right.
  const i = Math.max(0, Math.min(P.length - 2, Math.floor(P.length / 2) - 1));
  const p0 = P[i], p1 = P[i + 1];
  const q = Q[Math.floor(Q.length / 2)];
  const cr = (p1[0] - p0[0]) * (q[1] - p0[1]) - (p1[1] - p0[1]) * (q[0] - p0[0]);
  return cr >= 0 ? 1 : -1;
}

export function resampleClosed(poly, n) {
  const pts = poly.slice();
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
  const m = pts.length;
  if (m < 3) return pts.concat();
  const seg = [];
  let total = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const d = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
    seg.push(d); total += d;
  }
  if (total < 1e-12) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
  const out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n;
    while (i < m - 1 && acc + seg[i] < target) { acc += seg[i]; i++; }
    const t = seg[i] ? (target - acc) / seg[i] : 0;
    const j = (i + 1) % m;
    out.push([pts[i][0] + (pts[j][0] - pts[i][0]) * t, pts[i][1] + (pts[j][1] - pts[i][1]) * t]);
  }
  return out;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a / 2;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Number of proper self-intersections of a closed polygon (fold indicator).
export function selfIntersections(poly) {
  const m = poly.length;
  const hits = [];
  for (let i = 0; i < m; i++) {
    const a1 = poly[i], a2 = poly[(i + 1) % m];
    for (let j = i + 2; j < m; j++) {
      if ((j + 1) % m === i) continue;
      const b1 = poly[j], b2 = poly[(j + 1) % m];
      const hit = segIntersect(a1, a2, b1, b2);
      if (hit) hits.push({ i, j, point: hit.point });
    }
  }
  return hits;
}

export function ribbonPolygon(centerline, halfWidth, closed = false) {
  // Offset both sides along the normal; good enough for smooth curves.
  const n = centerline.length;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(n - 1, i + 1)];
    let tx = next[0] - prev[0], ty = next[1] - prev[1];
    const L = Math.hypot(tx, ty) || 1;
    tx /= L; ty /= L;
    const nx = -ty, ny = tx;
    const hw = typeof halfWidth === 'function' ? halfWidth(i, n) : halfWidth;
    left.push([centerline[i][0] + nx * hw, centerline[i][1] + ny * hw]);
    right.push([centerline[i][0] - nx * hw, centerline[i][1] - ny * hw]);
  }
  if (closed) return left.concat(right.reverse());
  return left.concat(right.reverse());
}

export function lerpPoint(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
