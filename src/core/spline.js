// Thin-plate spline (2D) with affine part, plain interpolation.
// Used in two directions: fit mid -> source A, mid -> source B (reverse sampling).
// Kernel U(r) = r^2 * log(r) (with r=0 -> 0), regularised by lambda for stability.

const EPS = 1e-9;

function U(r2) {
  if (r2 < 1e-18) return 0;
  return r2 * Math.log(r2) * 0.5; // = r^2 log r
}

// Solve dense linear system M x = B. B holds m right-hand side vectors, each length n.
function solveDense(M, B0) {
  const n = M.length;
  const m = B0.length;
  const A = M.map((row) => Float64Array.from(row));
  const B = B0.map((c) => Float64Array.from(c));
  for (let col = 0; col < n; col++) {
    let piv = col, max = Math.abs(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r][col]);
      if (v > max) { max = v; piv = r; }
    }
    if (max < 1e-12) throw new Error('spline system singular at pivot ' + col);
    if (piv !== col) {
      const t = A[col]; A[col] = A[piv]; A[piv] = t;
      for (let k = 0; k < m; k++) {
        const iv = B[k][col]; B[k][col] = B[k][piv]; B[k][piv] = iv;
      }
    }
    const d = A[col][col];
    for (let c = col + 1; c < n; c++) A[col][c] /= d;
    for (let k = 0; k < m; k++) B[k][col] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col + 1; c < n; c++) A[r][c] -= f * A[col][c];
      for (let k = 0; k < m; k++) B[k][r] -= f * B[k][col];
    }
  }
  return B;
}

export class TPS {
  constructor(src, dst, { lambda = 1e-8, jitter = 0 } = {}) {
    const n = src.length;
    if (n < 3) throw new Error('TPS needs >= 3 points');
    // isotropic normalisation for conditioning
    let cx = 0, cy = 0;
    for (const p of src) { cx += p[0]; cy += p[1]; }
    cx /= n; cy /= n;
    let s = 0;
    for (const p of src) s += (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    s = Math.sqrt(s / n) || 1;
    this.cx = cx; this.cy = cy; this.scale = s;

    const S = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      S[i * 2] = (src[i][0] - cx) / s;
      S[i * 2 + 1] = (src[i][1] - cy) / s;
    }
    const N = n + 3;
    const M = Array.from({ length: N }, () => new Float64Array(N));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = S[i * 2] - S[j * 2], dy = S[i * 2 + 1] - S[j * 2 + 1];
        M[i][j] = U(dx * dx + dy * dy);
      }
      if (jitter) M[i][i] = jitter * (i % 7 === 0 ? -1 : 1) * 1e-6;
      M[i][n] = 1; M[i][n + 1] = S[i * 2]; M[i][n + 2] = S[i * 2 + 1];
      M[n][i] = 1; M[n + 1][i] = S[i * 2]; M[n + 2][i] = S[i * 2 + 1];
    }
    for (let i = 0; i < n; i++) M[i][i] += lambda;
    const bx = new Float64Array(N), by = new Float64Array(N);
    for (let i = 0; i < n; i++) {
      bx[i] = (dst[i][0] - cx) / s;
      by[i] = (dst[i][1] - cy) / s;
    }
    const [sx, sy] = solveDense(M, [bx, by]);
    this.wx = Float64Array.from(sx.slice(0, n));
    this.wy = Float64Array.from(sy.slice(0, n));
    this.ax = sx.slice(n); this.ay = sy.slice(n);
    this.centers = S;
    this.n = n;
  }

  apply(x, y) {
    const { n, centers, cx, cy, scale } = this;
    let u = (x - cx) / scale, v = (y - cy) / scale;
    let fx = this.ax[0] + this.ax[1] * u + this.ax[2] * v;
    let fy = this.ay[0] + this.ay[1] * u + this.ay[2] * v;
    for (let i = 0; i < n; i++) {
      const dx = u - centers[i * 2], dy = v - centers[i * 2 + 1];
      const r2 = dx * dx + dy * dy;
      const k = U(r2);
      fx += this.wx[i] * k;
      fy += this.wy[i] * k;
    }
    return [fx * scale + cx, fy * scale + cy];
  }

  // Jacobian and its determinant (fold indicator), in original coordinates.
  jacobian(x, y) {
    const { n, centers, scale } = this;
    let u = (x - this.cx) / scale, v = (y - this.cy) / scale;
    let j11 = this.ax[1], j12 = this.ax[2], j21 = this.ay[1], j22 = this.ay[2];
    for (let i = 0; i < n; i++) {
      const dx = u - centers[i * 2], dy = v - centers[i * 2 + 1];
      const r2 = dx * dx + dy * dy;
      // d/du [r^2 log r] = dx (log r2 + 1)
      const gx = r2 < 1e-18 ? 0 : dx * (Math.log(r2) + 1);
      const gy = r2 < 1e-18 ? 0 : dy * (Math.log(r2) + 1);
      j11 += this.wx[i] * gx; j12 += this.wx[i] * gy;
      j21 += this.wy[i] * gx; j22 += this.wy[i] * gy;
    }
    // Input and output share the same isotropic normalisation, so the chain-rule
    // factors cancel: the Jacobian in original coordinates equals the raw
    // normalised derivative matrix.
    return {
      j11, j12, j21, j22,
      det: j11 * j22 - j12 * j21,
    };
  }
}

export function fitTPS(src, dst, opts) { return new TPS(src, dst, opts); }

// Arc-length resampling of an open polyline into n points (inclusive endpoints).
export function resamplePolyline(pts, n) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d); total += d;
  }
  const out = [];
  let si = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (si < seg.length - 1 && acc + seg[si] < target) { acc += seg[si]; si++; }
    const t = seg[si] ? (target - acc) / seg[si] : 0;
    out.push([
      pts[si][0] + (pts[si + 1][0] - pts[si][0]) * t,
      pts[si][1] + (pts[si + 1][1] - pts[si][1]) * t,
    ]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inverse mapping. The engine fits source->mid, so mid->source needs the
// inverse. We use Newton with the analytic Jacobian. A fold (det <= 0) is a
// hard signal: callers must not sample there.

export function invertPoint(tps, px, py, { guess = null, maxIter = 8, tol = 1e-4 } = {}) {
  let x = guess ? guess[0] : px, y = guess ? guess[1] : py;
  for (let it = 0; it < maxIter; it++) {
    const q = tps.apply(x, y);
    const rx = q[0] - px, ry = q[1] - py;
    if (Math.hypot(rx, ry) < tol) break;
    const J = tps.jacobian(x, y);
    const det = J.j11 * J.j22 - J.j12 * J.j21;
    if (det < 1e-10) return { p: [x, y], ok: false, det, folded: true, it };
    // solve J * d = r
    const dx = (J.j22 * rx - J.j12 * ry) / det;
    const dy = (-J.j21 * rx + J.j11 * ry) / det;
    // damped step to avoid overshoot in stiff regions
    const step = Math.min(1, 12 / (Math.hypot(dx, dy) + 1e-12));
    x -= dx * step; y -= dy * step;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { p: [x, y], ok: false, det, folded: true, it };
  }
  const J = tps.jacobian(x, y);
  const det = J.j11 * J.j22 - J.j12 * J.j21;
  const q = tps.apply(x, y);
  return { p: [x, y], ok: Math.hypot(q[0] - px, q[1] - py) < 1e-2, det, folded: det < 0, it: maxIter };
}

// Inverse on a coarse lattice, with per-cell signed area so folded cells can be
// rejected instead of stretched. g maps mid-grid corners back into the source.
export function buildInverseField(tps, width, height, step = 16, opts = {}) {
  const gx = Math.ceil((width - 1) / step) + 1;
  const gy = Math.ceil((height - 1) / step) + 1;
  const pts = new Float64Array(gx * gy * 2);
  const ok = new Uint8Array(gx * gy);
  const dets = new Float64Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const x = Math.min(width - 1, i * step), y = Math.min(height - 1, j * step);
      const r = invertPoint(tps, x, y, opts);
      const o = (j * gx + i) * 2;
      pts[o] = r.p[0]; pts[o + 1] = r.p[1];
      ok[j * gx + i] = r.ok && !r.folded ? 1 : 0;
      dets[j * gx + i] = r.det;
    }
  }
  // Cell signed area of the 4 corners in *source* space; negative => fold.
  const cellFolded = new Uint8Array((gx - 1) * (gy - 1));
  for (let j = 0; j < gy - 1; j++) {
    for (let i = 0; i < gx - 1; i++) {
      const a = (j * gx + i) * 2, b = (j * gx + i + 1) * 2;
      const c = ((j + 1) * gx + i + 1) * 2, d = ((j + 1) * gx + i) * 2;
      // two triangles (a,b,c) and (a,c,d)
      const area1 = 0.5 * ((pts[b] - pts[a]) * (pts[c + 1] - pts[a + 1]) - (pts[b + 1] - pts[a + 1]) * (pts[c] - pts[a]));
      const area2 = 0.5 * ((pts[c] - pts[a]) * (pts[d + 1] - pts[a + 1]) - (pts[c + 1] - pts[a + 1]) * (pts[d] - pts[a]));
      cellFolded[j * (gx - 1) + i] = (area1 < 0 || area2 < 0) ? 1 : 0;
    }
  }
  return { gx, gy, step, pts, ok, dets, cellFolded, width, height };
}

export function sampleInverseField(field, x, y) {
  const { gx, gy, step, pts, ok, cellFolded, width, height } = field;
  const fx = x / step, fy = y / step;
  let i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0) i = 0; if (j < 0) j = 0;
  if (i > gx - 2) i = gx - 2; if (j > gy - 2) j = gy - 2;
  const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fy - j));
  const ci = Math.min(gx - 2, Math.max(0, i)), cj = Math.min(gy - 2, Math.max(0, j));
  const folded = cellFolded[cj * (gx - 1) + ci];
  const a = (j * gx + i) * 2, b = (j * gx + i + 1) * 2;
  const c = ((j + 1) * gx + i + 1) * 2, d = ((j + 1) * gx + i) * 2;
  const allOk = ok[j * gx + i] && ok[j * gx + i + 1] && ok[(j + 1) * gx + i + 1] && ok[(j + 1) * gx + i];
  const sx = (1 - u) * (1 - v) * pts[a] + u * (1 - v) * pts[b] + u * v * pts[c] + (1 - u) * v * pts[d];
  const sy = (1 - u) * (1 - v) * pts[a + 1] + u * (1 - v) * pts[b + 1] + u * v * pts[c + 1] + (1 - u) * v * pts[d + 1];
  return { p: [sx, sy], valid: allOk && !folded, folded: !!folded };
}
