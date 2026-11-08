// Dev-only: renders all 10 characters, front row and back row, for art review.
// ?id=<id>&zoom      -> one character, front / side / back close-up
// ?low               -> lowDetail rigs
// ?expr=hurt|power|happy
// window.__lineup.measure(id, [names]) -> world AABBs of named nodes (feet-origin frame)
import { Box3, DirectionalLight, HemisphereLight, OrthographicCamera, Scene, WebGLRenderer, Color, Object3D, Vector3 } from 'three';
import { buildCharacter, createCharacterCache } from '../src/engine/render/characters/builder';
import type { CharacterRig } from '../src/engine/render/characters/types';
import { CHARACTERS } from '../src/engine/render/characters/defs';
import { createToonGradient } from '../src/engine/render/toon';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setSize(2000, 900, false);
const scene = new Scene();
scene.background = new Color(0xf6efe4);
scene.add(new HemisphereLight(0xffffff, 0xb8a890, 1.6));
const sun = new DirectionalLight(0xffffff, 1.6);
sun.position.set(3, 6, -4);
scene.add(sun);
const back = new DirectionalLight(0xffffff, 0.8);
back.position.set(-3, 4, 6);
scene.add(back);
const gradient = createToonGradient();
const cache = createCharacterCache();
const teams = [0xff2e88, 0x19e6d0];
const lowDetail = params.has('low');
const zoomId = params.get('id');
const zoom = zoomId !== null && params.has('zoom');

const rigs: CharacterRig[] = [];
let camera: OrthographicCamera;

if (zoom) {
  // ?id=a&zoom            -> a: front, side, back
  // ?id=a,b,c&zoom        -> each: front, back   (also ?views=front,side,back)
  const ids = zoomId!.split(',').filter((s) => s.length > 0);
  const yawOf: Record<string, number> = { front: Math.PI, side: Math.PI / 2, back: 0 };
  const views = (params.get('views') ?? (ids.length === 1 ? 'front,side,back' : 'front,back')).split(',');
  const defs = ids.map((id) => CHARACTERS.find((d) => d.id === id) ?? CHARACTERS[0]!);
  const total = defs.length * views.length;
  const spacing = Math.min(1.5, 4.3 / total);
  let k = 0;
  defs.forEach((def) => {
    views.forEach((view, vi) => {
      const rig = buildCharacter(def, { gradient, teamColor: teams[vi % 2]!, lowDetail, cache, seed: k });
      rig.root.position.set((k - (total - 1) / 2) * spacing, 0, 0);
      rig.root.rotation.y = yawOf[view] ?? Math.PI;
      scene.add(rig.root);
      rigs.push(rig);
      k += 1;
    });
  });
  // 2000x900 => aspect 2.222; show y in [-0.1, 1.9]
  const h = 2.0;
  const w = h * (2000 / 900);
  camera = new OrthographicCamera(-w / 2, w / 2, 1.9, -0.1, 0.1, 100);
  // frustum is relative to the camera position: keep the camera at y=0
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
} else {
  CHARACTERS.forEach((def, i) => {
    for (const row of [0, 1]) {
      const rig = buildCharacter(def, { gradient, teamColor: teams[row]!, lowDetail, cache, seed: i });
      // top row (row 0) faces the camera (camera is on +Z, model faces -Z => yaw PI); bottom row shows the back
      rig.root.position.set((i - 4.5) * 2, row === 0 ? 2.2 : 0, 0);
      rig.root.rotation.y = row === 0 ? Math.PI : 0;
      scene.add(rig.root);
      rigs.push(rig);
    }
  });
  // Ortho frustum is relative to the camera position: camera at y=0 so world y in [-0.3, 4.3] is visible.
  camera = new OrthographicCamera(-10.2, 10.2, 2.0 + 10.2 * 900 / 2000, 2.0 - 10.2 * 900 / 2000, 0.1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
}

/** World AABB (in the rig's feet-origin frame, unrotated) of named descendants. */
function measure(id: string, names?: string[]): Record<string, { min: number[]; max: number[]; size: number[] }> {
  const def = CHARACTERS.find((d) => d.id === id) ?? CHARACTERS[0]!;
  const rig = buildCharacter(def, { gradient, teamColor: teams[0]!, lowDetail: false, cache, seed: 0 });
  rig.root.updateMatrixWorld(true);
  const out: Record<string, { min: number[]; max: number[]; size: number[] }> = {};
  const box = new Box3();
  const size = new Vector3();
  const want = names === undefined ? null : new Set(names);
  rig.root.traverse((o: Object3D) => {
    if (!(o as { isMesh?: boolean }).isMesh) return;
    if (want !== null && !want.has(o.name)) return;
    box.setFromObject(o);
    box.getSize(size);
    out[o.name] = {
      min: [box.min.x, box.min.y, box.min.z].map((v) => +v.toFixed(3)),
      max: [box.max.x, box.max.y, box.max.z].map((v) => +v.toFixed(3)),
      size: [size.x, size.y, size.z].map((v) => +v.toFixed(3)),
    };
  });
  box.setFromObject(rig.root);
  box.getSize(size);
  out.__root = {
    min: [box.min.x, box.min.y, box.min.z].map((v) => +v.toFixed(3)),
    max: [box.max.x, box.max.y, box.max.z].map((v) => +v.toFixed(3)),
    size: [size.x, size.y, size.z].map((v) => +v.toFixed(3)),
  };
  rig.dispose();
  return out;
}
(window as unknown as { __lineup: unknown }).__lineup = { rigs, measure, ids: CHARACTERS.map((d) => d.id) };

let t = 0;
function frame(): void {
  t += 1 / 60;
  for (const rig of rigs) rig.update({ time: t, dtSec: 1 / 60, run: 0, airborne: false, expression: (params.get('expr') as 'neutral') ?? 'neutral' });
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
