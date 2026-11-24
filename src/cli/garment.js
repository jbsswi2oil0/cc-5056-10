// Garment project CLI.
//
//   node src/cli/garment.js <project> audit [--break]
//       Cuff identity tracking + winding/ownership audit. --break swaps two
//       cuff correspondences to demonstrate the protected-surface gap and the
//       missing-cloth diagnosis.
//
//   node src/cli/garment.js <project> tradeoff
//       Paired-contour vs occlusion-event generation metrics.
//
//   node src/cli/garment.js <project> handoff --switchT 0.35 --t 0.5
//       Move the draggable occlusion handoff and render one phase using the
//       modified crossing (mesh + keyframes regenerate from the same layers).
//
//   node src/cli/garment.js <project> export-heldout --t 0.37
//       Export an intermediate moment that has NO authored reference image.
//
import fs from 'node:fs';
import path from 'node:path';
import { loadSceneByName } from '../node/loadScene.js';
import { buildEngine } from '../core/engine.js';
import { renderFrame } from '../core/engine.js';
import { encodePNG } from '../node/png.js';
import {
  auditProject, auditCuffOwnership, cuffWinding, trackCuffVertices,
} from '../eval/garment-audit.js';
import { garmentTradeoffReport } from '../eval/garment-tradeoff.js';

function parseArgs(argv) {
  const out = { flags: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[a.slice(2)] = true;
      else { out.flags[a.slice(2)] = next; i++; }
    } else positional.push(a);
  }
  out.project = positional[0] || 'flapfront';
  out.command = positional[1] || 'audit';
  return out;
}

function main() {
  const { project, command, flags } = parseArgs(process.argv.slice(2));
  if (!['flapfront', 'armfront'].includes(project)) {
    throw new Error(`unknown garment project: ${project} (expected flapfront | armfront)`);
  }

  if (command === 'tradeoff') {
    console.log(JSON.stringify(garmentTradeoffReport(), null, 2));
    return;
  }

  const loaded = loadSceneByName(project);

  if (command === 'audit') {
    if (flags.break) {
      const broken = buildBrokenEngine(loaded);
      const report = auditProject(broken.engine);
      report.broken = true;
      report.brokenAt = ['cuff_top', 'cuff_bot'];
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.healthy ? 1 : 0);
    }
    const report = auditProject(loaded.engine);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.healthy ? 0 : 1);
  }

  if (command === 'handoff') {
    const t = num(flags.t, 0.5);
    const switchT = num(flags.switchT, 0.5);
    const engine = rebuildWithHandoff(loaded, switchT);
    const res = renderFrame(engine, t);
    const outDir = path.join(loaded.dir, 'render');
    fs.mkdirSync(outDir, { recursive: true });
    const name = `handoff_${switchT.toFixed(3)}_t${t.toFixed(3)}.png`;
    fs.writeFileSync(path.join(outDir, name), encodePNG(res.image));
    const own = auditCuffOwnership(engine, t);
    console.log(JSON.stringify({
      project, switchT, t, file: path.join(outDir, name),
      diagnostics: {
        folds: res.diagnostics.folds.length,
        splitPixels: res.diagnostics.splitPixels,
        gapPixels: res.diagnostics.gapPixels,
      },
      cuff: { winding: cuffWinding(engine, t), ownership: own, tracks: trackCuffVertices(engine, t).vertices },
    }, null, 2));
    return;
  }

  if (command === 'export-heldout') {
    const t = num(flags.t, 0.37);
    const res = renderFrame(loaded.engine, t);
    const outDir = path.join(loaded.dir, 'heldout');
    fs.mkdirSync(outDir, { recursive: true });
    const name = `heldout_t${t.toFixed(3)}.png`;
    fs.writeFileSync(path.join(outDir, name), encodePNG(res.image));
    // A manifest proves no reference frame exists for this moment: only A/B
    // are authored; every pixel here is solved from the deformation.
    const manifest = {
      project, t, file: name,
      authoredFrames: ['flapfront_A.png', 'flapfront_B.png'],
      note: 'No reference image exists for this phase; the frame is an engine solve from frames A and B only.',
      gapPixels: res.diagnostics.gapPixels,
      folds: res.diagnostics.folds.length,
      cuffWinding: cuffWinding(loaded.engine, t),
      cuffOwnership: auditCuffOwnership(loaded.engine, t),
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ exported: path.join(outDir, name), t, gapPixels: res.diagnostics.gapPixels }, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function num(v, dflt) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

// Rebuild an engine with the occlusion handoff moved. Geometry layers and
// correspondence are untouched; only the crossing event changes.
function rebuildWithHandoff(loaded, switchT) {
  const scene = JSON.parse(JSON.stringify({
    frame: loaded.engine.scene.frame,
    background: loaded.engine.scene.background,
    layers: loaded.meta.layers,
    objects: loaded.engine.scene.objects,
    crossings: loaded.engine.scene.crossings,
    protection: loaded.engine.scene.protection,
  }));
  for (const cr of scene.crossings) {
    if (cr.handoffDraggable) { cr.switchT = switchT; cr.switchTo = cr.objectA === cr.front ? cr.objectB : cr.objectA; }
  }
  return buildEngine(scene, loaded.loadImage);
}

// Swap two protected cuff correspondences to force a fold. The engine then
// refuses those faces (gap) instead of rendering reversed cloth.
function buildBrokenEngine(loaded) {
  const scene = JSON.parse(JSON.stringify({
    frame: loaded.engine.scene.frame,
    background: loaded.engine.scene.background,
    layers: loaded.meta.layers,
    objects: loaded.engine.scene.objects,
    crossings: loaded.engine.scene.crossings,
    protection: loaded.engine.scene.protection,
  }));
  const arm = scene.objects.find((o) => o.id === 'arm');
  const top = arm.landmarks.find((l) => l.id === 'cuff_top');
  const bot = arm.landmarks.find((l) => l.id === 'cuff_bot');
  const tmp = top.b; top.b = bot.b; bot.b = tmp;
  return { ...loaded, engine: buildEngine(scene, loaded.loadImage) };
}

main();
