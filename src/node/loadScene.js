// Node-side scene loading: read out/<scene>/ from disk, decode the PNGs, build
// the engine. Used by the render and evaluate CLIs so both exercise the exact
// same code path the browser editor uses.
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from './png.js';
import { buildEngine } from '../core/engine.js';

export function loadSceneDir(dir) {
  const scenePath = path.join(dir, 'scene.json');
  const meta = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
  const cache = new Map();
  const loadImage = (ref) => {
    if (typeof ref !== 'string') return ref;
    if (!cache.has(ref)) {
      const buf = fs.readFileSync(path.join(dir, ref));
      cache.set(ref, decodePNG(buf));
    }
    return cache.get(ref);
  };
  const scene = {
    frame: meta.frame,
    background: { A: loadImage(meta.frames.background), B: loadImage(meta.frames.background) },
    layers: meta.layers,
    objects: meta.objects,
    crossings: meta.crossings,
    protection: meta.protection || [],
  };
  const engine = buildEngine(scene, loadImage);
  engine._loadImage = loadImage;
  return { engine, meta, loadImage, dir };
}

export function loadSceneByName(name) {
  const dir = path.resolve(process.cwd(), 'out', name);
  return loadSceneDir(dir);
}
