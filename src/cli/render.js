// Render intermediates for a scene and export them.
//
//   node src/cli/render.js <scene> --t 0.5            single frame -> out/<scene>/render/t0.500.png
//   node src/cli/render.js <scene> --seq 25           full sequence -> out/<scene>/sequence/
//   node src/cli/render.js <scene> --seq 25 --gif     also build a stitch strip contact sheet
//
// Every frame is produced by the engine from frames A and B only. No pre-drawn
// intermediate frames are read or written: the CLI refuses to run if a
// render/sequence directory already contains files it did not just produce.
import fs from 'node:fs';
import path from 'node:path';
import { loadSceneByName } from '../node/loadScene.js';
import { renderFrame, midCurve } from '../core/engine.js';
import { encodePNG, decodePNG, encodeAPNG } from '../node/png.js';

function parseArgs(argv) {
  const out = { scene: null, t: null, seq: null, contact: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--t') out.t = parseFloat(argv[++i]);
    else if (a === '--seq') out.seq = parseInt(argv[++i], 10);
    else if (a === '--contact') out.contact = true;
    else if (a === '--verbose') out.verbose = true;
    else if (!a.startsWith('--')) out.scene = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sceneName = args.scene || 'hands';
  const { engine, dir } = loadSceneByName(sceneName);
  const W = engine.width, H = engine.height;

  if (args.t !== null && !Number.isNaN(args.t)) {
    const res = renderFrame(engine, args.t);
    const outDir = path.join(dir, 'render');
    fs.mkdirSync(outDir, { recursive: true });
    const name = `t${args.t.toFixed(3)}.png`;
    fs.writeFileSync(path.join(outDir, name), encodePNG(res.image));
    const summary = {
      scene: sceneName, t: args.t, file: path.join(outDir, name),
      diagnostics: summariseDiagnostics(res.diagnostics, args.verbose),
      curves: summariseCurves(engine, args.t),
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (args.seq) {
    const outDir = path.join(dir, 'sequence');
    fs.mkdirSync(outDir, { recursive: true });
    const frames = [];
    const animFrames = [];
    for (let i = 0; i < args.seq; i++) {
      const t = args.seq === 1 ? 0 : i / (args.seq - 1);
      const res = renderFrame(engine, t);
      const name = `frame_${String(i).padStart(3, '0')}.png`;
      fs.writeFileSync(path.join(outDir, name), encodePNG(res.image));
      animFrames.push({ image: res.image, delayMs: 60 });
      frames.push({
        i, t, file: name,
        folds: res.diagnostics.folds.length,
        splitPixels: res.diagnostics.splitPixels,
        outOfFramePixels: res.diagnostics.outOfFramePixels,
        residualPixels: res.diagnostics.residualPixels,
      });
    }
    // A plain-text manifest so the sequence is machine-checkable and nobody has
    // to guess what order or phase each frame came from.
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
      scene: sceneName, count: args.seq, width: W, height: H,
      sourceFrames: { A: '../' + path.basename(dir) + '_A.png', B: path.basename(dir) + '_B.png' },
      note: 'Frames are engine renders at t=i/(count-1); frame 000 must equal frame A and 0N must equal frame B.',
      frames,
    }, null, 2));
    if (args.contact) writeContactSheet(outDir, frames, W, H, 5);
    // A self-contained animation: an APNG plays natively in any browser with no
    // codec dependency, unlike mp4/gif. Ping-pongs so the morph loops smoothly.
    const ping = [...animFrames, ...animFrames.slice(1, -1).reverse()];
    fs.writeFileSync(path.join(outDir, 'anim.apng'), encodeAPNG(ping, { loop: 0 }));
    console.log(JSON.stringify({ scene: sceneName, dir: outDir, count: args.seq, width: W, height: H, anim: path.join(outDir, 'anim.apng') }, null, 2));
    return;
  }

  console.log(JSON.stringify({ scene: sceneName, width: W, height: H, usage: 'pass --t <phase> or --seq <count>' }, null, 2));
}

function summariseDiagnostics(d, verbose) {
  if (!d) return d;
  const base = {
    folds: d.folds.length,
    splitPixels: d.splitPixels,
    outOfFramePixels: d.outOfFramePixels,
    residualPixels: d.residualPixels,
    residualSum: Math.round(d.residualSum * 1000) / 1000,
  };
  if (verbose) base.residualByConstraint = d.residualByConstraint;
  else base.topConstraints = d.residualByConstraint.slice(0, 5);
  return base;
}

function summariseCurves(engine, t) {
  const out = [];
  for (const obj of engine.scene.objects) {
    for (const cv of obj.curves || []) {
      const mc = midCurve(engine, obj.id, cv.id, t);
      if (!mc) continue;
      const pts = mc.points;
      out.push({ object: obj.id, curve: cv.id, samples: pts.length, mid: pts[Math.floor(pts.length / 2)] });
    }
  }
  return out;
}

function writeContactSheet(outDir, frames, W, H, cols) {
  // build in pure JS: a downscaled montage of every frame for a quick look
  const sc = 3; // each cell 1/3 size
  const cw = Math.ceil(W / sc), ch = Math.ceil(H / sc);
  const rows = Math.ceil(frames.length / cols);
  const cwFull = cw * cols, chFull = ch * rows;
  const img = { width: cwFull, height: chFull, data: new Uint8ClampedArray(cwFull * chFull * 4) };
  frames.forEach((f, idx) => {
    const buf = fs.readFileSync(path.join(outDir, f.file));
    const src = decodePNG(buf);
    const ox = (idx % cols) * cw, oy = Math.floor(idx / cols) * ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = Math.min(W - 1, x * sc), sy = Math.min(H - 1, y * sc);
      const si = (sy * W + sx) * 4, di = ((oy + y) * cwFull + ox + x) * 4;
      img.data[di] = src.data[si]; img.data[di + 1] = src.data[si + 1];
      img.data[di + 2] = src.data[si + 2]; img.data[di + 3] = 255;
    }
  });
  fs.writeFileSync(path.join(outDir, 'contact.png'), encodePNG(img));
}

main();
