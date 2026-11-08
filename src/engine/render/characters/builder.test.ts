import {
  Box3,
  Euler,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { DataTexture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createToonGradient } from '../toon';
import { buildCharacter, createCharacterCache } from './builder';
import { CHARACTERS } from './defs';
import type {
  CharacterAssetCache,
  CharacterBody,
  CharacterDef,
  CharacterRig,
  PartDef,
} from './types';

const SPHERE_DEF: CharacterDef = {
  id: 'test-sphere',
  name: 'テストまる',
  tagline: 'まるい頭の見習い。',
  catchphrase: 'まるく、ぬる。',
  body: {
    headRadius: 0.28,
    headScale: [1, 1, 1],
    torso: 'capsule',
    bodyHeight: 0.56,
    bodyWidth: 0.34,
    legStyle: 'stub',
    legLength: 0.3,
    armStyle: 'capsule',
    handStyle: 'skin',
  },
  colors: {
    skin: '#ffe3c4',
    garb: '#2b2f5c',
    garbDark: '#1f2246',
    accent: '#3a2a26',
    accent2: '#f4ede0',
    iris: '#5a3a2a',
  },
  face: {
    eye: 'round',
    eyeSpread: 0.42,
    eyeY: 0.03,
    brow: 'flat',
    mouth: 'smile',
    cheeks: '#ffb0b8',
  },
  parts: [
    {
      id: 'tail',
      prim: { t: 'box', w: 0.08, h: 0.24, d: 0.05 },
      attach: 'torso',
      pos: [0.07, 1.04, 0.18],
      color: 'team',
      anim: { k: 'flutter', amp: 0.3, hz: 9 },
      chain: 2,
    },
    {
      id: 'fin',
      prim: { t: 'cone', r: 0.06, h: 0.2 },
      attach: 'root',
      pos: [0.2, 0.9, 0.1],
      rot: [0, 0, 0.2],
      color: 'accent',
      mirror: true,
    },
    {
      id: 'band',
      prim: { t: 'torus', R: 0.29, r: 0.03 },
      attach: 'head',
      pos: [0, 1.42, 0],
      rot: [Math.PI / 2, 0, 0],
      color: 'team',
      slot: 'headBand',
    },
    {
      id: 'braid',
      prim: { t: 'capsule', r: 0.05, len: 0.12 },
      attach: 'head',
      pos: [0, 1.2, 0.1],
      color: 'accent2',
      chain: 2,
      anim: { k: 'swing', amp: 0.3, lag: 0.1 },
    },
  ],
};

const BOX_DEF: CharacterDef = {
  id: 'test-box',
  name: 'テストかく',
  tagline: '四角い頭のからくり。',
  catchphrase: 'かく、ぬる。',
  body: {
    headRadius: 0.25,
    headScale: [1, 1, 1],
    headShape: 'box',
    torso: 'box',
    bodyHeight: 0.42,
    bodyWidth: 0.36,
    legStyle: 'peg',
    legLength: 0.32,
    armStyle: 'cyl',
    handStyle: 'box',
  },
  colors: {
    skin: '#cdb38e',
    garb: '#8c6a4a',
    garbDark: '#7a4b2a',
    accent: '#a8a49c',
    accent2: '#fff3c4',
    iris: '#3a2a2a',
  },
  face: {
    eye: 'disc',
    eyeSpread: 0.4,
    eyeY: 0.02,
    brow: 'thick',
    mouth: 'slit',
  },
  parts: [
    {
      id: 'sash',
      prim: { t: 'box', w: 0.4, h: 0.08, d: 0.02 },
      attach: 'hip',
      pos: [0, 0.6, 0.2],
      color: 'team',
      slot: 'belt',
    },
  ],
};

const BASE_COLORS = {
  skin: '#ffe3c4',
  garb: '#2b2f5c',
  garbDark: '#1f2246',
  accent: '#3a2a26',
  accent2: '#f4ede0',
  iris: '#5a3a2a',
} as const;

function makeDef(id: string, parts: readonly PartDef[], body: Partial<CharacterBody> = {}): CharacterDef {
  return {
    id,
    name: id,
    tagline: `${id} fixture`,
    catchphrase: `${id}!`,
    body: {
      headRadius: 0.33,
      headScale: [1, 0.94, 1],
      torso: 'capsule',
      bodyHeight: 0.68,
      bodyWidth: 0.48,
      legStyle: 'stub',
      legLength: 0.37,
      armStyle: 'capsule',
      handStyle: 'skin',
      ...body,
    },
    colors: { ...BASE_COLORS },
    face: {
      eye: 'round',
      eyeSpread: 0.48,
      eyeY: -0.08,
      brow: 'flat',
      mouth: 'smile',
    },
    parts,
  };
}

function build(
  def: CharacterDef,
  cache: CharacterAssetCache,
  gradient: DataTexture,
  lowDetail = false,
): CharacterRig {
  return buildCharacter(def, {
    gradient,
    teamColor: 0xff2e88,
    lowDetail,
    cache,
    seed: 987654,
  });
}

function countMeshes(root: Object3D): number {
  let count = 0;
  root.traverse((child) => {
    if (child instanceof Mesh) count += 1;
  });
  return count;
}

function countObjects(root: Object3D): number {
  let count = 0;
  root.traverse(() => {
    count += 1;
  });
  return count;
}

function materialColor(mesh: Mesh): number | null {
  const material = mesh.material;
  if (material instanceof MeshToonMaterial) return material.color.getHex();
  if (material instanceof MeshBasicMaterial) return material.color.getHex();
  return null;
}

function requiredObject(root: Object3D, name: string): Object3D {
  const found = root.getObjectByName(name);
  if (found === undefined) throw new Error(`missing object ${name}`);
  return found;
}

function requiredMesh(root: Object3D, name: string): Mesh {
  const found = root.getObjectByName(name);
  if (!(found instanceof Mesh)) throw new Error(`missing mesh ${name}`);
  return found;
}

function worldPosition(object: Object3D): Vector3 {
  const position = new Vector3();
  position.setFromMatrixPosition(object.matrixWorld);
  return position;
}

function worldBounds(object: Object3D): Box3 {
  return new Box3().setFromObject(object, true);
}

/** Bounds of the real geometry, ignoring the 6% outline hulls: hulls are
 * render duplicates and must not inflate the measured silhouette. Vertices
 * are transformed one by one so tilted discs do not report their cube box. */
function silhouetteBounds(root: Object3D): Box3 {
  const bounds = new Box3();
  const point = new Vector3();
  root.traverse((child) => {
    if (!(child instanceof Mesh) || child.name.endsWith('-outline')) return;
    const position = child.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index += 1) {
      point.fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld);
      bounds.expandByPoint(point);
    }
  });
  return bounds;
}

function namedObjects(root: Object3D, prefix: string): Object3D[] {
  const found: Object3D[] = [];
  root.traverse((child) => {
    if (child.name.startsWith(prefix)) found.push(child);
  });
  return found;
}

function expectFiniteTransforms(root: Object3D): void {
  root.traverse((child) => {
    expect(Number.isFinite(child.position.x)).toBe(true);
    expect(Number.isFinite(child.position.y)).toBe(true);
    expect(Number.isFinite(child.position.z)).toBe(true);
    expect(Number.isFinite(child.rotation.x)).toBe(true);
    expect(Number.isFinite(child.rotation.y)).toBe(true);
    expect(Number.isFinite(child.rotation.z)).toBe(true);
    expect(Number.isFinite(child.scale.x)).toBe(true);
    expect(Number.isFinite(child.scale.y)).toBe(true);
    expect(Number.isFinite(child.scale.z)).toBe(true);
  });
}

describe('createCharacterCache', () => {
  it('shares geometry between rigs and disposes cached geometry', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const first = build(SPHERE_DEF, cache, gradient);
    const second = build(SPHERE_DEF, cache, gradient);

    const firstHead = requiredMesh(first.root, 'head');
    const secondHead = requiredMesh(second.root, 'head');
    expect(firstHead.geometry).toBe(secondHead.geometry);

    const disposeSpy = vi.spyOn(firstHead.geometry, 'dispose');
    cache.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });
});

describe('buildCharacter body', () => {
  it('builds both fixtures within the mesh budget', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const sphere = build(SPHERE_DEF, cache, gradient);
    const box = build(BOX_DEF, cache, gradient);
    expect(countMeshes(sphere.root)).toBeLessThanOrEqual(44);
    expect(countMeshes(box.root)).toBeLessThanOrEqual(44);
    cache.dispose();
  });

  it('puts the fixture crown at its headY', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const def = makeDef('fixture-crown', []);
    const rig = build(def, cache, gradient);
    rig.root.updateMatrixWorld(true);

    const head = worldBounds(requiredObject(rig.root, 'head'));
    expect(Math.abs(head.max.y - 1.6)).toBeLessThanOrEqual(0.01);
    expect(head.max.y - head.min.y).toBeGreaterThanOrEqual(0.58);
    expect(head.max.y - head.min.y).toBeLessThanOrEqual(0.68);
    cache.dispose();
  });

  it('builds a box head without a sphere head geometry', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(BOX_DEF, cache, gradient);
    const head = requiredMesh(rig.root, 'head');
    expect(head.geometry.type).toBe('BoxGeometry');
    cache.dispose();
  });

  it('only builds the hip plate for square torsos', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const round = build(SPHERE_DEF, cache, gradient);
    const square = build(BOX_DEF, cache, gradient);
    expect(round.root.getObjectByName('hip')).toBeUndefined();
    expect(square.root.getObjectByName('hip')).toBeDefined();
    cache.dispose();
  });
});

describe('team colours', () => {
  it('recolours every team mesh through setTeamColor', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(SPHERE_DEF, cache, gradient);
    expect(rig.teamMeshes.length).toBeGreaterThan(0);

    const before = rig.teamMeshes.map((mesh) => materialColor(mesh));
    rig.setTeamColor(0x00ff00);
    const after = rig.teamMeshes.map((mesh) => materialColor(mesh));

    expect(after).not.toEqual(before);
    expect(after).toContain(0x00ff00);
    cache.dispose();
  });
});

describe('parts', () => {
  it('creates a mirrored copy at negative x', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(SPHERE_DEF, cache, gradient);
    rig.root.updateMatrixWorld(true);

    const original = requiredObject(rig.root, 'fin');
    const mirrored = requiredObject(rig.root, 'fin-mirror');
    const originalPosition = worldPosition(original);
    const mirroredPosition = worldPosition(mirrored);

    expect(originalPosition.x).toBeCloseTo(0.2, 5);
    expect(mirroredPosition.x).toBeCloseTo(-0.2, 5);
    cache.dispose();
  });

  it('chains segments as nested pivots', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(SPHERE_DEF, cache, gradient);

    const first = requiredObject(rig.root, 'braid');
    const second = requiredObject(rig.root, 'braid-1');
    const firstMesh = requiredMesh(rig.root, 'braid-segment-0');
    const secondMesh = requiredMesh(rig.root, 'braid-segment-1');

    expect(second.parent).toBe(first);
    expect(firstMesh.parent).toBe(first);
    expect(secondMesh.parent).toBe(second);
    cache.dispose();
  });

  it('applies chainBend per segment instead of repeating rot', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const def = makeDef('fixture-chain', [
      {
        id: 'chain',
        prim: { t: 'capsule', r: 0.05, len: 0.12 },
        attach: 'hip',
        pos: [0, 0.42, 0.22],
        rot: [-2.3, 0, 0],
        chain: 3,
        chainBend: [-0.35, 0, 0],
        color: 'skin',
      },
    ]);
    const rig = build(def, cache, gradient);
    rig.root.updateMatrixWorld(true);

    const base = -2.3;
    const bend = -0.35;
    expect(rig.root.getObjectByName('chain-1')).toBeDefined();
    expect(rig.root.getObjectByName('chain-2')).toBeDefined();
    for (let index = 0; index < 3; index += 1) {
      const node = requiredObject(rig.root, index === 0 ? 'chain' : `chain-${index}`);
      const world = new Euler().setFromQuaternion(node.getWorldQuaternion(node.quaternion.clone()), 'XYZ');
      expect(world.x).toBeCloseTo(base + bend * index, 4);
    }
    cache.dispose();
  });

  it('attaches a chainTip mesh at the final segment', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const def = makeDef('fixture-tip', [
      {
        id: 'braid',
        prim: { t: 'capsule', r: 0.05, len: 0.12 },
        attach: 'head',
        pos: [0, 1.2, 0.1],
        chain: 2,
        color: 'accent',
        chainTip: { prim: { t: 'sphere', r: 0.05 }, color: 'team' },
      },
    ]);
    const rig = build(def, cache, gradient);
    const tip = requiredMesh(rig.root, 'braid-tip');
    expect(tip.parent).toBe(requiredObject(rig.root, 'braid-1'));
    expect(worldPosition(tip).y).toBeLessThan(1.2);
    cache.dispose();
  });

  it('pivots base-anchored parts from the bottom of the primitive', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const def = makeDef('fixture-base', [
      {
        id: 'spike',
        prim: { t: 'cone', r: 0.08, h: 0.22 },
        attach: 'head',
        pos: [0, 1.5, 0.2],
        color: 'accent',
        anchor: 'base',
      },
    ]);
    const rig = build(def, cache, gradient);
    rig.root.updateMatrixWorld(true);

    const spike = worldBounds(requiredObject(rig.root, 'spike'));
    expect(spike.min.y).toBeCloseTo(1.5, 3);
    expect(spike.max.y).toBeCloseTo(1.72, 3);
    cache.dispose();
  });

  it('replaces the default headBand when a part claims the slot', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(SPHERE_DEF, cache, gradient);
    expect(rig.root.getObjectByName('default-headBand')).toBeUndefined();
    expect(rig.root.getObjectByName('band')).toBeDefined();
    cache.dispose();
  });

  it('replaces the default belt on the box fixture', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(BOX_DEF, cache, gradient);
    expect(rig.root.getObjectByName('default-belt')).toBeUndefined();
    expect(rig.root.getObjectByName('default-beltKnot')).toBeUndefined();
    expect(rig.root.getObjectByName('sash')).toBeDefined();
    cache.dispose();
  });
});

describe('attach points', () => {
  it('round-trips every attach point through the feet-origin frame', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const attaches = ['head', 'torso', 'hip', 'armL', 'armR', 'legL', 'legR', 'root'] as const;
    const parts: PartDef[] = attaches.map((attach) => ({
      id: `probe-${attach}`,
      prim: { t: 'sphere', r: 0.02 },
      attach,
      pos: [0.1, 0.5, 0.2],
      color: 'accent',
    }));
    const rig = build(makeDef('fixture-attach', parts), cache, gradient);
    rig.root.updateMatrixWorld(true);

    for (const attach of attaches) {
      const probe = worldPosition(requiredObject(rig.root, `probe-${attach}`));
      expect(probe.x).toBeCloseTo(0.1, 3);
      expect(probe.y).toBeCloseTo(0.5, 3);
      expect(probe.z).toBeCloseTo(0.2, 3);
    }
    cache.dispose();
  });
});

describe('low detail', () => {
  it('uses fewer meshes and skips outline hulls', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const high = build(SPHERE_DEF, cache, gradient, false);
    const low = build(SPHERE_DEF, cache, gradient, true);

    let highOutlines = 0;
    high.root.traverse((child) => {
      if (child instanceof Mesh && child.name.endsWith('-outline')) highOutlines += 1;
    });
    let lowOutlines = 0;
    low.root.traverse((child) => {
      if (child instanceof Mesh && child.name.endsWith('-outline')) lowOutlines += 1;
    });

    expect(highOutlines).toBeGreaterThan(0);
    expect(lowOutlines).toBe(0);
    expect(countMeshes(low.root)).toBeLessThan(countMeshes(high.root));
    cache.dispose();
  });
});

describe('update', () => {
  it('keeps every transform finite for non-finite inputs', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(SPHERE_DEF, cache, gradient);

    rig.update({
      time: Number.NaN,
      dtSec: Number.POSITIVE_INFINITY,
      run: Number.NaN,
      airborne: false,
      expression: 'neutral',
    });
    expectFiniteTransforms(rig.root);
    cache.dispose();
  });

  it('blinks within six seconds and never creates objects', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(SPHERE_DEF, cache, gradient);
    const eyeRoot = requiredObject(rig.root, 'eye-root-L');
    const before = countObjects(rig.root);

    let blinked = false;
    for (let step = 0; step <= 360; step += 1) {
      rig.update({
        time: step / 60,
        dtSec: 1 / 60,
        run: 0,
        airborne: false,
        expression: 'neutral',
      });
      if (eyeRoot.scale.y < 0.2) blinked = true;
    }

    expect(blinked).toBe(true);
    expect(countObjects(rig.root)).toBe(before);
    cache.dispose();
  });

  it('animates data parts and expressions without leaving NaN transforms', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(SPHERE_DEF, cache, gradient);
    const tail = requiredObject(rig.root, 'tail');
    const tailRotation = tail.rotation.x;

    rig.update({ time: 0.4, dtSec: 0.4, run: 1, airborne: true, expression: 'hurt' });
    expect(tail.rotation.x).not.toBe(tailRotation);
    expectFiniteTransforms(rig.root);

    rig.update({ time: 12, dtSec: 0.2, run: 0, airborne: false, expression: 'power' });
    expectFiniteTransforms(rig.root);
    cache.dispose();
  });
});

/* ---------------- roster acceptance (art director's list E) ---------------- */

describe('roster acceptance: silhouette', () => {
  for (const def of CHARACTERS) {
    it(`${def.id}: head, belt, legs and ground follow the body template`, () => {
      const cache = createCharacterCache();
      const gradient = createToonGradient();
      const rig = build(def, cache, gradient);
      rig.root.updateMatrixWorld(true);

      const head = worldBounds(requiredObject(rig.root, 'head'));
      const headHeight = head.max.y - head.min.y;
      const headY = def.body.headY ?? 1.6;

      /* 1. head size and crown height */
      expect(headHeight).toBeGreaterThanOrEqual(0.58);
      expect(headHeight).toBeLessThanOrEqual(0.68);
      expect(Math.abs(head.max.y - headY)).toBeLessThanOrEqual(0.01);

      const torso = worldBounds(requiredObject(rig.root, 'torso'));

      /* 2. the belt sits on the pelvis, never on the ankles */
      const beltPart = def.parts.find((part) => part.slot === 'belt');
      const belt = rig.root.getObjectByName(beltPart?.id ?? 'default-belt');
      if (belt === undefined) throw new Error(`missing belt for ${def.id}`);
      const beltY = worldPosition(belt).y;
      expect(beltY).toBeGreaterThanOrEqual(torso.min.y + 0.12);
      expect(beltY).toBeLessThanOrEqual(torso.min.y + 0.28);
      if (def.id === 'mame') {
        expect(beltY).toBeGreaterThanOrEqual(0.36);
        expect(beltY).toBeLessThanOrEqual(0.48);
      } else {
        expect(beltY).toBeGreaterThanOrEqual(0.5);
        expect(beltY).toBeLessThanOrEqual(0.65);
      }

      /* 3. legs meet the feet and reach into the torso */
      const leg = worldBounds(requiredObject(rig.root, 'legL-mesh'));
      const foot = worldBounds(requiredObject(rig.root, 'footL'));
      expect(leg.min.y).toBeLessThanOrEqual(foot.max.y + 0.005);
      expect(leg.max.y).toBeGreaterThanOrEqual(torso.min.y);

      /* 4. visible leg stays under 17% of the body height */
      expect((torso.min.y - foot.max.y) / headY).toBeLessThanOrEqual(0.17);

      /* 5. nothing sinks below the ground and the crown stays in budget */
      const bounds = silhouetteBounds(rig.root);
      expect(bounds.min.y).toBeGreaterThanOrEqual(-0.01);
      expect(bounds.max.y).toBeLessThanOrEqual(1.76);

      cache.dispose();
    });

    it(`${def.id}: faces -Z and keeps its back detail behind`, () => {
      const cache = createCharacterCache();
      const gradient = createToonGradient();
      const rig = build(def, cache, gradient);
      rig.root.updateMatrixWorld(true);

      /* 6. face parts sit on the front half */
      const frontPrefixes = ['eye-white', 'eye-disc', 'mouth', 'cheek'];
      for (const prefix of frontPrefixes) {
        for (const object of namedObjects(rig.root, prefix)) {
          expect(worldPosition(object).z).toBeLessThan(-0.2);
        }
      }
      expect(namedObjects(rig.root, 'mouth').length).toBeGreaterThan(0);
      expect(namedObjects(rig.root, 'cheek').length).toBeGreaterThan(0);

      /* back detail stays on the back half */
      const backPrefixes = ['default-scarfTail', 'default-backCrest', 'scroll', 'gourd', 'wing'];
      for (const prefix of backPrefixes) {
        for (const object of namedObjects(rig.root, prefix)) {
          expect(worldPosition(object).z).toBeGreaterThan(0.1);
        }
      }

      /* 11. both eye highlights catch the light on the same side */
      const eyesL = rig.root.getObjectByName('eye-white-L');
      const eyesR = rig.root.getObjectByName('eye-white-R');
      const shineL = rig.root.getObjectByName('highlight-L');
      const shineR = rig.root.getObjectByName('highlight-R');
      if (eyesL !== undefined && eyesR !== undefined && shineL !== undefined && shineR !== undefined) {
        const offsetL = worldPosition(shineL).x - worldPosition(eyesL).x;
        const offsetR = worldPosition(shineR).x - worldPosition(eyesR).x;
        expect(offsetL).not.toBe(0);
        expect(offsetR).not.toBe(0);
        expect(Math.sign(offsetL)).toBe(Math.sign(offsetR));
      }

      cache.dispose();
    });
  }

  it('every character fits the mesh budget', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const heavy: string[] = [];
    for (const def of CHARACTERS) {
      const rig = build(def, cache, gradient);
      const meshes = countMeshes(rig.root);
      if (meshes > 44) heavy.push(`${def.id}=${meshes}`);
    }
    expect(heavy).toEqual([]);
    /* 12. roster size is fixed */
    expect(CHARACTERS.length).toBe(10);
    cache.dispose();
  });

  it('the onigiri cone points up, not down', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    let checked = 0;
    for (const def of CHARACTERS) {
      const part = def.parts.find((entry) => entry.id === 'onigiri');
      if (part === undefined) continue;
      checked += 1;
      const rig = build(def, cache, gradient);
      rig.root.updateMatrixWorld(true);
      const bounds = worldBounds(requiredObject(rig.root, 'onigiri'));
      const midY = part.pos[1];
      /* 8. the broad base is below the apex */
      expect(bounds.max.y - midY).toBeGreaterThan(midY - bounds.min.y);
    }
    expect(checked).toBeGreaterThan(0);
    cache.dispose();
  });
});

/* ---------------- visual polish round 2 ---------------- */

function defById(id: string): CharacterDef {
  const found = CHARACTERS.find((def) => def.id === id);
  if (found === undefined) throw new Error(`missing character ${id}`);
  return found;
}

/** World AABB of one mesh's own vertices: outline hulls are 6% bigger replicas
 * and must never decide where a part sits. */
function geometryBounds(root: Object3D, name: string): Box3 {
  const mesh = requiredMesh(root, name);
  const position = mesh.geometry.getAttribute('position');
  const bounds = new Box3();
  const point = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
    bounds.expandByPoint(point);
  }
  return bounds;
}

function boundsCentre(bounds: Box3): Vector3 {
  return bounds.getCenter(new Vector3());
}

function headCentreOf(root: Object3D): number {
  return boundsCentre(geometryBounds(root, 'head')).y;
}

/** World position of a named object expressed in the head pivot's own frame,
 * so head-relative numbers survive a stooped body. */
function headLocalPoint(root: Object3D, name: string, toHead: Matrix4): Vector3 {
  return worldPosition(requiredObject(root, name)).applyMatrix4(toHead);
}

function activeMouthNames(mouth: CharacterDef['face']['mouth']): readonly string[] {
  switch (mouth) {
    case 'smile':
      return ['mouth-smile'];
    case 'wide':
      return ['mouth-wide-base'];
    case 'cat':
      return ['mouth-cat-L', 'mouth-cat-R'];
    case 'line':
      return ['mouth-line'];
    case 'o':
      return ['mouth-o-base'];
    case 'slit':
      return ['mouth-slit'];
    case 'none':
      return [];
  }
}

/** Part-frame AABB (ignores the body stoop and outline hulls) for judging a
 * primitive's own proportions. */
function localMeshBounds(root: Object3D, name: string): Box3 {
  const mesh = requiredMesh(root, name);
  mesh.updateMatrix();
  const position = mesh.geometry.getAttribute('position');
  const bounds = new Box3();
  const point = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrix);
    bounds.expandByPoint(point);
  }
  return bounds;
}

describe('roster polish: bands', () => {
  it('keeps the default scarf and belt thin instead of float-like', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    for (const def of CHARACTERS) {
      const rig = build(def, cache, gradient);
      rig.root.updateMatrixWorld(true);

      if (rig.root.getObjectByName('default-scarf') !== undefined) {
        const scarf = localMeshBounds(rig.root, 'default-scarf');
        /* A flat torus shows its tube diameter as its height. */
        expect(scarf.max.y - scarf.min.y, `${def.id} scarf tube`).toBeLessThanOrEqual(0.095);
        expect((scarf.max.x - scarf.min.x) / 2, `${def.id} scarf radius`).toBeLessThanOrEqual(0.27);
      }

      const beltPart = def.parts.find((part) => part.slot === 'belt');
      const beltName = beltPart?.id ?? 'default-belt';
      expect(rig.root.getObjectByName(beltName), `${def.id} belt`).toBeDefined();
      if (beltPart === undefined) {
        const belt = localMeshBounds(rig.root, beltName);
        const torso = localMeshBounds(rig.root, 'torso');
        expect(belt.max.y - belt.min.y, `${def.id} belt tube`).toBeLessThanOrEqual(0.07);
        expect((belt.max.x - belt.min.x) / 2, `${def.id} belt radius`).toBeLessThanOrEqual(
          (torso.max.x - torso.min.x) / 2 + 0.06,
        );
      }
    }
    cache.dispose();
  });
});

describe('roster polish: mouths', () => {
  it('draws every mouth on the head surface just below the eyes', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    for (const def of CHARACTERS) {
      const names = activeMouthNames(def.face.mouth);
      if (names.length === 0) continue;
      const rig = build(def, cache, gradient);
      rig.root.updateMatrixWorld(true);

      const eyeY = worldPosition(requiredObject(rig.root, 'eye-root-L')).y;
      const nearby: Mesh[] = [];
      rig.root.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        if (child.name.endsWith('-outline')) return;
        if (names.includes(child.name)) return;
        nearby.push(child);
      });

      for (const name of names) {
        const mouth = requiredMesh(rig.root, name);
        const centre = worldPosition(mouth);
        expect(centre.y, `${def.id} ${name} too high`).toBeLessThanOrEqual(eyeY - 0.06);
        expect(centre.y, `${def.id} ${name} too low`).toBeGreaterThanOrEqual(eyeY - 0.22);
        for (const other of nearby) {
          const otherCentre = worldPosition(other);
          if (centre.distanceTo(otherCentre) > 0.12) continue;
          expect(
            otherCentre.z,
            `${def.id}: ${other.name} hides ${name}`,
          ).toBeGreaterThanOrEqual(centre.z - 1e-6);
        }
      }
      cache.dispose();
    }
  });

  it('puts the nyanta muzzle below the nose with the cat mouth on its front', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(defById('nyanta'), cache, gradient);
    rig.root.updateMatrixWorld(true);

    const muzzle = boundsCentre(geometryBounds(rig.root, 'muzzle'));
    const mouth = worldPosition(requiredMesh(rig.root, 'mouth-cat-L'));
    expect(muzzle.y).toBeLessThan(mouth.y);
    expect(mouth.z).toBeLessThan(muzzle.z - 0.02);
    cache.dispose();
  });
});

describe('roster polish: gonta', () => {
  it('wears a wide rice-ball hat with its nori on the front face', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(defById('gonta'), cache, gradient);
    rig.root.updateMatrixWorld(true);

    const hat = geometryBounds(rig.root, 'onigiri');
    expect(hat.max.y).toBeLessThanOrEqual(1.76 + 1e-6);
    expect(hat.max.y - hat.min.y).toBeGreaterThanOrEqual(0.18);
    expect(hat.max.x - hat.min.x).toBeGreaterThanOrEqual(0.5);
    expect(hat.max.y - 1.62).toBeGreaterThan(1.62 - hat.min.y);

    const nori = geometryBounds(rig.root, 'nori');
    expect(nori.max.z).toBeLessThanOrEqual(hat.min.z - 0.001);
    expect(boundsCentre(nori).y).toBeLessThan(boundsCentre(hat).y);

    const band = worldPosition(requiredObject(rig.root, 'hatBand'));
    expect(band.y).toBeCloseTo(1.5, 2);
    expect(rig.root.getObjectByName('headBand')).toBeUndefined();
    cache.dispose();
  });

  it('keeps the haramaki visible around the smaller belly', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(defById('gonta'), cache, gradient);
    rig.root.updateMatrixWorld(true);

    const belly = geometryBounds(rig.root, 'belly');
    const haramaki = geometryBounds(rig.root, 'haramaki');
    expect(haramaki.max.x - belly.max.x).toBeGreaterThan(0.1);
    expect(boundsCentre(belly).y).toBeCloseTo(0.66, 2);
    expect(boundsCentre(belly).z).toBeLessThan(-0.25);
    cache.dispose();
  });
});

describe('roster polish: mame', () => {
  it('has a hair cap on the crown and bangs above the eyes', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(defById('mame'), cache, gradient);
    rig.root.updateMatrixWorld(true);

    const headCentre = headCentreOf(rig.root);
    const head = geometryBounds(rig.root, 'head');
    const hair = geometryBounds(rig.root, 'hairCap');
    expect(boundsCentre(hair).y).toBeCloseTo(headCentre + 0.07, 1);
    expect(hair.max.y).toBeGreaterThan(head.max.y - 0.005);
    expect(hair.max.x - hair.min.x).toBeGreaterThan(head.max.x - head.min.x);

    const eyeY = worldPosition(requiredObject(rig.root, 'eye-root-L')).y;
    const bangs = boundsCentre(geometryBounds(rig.root, 'bangs'));
    expect(bangs.y).toBeCloseTo(headCentre + 0.2, 1);
    expect(bangs.z).toBeCloseTo(-0.2, 1);
    expect(bangs.y).toBeGreaterThan(eyeY + 0.15);

    for (const name of ['bun', 'bun-mirror']) {
      expect(boundsCentre(geometryBounds(rig.root, name)).y).toBeCloseTo(headCentre + 0.2, 1);
    }
    cache.dispose();
  });
});

describe('roster polish: gen-san', () => {
  it('drops the mustache under the nose and lifts white brows over the eyes', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(defById('gen-san'), cache, gradient);
    rig.root.updateMatrixWorld(true);

    /* gen-san stoops, so head-relative numbers are read in the head frame. */
    const toHead = new Matrix4().copy(rig.pivots.head.matrixWorld).invert();
    const headCentre = worldPosition(requiredObject(rig.root, 'head')).applyMatrix4(toHead);
    expect(headCentre.y).toBeCloseTo(0, 3);

    const mustache = headLocalPoint(rig.root, 'mustache', toHead);
    expect(mustache.y).toBeCloseTo(-0.17, 2);
    expect(mustache.z).toBeCloseTo(-0.31, 2);

    const brows = [requiredMesh(rig.root, 'brow'), requiredMesh(rig.root, 'brow-mirror')];
    for (const brow of brows) {
      const centre = headLocalPoint(rig.root, brow.name, toHead);
      expect(centre.y).toBeCloseTo(0.11, 2);
      const hex = materialColor(brow);
      expect(hex).not.toBeNull();
      if (hex === null) continue;
      expect((hex >> 16) & 0xff).toBeGreaterThanOrEqual(0xf0);
      expect((hex >> 8) & 0xff).toBeGreaterThanOrEqual(0xf0);
      expect(hex & 0xff).toBeGreaterThanOrEqual(0xf0);
      /* Outer ends droop away from the nose. */
      expect(worldPosition(brow).x * brow.rotation.z).toBeLessThan(0);
    }

    const beard = headLocalPoint(rig.root, 'beard', toHead);
    expect(beard.y).toBeCloseTo(-0.2, 2);
    cache.dispose();
  });
});

describe('roster polish: kuroha', () => {
  it('shows the beak on the side of the head with a pale tie', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(defById('kuroha'), cache, gradient);
    rig.root.updateMatrixWorld(true);

    const headCentre = headCentreOf(rig.root);
    const beak = boundsCentre(geometryBounds(rig.root, 'beakMask'));
    expect(beak.x).toBeGreaterThan(0.25);
    expect(beak.y).toBeCloseTo(headCentre + 0.1, 1);

    const tie = requiredMesh(rig.root, 'beakTie');
    expect(materialColor(tie)).toBe(0xfafafa);
    cache.dispose();
  });
});

describe('roster polish: zenmai', () => {
  it('keeps the box head clear of the scarf so the slit mouth shows', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();
    const rig = build(defById('zenmai'), cache, gradient);
    rig.root.updateMatrixWorld(true);

    const head = geometryBounds(rig.root, 'head');
    const scarf = worldBounds(requiredObject(rig.root, 'default-scarf'));
    expect(head.min.y).toBeGreaterThanOrEqual(scarf.max.y + 0.02 - 1e-6);

    const mouth = worldPosition(requiredMesh(rig.root, 'mouth-slit'));
    expect(mouth.y).toBeGreaterThan(scarf.max.y + 0.05);
    expect(mouth.z).toBeLessThan(-0.2);
    cache.dispose();
  });
});


