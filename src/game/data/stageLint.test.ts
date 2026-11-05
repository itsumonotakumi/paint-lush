import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../core/types';
import stageJson from '../../data/stages/neon-town.json';
import { parseStage } from './load';
import { lintStage } from './stageLint';
import type { StageData } from './schemas';

const PLAYER_HALF: Vec3 = { x: 0.3, y: 0.8, z: 0.3 };

function freshStage(): StageData {
  return parseStage(structuredClone(stageJson));
}

function waypoint(stage: StageData, id: number): StageData['waypoints'][number] {
  const found = stage.waypoints.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`test stage has no waypoint ${id}`);
  return found;
}

function firstBox(stage: StageData): StageData['boxes'][number] {
  const found = stage.boxes[0];
  if (!found) throw new Error('test stage has no boxes');
  return found;
}

function has(problems: readonly string[], pattern: RegExp): boolean {
  return problems.some((problem) => pattern.test(problem));
}

describe('lintStage', () => {
  it('accepts the shipped neon-town stage', () => {
    expect(lintStage(freshStage(), PLAYER_HALF)).toEqual([]);
  });

  it('rejects a spawn that overlaps a box', () => {
    const stage = freshStage();
    stage.spawns[0][0] = { x: 0, y: 0.8, z: 0 };
    expect(has(lintStage(stage, PLAYER_HALF), /spawns\.0\.0: overlaps box/)).toBe(true);
  });

  it('rejects a spawn with no ground within three metres', () => {
    const stage = freshStage();
    stage.spawns[0][0] = { x: 0, y: 5, z: 17 };
    expect(has(lintStage(stage, PLAYER_HALF), /spawns\.0\.0: ground is more than 3 m below/)).toBe(
      true,
    );
  });

  it('rejects a team without a nearby spawn-tagged waypoint', () => {
    const stage = freshStage();
    stage.waypoints = stage.waypoints.map((entry) => ({
      ...entry,
      tags: entry.tags.filter((tag) => tag !== 'spawn0'),
    }));
    expect(has(lintStage(stage, PLAYER_HALF), /team 0 needs a spawn0 waypoint/)).toBe(true);
  });

  it('rejects a spawn-tagged waypoint farther than three metres from a spawn', () => {
    const stage = freshStage();
    waypoint(stage, 0).pos = { x: 0, y: 1, z: 10 };
    expect(has(lintStage(stage, PLAYER_HALF), /spawn0 waypoint within 3 m/)).toBe(true);
  });

  it('rejects a stage without a mid tag', () => {
    const stage = freshStage();
    stage.waypoints = stage.waypoints.map((entry) => ({
      ...entry,
      tags: entry.tags.filter((tag) => tag !== 'mid'),
    }));
    expect(has(lintStage(stage, PLAYER_HALF), /needs the mid tag/)).toBe(true);
  });

  it('rejects a one-way waypoint link', () => {
    const stage = freshStage();
    const target = waypoint(stage, 2);
    target.links = target.links.filter((link) => link !== 0);
    expect(has(lintStage(stage, PLAYER_HALF), /one-way link to 2/)).toBe(true);
  });

  it('rejects a disconnected waypoint graph', () => {
    const stage = freshStage();
    waypoint(stage, 9).links = waypoint(stage, 9).links.filter((link) => link !== 13);
    waypoint(stage, 13).links = [13];
    expect(has(lintStage(stage, PLAYER_HALF), /graph is not connected/)).toBe(true);
  });

  it('rejects a waypoint outside the bounds', () => {
    const stage = freshStage();
    waypoint(stage, 0).pos.x = stage.bounds.max.x + 1;
    expect(has(lintStage(stage, PLAYER_HALF), /waypoints\.0: outside bounds/)).toBe(true);
  });

  it('rejects a waypoint with no surface directly below', () => {
    const stage = freshStage();
    stage.boxes = [];
    expect(has(lintStage(stage, PLAYER_HALF), /no surface directly below/)).toBe(true);
  });

  it('rejects a waypoint outside the allowed height range', () => {
    const stage = freshStage();
    waypoint(stage, 0).pos.y = 3;
    expect(has(lintStage(stage, PLAYER_HALF), /0\.5 to 1\.5 m above a surface/)).toBe(true);
  });

  it('rejects a waypoint with too few links', () => {
    const stage = freshStage();
    waypoint(stage, 0).links = [];
    expect(has(lintStage(stage, PLAYER_HALF), /links must be 1 to 4/)).toBe(true);
  });

  it('rejects a waypoint with too many links', () => {
    const stage = freshStage();
    waypoint(stage, 0).links = [1, 2, 3, 4, 5];
    expect(has(lintStage(stage, PLAYER_HALF), /links must be 1 to 4/)).toBe(true);
  });

  it('rejects too few waypoints', () => {
    const stage = freshStage();
    stage.waypoints = stage.waypoints.slice(0, 15);
    expect(has(lintStage(stage, PLAYER_HALF), /count must be 16 to 40/)).toBe(true);
  });

  it('rejects too many waypoints', () => {
    const stage = freshStage();
    const extra: StageData['waypoints'] = Array.from({ length: 25 }, (_, index) => ({
      id: 100 + index,
      pos: { x: 0, y: 1, z: 17 },
      links: [2],
      tags: [],
    }));
    stage.waypoints = [...stage.waypoints, ...extra];
    expect(has(lintStage(stage, PLAYER_HALF), /count must be 16 to 40/)).toBe(true);
  });

  it('rejects a stage with more than 120 boxes', () => {
    const stage = freshStage();
    const baseBox = firstBox(stage);
    stage.boxes = [...stage.boxes, ...Array.from({ length: 87 }, () => baseBox)];
    expect(stage.boxes.length).toBeGreaterThan(120);
    expect(has(lintStage(stage, PLAYER_HALF), /count must be at most 120/)).toBe(true);
  });

  it('rejects a stage that is not point symmetric in x and z', () => {
    const stage = freshStage();
    firstBox(stage).box.max.x += 1;
    expect(has(lintStage(stage, PLAYER_HALF), /not point symmetric/)).toBe(true);
  });
});
