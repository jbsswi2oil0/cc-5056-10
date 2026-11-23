// Per-object deformation mesh with an intrinsic (rotation-aware) mid geometry.
//
// Each morphable object owns a triangle mesh whose topology is FIXED across the
// two frames: VA (frame A node positions), VB (frame B), T (triangles). Nodes
// are the author's correspondence controls plus a covering lattice, so the
// correspondence is carried by the mesh itself.
//
// Mid geometry: correspondence between A and B is decomposed into
//   * a global similarity  H_t(x) = c_t + s^t R(t*theta) (x - cA)
//   * a per-node residual in the similarity-normalised frame
// For phase t we interpolate the residual linearly in that frame:
//   uA = H_0^-1(a) = a,  uB = H_1^-1(b)
//   V(t) = H_t( (1-t) uA + t uB )
// This is exact at t=0 and t=1 for every node (not only controls), so endpoints
// restore fully, and it reproduces the natural half-rotation instead of
// collapsing to B (which a componentwise median would do).
//
// Folding is diagnosed per triangle from the SIGNED area relative to the source
// triangle. Folded triangles are reported with the nearest correspondence
// constraint; they are never rasterised (no "random pull" from negative area).

import { delaunay } from './triangulate.js';
import { TPS } from './spline.js';

export const FOLD_EPS = 1e-4;

// ---- similarity decomposition over control pairs -------------------------
export function fitSimilarity(pairs) {
  const n = pairs.length;
  if (n === 0) return null;
  let cax = 0, cay = 0, cbx = 0, cby = 0;
  for (const p of pairs) { cax += p[0][0]; cay += p[0][1]; cbx += p[1][0]; cby += p[1][1]; }
  cax /= n; cay /= n; cbx /= n; cby /= n;
  let re = 0, im = 0, den = 0;
  for (const [a, b] of pairs) {
    const ax = a[0] - cax, ay = a[1] - cay;
    const bx = b[0] - cbx, by = b[1] - cby;
    re += ax * bx + ay * by;
    im += ax * by - ay * bx;
    den += ax * ax + ay * ay;
  }
  if (den < 1e-12) return { cA: [cax, cay], cB: [cbx, cby], theta: 0, s: 1, degenerate: true };
  const cr = re / den, ci = im / den;
  return { cA: [cax, cay], cB: [cbx, cby], theta: Math.atan2(ci, cr), s: Math.hypot(cr, ci), degenerate: false };
}

export function simApply(sim, t, x, y) {
  // H_t(x) ; x is in frame-A absolute coordinates
  const th = sim.theta * t;
  const sc = Math.pow(sim.s, t);
  const c = Math.cos(th) * sc, s = Math.sin(th) * sc;
  const cx = sim.cA[0] + (sim.cB[0] - sim.cA[0]) * t;
  const cy = sim.cA[1] + (sim.cB[1] - sim.cA[1]) * t;
  const dx = x - sim.cA[0], dy = y - sim.cA[1];
  return [cx + c * dx - s * dy, cy + s * dx + c * dy];
}

export function simInvertUnit(sim, t, x, y) {
  // inverse of simApply: maps an absolute point back to frame-A absolute coords
  const th = sim.theta * t;
  const sc = Math.pow(sim.s, t);
  const cx = sim.cA[0] + (sim.cB[0] - sim.cA[0]) * t;
  const cy = sim.cA[1] + (sim.cB[1] - sim.cA[1]) * t;
  const dx = x - cx, dy = y - cy;
  const c = Math.cos(th), s = Math.sin(th);
  return [
    sim.cA[0] + (c * dx + s * dy) / (sc || 1e-12),
    sim.cA[1] + (-s * dx + c * dy) / (sc || 1e-12),
  ];
}

// ---- mesh construction ----------------------------------------------------
export function buildObjectMesh({ object, frame, gridStep = 18, extraNodes = [], objCoverage = null, extraLatticeB = null }) {
  const { width: w, height: h } = frame;

  const controls = []; // {a,b,label,kind,id,curveId}
  for (const lm of object.landmarks || []) {
    if (lm.enabled && lm.a && lm.b) {
      controls.push({ a: lm.a.slice(), b: lm.b.slice(), label: lm.label || lm.id, kind: lm.kind || 'landmark', id: lm.id });
    }
  }
  for (const cv of object.curves || []) {
    if (!cv.enabled) continue;
    const n = Math.min(cv.a?.length || 0, cv.b?.length || 0);
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      controls.push({
        a: cv.a[i].slice(), b: cv.b[i].slice(),
        label: `${cv.name || cv.id}#${i}`, kind: cv.kind || 'curve',
        id: `${cv.id}@${i}`, curveId: cv.id, curveT: n > 1 ? i / (n - 1) : 0,
      });
    }
  }
  if (controls.length < 3) throw new Error(`object ${object.id}: need >=3 control pairs, got ${controls.length}`);

  const sim = fitSimilarity(controls.map((c) => [c.a, c.b]));

  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const c of controls) for (const p of [c.a, c.b]) {
    if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
    if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
  }
  // A control set that only traces an inner contour would leave parts of the
  // object (finger tips, curved ends) outside the mesh. Widen to the actual
  // source coverage when masks are available, then pad, so every object pixel
  // is enclosed by triangles.
  if (objCoverage) {
    // scan the whole mask: the object can reach far from a sparse control set
    for (let y = 0; y < objCoverage.height; y++) {
      for (let x = 0; x < objCoverage.width; x++) {
        if (objCoverage.data[(y * objCoverage.width + x) * 4 + 3] > 0) {
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
      }
    }
  }
  const pad = Math.max(4, gridStep * 1.5);
  minx = Math.max(0, minx - pad);
  miny = Math.max(0, miny - pad);
  maxx = Math.min(w - 1, maxx + pad);
  maxy = Math.min(h - 1, maxy + pad);

  const nodesA = controls.map((c) => c.a.slice());
  const nodeMeta = controls.map((c) => ({ pin: true, lattice: false, controls: [c] }));
  const addNode = (p, isPin) => {
    nodesA.push(p.slice());
    nodeMeta.push({ pin: isPin, lattice: true, controls: [] });
  };
  const snap2 = (gridStep * 0.45) ** 2;
  const nearExisting = (x, y, list) => {
    for (let k = 0; k < list.length; k++) {
      const dx = x - list[k][0], dy = y - list[k][1];
      if (dx * dx + dy * dy < snap2) return true;
    }
    return false;
  };
  const nx = Math.max(2, Math.ceil((maxx - minx) / gridStep) + 1);
  const ny = Math.max(2, Math.ceil((maxy - miny) / gridStep) + 1);
  const lattice = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    lattice.push([minx + ((maxx - minx) * i) / (nx - 1), miny + ((maxy - miny) * j) / (ny - 1)]);
  }
  for (const g of lattice) {
    if (nearExisting(g[0], g[1], nodesA)) continue;
    addNode(g, false);
  }
  // The mesh must enclose both frames. In frame B the body may reach beyond the
  // frame-A lattice (rotation/translation pushes limb tips out); add a lattice
  // over B's coverage mapped back through the similarity, and mark it as
  // regularisation-only nodes (they carry no pin, so exactness is untouched).
  if (extraLatticeB) {
    for (const g of extraLatticeB) {
      // g is already expressed in frame-A coordinates
      if (nearExisting(g[0], g[1], nodesA)) continue;
      addNode(g, false);
    }
  }
  // extra nodes used for shared-crossing pins between objects
  for (const en of extraNodes) {
    nodesA.push(en.a.slice());
    nodeMeta.push({ pin: true, lattice: false, controls: [], extra: true, extB: en.b });
  }

  // dedupe
  const P = [], meta = [];
  for (let i = 0; i < nodesA.length; i++) {
    let f = -1;
    for (let j = 0; j < P.length; j++) {
      if ((nodesA[i][0] - P[j][0]) ** 2 + (nodesA[i][1] - P[j][1]) ** 2 < 0.25) { f = j; break; }
    }
    if (f >= 0) {
      meta[f].controls.push(...nodeMeta[i].controls);
      if (nodeMeta[i].extB) meta[f].extB = nodeMeta[i].extB;
      meta[f].pin = meta[f].pin || nodeMeta[i].pin;
    } else { P.push(nodesA[i]); meta.push({ ...nodeMeta[i], controls: [...nodeMeta[i].controls] }); }
  }

  let tps = controls.length >= 3
    ? new TPS(controls.map((c) => c.a), controls.map((c) => c.b), { lambda: 1e-6 })
    : null;

  const VA = new Float64Array(P.length * 2);
  const VB = new Float64Array(P.length * 2);
  const localA = new Float64Array(P.length * 2);
  const localB = new Float64Array(P.length * 2);
  for (let i = 0; i < P.length; i++) {
    VA[i * 2] = P[i][0]; VA[i * 2 + 1] = P[i][1];
    let b;
    if (meta[i].controls.length) b = meta[i].controls[0].b;
    else if (meta[i].extB) b = meta[i].extB;
    else b = tps ? tps.apply(P[i][0], P[i][1]) : P[i];
    VB[i * 2] = b[0]; VB[i * 2 + 1] = b[1];
    const ua = simInvertUnit(sim, 0, P[i][0], P[i][1]);
    const ub = simInvertUnit(sim, 1, VB[i * 2], VB[i * 2 + 1]);
    localA[i * 2] = ua[0]; localA[i * 2 + 1] = ua[1];
    localB[i * 2] = ub[0]; localB[i * 2 + 1] = ub[1];
  }

  const tri = delaunay(P.map(([x, y]) => ({ x, y })));
  const T = tri.triangles.filter(([i, j, k]) => {
    const a = P[i], b = P[j], c = P[k];
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-6;
  });
  if (T.length < 2) throw new Error(`object ${object.id}: triangulation degenerated`);
  for (const t3 of T) {
    const [i, j, k] = t3;
    if ((P[j][0] - P[i][0]) * (P[k][1] - P[i][1]) - (P[j][1] - P[i][1]) * (P[k][0] - P[i][0]) < 0) {
      t3[1] = k; t3[2] = j;
    }
  }

  return {
    id: object.id, w, h, sim, gridStep,
    points: P, meta, VA, VB, localA, localB, T,
    bbox: [minx, miny, maxx, maxy],
    pins: collectPins(meta),
  };
}

function collectPins(meta) {
  const out = [];
  for (let i = 0; i < meta.length; i++) {
    for (const c of meta[i].controls) {
      out.push({ v: i, a: c.a, b: c.b, label: c.label, kind: c.kind, id: c.id, curveId: c.curveId });
    }
  }
  return out;
}

// ---- phase solve ----------------------------------------------------------
export function solvePhase(mesh, t, opts = {}) {
  const { localA, localB, sim, T } = mesh;
  const N = mesh.VA.length / 2;

  const V = new Float64Array(N * 2);
  const residual = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) {
    const lx = localA[i * 2] + t * (localB[i * 2] - localA[i * 2]);
    const ly = localA[i * 2 + 1] + t * (localB[i * 2 + 1] - localA[i * 2 + 1]);
    const p = simApply(sim, t, lx, ly);
    V[i * 2] = p[0]; V[i * 2 + 1] = p[1];
    residual[i * 2] = 0; residual[i * 2 + 1] = 0;
  }

  // Domain warp for crossings/links: an external displacement field added to
  // the intrinsic motion, weighted to vanish at endpoints.
  if (opts.warp) {
    const wgt = 4 * t * (1 - t);
    for (let i = 0; i < N; i++) {
      const d = opts.warp(V[i * 2], V[i * 2 + 1], t);
      V[i * 2] += d[0] * wgt;
      V[i * 2 + 1] += d[1] * wgt;
    }
  }

  if (opts.relax > 0 && t > 0 && t < 1) {
    const wgt = 4 * t * (1 - t);
    const pinned = new Uint8Array(N);
    for (const pin of mesh.pins) pinned[pin.v] = 1;
    if (opts.pinOverride) for (const v of opts.pinOverride.keys()) pinned[v] = 1;
    const adj = buildAdjacency(N, T);
    const tmp = new Float64Array(N * 2);
    for (let it = 0; it < opts.relax; it++) {
      for (let i = 0; i < N; i++) {
        const nb = adj[i];
        if (!nb.length || pinned[i]) { tmp[i * 2] = V[i * 2]; tmp[i * 2 + 1] = V[i * 2 + 1]; continue; }
        let ax = 0, ay = 0;
        for (const j of nb) { ax += V[j * 2]; ay += V[j * 2 + 1]; }
        tmp[i * 2] = V[i * 2] + (ax / nb.length - V[i * 2]) * 0.35 * wgt;
        tmp[i * 2 + 1] = V[i * 2 + 1] + (ay / nb.length - V[i * 2 + 1]) * 0.35 * wgt;
      }
      V.set(tmp);
    }
  }

  if (opts.pinOverride) {
    for (const [v, p] of opts.pinOverride) { V[v * 2] = p[0]; V[v * 2 + 1] = p[1]; }
  }

  const fold = analyseFolds(mesh, V);
  return { V, ...fold };
}

function buildAdjacency(N, T) {
  const adj = Array.from({ length: N }, () => []);
  for (const [i, j, k] of T) { adj[i].push(j, k); adj[j].push(i, k); adj[k].push(i, j); }
  return adj;
}

export function triangleAreas(mesh, V) {
  const out = new Float64Array(mesh.T.length);
  for (let ti = 0; ti < mesh.T.length; ti++) {
    const [i, j, k] = mesh.T[ti];
    out[ti] = 0.5 * ((V[j * 2] - V[i * 2]) * (V[k * 2 + 1] - V[i * 2 + 1]) -
      (V[j * 2 + 1] - V[i * 2 + 1]) * (V[k * 2] - V[i * 2]));
  }
  return out;
}

export function sourceTriangleAreas(mesh) {
  const out = new Float64Array(mesh.T.length);
  const P = mesh.points;
  for (let ti = 0; ti < mesh.T.length; ti++) {
    const [i, j, k] = mesh.T[ti];
    out[ti] = 0.5 * ((P[j][0] - P[i][0]) * (P[k][1] - P[i][1]) - (P[j][1] - P[i][1]) * (P[k][0] - P[i][0]));
  }
  return out;
}

export function analyseFolds(mesh, V) {
  const areaT = triangleAreas(mesh, V);
  const area0 = sourceTriangleAreas(mesh);
  const folded = [];
  let minRatio = Infinity;
  for (let ti = 0; ti < areaT.length; ti++) {
    const r = area0[ti] ? areaT[ti] / area0[ti] : 1;
    if (r < minRatio) minRatio = r;
    if (areaT[ti] <= 0 || r < FOLD_EPS) folded.push(ti);
  }
  return { folded, areaT, area0, minAreaRatio: minRatio };
}

// Attribute folded triangles to the nearest correspondence control, so a wrong
// correspondence is traceable to a named constraint.
export function diagnoseFolds(mesh, V, foldedTris) {
  if (!foldedTris || !foldedTris.length) return [];
  const byCon = new Map();
  for (const ti of foldedTris) {
    const [i, j, k] = mesh.T[ti];
    const cx = (V[i * 2] + V[j * 2] + V[k * 2]) / 3;
    const cy = (V[i * 2 + 1] + V[j * 2 + 1] + V[k * 2 + 1]) / 3;
    let best = null, bd = Infinity;
    for (const pin of mesh.pins) {
      const d = Math.hypot(pin.a[0] - cx, pin.a[1] - cy);
      if (d < bd) { bd = d; best = pin; }
    }
    const key = best ? best.id : 'none';
    if (!byCon.has(key)) {
      byCon.set(key, {
        constraint: best ? { id: best.id, label: best.label, kind: best.kind, curveId: best.curveId } : null,
        triangleCount: 0, centroidSum: [0, 0],
      });
    }
    const e = byCon.get(key);
    e.triangleCount++;
    e.centroidSum[0] += cx; e.centroidSum[1] += cy;
  }
  const out = [];
  for (const [, e] of byCon) {
    out.push({
      constraint: e.constraint,
      triangleCount: e.triangleCount,
      centroid: [e.centroidSum[0] / e.triangleCount, e.centroidSum[1] / e.triangleCount],
    });
  }
  out.sort((a, b) => b.triangleCount - a.triangleCount);
  return out;
}

export function baryOf(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-12) return null;
  const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return [w0, w1, 1 - w0 - w1];
}
