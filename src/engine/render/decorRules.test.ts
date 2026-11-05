import { describe, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial, MeshToonMaterial, Scene } from 'three';
import type { BufferGeometry, Material } from 'three';
import type { WorldSnapshot } from '../../core/snapshot';
import decorJson from '../../data/stages/neon-town.decor.json';
import stageJson from '../../data/stages/neon-town.json';
import { parseStage } from '../../game/data/load';
import type { StageData } from '../../game/data/schemas';
import { PALETTE } from './palette';
import { createToonGradient } from './toon';
import { buildDecorPlan, createDecor, parseDecor } from './decor';
import type { DecorAabb, DecorData, DecorItem, DecorKind } from './decor';

const stage: StageData = parseStage(stageJson);
const decor: DecorData = parseDecor(decorJson);
const PALETTE_VALUES = new Set<number>(Object.values(PALETTE));
const EPS = 1e-6;
const SNAPSHOT: WorldSnapshot = {
  tick: 0,
  players: [],
  projectiles: [],
  counts: [0, 0],
};

function countKinds(items: readonly DecorItem[]): Map<DecorKind, number> {
  const counts = new Map<DecorKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return counts;
}

function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax - EPS && aMax > bMin + EPS;
}

/** Largest horizontal distance an item extends outward from a box face it touches. */
function maxProtrusion(item: DecorAabb, box: DecorAabb): number {
  const attach = 0.1;
  let max = 0;
  const yOverlap = overlap1d(item.min.y, item.max.y, box.min.y, box.max.y);
  const xOverlap = overlap1d(item.min.x, item.max.x, box.min.x, box.max.x);
  const zOverlap = overlap1d(item.min.z, item.max.z, box.min.z, box.max.z);

  if (
    yOverlap &&
    zOverlap &&
    item.min.x >= box.max.x - EPS &&
    item.min.x <= box.max.x + attach
  ) {
    max = Math.max(max, item.max.x - box.max.x);
  }
  if (
    yOverlap &&
    zOverlap &&
    item.max.x <= box.min.x + EPS &&
    item.max.x >= box.min.x - attach
  ) {
    max = Math.max(max, box.min.x - item.min.x);
  }
  if (
    yOverlap &&
    xOverlap &&
    item.min.z >= box.max.z - EPS &&
    item.min.z <= box.max.z + attach
  ) {
    max = Math.max(max, item.max.z - box.max.z);
  }
  if (
    yOverlap &&
    xOverlap &&
    item.max.z <= box.min.z + EPS &&
    item.max.z >= box.min.z - attach
  ) {
    max = Math.max(max, box.min.z - item.min.z);
  }

  return max;
}

function overlapsStrict(a: DecorAabb, b: DecorAabb): boolean {
  return (
    overlap1d(a.min.x, a.max.x, b.min.x, b.max.x) &&
    overlap1d(a.min.y, a.max.y, b.min.y, b.max.y) &&
    overlap1d(a.min.z, a.max.z, b.min.z, b.max.z)
  );
}

/** Rule D exemption only covers items that are fully outside the |x|/|z| bounds. */
function insideHorizontalBounds(item: DecorAabb, bounds: DecorAabb): boolean {
  return (
    item.max.x > bounds.min.x + EPS &&
    item.min.x < bounds.max.x - EPS &&
    item.max.z > bounds.min.z + EPS &&
    item.min.z < bounds.max.z - EPS
  );
}

function boxOf(entry: StageData['boxes'][number]): DecorAabb {
  return {
    min: {
      x: Math.min(entry.box.min.x, entry.box.max.x),
      y: Math.min(entry.box.min.y, entry.box.max.y),
      z: Math.min(entry.box.min.z, entry.box.max.z),
    },
    max: {
      x: Math.max(entry.box.min.x, entry.box.max.x),
      y: Math.max(entry.box.min.y, entry.box.max.y),
      z: Math.max(entry.box.min.z, entry.box.max.z),
    },
  };
}

function geometryTriangles(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  return geometry.getAttribute('position').count / 3;
}

function materialOf(mesh: Mesh): Material | null {
  const material = mesh.material;
  return Array.isArray(material) ? (material[0] ?? null) : material;
}

describe('parseDecor', () => {
  it('accepts the shipped neon-town decoration file', () => {
    expect(decor.theme).toBe('sunset-castle');
    expect(decor.lantern.spacing).toBe(2.5);
    expect(decor.cloud.count).toBe(8);
  });

  it('rejects unknown keys at every level', () => {
    expect(() => parseDecor({ ...decorJson, mystery: true })).toThrow();
    expect(() =>
      parseDecor({ ...decorJson, cloud: { ...decorJson.cloud, mystery: 1 } }),
    ).toThrow();
    expect(() =>
      parseDecor({ ...decorJson, lantern: { ...decorJson.lantern, extra: 0 } }),
    ).toThrow();
  });

  it('rejects wrong value types and non-positive sizes', () => {
    expect(() => parseDecor({ ...decorJson, seed: 'soon' })).toThrow();
    expect(() => parseDecor({ ...decorJson, theme: 'neon-night' })).toThrow();
    expect(() =>
      parseDecor({ ...decorJson, cloud: { ...decorJson.cloud, minRadius: 0 } }),
    ).toThrow();
    expect(() => parseDecor(null)).toThrow();
    expect(() => parseDecor([])).toThrow();
  });
});

describe('decor placement counts', () => {
  it('places the required background, lantern and banner counts', () => {
    const counts = countKinds(buildDecorPlan(stage, decor, false));

    expect(counts.get('roof')).toBe(4);
    expect(counts.get('lantern')).toBe(64);
    expect(counts.get('lanternCap')).toBe(128);
    expect(counts.get('lanternGlow')).toBe(64);
    expect(counts.get('lanternBracket')).toBe(64);
    expect(counts.get('banner')).toBe(16);
    expect(counts.get('bannerPattern')).toBe(27);
    expect(counts.get('treeTrunk')).toBe(12);
    expect(counts.get('treeLeaf')).toBe(36);
    expect(counts.get('mountain')).toBe(5);
    expect(counts.get('castleBody')).toBe(2);
    expect(counts.get('castleRoof')).toBe(2);
    expect(counts.get('cloud')).toBe(8);
    expect(counts.get('eave')).toBeGreaterThan(0);
    expect(counts.get('beam')).toBeGreaterThan(0);
  });

  it('halves lantern density but keeps the skyline when lowDetail is on', () => {
    const counts = countKinds(buildDecorPlan(stage, decor, true));

    expect(counts.get('lantern')).toBe(32);
    expect(counts.get('lanternCap')).toBe(64);
    expect(counts.get('lanternGlow')).toBe(32);
    expect(counts.get('lanternBracket')).toBe(32);
    expect(counts.get('banner')).toBe(16);
    expect(counts.get('treeTrunk')).toBe(12);
    expect(counts.get('mountain')).toBe(5);
    expect(counts.get('cloud')).toBe(8);
  });

  it('gives every box at least 1 m tall at least one eave and keeps 3-5 cloud puffs', () => {
    const items = buildDecorPlan(stage, decor, false);

    let tallBoxes = 0;
    for (const entry of stage.boxes) {
      const box = boxOf(entry);
      const height = box.max.y - box.min.y;
      if (height < 1 - 1e-9) continue;
      tallBoxes += 1;
      const boxHasEave = items.some((item) => {
        if (item.kind !== 'eave') return false;
        if (Math.abs(item.aabb.max.y - box.max.y) > 1e-6) return false;
        const protrusion = maxProtrusion(item.aabb, box);
        return protrusion > 0 && protrusion <= 0.1 + 1e-5;
      });
      expect(boxHasEave).toBe(true);
    }
    expect(tallBoxes).toBeGreaterThan(0);

    const clouds = items.filter((item) => item.kind === 'cloud');
    for (const cloud of clouds) {
      expect(cloud.shape.type).toBe('cluster');
      if (cloud.shape.type !== 'cluster') continue;
      expect(cloud.shape.spheres.length).toBeGreaterThanOrEqual(3);
      expect(cloud.shape.spheres.length).toBeLessThanOrEqual(5);
    }
  });

  it('uses only palette colours', () => {
    for (const item of buildDecorPlan(stage, decor, false)) {
      expect(PALETTE_VALUES.has(item.color)).toBe(true);
    }
  });

  it('builds a tiered castle keep beyond the north wall', () => {
    const items = buildDecorPlan(stage, decor, false);
    const tiers = items.filter((item) => item.kind === 'castleTier');
    const roofs = items.filter((item) => item.kind === 'castleRoof');
    const bodies = items.filter((item) => item.kind === 'castleBody');
    const ornaments = items.filter((item) => item.kind === 'castleOrnament');

    expect(tiers).toHaveLength(3);
    expect(tiers.map((tier) => (tier.shape.type === 'box' ? tier.shape.size.x : 0))).toEqual([
      7, 5, 3.4,
    ]);
    expect(roofs).toHaveLength(2);
    for (const roof of roofs) {
      expect(roof.shape.type).toBe('cone');
      if (roof.shape.type !== 'cone') continue;
      expect(roof.shape.segments).toBe(4);
      expect(roof.shape.height).toBeCloseTo(1.1, 6);
      expect(roof.color).toBe(PALETTE.roof);
    }
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.renderColor).toBe(0xb8a98f);
    expect(ornaments.length).toBeGreaterThan(0);
    for (const ornament of ornaments) expect(ornament.color).toBe(PALETTE.signYellow);

    const bounds = boxOf({ box: stage.bounds, paintable: [] });
    for (const item of [...tiers, ...roofs, ...bodies, ...ornaments]) {
      expect(item.aabb.max.z).toBeLessThan(bounds.min.z);
    }
  });

  it('rings the arena with tall gabled houses outside the bounds', () => {
    const items = buildDecorPlan(stage, decor, false);
    const walls = items.filter((item) => item.kind === 'houseWall');
    const roofs = items.filter((item) => item.kind === 'houseRoof');
    const bounds = boxOf({ box: stage.bounds, paintable: [] });

    expect(walls.length).toBeGreaterThanOrEqual(32);
    expect(walls.length).toBeLessThanOrEqual(40);
    expect(roofs).toHaveLength(walls.length);

    for (const wall of walls) {
      expect(insideHorizontalBounds(wall.aabb, bounds)).toBe(false);
      const widthX = wall.aabb.max.x - wall.aabb.min.x;
      const widthZ = wall.aabb.max.z - wall.aabb.min.z;
      expect(Math.min(widthX, widthZ)).toBeGreaterThanOrEqual(3 - EPS);
      expect(Math.max(widthX, widthZ)).toBeLessThanOrEqual(5 + EPS);
    }

    for (const roof of roofs) {
      expect(roof.shape.type).toBe('gable');
      expect(roof.aabb.max.y).toBeGreaterThanOrEqual(7 - EPS);
      expect(roof.aabb.max.y).toBeLessThanOrEqual(9 + EPS);
    }
  });

  it('panels raised shops with doors and windows and skirts the walls', () => {
    const items = buildDecorPlan(stage, decor, false);
    const doors = items.filter((item) => item.kind === 'shopDoor');
    const windows = items.filter((item) => item.kind === 'shopWindow');
    const skirts = items.filter((item) => item.kind === 'wallSkirt');
    const rails = items.filter((item) => item.kind === 'wallRail');

    expect(doors.length).toBeGreaterThan(0);
    expect(windows.length).toBeGreaterThanOrEqual(doors.length * 2);
    expect(skirts).toHaveLength(4);
    expect(rails).toHaveLength(4);

    for (const panel of [...doors, ...windows]) {
      const widthX = panel.aabb.max.x - panel.aabb.min.x;
      const widthZ = panel.aabb.max.z - panel.aabb.min.z;
      expect(Math.min(widthX, widthZ)).toBeCloseTo(0.04, 6);
    }
    for (const skirt of skirts) expect(skirt.renderColor).toBe(0xb8a98f);
    for (const rail of rails) expect(rail.color).toBe(PALETTE.timber);
  });
});

describe('collision-friendly decoration rules', () => {
  const items = buildDecorPlan(stage, decor, false);
  const bounds = boxOf({
    box: stage.bounds,
    paintable: [],
  });

  it('never protrudes over 0.10 m unless it is above jump reach (A, B, D)', () => {
    for (const item of items) {
      if (!insideHorizontalBounds(item.aabb, bounds)) continue;

      let protrusion = 0;
      for (const entry of stage.boxes) {
        protrusion = Math.max(protrusion, maxProtrusion(item.aabb, boxOf(entry)));
      }

      if (protrusion > 0.1 + 1e-5) {
        expect(item.aabb.min.y).toBeGreaterThanOrEqual(2.6);
      }
      if (item.aabb.min.y < 2.6) {
        expect(protrusion).toBeLessThanOrEqual(0.1 + 1e-5);
      }
    }
  });

  it('never puts anything on a walkable +y paintable top (C)', () => {
    for (const item of items) {
      if (!insideHorizontalBounds(item.aabb, bounds)) continue;
      for (const entry of stage.boxes) {
        if (!entry.paintable.includes('+y')) continue;
        const box = boxOf(entry);
        const topSlab: DecorAabb = {
          min: { x: box.min.x, y: box.max.y - 0.02, z: box.min.z },
          max: { x: box.max.x, y: box.max.y + 0.02, z: box.max.z },
        };
        expect(overlapsStrict(item.aabb, topSlab)).toBe(false);
      }
    }
  });

  it('keeps every decoration out of the collision volumes below jump height', () => {
    for (const item of items) {
      if (!insideHorizontalBounds(item.aabb, bounds)) continue;
      if (item.aabb.min.y >= 2.6) continue;
      for (const entry of stage.boxes) {
        expect(overlapsStrict(item.aabb, boxOf(entry))).toBe(false);
      }
    }
  });
});

describe('createDecor module', () => {
  function makeModule(lowDetail: boolean): { scene: Scene; gradient: ReturnType<typeof createToonGradient>; module: ReturnType<typeof createDecor> } {
    const scene = new Scene();
    const gradient = createToonGradient();
    const module = createDecor({
      scene,
      teamColors: [0xff3fa4, 0x2df3d2],
      gradient,
      localPlayerId: 0,
      lowDetail,
      stage,
      decor,
    });
    return { scene, gradient, module };
  }

  it('merges static decor into at most 10 draw calls and stays under 80000 triangles', () => {
    const { scene, gradient, module } = makeModule(false);

    let staticMeshes = 0;
    let triangles = 0;
    const meshes: Mesh[] = [];
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      meshes.push(object);
      triangles += geometryTriangles(object.geometry);
      if (object.userData.decorStatic === true) staticMeshes += 1;
    });

    expect(staticMeshes).toBeGreaterThan(0);
    expect(staticMeshes).toBeLessThanOrEqual(10);
    expect(triangles).toBeLessThanOrEqual(80000);
    expect(triangles).toBeGreaterThan(0);

    const basicMaterials = meshes
      .map(materialOf)
      .filter((material): material is MeshBasicMaterial => material instanceof MeshBasicMaterial);
    expect(basicMaterials.length).toBeGreaterThan(0);
    for (const material of basicMaterials) expect(material.toneMapped).toBe(false);

    const toonMaterials = meshes
      .map(materialOf)
      .filter((material): material is MeshToonMaterial => material instanceof MeshToonMaterial);
    expect(toonMaterials.length).toBeGreaterThan(0);
    expect(
      basicMaterials.some((material) => material.color.getHex() === PALETTE.lantern),
    ).toBe(true);

    module.dispose();
    gradient.dispose();
  });

  it('drifts clouds +x at 0.3 m/s and freezes them when lowDetail is on', () => {
    const normal = makeModule(false);
    const clouds = normal.scene.children.filter(
      (child): child is Mesh => child instanceof Mesh && child.userData.decorStatic === false,
    );
    expect(clouds.length).toBe(8);
    const cloud = clouds[0];
    if (!cloud) throw new Error('missing cloud');
    const before = cloud.position.x;
    normal.module.update(0.5, SNAPSHOT, SNAPSHOT, 0);
    const moved = cloud.position.x - before;
    expect(moved).toBeCloseTo(moved < 0 ? 0.15 - 120 : 0.15, 6);
    normal.module.dispose();
    normal.gradient.dispose();

    const low = makeModule(true);
    const lowClouds = low.scene.children.filter(
      (child): child is Mesh => child instanceof Mesh && child.userData.decorStatic === false,
    );
    const lowCloud = lowClouds[0];
    if (!lowCloud) throw new Error('missing low-detail cloud');
    const lowBefore = lowCloud.position.x;
    low.module.update(0.5, SNAPSHOT, SNAPSHOT, 0);
    expect(lowCloud.position.x).toBe(lowBefore);
    low.module.dispose();
    low.gradient.dispose();
  });

  it('frees its own GPU resources but not the shared gradient', () => {
    const { scene, gradient, module } = makeModule(false);
    const spy = vi.spyOn(gradient, 'dispose');

    module.dispose();
    module.dispose();
    expect(scene.children).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
    gradient.dispose();
  });
});
