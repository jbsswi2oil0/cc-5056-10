// Scene engine: builds per-object meshes, renders intermediate frames by
// reverse-sampling each source layer through that object's own mesh, composites
// with explicit visible-surface splitting, and records provenance + diagnostics.
//
// Contract (explicit, see README):
//   * correspondence: landmark pairs + curve pairs, carried by mesh nodes.
//   * frame boundary: the source canvas; samples outside it are UNKNOWN and
//     never replaced by unrelated border pixels.
//   * deformation model: intrinsic similarity homotopy + per-node residual
//     interpolation over a fixed triangle mesh (piecewise affine per triangle).
//
// Colour/alpha merge: both source samples are straight RGBA turned premultiplied,
// blended with (1-t, t) under the SAME semantics, then composited over the
// background. No Gaussian blur is applied anywhere, so ghosting caused by bad
// correspondence is visible and measurable rather than hidden.

import { buildObjectMesh, solvePhase, diagnoseFolds, fitSimilarity } from './mesh.js';
import { polylineIntersections, projectPointOnPolyline } from './geometry.js';

export function buildEngine(scene, loadImage) {
  const { width: w, height: h } = scene.frame;
  const layerImages = {};
  const meshes = {};
  const resolvedCrossings = [];

  const objById = new Map(scene.objects.map((o) => [o.id, o]));

  for (const obj of scene.objects) {
    if (obj.enabled === false) continue;
    const layer = scene.layers[obj.id];
    layerImages[obj.id] = {
      A: loadImage(layer.A),
      B: loadImage(layer.B),
    };
  }
  const background = {
    A: loadImage(scene.background.A),
    B: loadImage(scene.background.B),
  };

  // Resolve crossings -> continuity pins and depth ordering.
  for (const cr of scene.crossings || []) {
    if (cr.type === 'continuity') {
      const obj = objById.get(cr.object);
      if (!obj) continue;
      const cvA = obj.curves.find((c) => c.id === cr.curveA);
      const cvB = obj.curves.find((c) => c.id === cr.curveB);
      if (!cvA || !cvB) continue;
      const interA = pickCrossing(polylineIntersections(cvA.a, cvB.a), cr.refA);
      const interB = pickCrossing(polylineIntersections(cvA.b, cvB.b), cr.refB);
      const rec = {
        id: cr.id, type: 'continuity', object: cr.object,
        curveA: cr.curveA, curveB: cr.curveB, link: cr.link !== false,
        interA: interA ? interA.point : null,
        interB: interB ? interB.point : null,
        splitPolicy: cr.splitPolicy || (cr.link !== false ? 'limit' : 'split'),
      };
      resolvedCrossings.push(rec);
    } else if (cr.type === 'occlusion') {
      resolvedCrossings.push({ ...cr, type: 'occlusion' });
    }
  }

  for (const obj of scene.objects) {
    if (obj.enabled === false) continue;
    const extraNodes = [];
    for (const cr of resolvedCrossings) {
      if (cr.type !== 'continuity' || cr.object !== obj.id || !cr.link) continue;
      if (cr.interA && cr.interB) extraNodes.push({ a: cr.interA, b: cr.interB, crossingId: cr.id });
    }
    const covA = layerImages[obj.id]?.A, covB = layerImages[obj.id]?.B;
    const simForB = fitSimilarity(controlPairsOf(obj));
    const mesh = buildObjectMesh({
      object: obj, frame: scene.frame,
      gridStep: obj.gridStep ?? 18, extraNodes,
      objCoverage: covA && covB ? unionCoverage(covA, covB) : (covA || covB),
      extraLatticeB: covB && simForB ? bCoverageInASpace(covB, simForB, obj.gridStep ?? 18, scene.frame) : null,
    });
    mesh.depthA = obj.depthA ?? 0;
    mesh.depthB = obj.depthB ?? mesh.depthA;
    mesh.name = obj.name || obj.id;
    meshes[obj.id] = mesh;
  }

  const occlusion = resolvedCrossings.filter((c) => c.type === 'occlusion');
  // depth at a phase: the author declares a depth per frame; interpolate it.
  // Occlusion crossings may additionally swap the pair order at a switchT.
  const depthOf = (id, t) => meshes[id]?.depthA ?? objById.get(id)?.depthA ?? 0;
  return {
    scene, layerImages, background, meshes, crossings: resolvedCrossings,
    occlusion, depthOf, objById, width: w, height: h,
  };
}

function pickCrossing(hits, ref) {
  if (!hits.length) return null;
  if (!ref) return hits[0];
  let best = hits[0], bd = Infinity;
  for (const h of hits) {
    const d = (h.point[0] - ref[0]) ** 2 + (h.point[1] - ref[1]) ** 2;
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

function sampleLayer(img, x, y) {
  const { width: w, height: h, data } = img;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    out[c] = ((data[i00 + c] * (1 - fx) + data[i10 + c] * fx) * (1 - fy) +
      (data[i01 + c] * (1 - fx) + data[i11 + c] * fx) * fy) / 255;
  }
  return out;
}
export { sampleLayer };

// Alpha union of the two frames, used only to size the mesh enclosure.
function unionCoverage(a, b) {
  const w = a.width, h = a.height;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = Math.max(a.data[i * 4 + 3], b.data[i * 4 + 3]);
  return { width: w, height: h, data };
}

// Rasterise one object at phase t into premultiplied RGBA + provenance.
export function rasteriseObject(engine, objId, solved, t) {
  const mesh = engine.meshes[objId];
  const layerA = engine.layerImages[objId].A;
  const layerB = engine.layerImages[objId].B;
  const W = engine.width, H = engine.height;
  const prem = new Float32Array(W * H * 4);
  const srcA = new Float32Array(W * H * 2);
  const srcB = new Float32Array(W * H * 2);
  const triOf = new Int32Array(W * H).fill(-1);
  const covered = new Uint8Array(W * H);
  const { V, VA, VB, T } = { V: solved.V, VA: mesh.VA, VB: mesh.VB, T: mesh.T };
  const foldedSet = new Set(solved.folded);

  for (let ti = 0; ti < T.length; ti++) {
    if (foldedSet.has(ti)) continue; // never rasterise negative-area triangles
    const [i, j, k] = T[ti];
    const ax = V[i * 2], ay = V[i * 2 + 1];
    const bx = V[j * 2], by = V[j * 2 + 1];
    const cx = V[k * 2], cy = V[k * 2 + 1];
    let minx = Math.floor(Math.min(ax, bx, cx)), maxx = Math.ceil(Math.max(ax, bx, cx));
    let miny = Math.floor(Math.min(ay, by, cy)), maxy = Math.ceil(Math.max(ay, by, cy));
    minx = Math.max(0, minx); miny = Math.max(0, miny);
    maxx = Math.min(W - 1, maxx); maxy = Math.min(H - 1, maxy);
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x, py = y;
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
        const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const aX = w0 * VA[i * 2] + w1 * VA[j * 2] + w2 * VA[k * 2];
        const aY = w0 * VA[i * 2 + 1] + w1 * VA[j * 2 + 1] + w2 * VA[k * 2 + 1];
        const bX = w0 * VB[i * 2] + w1 * VB[j * 2] + w2 * VB[k * 2];
        const bY = w0 * VB[i * 2 + 1] + w1 * VB[j * 2 + 1] + w2 * VB[k * 2 + 1];
        const sA = sampleLayer(layerA, aX, aY);
        const sB = sampleLayer(layerB, bX, bY);
        const p = (y * W + x);
        srcA[p * 2] = aX; srcA[p * 2 + 1] = aY;
        srcB[p * 2] = bX; srcB[p * 2 + 1] = bY;
        triOf[p] = ti;
        const premA = sA ? [sA[0] * sA[3], sA[1] * sA[3], sA[2] * sA[3], sA[3]] : [0, 0, 0, 0];
        const premB = sB ? [sB[0] * sB[3], sB[1] * sB[3], sB[2] * sB[3], sB[3]] : [0, 0, 0, 0];
        const wA = 1 - t, wB = t;
        const r = premA[0] * wA + premB[0] * wB;
        const g = premA[1] * wA + premB[1] * wB;
        const b = premA[2] * wA + premB[2] * wB;
        const al = premA[3] * wA + premB[3] * wB;
        prem[p * 4] = r; prem[p * 4 + 1] = g; prem[p * 4 + 2] = b; prem[p * 4 + 3] = al;
        if (al > 1e-4) covered[p] = 1;
      }
    }
  }
  return { prem, alpha: null, srcA, srcB, triOf, covered };
}

// Control pairs as [A,B] arrays, used to fit the enclosing similarity.
function controlPairsOf(obj) {
  const out = [];
  for (const lm of obj.landmarks || []) if (lm.enabled && lm.a && lm.b) out.push([lm.a, lm.b]);
  for (const cv of obj.curves || []) {
    if (!cv.enabled) continue;
    const n = Math.min(cv.a?.length || 0, cv.b?.length || 0);
    for (let i = 0; i < n; i++) out.push([cv.a[i], cv.b[i]]);
  }
  return out;
}

// Sample frame-B coverage on a lattice, mapped back to frame-A coordinates via
// the inverse similarity, so the frame-A mesh encloses B as well.
function bCoverageInASpace(covB, sim, step, frame) {
  const th = sim.theta, sc = sim.s || 1;
  const c = Math.cos(-th), s = Math.sin(-th);
  const out = [];
  for (let y = 0; y < covB.height; y += step) {
    for (let x = 0; x < covB.width; x += step) {
      if (covB.data[(y * covB.width + x) * 4 + 3] <= 0) continue;
      const dx = x - sim.cB[0], dy = y - sim.cB[1];
      const ax = sim.cA[0] + (c * dx - s * dy) / sc;
      const ay = sim.cA[1] + (s * dx + c * dy) / sc;
      if (ax < 0 || ay < 0 || ax > frame.width - 1 || ay > frame.height - 1) continue;
      out.push([ax, ay]);
    }
  }
  return out;
}

export function renderFrame(engine, t, opts = {}) {
  const W = engine.width, H = engine.height;
  const tClamped = Math.max(0, Math.min(1, t));
  const solved = {};
  for (const [id, mesh] of Object.entries(engine.meshes)) {
    solved[id] = solvePhase(mesh, tClamped, { relax: opts.relax ?? 0 });
  }

  // Rasterise all objects.
  const layers = {};
  for (const id of Object.keys(engine.meshes)) {
    layers[id] = rasteriseObject(engine, id, solved[id], tClamped);
  }

  // Explicit visible-surface splitting. Each author-declared occlusion crossing
  // names a FRONT object for one side of its switch time and a FRONT object on
  // the other side, so the front/back pair can swap mid-morph (hand-over-hand).
  // A back object loses its alpha wherever a front object covers it.
  let splitPixels = 0;
  const ids = Object.keys(engine.meshes);
  const orderAt = (id, t) => {
    // depth ranking: higher depth = drawn later = in front
    const m = engine.meshes[id];
    if (!m) return 0;
    // author-declared swaps take precedence over interpolated depth
    return m.depthA + (m.depthB - m.depthA) * t;
  };
  const explicitFront = (cr, t) => {
    if (t < (cr.switchT ?? 0.5)) return cr.front || cr.objectA;
    return cr.switchTo || cr.objectB || cr.front;
  };
  // Build ordered pairs for the current t.
  const pairFront = new Map(); // back -> front
  for (const cr of engine.occlusion) {
    const f = explicitFront(cr, tClamped);
    const b = f === cr.objectA || f === (cr.objectFront ?? cr.objectA)
      ? (cr.objectB ?? cr.objectBack) : (cr.objectA ?? cr.objectBack);
    if (f && b && f !== b) pairFront.set(b, f);
  }
  // depth-based pairs for objects not covered by an explicit crossing
  const ordered = ids.slice().sort((a, b) => orderAt(a, tClamped) - orderAt(b, tClamped));
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < i; j++) {
      const front = ordered[i], back = ordered[j];
      if (pairFront.has(back) && pairFront.get(back) === front) continue;
      if (!pairFront.has(back)) pairFront.set(back, front);
    }
  }
  for (const [back, front] of pairFront) {
    if (!layers[front] || !layers[back]) continue;
    const F = layers[front].prem, Bk = layers[back].prem;
    for (let p = 0; p < W * H; p++) {
      const fa = F[p * 4 + 3];
      if (fa <= 1e-4 || Bk[p * 4 + 3] <= 1e-4) continue;
      // visible-surface split: the back layer keeps only what the front leaves
      const keep = 1 - fa;
      Bk[p * 4] *= keep; Bk[p * 4 + 1] *= keep;
      Bk[p * 4 + 2] *= keep; Bk[p * 4 + 3] *= keep;
      if (fa > 0.5) splitPixels++;
    }
  }

  // Composite: background first, then objects back-to-front by depth.
  const bgA = engine.background.A, bgB = engine.background.B;
  const out = new Uint8ClampedArray(W * H * 4);
  const owner = new Int16Array(W * H).fill(-1);
  const objIds = ids.slice().sort((x, y) => orderAt(x, tClamped) - orderAt(y, tClamped));
  const prov = {
    object: owner,
    srcA: new Float32Array(W * H * 2),
    srcB: new Float32Array(W * H * 2),
    tri: new Int32Array(W * H).fill(-1),
    residual: new Float32Array(W * H),
    outOfFrame: new Uint8Array(W * H),
  };
  const idIndex = new Map(objIds.map((id, i) => [id, i]));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      let r, g, b, a;
      const sA = sampleLayer(bgA, x, y);
      const sB = sampleLayer(bgB, x, y);
      if (sA && sB) {
        const wA = 1 - tClamped, wB = tClamped;
        r = (sA[0] * sA[3]) * wA + (sB[0] * sB[3]) * wB;
        g = (sA[1] * sA[3]) * wA + (sB[1] * sB[3]) * wB;
        b = (sA[2] * sA[3]) * wA + (sB[2] * sB[3]) * wB;
        a = sA[3] * wA + sB[3] * wB;
      } else { r = g = b = 0; a = 0; }

      let top = -1, topRes = 0, topSA = null, topSB = null, topTri = -1;
      for (const id of objIds) {
        const L = layers[id];
        if (L.prem[p * 4 + 3] <= 1e-4) continue;
        const lr = L.prem[p * 4], lg = L.prem[p * 4 + 1], lb = L.prem[p * 4 + 2], la = L.prem[p * 4 + 3];
        // over
        r = lr + r * (1 - la);
        g = lg + g * (1 - la);
        b = lb + b * (1 - la);
        a = la + a * (1 - la);
        if (la > 0.5) {
          top = idIndex.get(id);
          topTri = L.triOf[p];
          topSA = [L.srcA[p * 2], L.srcA[p * 2 + 1]];
          topSB = [L.srcB[p * 2], L.srcB[p * 2 + 1]];
          // residual between the two corresponding samples
          const qA = sampleLayer(engine.layerImages[id].A, topSA[0], topSA[1]);
          const qB = sampleLayer(engine.layerImages[id].B, topSB[0], topSB[1]);
          if (qA && qB) {
            topRes = Math.hypot(
              qA[0] * qA[3] - qB[0] * qB[3],
              qA[1] * qA[3] - qB[1] * qB[3],
              qA[2] * qA[3] - qB[2] * qB[3]
            );
          }
        }
      }
      prov.object[p] = top;
      if (top >= 0) {
        prov.srcA[p * 2] = topSA[0]; prov.srcA[p * 2 + 1] = topSA[1];
        prov.srcB[p * 2] = topSB[0]; prov.srcB[p * 2 + 1] = topSB[1];
        prov.tri[p] = topTri;
        prov.residual[p] = topRes;
        const objId = objIds[top];
        const imA = engine.layerImages[objId].A, imB = engine.layerImages[objId].B;
        if (topSA[0] < 0 || topSA[1] < 0 || topSA[0] > imA.width - 1 || topSA[1] > imA.height - 1 ||
          topSB[0] < 0 || topSB[1] < 0 || topSB[0] > imB.width - 1 || topSB[1] > imB.height - 1) {
          prov.outOfFrame[p] = 1;
        }
      }
      // straight-alpha output over opaque background
      out[p * 4] = Math.round(Math.max(0, Math.min(1, a > 0 ? r / a : 0)) * 255);
      out[p * 4 + 1] = Math.round(Math.max(0, Math.min(1, a > 0 ? g / a : 0)) * 255);
      out[p * 4 + 2] = Math.round(Math.max(0, Math.min(1, a > 0 ? b / a : 0)) * 255);
      out[p * 4 + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }

  // Diagnostics
  const foldReports = [];
  for (const [id, mesh] of Object.entries(engine.meshes)) {
    const rep = diagnoseFolds(mesh, solved[id].V, solved[id].folded);
    for (const r of rep) foldReports.push({ object: id, ...r });
  }
  // Attribute high-residual pixels to the nearest constraint of their object.
  const residualByConstraint = new Map();
  let residualPixels = 0, residualSum = 0;
  const thresholds = opts.residualThreshold ?? 0.08;
  for (const [id, mesh] of Object.entries(engine.meshes)) {
    const pinMid = mesh.pins.map((pin) => ({
      pin, x: solved[id].V[pin.v * 2], y: solved[id].V[pin.v * 2 + 1],
    }));
    const idx = idIndex.get(id);
    for (let p = 0; p < W * H; p++) {
      if (prov.object[p] !== idx) continue;
      const res = prov.residual[p];
      residualSum += res;
      if (res < thresholds) continue;
      residualPixels++;
      const px = p % W, py = (p / W) | 0;
      let best = null, bd = Infinity;
      for (const pm of pinMid) {
        const d = (pm.x - px) ** 2 + (pm.y - py) ** 2;
        if (d < bd) { bd = d; best = pm.pin; }
      }
      const key = best ? `${id}:${best.id}` : `${id}:unattributed`;
      if (!residualByConstraint.has(key)) {
        residualByConstraint.set(key, {
          object: id, constraint: best ? { id: best.id, label: best.label, kind: best.kind } : null,
          pixels: 0,
        });
      }
      residualByConstraint.get(key).pixels++;
    }
  }

  let outOfFramePixels = 0;
  for (let p = 0; p < W * H; p++) if (prov.outOfFrame[p]) outOfFramePixels++;

  return {
    image: { width: W, height: H, data: out },
    t: tClamped,
    solved, layers, provenance: prov,
    diagnostics: {
      folds: foldReports,
      splitPixels,
      outOfFramePixels,
      residualPixels,
      residualSum,
      residualByConstraint: [...residualByConstraint.values()].sort((a, b) => b.pixels - a.pixels),
      objectIds: objIds,
    },
  };
}

// Map a frame-A material point through an object's mesh to phase t (forward).
export function mapPointThroughMesh(mesh, V, p) {
  const { points, T } = mesh;
  for (let ti = 0; ti < T.length; ti++) {
    const [i, j, k] = T[ti];
    const ax = points[i][0], ay = points[i][1];
    const bx = points[j][0], by = points[j][1];
    const cx = points[k][0], cy = points[k][1];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const w0 = ((by - cy) * (p[0] - cx) + (cx - bx) * (p[1] - cy)) / d;
    const w1 = ((cy - ay) * (p[0] - cx) + (ax - cx) * (p[1] - cy)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    return [
      w0 * V[i * 2] + w1 * V[j * 2] + w2 * V[k * 2],
      w0 * V[i * 2 + 1] + w1 * V[j * 2 + 1] + w2 * V[k * 2 + 1],
    ];
  }
  return null;
}

// Map a frame-B material point through the mesh back to phase t. Uses frame-B
// triangle lookup with the same topology.
export function mapPointThroughMeshB(mesh, V, p) {
  const { VB, T } = mesh;
  for (let ti = 0; ti < T.length; ti++) {
    const [i, j, k] = T[ti];
    const ax = VB[i * 2], ay = VB[i * 2 + 1];
    const bx = VB[j * 2], by = VB[j * 2 + 1];
    const cx = VB[k * 2], cy = VB[k * 2 + 1];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const w0 = ((by - cy) * (p[0] - cx) + (cx - bx) * (p[1] - cy)) / d;
    const w1 = ((cy - ay) * (p[0] - cx) + (ax - cx) * (p[1] - cy)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    return [
      w0 * V[i * 2] + w1 * V[j * 2] + w2 * V[k * 2],
      w0 * V[i * 2 + 1] + w1 * V[j * 2 + 1] + w2 * V[k * 2 + 1],
    ];
  }
  return null;
}

// Mid-frame polyline of a curve: map each frame-A vertex through the object mesh.
export function midCurve(engine, objectId, curveId, t, opts = {}) {
  const mesh = engine.meshes[objectId];
  const obj = engine.scene.objects.find((o) => o.id === objectId);
  const curve = obj.curves.find((c) => c.id === curveId);
  if (!mesh || !curve) return null;
  const solved = solvePhase(mesh, t, { relax: opts.relax ?? 0 });
  return {
    points: curve.a.map((p) => mapPointThroughMesh(mesh, solved.V, p) || p),
    solved,
  };
}
