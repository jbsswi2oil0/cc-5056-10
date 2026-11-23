// Write both ground-truth scenes to out/: frame A, frame B, per-object layers,
// and the authoring data (correspondence, crossings, truth) as JSON. The browser
// editor and the CLI both read from here, so there is a single source of truth.
import fs from 'node:fs';
import path from 'node:path';
import { buildHandSceneData, buildStitchSceneData } from './scenes.js';
import { encodePNG } from '../node/png.js';

const OUT = path.resolve(process.cwd(), 'out');

function writePNG(dir, name, img) {
  fs.writeFileSync(path.join(dir, `${name}.png`), encodePNG(img));
}

function stripBuffers(sceneData) {
  // JSON-able view: drop raw pixel buffers, keep geometry + truth + refs.
  const layers = {};
  for (const [id, pair] of Object.entries(sceneData.layers)) {
    layers[id] = { A: `${id}_A.png`, B: `${id}_B.png` };
  }
  return {
    id: sceneData.id,
    frame: sceneData.frame,
    objects: sceneData.objects,
    crossings: sceneData.crossings,
    truth: sceneData.truth,
    layers,
    frames: {
      A: `${sceneData.id}_A.png`,
      B: `${sceneData.id}_B.png`,
      background: `${sceneData.id}_bg.png`,
    },
  };
}

function emit(sceneData) {
  const dir = path.join(OUT, sceneData.id);
  fs.mkdirSync(dir, { recursive: true });
  writePNG(dir, `${sceneData.id}_A`, sceneData.frames.A);
  writePNG(dir, `${sceneData.id}_B`, sceneData.frames.B);
  writePNG(dir, `${sceneData.id}_bg`, sceneData.background.A);
  for (const [id, pair] of Object.entries(sceneData.layers)) {
    writePNG(dir, `${id}_A`, pair.A);
    writePNG(dir, `${id}_B`, pair.B);
  }
  // Per-object coverage masks make provenance checks easy to eyeball later.
  const meta = stripBuffers(sceneData);
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(meta, null, 2));
  return { dir, objects: sceneData.objects.length, layers: Object.keys(sceneData.layers) };
}

const hands = buildHandSceneData();
const stitch = buildStitchSceneData();
const report = { hands: emit(hands), stitch: emit(stitch) };
console.log(JSON.stringify(report, null, 2));
