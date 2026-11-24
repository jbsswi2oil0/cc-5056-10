// Browser editor for the dual-material shape-morph compositor.
//
// It imports the SAME engine and mesh modules the CLI uses (served as plain ES
// modules by web/server.js), loads the ground-truth scene written by
// assets/build.js, and lets you:
//   * scrub a phase slider across the two frames (including past the midpoint)
//   * overlay the deformation mesh, the correspondence, provenance, folds
//   * drag landmark correspondence dots locally (at t=0 edits frame A, t=1 edits
//     frame B) and watch the mesh rebuild and the render update
//   * hover any pixel to read where its colour came from in each source
//   * export the current frame or the whole sequence as a ZIP (frames + manifest)

import { buildEngine, renderFrame, mapPointThroughMesh } from '../src/core/engine.js';
import { solvePhase } from '../src/core/mesh.js';

const OUT = 'out';
const state = {
  sceneName: 'hands',
  meta: null,
  objects: null,
  images: {},      // filename -> {width,height,data:Uint8ClampedArray RGBA}
  engine: null,
  t: 0,
  playing: false,
  activeLandmark: null,   // {objectId, landmarkId}
  drag: null,
  render: null,           // last renderFrame result
};
const el = (id) => document.getElementById(id);
const canvas = el('canvas');
const overlay = el('overlay');
const stage = el('stage');
const ctx = canvas.getContext('2d');
const octx = overlay.getContext('2d');

// ---------------------------------------------------------------------------
// Occlusion handoff control (garment projects)
// ---------------------------------------------------------------------------
function initHandoffControl() {
  const row = el('handoffRow');
  const slider = el('handoff');
  const cr = state.crossings && state.crossings.find((c) => c.handoffDraggable);
  if (!cr) { row.hidden = true; return; }
  row.hidden = false;
  // A switchT outside [0,1] means the order is pinned for the whole shot; map
  // that onto 0/1 for the slider while remembering the original branch order.
  const pinned = cr.switchT < 0 || cr.switchT > 1;
  state.handoff = pinned ? null : cr.switchT;
  state.pinnedOrder = pinned ? (cr.switchT < 0 ? cr.front : cr.switchTo) : null;
  slider.value = pinned ? '0.5' : String(cr.switchT);
  updateHandoffUI();
}

function updateHandoffUI() {
  const cr = state.crossings.find((c) => c.handoffDraggable);
  const slider = el('handoff');
  if (state.handoff === null) {
    el('handoffVal').textContent = `switchT = pinned (${state.pinnedOrder} always front)`;
    el('handoffBranch').textContent = 'drag the handle to place a mid-shot handoff';
  } else {
    el('handoffVal').textContent = `switchT = ${Number(state.handoff).toFixed(3)}`;
    const frontNow = state.t < state.handoff ? cr.front : cr.switchTo;
    el('handoffBranch').textContent = `front at t=${state.t.toFixed(2)}: ${frontNow}`;
  }
  slider.value = state.handoff === null ? '0.5' : String(state.handoff);
}

function applyHandoff(switchT) {
  const cr = state.crossings.find((c) => c.handoffDraggable);
  state.handoff = switchT;
  // First drag releases the pinned order: derive the two sides from the
  // current branch and insert a real mid-shot switch.
  const a = cr.objectA, b = cr.objectB;
  if (switchT <= 0.5) { cr.front = a; cr.switchTo = b; }
  else { cr.front = b; cr.switchTo = a; }
  cr.switchT = switchT;
  buildEngineForScene();
  updateHandoffUI();
  scheduleRender();
}

el('handoff').addEventListener('input', (e) => {
  applyHandoff(parseFloat(e.target.value));
});

// Drag the on-image handle horizontally to move the handoff.
function handoffHandleX() {
  const eng = state.engine;
  const cr = eng.occlusion && eng.occlusion[0];
  if (!cr || !cr.handoffDraggable) return null;
  const sw = state.handoff ?? 0.5;
  return 40 + (eng.width - 80) * Math.max(0, Math.min(1, sw));
}
function hitHandoff(x, y) {
  const eng = state.engine;
  const cr = eng.occlusion && eng.occlusion[0];
  if (!cr || !cr.handoffDraggable) return false;
  const c = (state.meta.truth || {}).overlapCentroid || [eng.width / 2, eng.height / 2];
  const hx = handoffHandleX();
  return Math.abs(x - hx) < 12 && Math.abs(y - c[1]) < 64;
}

// ---------------------------------------------------------------------------
// Scene loading
// ---------------------------------------------------------------------------
async function loadScene(name) {
  state.sceneName = name;
  const meta = await fetch(`${OUT}/${name}/scene.json`).then((r) => {
    if (!r.ok) throw new Error(`scene.json: ${r.statusText}`);
    return r.json();
  });
  state.meta = meta;
  state.objects = JSON.parse(JSON.stringify(meta.objects));
  state.crossings = JSON.parse(JSON.stringify(meta.crossings));
  state.handoff = null;
  initHandoffControl();

  // Decode every PNG the scene needs (frames, background, per-object layers).
  const files = new Set([meta.frames.A, meta.frames.B, meta.frames.background]);
  for (const pair of Object.values(meta.layers)) { files.add(pair.A); files.add(pair.B); }
  await Promise.all([...files].map(async (f) => {
    state.images[f] = await loadImageData(`${OUT}/${name}/${f}`);
  }));

  buildEngineForScene();
  state.t = 0;
  el('phase').value = '0';
  resize();
  scheduleRender();
  renderPanel();
}

function buildEngineForScene() {
  const meta = state.meta;
  const scene = {
    frame: meta.frame,
    background: { A: meta.frames.background, B: meta.frames.background },
    layers: meta.layers,
    objects: state.objects,
    crossings: state.crossings || meta.crossings,
    protection: meta.protection || [],
  };
  const loadImage = (ref) => (typeof ref === 'string' ? state.images[ref] : ref);
  state.engine = buildEngine(scene, loadImage);
}

async function loadImageData(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; doRender(); });
}

function doRender() {
  const eng = state.engine;
  if (!eng) return;
  const res = renderFrame(eng, state.t);
  state.render = res;
  const { width: W, height: H } = eng;
  canvas.width = W; canvas.height = H;
  overlay.width = W; overlay.height = H;
  const img = new ImageData(new Uint8ClampedArray(res.image.data), W, H);
  ctx.putImageData(img, 0, 0);
  drawOverlays(res);
  updateDiagnostics(res);
  updateEndpoints();
}

function drawOverlays(res) {
  const { width: W, height: H } = state.engine;
  octx.clearRect(0, 0, W, H);
  if (el('showProv').checked) drawProvenance(res);
  if (el('showFolds').checked) drawFolds(res);
  if (el('showGaps').checked) drawGaps(res);
  if (el('showMesh').checked) drawMesh(res);
  if (el('showCorr').checked) drawCorrespondence(res);
  if (el('showTracks').checked) drawCuffTracks(res);
  drawHandoffHandle(res);
  if (state.drag && state.drag.pos) {
    octx.strokeStyle = '#ffffff'; octx.lineWidth = 2;
    octx.beginPath(); octx.arc(state.drag.pos[0], state.drag.pos[1], 7, 0, Math.PI * 2); octx.stroke();
  }
}

// Protection gaps: hatch the mask the engine produced when a protected surface
// lost its legal correspondence. This is deliberately NOT filled with cloth.
function drawGaps(res) {
  const { width: W, height: H } = state.engine;
  octx.save();
  octx.strokeStyle = 'rgba(255,77,109,0.9)';
  octx.lineWidth = 1;
  for (let p = 0; p < W * H; p++) {
    if (!res.gapMask[p]) continue;
    const x = p % W, y = (p / W) | 0;
    octx.beginPath();
    octx.moveTo(x - 2, y + 2); octx.lineTo(x + 2, y - 2);
    octx.stroke();
  }
  octx.restore();
}

// Three identity cuff vertices and their phase trails, so the author can check
// the material points frame by frame.
function drawCuffTracks(res) {
  const eng = state.engine;
  const arm = eng.scene.objects.find((o) => o.id === 'arm');
  if (!arm) return;
  const mesh = eng.meshes.arm;
  const sol = res.solved.arm;
  if (!mesh || !sol) return;
  const colors = { cuff_top: '#7ee787', cuff_mid: '#ffd166', cuff_bot: '#79c0ff' };
  for (const lm of arm.landmarks || []) {
    if (!lm.id.startsWith('cuff_')) continue;
    // trail across phases
    octx.beginPath();
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const s = solvePhase(mesh, t, {});
      const p = mapPointThroughMesh(mesh, s.V, lm.a);
      if (!p) continue;
      if (k === 0) octx.moveTo(p[0], p[1]); else octx.lineTo(p[0], p[1]);
    }
    octx.strokeStyle = colors[lm.id] || '#fff';
    octx.globalAlpha = 0.35; octx.lineWidth = 1; octx.stroke();
    const now = mapPointThroughMesh(mesh, sol.V, lm.a);
    if (now) {
      octx.globalAlpha = 1;
      octx.fillStyle = colors[lm.id] || '#fff';
      octx.beginPath(); octx.arc(now[0], now[1], 3.2, 0, Math.PI * 2); octx.fill();
      octx.strokeStyle = '#0b0d12'; octx.lineWidth = 1; octx.stroke();
    }
  }
  octx.globalAlpha = 1;
}

// The draggable occlusion handoff: a vertical marker at switchT on the phase
// axis, drawn on the overlap centroid so it reads on the image.
function drawHandoffHandle(res) {
  const eng = state.engine;
  const cr = eng.occlusion && eng.occlusion[0];
  if (!cr || !cr.handoffDraggable) return;
  const truth = state.meta.truth || {};
  const c = truth.overlapCentroid || [eng.width / 2, eng.height / 2];
  const sw = state.handoff ?? cr.switchT;
  // marker position: project switchT onto the horizontal line through c
  const x = 40 + (eng.width - 80) * Math.max(0, Math.min(1, sw));
  const y = c[1];
  octx.save();
  octx.strokeStyle = '#ffd166'; octx.lineWidth = 2; octx.setLineDash([6, 4]);
  octx.beginPath(); octx.moveTo(x, y - 60); octx.lineTo(x, y + 60); octx.stroke();
  octx.setLineDash([]);
  octx.fillStyle = '#ffd166';
  octx.beginPath(); octx.arc(x, y, 6, 0, Math.PI * 2); octx.fill();
  octx.strokeStyle = '#0b0d12'; octx.lineWidth = 1.5; octx.stroke();
  octx.fillStyle = '#ffd166';
  octx.font = '12px monospace';
  octx.fillText(`switchT ${Number(sw).toFixed(3)}`, x + 9, y - 62);
  octx.restore();
}

function drawProvenance(res) {
  const { width: W, height: H } = state.engine;
  const prov = res.provenance;
  const idImg = new ImageData(W, H);
  const palette = [[0, 0, 0], [110, 168, 254], [87, 212, 165], [255, 122, 89]];
  for (let p = 0; p < W * H; p++) {
    const who = prov.object[p];
    if (who < 0) continue;
    const c = palette[who % palette.length];
    idImg.data[p * 4] = c[0]; idImg.data[p * 4 + 1] = c[1]; idImg.data[p * 4 + 2] = c[2];
    idImg.data[p * 4 + 3] = 130;
  }
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
  tmp.getContext('2d').putImageData(idImg, 0, 0);
  octx.save(); octx.globalAlpha = 0.55; octx.drawImage(tmp, 0, 0); octx.restore();
}

function drawFolds(res) {
  const eng = state.engine;
  for (const [id, sol] of Object.entries(res.solved)) {
    const mesh = eng.meshes[id];
    if (!sol.folded || !sol.folded.length) continue;
    const V = sol.V;
    octx.fillStyle = 'rgba(255,77,109,0.55)';
    octx.strokeStyle = 'rgba(255,77,109,0.95)';
    for (const ti of sol.folded) {
      const [i, j, k] = mesh.T[ti];
      octx.beginPath();
      octx.moveTo(V[i * 2], V[i * 2 + 1]);
      octx.lineTo(V[j * 2], V[j * 2 + 1]);
      octx.lineTo(V[k * 2], V[k * 2 + 1]);
      octx.closePath(); octx.fill(); octx.stroke();
    }
  }
}

function drawMesh(res) {
  const eng = state.engine;
  const hues = ['#6ea8fe', '#57d4a5', '#ffb86b'];
  let oi = 0;
  for (const [id, sol] of Object.entries(res.solved)) {
    const mesh = eng.meshes[id];
    const V = sol.V;
    octx.strokeStyle = hues[oi++ % hues.length];
    octx.globalAlpha = 0.35;
    octx.lineWidth = 0.7;
    octx.beginPath();
    for (const [i, j, k] of mesh.T) {
      octx.moveTo(V[i * 2], V[i * 2 + 1]); octx.lineTo(V[j * 2], V[j * 2 + 1]);
      octx.lineTo(V[k * 2], V[k * 2 + 1]); octx.closePath();
    }
    octx.stroke();
    octx.globalAlpha = 1;
    // pinned correspondence nodes
    octx.fillStyle = hues[(oi - 1) % hues.length];
    for (const pin of mesh.pins) {
      octx.beginPath(); octx.arc(V[pin.v * 2], V[pin.v * 2 + 1], 1.4, 0, Math.PI * 2); octx.fill();
    }
  }
}

function drawCorrespondence(res) {
  const eng = state.engine;
  const t = state.t;
  for (const obj of eng.scene.objects) {
    const sol = res.solved[obj.id];
    if (!sol) continue;
    const mesh = eng.meshes[obj.id];
    const V = sol.V;
    // curves at current phase
    for (const cv of obj.curves || []) {
      if (!cv.enabled) continue;
      octx.strokeStyle = 'rgba(255,255,255,0.85)';
      octx.lineWidth = 1;
      octx.setLineDash([4, 3]);
      octx.beginPath();
      for (let i = 0; i < cv.a.length; i++) {
        const p = mapPointThroughMesh(mesh, V, cv.a[i]);
        if (!p) continue;
        if (i === 0) octx.moveTo(p[0], p[1]); else octx.lineTo(p[0], p[1]);
      }
      octx.stroke();
      octx.setLineDash([]);
    }
    // landmark dots
    for (const lm of obj.landmarks || []) {
      if (!lm.enabled) continue;
      const p = displayPosForLandmark(obj.id, lm, res);
      if (!p) continue;
      const active = state.activeLandmark && state.activeLandmark.objectId === obj.id && state.activeLandmark.landmarkId === lm.id;
      octx.beginPath(); octx.arc(p[0], p[1], active ? 6 : 4, 0, Math.PI * 2);
      octx.fillStyle = active ? '#ffd166' : 'rgba(110,168,254,0.9)';
      octx.fill();
      octx.strokeStyle = '#0b0d12'; octx.lineWidth = 1.5; octx.stroke();
    }
  }
}

function displayPosForLandmark(objId, lm, res) {
  const t = state.t;
  if (t <= 0.0001) return lm.a;
  if (t >= 0.9999) return lm.b;
  const mesh = state.engine.meshes[objId];
  const sol = res.solved[objId];
  if (!mesh || !sol) return lm.a;
  return mapPointThroughMesh(mesh, sol.V, lm.a) || lm.a;
}

// ---------------------------------------------------------------------------
// Layout + pointer mapping
// ---------------------------------------------------------------------------
let layout = { scale: 1, dw: 0, dh: 0, left: 0, top: 0 };
function resize() {
  const eng = state.engine;
  if (!eng) return;
  const r = stage.getBoundingClientRect();
  const scale = Math.min((r.width - 24) / eng.width, (r.height - 24) / eng.height);
  const dw = Math.round(eng.width * scale), dh = Math.round(eng.height * scale);
  const left = Math.round((r.width - dw) / 2), top = Math.round((r.height - dh) / 2);
  layout = { scale, dw, dh, left, top };
  for (const c of [canvas, overlay]) {
    c.style.left = left + 'px'; c.style.top = top + 'px';
    c.style.width = dw + 'px'; c.style.height = dh + 'px';
  }
}
window.addEventListener('resize', () => { resize(); scheduleRender(); });

function eventToImage(e) {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / (r.width / state.engine.width);
  const y = (e.clientY - r.top) / (r.height / state.engine.height);
  return [x, y];
}

stage.addEventListener('mousemove', (e) => {
  if (!state.engine) return;
  const [x, y] = eventToImage(e);
  updateProbe(x, y);
  if (state.drag) {
    state.drag.pos = [x, y];
    if (state.drag.kind === 'handoff') {
      const sw = Math.max(0, Math.min(1, (x - 40) / (state.engine.width - 80)));
      applyHandoff(sw);
      return;
    }
    const mode = state.drag.mode;
    const lm = state.drag.lm;
    if (mode === 'a') lm.a = [x, y]; else lm.b = [x, y];
    state.dirty = true;
    scheduleRender();
  } else if (el('showCorr').checked && isEditablePhase()) {
    const hit = hitTestLandmark(x, y);
    stage.style.cursor = hit ? 'grab' : (hitHandoff(x, y) ? 'ew-resize' : 'default');
  } else if (hitHandoff(x, y)) {
    stage.style.cursor = 'ew-resize';
  }
});
stage.addEventListener('mouseleave', () => { stage.style.cursor = 'default'; });

stage.addEventListener('mousedown', (e) => {
  if (!state.engine) return;
  const [x, y] = eventToImage(e);
  // occlusion handoff handle takes priority
  if (hitHandoff(x, y)) {
    state.drag = { kind: 'handoff' };
    stage.style.cursor = 'ew-resize';
    return;
  }
  if (!el('showCorr').checked) return;
  const mode = editableMode();
  if (!mode) return;
  const hit = hitTestLandmark(x, y);
  if (!hit) return;
  state.activeLandmark = { objectId: hit.objectId, landmarkId: hit.lm.id };
  state.drag = { lm: hit.lm, mode, pos: displayPosForLandmark(hit.objectId, hit.lm, state.render) };
  stage.style.cursor = 'grabbing';
  renderPanel();
});

window.addEventListener('mouseup', () => {
  if (!state.drag) return;
  const wasHandoff = state.drag.kind === 'handoff';
  state.drag = null;
  stage.style.cursor = 'default';
  if (wasHandoff) return;
  if (state.dirty) { state.dirty = false; buildEngineForScene(); scheduleRender(); }
});

function isEditablePhase() { return editableMode() !== null; }
function editableMode() {
  if (state.t <= 0.0001) return 'a';
  if (state.t >= 0.9999) return 'b';
  return null;
}

function hitTestLandmark(x, y) {
  let best = null, bd = 10 * 10;
  for (const obj of state.engine.scene.objects) {
    for (const lm of obj.landmarks || []) {
      if (!lm.enabled) continue;
      const p = displayPosForLandmark(obj.id, lm, state.render);
      if (!p) continue;
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d < bd) { bd = d; best = { objectId: obj.id, lm }; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Provenance probe
// ---------------------------------------------------------------------------
function updateProbe(x, y) {
  const res = state.render;
  if (!res) return;
  const W = state.engine.width, H = state.engine.height;
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const p = yi * W + xi;
  const who = res.provenance.object[p];
  if (who < 0) { el('probe').textContent = `(${xi},${yi})  background only`; return; }
  const id = res.diagnostics.objectIds[who];
  const sA = [res.provenance.srcA[p * 2], res.provenance.srcA[p * 2 + 1]].map((v) => v.toFixed(1));
  const sB = [res.provenance.srcB[p * 2], res.provenance.srcB[p * 2 + 1]].map((v) => v.toFixed(1));
  const oof = res.provenance.outOfFrame[p] ? '  [out of frame -> unknown]' : '';
  el('probe').textContent = `(${xi},${yi})  object=${id}  srcA=(${sA.join(',')})  srcB=(${sB.join(',')})${oof}`;
}

// ---------------------------------------------------------------------------
// Panel: correspondence, crossings, diagnostics, endpoints
// ---------------------------------------------------------------------------
function renderPanel() {
  renderObjectList();
  renderCrossingList();
}

function renderObjectList() {
  const host = el('objectList');
  host.innerHTML = '';
  const palette = ['#6ea8fe', '#57d4a5', '#ffb86b'];
  state.engine.scene.objects.forEach((obj, oi) => {
    const card = document.createElement('div');
    card.className = 'object-card';
    const name = document.createElement('div');
    name.className = 'name';
    name.innerHTML = `<span><span class="swatch" style="display:inline-block;background:${palette[oi % 3]}"></span> ${obj.name || obj.id}</span><span class="badge">depth ${obj.depthA ?? 0}→${obj.depthB ?? 0}</span>`;
    card.appendChild(name);
    for (const lm of obj.landmarks || []) {
      if (!lm.enabled) continue;
      const row = document.createElement('div');
      row.className = 'lm-row';
      if (state.activeLandmark && state.activeLandmark.objectId === obj.id && state.activeLandmark.landmarkId === lm.id) row.classList.add('active');
      row.innerHTML = `<span class="swatch" style="background:${palette[oi % 3]}"></span><span>${lm.label || lm.id}</span>`;
      row.addEventListener('click', () => {
        state.activeLandmark = { objectId: obj.id, landmarkId: lm.id };
        renderPanel(); scheduleRender();
      });
      card.appendChild(row);
    }
    host.appendChild(card);
  });
}

function renderCrossingList() {
  const host = el('crossingList');
  host.innerHTML = '';
  const resolved = state.engine.crossings;
  for (const cr of resolved) {
    const card = document.createElement('div');
    card.className = 'crossing-card';
    if (cr.type === 'occlusion') {
      card.innerHTML = `<div>${cr.id}<span class="tag">occlusion</span></div>
        <div class="muted">${cr.objectA} vs ${cr.objectB}: front ${cr.front} → ${cr.switchTo || cr.front} at t=${cr.switchT ?? 0.5}</div>`;
    } else {
      const linkTxt = cr.link ? 'continuity link (limit)' : 'split';
      card.innerHTML = `<div>${cr.id}<span class="tag cont">${cr.link ? 'continuity' : 'split'}</span></div>
        <div class="muted">${cr.object}: ${linkTxt}; crossing A=${fmtPt(cr.interA)} B=${fmtPt(cr.interB)}</div>`;
    }
    host.appendChild(card);
  }
}

function fmtPt(p) { return p ? `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})` : '—'; }

function updateDiagnostics(res) {
  const d = res.diagnostics;
  const folds = d.folds.length;
  const foldColor = folds ? 'bad' : 'ok';
  let html = '';
  html += line('phase t', state.t.toFixed(3));
  html += line('folds', `<span class="${foldColor}">${folds}</span>`);
  html += line('protection gaps', `<span class="${d.gapPixels ? 'bad' : 'ok'}">${d.gapPixels}</span>`);
  html += line('split pixels', d.splitPixels);
  html += line('out-of-frame', d.outOfFramePixels, d.outOfFramePixels ? 'warn' : 'ok');
  html += line('residual pixels', d.residualPixels);
  html += line('residual sum', d.residualSum.toFixed(2));
  if (folds) {
    for (const f of d.folds.slice(0, 4)) {
      html += `<div class="attrib">${f.object} · ${f.constraint ? f.constraint.label || f.constraint.id : 'unattributed'} · ${f.triangleCount} tri</div>`;
    }
  }
  if (d.residualByConstraint.length) {
    html += `<div class="attrib" style="margin-top:4px">worst constraints:</div>`;
    for (const r of d.residualByConstraint.slice(0, 4)) {
      const c = r.constraint ? (r.constraint.label || r.constraint.id) : 'none';
      html += `<div class="attrib">${r.object} · ${c} · ${r.pixels}px</div>`;
    }
  }
  el('diagnostics').innerHTML = html;
}

function updateEndpoints() {
  // Endpoint exactness: reconstruct each object at t=0 and t=1 and measure how
  // far its landmarks land from their authored A / B positions.
  let html = '';
  for (const obj of state.engine.scene.objects) {
    const mesh = state.engine.meshes[obj.id];
    if (!mesh) continue;
    const V0 = solvePhase(mesh, 0, {}).V;
    const V1 = solvePhase(mesh, 1, {}).V;
    let e0 = 0, e1 = 0;
    for (const lm of obj.landmarks || []) {
      if (!lm.enabled) continue;
      const p0 = mapPointThroughMesh(mesh, V0, lm.a);
      const p1 = mapPointThroughMesh(mesh, V1, lm.a);
      if (p0) e0 = Math.max(e0, Math.hypot(p0[0] - lm.a[0], p0[1] - lm.a[1]));
      if (p1) e1 = Math.max(e1, Math.hypot(p1[0] - lm.b[0], p1[1] - lm.b[1]));
    }
    html += line(obj.id, `<span class="${e0 < 0.01 && e1 < 0.01 ? 'ok' : 'warn'}">A ${e0.toFixed(3)}px · B ${e1.toFixed(3)}px</span>`);
  }
  el('endpoints').innerHTML = html;
}

function line(k, v, cls) {
  return `<div class="diag-line"><span class="k">${k}</span><span class="${cls || ''}">${v}</span></div>`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
el('phase').addEventListener('input', (e) => {
  state.t = parseFloat(e.target.value);
  el('tval').textContent = `t = ${state.t.toFixed(3)}`;
  if (state.handoff !== null && state.engine?.occlusion?.[0]?.handoffDraggable) updateHandoffUI();
  updateEditHint();
  scheduleRender();
});

el('playBtn').addEventListener('click', () => {
  state.playing = !state.playing;
  el('playBtn').textContent = state.playing ? 'pause' : 'play';
  if (state.playing) { state.playDir = 1; playLoop(performance.now()); }
});

function playLoop(now) {
  if (!state.playing) return;
  const dt = (now - (state.lastNow || now)) / 1000;
  state.lastNow = now;
  state.t += dt * 0.5 * (state.playDir || 1);
  if (state.t >= 1) { state.t = 1; state.playDir = -1; }
  if (state.t <= 0) { state.t = 0; state.playDir = 1; }
  el('phase').value = String(state.t);
  el('tval').textContent = `t = ${state.t.toFixed(3)}`;
  updateEditHint();
  scheduleRender();
  requestAnimationFrame(playLoop);
}
el('playBtn').addEventListener('click', () => { state.lastNow = 0; }, true);

function updateEditHint() {
  const hint = el('hint');
  if (editableMode()) {
    hint.textContent = `editing frame ${editableMode().toUpperCase()} — drag landmark dots to change correspondence locally`;
  } else {
    hint.textContent = 'scrub to t=0 or t=1 to drag landmark dots · hover to read provenance';
  }
}

el('showMesh').addEventListener('change', scheduleRender);
el('showCorr').addEventListener('change', scheduleRender);
el('showProv').addEventListener('change', scheduleRender);
el('showFolds').addEventListener('change', scheduleRender);
el('showGaps').addEventListener('change', scheduleRender);
el('showTracks').addEventListener('change', scheduleRender);

el('resetCorr').addEventListener('click', () => {
  state.objects = JSON.parse(JSON.stringify(state.meta.objects));
  state.crossings = JSON.parse(JSON.stringify(state.meta.crossings));
  state.activeLandmark = null;
  initHandoffControl();
  buildEngineForScene();
  scheduleRender();
  renderPanel();
});

el('sceneSelect').addEventListener('change', async (e) => {
  await loadScene(e.target.value);
  updateEditHint();
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
el('exportFrame').addEventListener('click', () => {
  canvas.toBlob((blob) => downloadBlob(blob, `${state.sceneName}_t${state.t.toFixed(3)}.png`), 'image/png');
});

el('exportSeq').addEventListener('click', async () => {
  const btn = el('exportSeq');
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'rendering…';
  try {
    const N = 25;
    const { width: W, height: H } = state.engine;
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const g = tmp.getContext('2d');
    const files = [];
    const manifest = { scene: state.sceneName, count: N, width: W, height: H, frames: [] };
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const res = renderFrame(state.engine, t);
      g.putImageData(new ImageData(new Uint8ClampedArray(res.image.data), W, H), 0, 0);
      const blob = await new Promise((r) => tmp.toBlob(r, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      const name = `frame_${String(i).padStart(3, '0')}.png`;
      files.push({ name, data: buf });
      if (!manifest.pngs) manifest.pngs = [];
      manifest.pngs.push(res.image);
      manifest.frames.push({ i, t, file: name, folds: res.diagnostics.folds.length, residualPixels: res.diagnostics.residualPixels });
    }
    const manifestJson = { ...manifest }; delete manifestJson.pngs;
    files.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifestJson, null, 2)) });
    const zip = zipStore(files);
    downloadBlob(zip, `${state.sceneName}_sequence.zip`);
    // Also save a self-contained APNG (plays natively in any browser).
    try {
      const apng = await encodeAPNGFrames(manifest.pngs, 60);
      downloadBlob(new Blob([apng], { type: 'image/apng' }), `${state.sceneName}_anim.apng`);
    } catch (e) { console.warn('APNG export failed', e); }
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
});

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

// APNG in the browser, using CompressionStream('deflate') for the zlib stream.
// The first frame is IDAT; later frames are fdAT; sequence numbers run 0,1,2,...
async function encodeAPNGFrames(images, delayMs) {
  const { width: W, height: H } = images[0];
  const chunks = [PNG_SIG];
  chunks.push(pngChunk('IHDR', ihdrBytes(W, H)));
  const actl = new Uint8Array(8); const av = new DataView(actl.buffer);
  av.setUint32(0, images.length); av.setUint32(4, 0);
  chunks.push(pngChunk('acTL', actl));
  let seq = 0;
  for (let idx = 0; idx < images.length; idx++) {
    const fctl = new Uint8Array(26); const fv = new DataView(fctl.buffer);
    fv.setUint32(0, seq++); fv.setUint32(4, W); fv.setUint32(8, H);
    fv.setUint32(12, 0); fv.setUint32(16, 0);
    fv.setUint16(20, delayMs); fv.setUint16(22, 1000);
    fv.setUint8(24, 0); fv.setUint8(25, 0);
    chunks.push(pngChunk('fcTL', fctl));
    const z = await deflateImage(images[idx]);
    if (idx === 0) { chunks.push(pngChunk('IDAT', z)); }
    else { const s = new Uint8Array(4); new DataView(s.buffer).setUint32(0, seq++); const fd = new Uint8Array(4 + z.length); fd.set(s, 0); fd.set(z, 4); chunks.push(pngChunk('fdAT', fd)); }
  }
  chunks.push(pngChunk('IEND', new Uint8Array(0)));
  return new Blob(chunks);
}
const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function ihdrBytes(W, H) {
  const b = new Uint8Array(13); const v = new DataView(b.buffer);
  v.setUint32(0, W); v.setUint32(4, H); b[8] = 8; b[9] = 6; b[10] = 0; b[11] = 0; b[12] = 0;
  return b;
}
async function deflateImage(img) {
  const { width: W, height: H, data } = img;
  const raw = new Uint8Array((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    raw.set(data.subarray(y * W * 4, (y + 1) * W * 4), y * (W * 4 + 1) + 1);
  }
  const cs = new CompressionStream('deflate');
  const stream = new Blob([raw]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32of(out.subarray(4, 8 + data.length)));
  return out;
}
function crc32of(bytes) { return crc32(bytes); }

// Minimal ZIP (store, no compression) so a whole sequence downloads as one file.
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + nameBytes.length + f.data.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true); dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
    local.set(nameBytes, 30); local.set(f.data, 30 + nameBytes.length);
    chunks.push(local);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
  chunks.push(end);
  return new Blob(chunks, { type: 'application/zip' });
}

let crcTable = null;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Expose a small read/debug surface for the headless test harness. Reads only,
// plus a single helper to report on-screen dot positions in client coordinates.
window.__editor = {
  getState: () => ({ sceneName: state.sceneName, t: state.t, engineReady: !!state.engine }),
  landmarkScreenPositions: () => {
    const out = [];
    for (const obj of state.engine.scene.objects) {
      for (const lm of obj.landmarks || []) {
        if (!lm.enabled) continue;
        const p = displayPosForLandmark(obj.id, lm, state.render);
        if (!p) continue;
        out.push({
          objectId: obj.id, landmarkId: lm.id,
          canvas: [p[0] * layout.scale, p[1] * layout.scale],
          image: [p[0], p[1]],
          scale: layout.scale,
        });
      }
    }
    return out;
  },
  canvasRect: () => canvas.getBoundingClientRect(),
};

loadScene('hands').then(updateEditHint).catch((e) => {
  el('hint').textContent = 'failed to load scene: ' + e.message + ' (run `npm run build-assets` first)';
  console.error(e);
});
