// Garment practice scenes: a robed figure (robe body + front lapel flap) and a
// sleeved arm that swings across the lapel between the two endpoint poses.
//
// Everything here is vector geometry rendered with the small software
// rasteriser, so the same master spec regenerates byte-identical layers. No
// intermediate frame is ever drawn: only endpoint layers A/B are produced and
// every in-between is solved by the morph engine.
//
// Two projects share ONE geometry rig and therefore identical endpoint poses:
//   * flapfront — the lapel flap passes in front of the arm the whole shot
//   * armfront  — the arm passes in front of the flap the whole shot
// They differ only in the declared occlusion crossing, so their middle frames
// have different visible domains while frame A and frame B stay compatible.

import { makeRGBA, clamp, smoothstep, toUint8 } from './softraster.js';
import { polyAreaSigned } from './softraster.js';

export const GARMENT_W = 640;
export const GARMENT_H = 520;

// ---------------------------------------------------------------------------
// Master spec — every editable contour, pose, colour and occlusion parameter.
// This is the single source the project generator consumes; changing a value
// here and re-running build regenerates layers, vertex correspondence and
// keyframes together (see garment-project.js).
// ---------------------------------------------------------------------------
export function masterGarmentSpec() {
  return {
    frame: { width: GARMENT_W, height: GARMENT_H },
    backgroundSeed: 23,
    robe: {
      // closed torso contour, CCW
      torso: [
        [214, 96], [426, 96], [452, 180], [462, 470],
        [178, 470], [188, 180],
      ],
      // front lapel flap: a separate cloth panel with its own layer + outline
      flap: [
        [300, 104], [392, 122], [372, 332], [318, 402], [286, 332],
      ],
      // frame-B flap: the panel settles a few pixels; same vertex count/order
      flapB: [
        [302, 106], [394, 124], [368, 330], [314, 398], [284, 330],
      ],
      color: { base: [38, 92, 104], shade: [24, 62, 72] },
      flapColor: { base: [196, 138, 58], trim: [232, 196, 120], shade: [150, 98, 36] },
    },
    arm: {
      // local contour around the shoulder pivot (0,0); sleeve runs +x
      // rounded capsule: 10 samples per cap, straight sides, 30 points total
      radius: 30,
      length: 232,
      pivotA: [232, 146],
      pivotB: [232, 146],
      angleADeg: 52,   // pointing down-right across the flap in frame A
      angleBDeg: 14,   // swings up toward the shoulder line in frame B
      color: { base: [158, 58, 52], shade: [112, 36, 34] },
      cuffColor: { base: [232, 220, 196], shade: [196, 182, 158] },
      cuffDepth: 26,   // cuff band length from the wrist, local x
    },
    // named material points on the cuff (local arm coords), tracked with
    // identity through every phase for the missing-cloth audit
    cuffIds: [
      { id: 'cuff_top', local: [232, -18] },
      { id: 'cuff_mid', local: [240, 0] },
      { id: 'cuff_bot', local: [232, 18] },
    ],
    outlineSamples: 40, // resample count for each object's outline curve
    gridStep: 16,
    occlusion: {
      id: 'lapel_arm_cross',
      objectA: 'flap',
      objectB: 'arm',
      // handoff point in phase space: switchT is the draggable occlusion
      // handoff. A value outside [0,1] pins the order for the whole shot.
      handoff: {
        flapfront: { front: 'flap', switchT: 2.0, switchTo: 'flap' },
        armfront: { front: 'arm', switchT: -1.0, switchTo: 'arm' },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Rigid 2D pose
// ---------------------------------------------------------------------------
export function makePose(pivot, angleDeg) {
  const th = (angleDeg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  return {
    pivot: pivot.slice(), theta: th,
    apply([x, y]) {
      return [pivot[0] + c * x - s * y, pivot[1] + s * x + c * y];
    },
  };
}

// ---------------------------------------------------------------------------
// Arm local contour (closed, CCW), with identity-stable vertices.
// Straight-cut shoulder (left), rounded wrist cap (right). The shoulder edge
// is meant to sit inside the robe, so it never needs a cap; vertex order
// starts at the top shoulder corner.
export function armLocalContour(spec) {
  const { radius: r, length: L } = spec.arm;
  const cap = 10; // samples on the wrist semicircle
  const pts = [];
  // shoulder: straight edge from top to bottom (x = 0)
  pts.push([0, -r]);
  pts.push([0, r]);
  // wrist cap: angle from +pi/2 ... 3pi/2 (right side, around x=L)
  for (let i = 0; i <= cap; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / cap;
    pts.push([L + r * Math.cos(a), r * Math.sin(a)]);
  }
  // ensure CCW in local space
  return polyAreaSigned(pts) > 0 ? pts : pts.slice().reverse();
}

// Cuff band polygon in local coordinates (the lighter wrist band).
export function cuffLocalPolygon(spec) {
  const { radius: r, length: L, cuffDepth: d } = spec.arm;
  return [
    [L - d, -r], [L + r * 0.4, -r], [L + r, 0], [L + r * 0.4, r],
    [L - d, r],
  ];
}

// ---------------------------------------------------------------------------
// Polygon rasterisation: analytic edge SDF gives clean anti-aliased coverage
// without any blur. Colour is a simple two-stop vertical shade.
// ---------------------------------------------------------------------------
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const hit = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function edgeSDF(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy || 1e-9;
  let u = ((px - ax) * dx + (py - ay) * dy) / L2;
  u = clamp(u, 0, 1);
  return Math.hypot(px - (ax + dx * u), py - (ay + dy * u));
}

function polygonCoverage(px, py, poly) {
  // distance to boundary (0 on the edge); sign from containment
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    d = Math.min(d, edgeSDF(px, py, poly[i][0], poly[i][1], poly[j][0], poly[j][1]));
  }
  const inside = pointInPoly(px, py, poly);
  const signed = inside ? -d : d;
  return smoothstep(1.0, -1.0, signed);
}

function shadeColor(color, shade, t) {
  return [
    color[0] + (shade[0] - color[0]) * t,
    color[1] + (shade[1] - color[1]) * t,
    color[2] + (shade[2] - color[2]) * t,
  ];
}

// Render one flat-shaded polygon layer into a fresh RGBA image (straight alpha).
export function renderPolygonLayer(poly, baseColor, shadeColorValue, W, H) {
  const img = makeRGBA(W, H);
  let minY = H, maxY = 0;
  for (const [, y] of poly) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.max(0, Math.floor(minY) - 2); y <= Math.min(H - 1, Math.ceil(maxY) + 2); y++) {
    for (let x = 0; x < W; x++) {
      const cov = polygonCoverage(x + 0.5, y + 0.5, poly);
      if (cov <= 1e-4) continue;
      const t = clamp((y - minY) / Math.max(1, maxY - minY), 0, 1);
      const col = shadeColor(baseColor, shadeColorValue, t);
      const i = (y * W + x) * 4;
      img.data[i] = col[0] / 255;
      img.data[i + 1] = col[1] / 255;
      img.data[i + 2] = col[2] / 255;
      img.data[i + 3] = cov;
    }
  }
  return img;
}

// Overlay a second polygon inside an existing layer (cuff band, flap trim),
// mixing by its own coverage.
export function overlayPolygon(layer, poly, baseColor, shadeColorValue) {
  const { width: W, height: H, data } = layer;
  let minY = H, maxY = 0;
  for (const [, y] of poly) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.max(0, Math.floor(minY) - 2); y <= Math.min(H - 1, Math.ceil(maxY) + 2); y++) {
    for (let x = 0; x < W; x++) {
      const cov = polygonCoverage(x + 0.5, y + 0.5, poly);
      if (cov <= 1e-4) continue;
      const t = clamp((y - minY) / Math.max(1, maxY - minY), 0, 1);
      const col = shadeColor(baseColor, shadeColorValue, t);
      const i = (y * W + x) * 4;
      const da = data[i + 3];
      const sa = cov;
      const oa = sa + da * (1 - sa);
      if (oa <= 1e-8) continue;
      for (let c = 0; c < 3; c++) {
        data[i + c] = ((col[c] / 255) * sa + data[i + c] * da * (1 - sa)) / oa;
      }
      data[i + 3] = oa;
    }
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Background (matches the texture style of the other scenes, different seed)
// ---------------------------------------------------------------------------
export function renderGarmentBackground(W, H, seed) {
  const img = makeRGBA(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const t = (x / W + y / H) * 0.5;
    const vig = 1 - 0.32 * Math.hypot((x - W * 0.5) / W, (y - H * 0.55) / H);
    const grain = 3.0 * Math.sin(x * 0.27 + seed) * Math.cos(y * 0.19 - x * 0.05);
    img.data[i] = (40 + 24 * t) * vig / 255 + grain / 255;
    img.data[i + 1] = (44 + 22 * t) * vig / 255 + grain / 255;
    img.data[i + 2] = (54 + 20 * t) * vig / 255 + grain * 0.7 / 255;
    img.data[i + 3] = 1;
  }
  return img;
}

// ---------------------------------------------------------------------------
// Per-object layer rendering for one frame key.
// ---------------------------------------------------------------------------
export function renderRobeLayers(spec, frameKey) {
  const { width: W, height: H } = spec.frame;
  const torso = renderPolygonLayer(
    spec.robe.torso, spec.robe.color.base, spec.robe.color.shade, W, H
  );
  const flapPoly = frameKey === 'A' ? spec.robe.flap : spec.robe.flapB;
  const flap = renderPolygonLayer(
    flapPoly, spec.robe.flapColor.base, spec.robe.flapColor.shade, W, H
  );
  // trim: a thin inner contour offset toward the flap centroid
  const trim = insetPolygon(flapPoly, 0.82);
  overlayPolygon(flap, trim, spec.robe.flapColor.trim, spec.robe.flapColor.base);
  return { torso, flap, flapPoly };
}

export function renderArmLayer(spec, frameKey) {
  const { width: W, height: H } = spec.frame;
  const local = armLocalContour(spec);
  const pose = makePose(
    spec.arm[`pivot${frameKey}`],
    frameKey === 'A' ? spec.arm.angleADeg : spec.arm.angleBDeg
  );
  const world = local.map(pose.apply);
  const arm = renderPolygonLayer(world, spec.arm.color.base, spec.arm.color.shade, W, H);
  const cuffWorld = cuffLocalPolygon(spec).map(pose.apply);
  overlayPolygon(arm, cuffWorld, spec.arm.cuffColor.base, spec.arm.cuffColor.shade);
  return { image: arm, contour: world, pose };
}

// Uniform-ish inset toward the polygon centroid (keeps vertex count/order).
function insetPolygon(poly, factor) {
  let cx = 0, cy = 0;
  for (const [x, y] of poly) { cx += x; cy += y; }
  cx /= poly.length; cy /= poly.length;
  return poly.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

// Composite ordered layers over the background into a full frame.
export function composeFrame(bg, layersBackToFront) {
  const img = makeRGBA(bg.width, bg.height);
  img.data.set(bg.data);
  for (const L of layersBackToFront) {
    for (let i = 0; i < img.width * img.height; i++) {
      const sa = L.data[i * 4 + 3];
      if (sa <= 1e-4) continue;
      const da = img.data[i * 4 + 3];
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        img.data[i * 4 + c] = (L.data[i * 4 + c] * sa + img.data[i * 4 + c] * da * (1 - sa)) / oa;
      }
      img.data[i * 4 + 3] = oa;
    }
  }
  return toUint8(img);
}

export { toUint8 };

// Straight-alpha RGBA -> straight-alpha Uint8 image with transparent pixels
// carrying black RGB. The engine and compositor read straight (non-associated)
// alpha, so colour channels must stay un-premultiplied; only fully transparent
// pixels are zeroed to avoid a white fringe when viewed alone.
export function toStraightUint8(img) {
  const w = img.width, h = img.height;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = clamp(img.data[i * 4 + 3], 0, 1);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(clamp(img.data[i * 4 + c], 0, 1) * 255);
    out[i * 4 + 3] = Math.round(a * 255);
    if (a === 0) { out[i * 4] = 0; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0; }
  }
  return { width: w, height: h, data: out };
}
