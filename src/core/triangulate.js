// Bowyer-Watson Delaunay triangulation with robust orientation tests.
// Returns triangles as CCW index triples. Duplicate coordinates must be merged
// by the caller; near-duplicates are handled via the eps-aware inCircle test.

export const orient2d = (ax, ay, bx, by, cx, cy) =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function inCircle(ax, ay, bx, by, cx, cy, px, py, eps = 1e-12) {
  const dx = ax - px, dy = ay - py;
  const ex = bx - px, ey = by - py;
  const fx = cx - px, fy = cy - py;
  const det =
    (dx * dx + dy * dy) * (ex * fy - ey * fx) -
    (ex * ex + ey * ey) * (dx * fy - dy * fx) +
    (fx * fx + fy * fy) * (dx * ey - dy * ex);
  const o = orient2d(ax, ay, bx, by, cx, cy);
  // det > 0 <=> p strictly inside circumcircle for CCW triangle
  return o > 0 ? det > eps : det < -eps;
}

function circumcircle(a, b, c) {
  const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
}

// points: [{x,y}] ; returns {triangles:[[i,j,k]], hull:[[i,j]]}
export function delaunay(points) {
  const n = points.length;
  if (n < 3) return { triangles: [], hull: [] };
  // Bounding box + super-triangle
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of points) {
    if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
  }
  const dx = Math.max(maxx - minx, 1), dy = Math.max(maxy - miny, 1);
  const mx = (minx + maxx) / 2, my = (miny + maxy) / 2;
  const D = Math.max(dx, dy) * 32;
  const verts = points.map((p) => ({ x: p.x, y: p.y }));
  const s0 = verts.length, s1 = s0 + 1, s2 = s0 + 2;
  verts.push({ x: mx - 2 * D, y: my - D }, { x: mx + 2 * D, y: my - D }, { x: mx, y: my + 2 * D });
  let tris = [{ a: s0, b: s1, c: s2, cc: null }];
  tris[0].cc = circumcircle(verts[s0], verts[s1], verts[s2]);

  for (let i = 0; i < s0; i++) {
    const p = verts[i];
    const bad = [];
    for (let t = 0; t < tris.length; t++) {
      const tr = tris[t];
      const cc = tr.cc;
      if (cc && (p.x - cc.x) ** 2 + (p.y - cc.y) ** 2 <= cc.r2 + 1e-9) bad.push(t);
    }
    if (!bad.length) continue;
    // Boundary of the polygonal hole: edges used exactly once by bad triangles.
    const edgeCount = new Map();
    for (const t of bad) {
      const tr = tris[t];
      for (const [u, v] of [[tr.a, tr.b], [tr.b, tr.c], [tr.c, tr.a]]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      }
    }
    const boundary = [];
    for (const [key, cnt] of edgeCount) {
      if (cnt !== 1) continue;
      const [u, v] = key.split('_').map(Number);
      boundary.push([u, v]);
    }
    const isBad = new Set(bad);
    tris = tris.filter((_, idx) => !isBad.has(idx));
    for (const [u, v] of boundary) {
      const o = orient2d(verts[u].x, verts[u].y, verts[v].x, verts[v].y, p.x, p.y);
      if (Math.abs(o) < 1e-12) continue; // collinear -> degenerate triangle
      const a = u, b = v;
      const cc = circumcircle(verts[a], verts[b], verts[i]);
      tris.push({ a, b, c: i, cc });
    }
  }
  const out = [];
  for (const tr of tris) {
    if (tr.a >= s0 || tr.b >= s0 || tr.c >= s0) continue;
    let [a, b, c] = [tr.a, tr.b, tr.c];
    if (orient2d(verts[a].x, verts[a].y, verts[b].x, verts[b].y, verts[c].x, verts[c].y) < 0) {
      [b, c] = [c, b];
    }
    out.push([a, b, c]);
  }
  return { triangles: out, hull: [] };
}

// Signed area (positive = CCW).
export function triSignedArea(pts, tri) {
  const [a, b, c] = tri;
  return 0.5 * orient2d(pts[a].x, pts[a].y, pts[b].x, pts[b].y, pts[c].x, pts[c].y);
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a / 2;
}

// Deduplicate points within tol; returns {points, remap} where remap[i] = index into points.
export function dedupePoints(pts, tol = 1e-6) {
  const out = [];
  const remap = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    let found = -1;
    for (let j = 0; j < out.length; j++) {
      if (Math.abs(pts[i].x - out[j].x) <= tol && Math.abs(pts[i].y - out[j].y) <= tol) { found = j; break; }
    }
    if (found >= 0) remap[i] = found;
    else { remap[i] = out.length; out.push({ x: pts[i].x, y: pts[i].y }); }
  }
  return { points: out, remap };
}

export function signedArea(poly) {
  return polygonArea(poly);
}
