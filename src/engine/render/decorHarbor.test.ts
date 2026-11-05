import { Group, Mesh, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import type { WorldSnapshot } from '../../core/snapshot';
import decorJson from '../../data/stages/karakuri-port.decor.json';
import stageJson from '../../data/stages/karakuri-port.json';
import { parseStage } from '../../game/data/load';
import type { StageData } from '../../game/data/schemas';
import { buildDecorPlan, createDecor, parseDecor } from './decor';
import type { DecorAabb } from './decor';
import { PALETTE } from './palette';
import { createToonGradient } from './toon';

const stage: StageData = parseStage(stageJson);
const decor = parseDecor(decorJson);
const SNAPSHOT: WorldSnapshot = {
  tick: 0,
  players: [],
  projectiles: [],
  bombs: [],
  phase: 'play',
  timeLeft: 60,
  counts: [0, 0],
};
const EPS = 1e-6;

function bounds(): DecorAabb {
  return {
    min: {
      x: Math.min(stage.bounds.min.x, stage.bounds.max.x),
      y: Math.min(stage.bounds.min.y, stage.bounds.max.y),
      z: Math.min(stage.bounds.min.z, stage.bounds.max.z),
    },
    max: {
      x: Math.max(stage.bounds.min.x, stage.bounds.max.x),
      y: Math.max(stage.bounds.min.y, stage.bounds.max.y),
      z: Math.max(stage.bounds.min.z, stage.bounds.max.z),
    },
  };
}

function insideHorizontal(item: DecorAabb, box: DecorAabb): boolean {
  return (
    item.max.x > box.min.x + EPS &&
    item.min.x < box.max.x - EPS &&
    item.max.z > box.min.z + EPS &&
    item.min.z < box.max.z - EPS
  );
}

describe('harbour decoration', () => {
  it('parses the shipped harbour file and rejects a missing crane', () => {
    expect(decor.theme).toBe('harbor');
    const { crane, ...withoutCrane } = decorJson;
    expect(crane.count).toBe(2);
    expect(() => parseDecor(withoutCrane)).toThrow();
    expect(() => parseDecor({ ...decorJson, theme: 'sunset-castle' })).toThrow();
  });

  it('places two cranes at x +-14, z -30 and sea planes outside the walls', () => {
    const items = buildDecorPlan(stage, decor, false);
    const towers = items.filter((item) => item.kind === 'craneTower');
    const jibs = items.filter((item) => item.kind === 'craneJib');
    const hooks = items.filter((item) => item.kind === 'craneHook');
    const sea = items.filter((item) => item.kind === 'seaPlane');

    expect(towers.length).toBeGreaterThan(0);
    expect(jibs).toHaveLength(6);
    expect(hooks).toHaveLength(2);
    expect(sea).toHaveLength(16);

    const box = bounds();
    for (const item of [...towers, ...jibs, ...hooks]) {
      expect(item.aabb.max.z).toBeLessThan(box.min.z);
      expect(insideHorizontal(item.aabb, box)).toBe(false);
    }
    for (const item of sea) expect(insideHorizontal(item.aabb, box)).toBe(false);

    const pivots = new Set(
      jibs.map((item) => `${item.offset.x.toFixed(2)}|${item.offset.z.toFixed(2)}`),
    );
    expect(pivots).toEqual(new Set(['-14.00|-30.00', '14.00|-30.00']));
  });

  it('uses the exact crane and sea hues while keeping palette slots', () => {
    const items = buildDecorPlan(stage, decor, false);
    const orange = items.filter((item) => item.kind === 'craneTower' || item.kind === 'craneHook');
    const yellow = items.filter(
      (item) => item.kind === 'craneJib' && item.renderColor === 0xf2c14e,
    );
    const counterweight = items.filter(
      (item) => item.kind === 'craneJib' && item.renderColor === 0xe8743b,
    );
    const sea = items.filter((item) => item.kind === 'seaPlane');

    expect(yellow.length).toBeGreaterThan(0);
    expect(counterweight.length).toBeGreaterThan(0);
    for (const item of orange) {
      expect(item.renderColor).toBe(0xe8743b);
      expect(item.color).toBe(PALETTE.harborOrange);
    }
    for (const item of yellow) {
      expect(item.renderColor).toBe(0xf2c14e);
      expect(item.color).toBe(PALETTE.harborYellow);
    }
    for (const item of sea) {
      expect(item.renderColor).toBe(0x4fc3d9);
      expect(item.color).toBe(PALETTE.sea);
    }
  });

  it('sways the jib groups around their pivots and freezes nothing else', () => {
    const scene = new Scene();
    const gradient = createToonGradient();
    const module = createDecor({
      scene,
      teamColors: [0xff2e88, 0x19e6d0],
      gradient,
      localPlayerId: 0,
      lowDetail: false,
      stage,
      decor,
    });

    const groups = scene.children.filter((child): child is Group => child instanceof Group);
    expect(groups).toHaveLength(2);
    for (const group of groups) expect(Math.abs(group.position.z + 30)).toBeLessThan(1e-6);

    const before = groups.map((group) => group.rotation.y);
    module.update(0.5, SNAPSHOT, SNAPSHOT, 0);
    const after = groups.map((group) => group.rotation.y);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(Math.abs((after[0] ?? 0) - (before[0] ?? 0))).toBeLessThan(0.06 + 1e-6);

    for (const group of groups) {
      for (const child of group.children) expect(child).toBeInstanceOf(Mesh);
    }

    module.dispose();
    gradient.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
