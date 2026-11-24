// Cuff / protection audit for the garment practice projects.
//
// Three named material vertices are tracked along the cuff with stable
// identity (cuff_top, cuff_mid, cuff_bot). Two independent signals decide
// whether a piece of cloth is missing:
//
//   1. contour winding — the cuff polygon must keep the same signed orientation
//      (CCW) at every phase. A reversal means the correspondence folded.
//   2. layer ownership — inside the authored cuff footprint, the topmost
//      visible object must be the arm. Where another layer owns the pixel that
//      is legitimate OCCLUSION only if that layer is declared in front at this
//      phase; otherwise the arm cloth is missing.
//
// When the protected cuff correspondence loses legality the engine already
// refuses those faces (gapMask); this module names the missing cloth piece and
// reports the offending identity vertices.

import { renderFrame, mapPointThroughMesh } from '../core/engine.js';
import { solvePhase } from '../core/mesh.js';
import { polyAreaSigned } from '../assets/softraster.js';

const round2 = (v) => Math.round(v * 100) / 100;

// Track the three identity cuff vertices through the arm mesh at phase t.
export function trackCuffVertices(engine, t) {
  const arm = engine.scene.objects.find((o) => o.id === 'arm');
  const mesh = engine.meshes.arm;
  const solved = solvePhase(mesh, t, {});
  const out = [];
  for (const lm of arm.landmarks) {
    if (!lm.id.startsWith('cuff_')) continue;
    const p = mapPointThroughMesh(mesh, solved.V, lm.a);
    out.push({
      id: lm.id,
      a: lm.a, b: lm.b,
      pos: p ? [round2(p[0]), round2(p[1])] : null,
      lost: !p,
    });
  }
  return { vertices: out, V: solved.V, solved };
}

// Local winding of the three identity cuff vertices. The authored order is
// cuff_top -> cuff_mid -> cuff_bot along one side of the wrist; the signed
// turn of that triplet must keep the same sign at every phase. A sign flip
// (or collapse to ~0 when two identities meet) is a correspondence reversal
// even when the whole cuff polygon's area stays positive.
export function cuffIdentityWinding(engine, t) {
  const tracked = trackCuffVertices(engine, t);
  const byId = Object.fromEntries(tracked.vertices.map((v) => [v.id, v.pos]));
  const order = engine.scene.protection?.find((s) => s.id === 'cuff_band')?.identityOrder;
  if (!order || order.some((id) => !byId[id])) return { available: false };
  const [p0, p1, p2] = order.map((id) => byId[id]);
  const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
  return {
    available: true,
    signedTurn: round2(cross),
    reversed: cross <= 0, // <=0 catches both flip and identity collapse
    positions: { [order[0]]: p0, [order[1]]: p1, [order[2]]: p2 },
  };
}

// Signed winding of the moving cuff polygon at phase t, using the three
// tracked identities plus the protected polygon's other vertices mapped
// through the mesh. Sign > 0 is CCW (legal); <= 0 is a reversal.
export function cuffWinding(engine, t) {
  const mesh = engine.meshes.arm;
  const solved = solvePhase(mesh, t, {});
  const protection = engine.scene.protection?.find((s) => s.id === 'cuff_band');
  if (!protection) return { available: false };
  const moved = protection.polygonA.map((p) => mapPointThroughMesh(mesh, solved.V, p));
  if (moved.some((p) => !p)) return { available: true, reversed: true, signedArea: 0, reason: 'vertex left the mesh' };
  const signedArea = polyAreaSigned(moved);
  return {
    available: true,
    reversed: signedArea <= 0,
    signedArea: round2(signedArea),
    polygon: moved.map((p) => p.map(round2)),
  };
}

// Which object owns each pixel inside the authored cuff footprint at phase t,
// and whether a non-arm owner is a legitimate front layer or missing cloth.
export function auditCuffOwnership(engine, t) {
  const res = renderFrame(engine, t);
  const W = engine.width, H = engine.height;
  const mesh = engine.meshes.arm;
  const solved = solvePhase(mesh, t, {});
  const protection = engine.scene.protection?.find((s) => s.id === 'cuff_band');
  if (!protection) return { available: false };

  const moved = protection.polygonA.map((p) => mapPointThroughMesh(mesh, solved.V, p));
  const footprint = moved.every(Boolean);
  const occ = engine.occlusion[0];
  const frontAt = (tt) => {
    if (!occ) return null;
    return tt < (occ.switchT ?? 0.5) ? (occ.front || occ.objectA) : (occ.switchTo || occ.objectB || occ.front);
  };
  const declaredFront = frontAt(t);

  const counts = { arm: 0, other: 0, background: 0, gap: 0 };
  const otherOwners = {};
  let minx = W, miny = H, maxx = 0, maxy = 0;
  for (const p of moved.filter(Boolean)) {
    minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
    miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
  }
  // The robe torso is a constant back layer the arm is worn over; it can never
  // be an occlusion competitor for the cuff. Only flap/arm own cloth here.
  const backLayers = new Set(['torso']);
  for (let y = Math.max(0, miny | 0); y <= Math.min(H - 1, maxy | 0); y++) {
    for (let x = Math.max(0, minx | 0); x <= Math.min(W - 1, maxx | 0); x++) {
      if (!footprint || !pointInPoly(x + 0.5, y + 0.5, moved)) continue;
      const p = y * W + x;
      if (res.gapMask[p]) { counts.gap++; continue; }
      const idx = res.provenance.object[p];
      if (idx < 0) { counts.background++; continue; }
      const id = res.diagnostics.objectIds[idx];
      if (id === 'arm') counts.arm++;
      else if (backLayers.has(id)) counts.background++;
      else {
        counts.other++;
        otherOwners[id] = (otherOwners[id] || 0) + 1;
      }
    }
  }

  // A non-arm cloth owner is legal occlusion only when that object is the
  // declared front layer at this phase. Anything else is missing arm cloth.
  // Small counts are anti-aliasing/footprint edge noise, not missing pieces.
  const NOISE = 4;
  const missing = [];
  for (const [id, n] of Object.entries(otherOwners)) {
    if (id !== declaredFront && n > NOISE) missing.push({ object: id, pixels: n, reason: 'not the declared front layer' });
  }
  // Background is only a defect where the arm's OWN source layer covers that
  // pixel AND no front cloth layer covers it. A cuff hidden behind the flap is
  // legitimate occlusion even though the arm is no longer the provenance
  // owner; a cuff the source says is sleeve must not resolve to empty when
  // nothing is in front of it.
  const armSrc = engine.layerImages.arm[t < 0.5 ? 'A' : 'B'];
  const flapLayer = res.layers.flap;
  let uncovered = 0;
  for (let y = Math.max(0, miny | 0); y <= Math.min(H - 1, maxy | 0); y++) {
    for (let x = Math.max(0, minx | 0); x <= Math.min(W - 1, maxx | 0); x++) {
      if (!footprint || !pointInPoly(x + 0.5, y + 0.5, moved)) continue;
      const p = y * W + x;
      if (res.gapMask[p]) continue;
      if (res.provenance.object[p] >= 0) continue;
      // hidden behind the flap (including its anti-aliased soft edge)? then
      // occlusion, not missing cloth
      if (flapLayer && flapLayer.prem[p * 4 + 3] > 0.1) continue;
      if (armSrc.data[p * 4 + 3] > 128) uncovered++;
    }
  }
  if (uncovered > 12) missing.push({ object: 'arm', pixels: uncovered, reason: 'sleeve source covers this footprint pixel but the render is empty' });
  if (counts.gap > 0) missing.push({ object: 'arm', pixels: counts.gap, reason: 'protected cuff correspondence lost legality (gap)' });

  return {
    available: true,
    t,
    declaredFront,
    footprintComplete: footprint,
    counts,
    otherOwners,
    occlusionLegit: missing.length === 0,
    missingCloth: missing,
  };
}

// Full per-phase audit: identity tracks, winding, ownership, and a verdict
// naming which cloth piece (if any) is under-drawn.
export function auditProject(engine, phases = 11) {
  const tracks = [];
  const phaseReports = [];
  for (let k = 0; k < phases; k++) {
    const t = k / (phases - 1);
    const winding = cuffWinding(engine, t);
    const identity = cuffIdentityWinding(engine, t);
    const ownership = auditCuffOwnership(engine, t);
    const tracked = trackCuffVertices(engine, t);
    if (k === 0 || k === phases - 1) tracks.push(...tracked.vertices.map((v) => ({ t, ...v })));
    phaseReports.push({
      t: round2(t),
      winding: winding.available ? { reversed: winding.reversed, signedArea: winding.signedArea } : null,
      identityWinding: identity.available
        ? { reversed: identity.reversed, signedTurn: identity.signedTurn }
        : null,
      gap: ownership.counts?.gap ?? 0,
      missingCloth: ownership.missingCloth,
      declaredFront: ownership.declaredFront,
    });
  }
  const windingReversal = phaseReports.filter((r) => r.winding?.reversed || r.identityWinding?.reversed);
  const gaps = phaseReports.filter((r) => r.gap > 0);
  const missing = phaseReports.filter((r) => r.missingCloth.length);
  const healthy = windingReversal.length === 0 && gaps.length === 0 && missing.length === 0;
  return {
    project: engine.scene.id,
    cuffIdentities: tracks,
    windingReversals: windingReversal,
    gapPhases: gaps,
    missingClothPhases: missing,
    healthy,
    diagnosis: healthy
      ? 'cuff cloth complete: winding stays CCW and every non-arm pixel is declared-front occlusion'
      : describeFailure(windingReversal, gaps, missing),
  };
}

function describeFailure(windingReversal, gaps, missing) {
  const parts = [];
  if (windingReversal.length) parts.push(`cuff winding reversed at t=${windingReversal.map((r) => r.t).join(',')}`);
  if (gaps.length) parts.push(`protection gap at t=${gaps.map((r) => r.t).join(',')}`);
  if (missing.length) {
    const pieces = new Set();
    for (const r of missing) for (const m of r.missingCloth) pieces.add(`${m.object} (${m.reason})`);
    parts.push(`missing cloth: ${[...pieces].join('; ')}`);
  }
  return parts.join(' | ');
}

// Deliberately break the cuff correspondence by swapping two identity
// landmarks' frame-B targets. The protected cuff folds; the audit must show a
// reversal and a gap, and name the arm cuff as the missing piece.
export function buildBrokenCuffEngine(engine, buildEngineFn) {
  const scene = JSON.parse(JSON.stringify(engine.scene));
  const arm = scene.objects.find((o) => o.id === 'arm');
  const top = arm.landmarks.find((l) => l.id === 'cuff_top');
  const bot = arm.landmarks.find((l) => l.id === 'cuff_bot');
  const tmp = top.b; top.b = bot.b; bot.b = tmp;
  const loadImage = (ref) => (typeof ref === 'string' ? engine.layerImageLoader?.(ref) ?? ref : ref);
  return buildEngineFn(scene, engine._loadImage || ((r) => r));
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
