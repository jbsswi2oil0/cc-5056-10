// Load a scene built by assets/scenes.js into the engine, with images decoded
// from raw RGBA buffers. Also provides the authoring-layer serialisation the
// interactive editor reads and writes.
import { buildEngine } from '../core/engine.js';

export function imageLoaderFromBuffers(bufs) {
  // bufs: { key: {width,height,data:Uint8ClampedArray} }
  const cache = new Map();
  return (ref) => {
    if (typeof ref !== 'string') return ref;
    if (!cache.has(ref)) cache.set(ref, bufs[ref]);
    return cache.get(ref);
  };
}

export function makeEngineFromSceneData(sceneData, buffers) {
  const scene = {
    frame: sceneData.frame,
    background: { A: sceneData.background.A, B: sceneData.background.B },
    layers: {},
    objects: sceneData.objects,
    crossings: sceneData.crossings,
  };
  const bufs = {};
  for (const [id, pair] of Object.entries(sceneData.layers)) {
    bufs[`${id}:A`] = pair.A;
    bufs[`${id}:B`] = pair.B;
    scene.layers[id] = { A: `${id}:A`, B: `${id}:B` };
  }
  // the loader receives the already-decoded object images
  const loader = (ref) => {
    if (bufs[ref]) return bufs[ref];
    return ref;
  };
  const engineScene = {
    ...scene,
    background: { A: sceneData.background.A, B: sceneData.background.B },
  };
  return buildEngine(engineScene, loader);
}
