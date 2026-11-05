import { describe, expect, it } from 'vitest';
import { boxAround, boxOverlap } from '../../core/math/aabb';
import type { Box, Face, Vec3 } from '../../core/types';
import aiJson from '../../data/ai.json';
import matchJson from '../../data/match.json';
import playerJson from '../../data/player.json';
import specialsJson from '../../data/specials.json';
import stageJson from '../../data/stages/neon-town.json';
import subsJson from '../../data/subs.json';
import weaponsJson from '../../data/weapons.json';
import {
  parseAi,
  parseMatchConfig,
  parsePlayerConfig,
  parseSpecial,
  parseStage,
  parseSub,
  parseWeapons,
} from './load';
import type { StageData } from './schemas';

const PLAYER_HALF: Vec3 = { x: 0.3, y: 0.8, z: 0.3 };

/* ---------- helpers ---------- */

function num(value: number): string {
  return String(value === 0 ? 0 : value);
}

function pointKey(point: Vec3): string {
  return `${num(point.x)},${num(point.y)},${num(point.z)}`;
}

function mirrorPoint(point: Vec3): Vec3 {
  return { x: -point.x, y: point.y, z: -point.z };
}

function boxKey(box: Box): string {
  return `${pointKey(box.min)}|${pointKey(box.max)}`;
}

function mirrorBox(box: Box): Box {
  return {
    min: { x: -box.max.x, y: box.min.y, z: -box.max.z },
    max: { x: -box.min.x, y: box.max.y, z: -box.min.z },
  };
}

type Axis = 'x' | 'y' | 'z';

function faceAxis(face: Face): Axis {
  if (face === '+x' || face === '-x') return 'x';
  if (face === '+y' || face === '-y') return 'y';
  return 'z';
}

/** Faces are mirrored through the same XZ point reflection as the boxes. */
function mirrorFace(face: Face): Face {
  switch (face) {
    case '+x':
      return '-x';
    case '-x':
      return '+x';
    case '+y':
      return '+y';
    case '-y':
      return '-y';
    case '+z':
      return '-z';
    case '-z':
      return '+z';
  }
}

/** True when another box sits flush against the whole face and hides it. */
function isFaceCovered(boxes: readonly Box[], index: number, face: Face): boolean {
  const source = boxes[index];
  if (!source) return false;
  const axis = faceAxis(face);
  const outward = face[0] === '+' ? 1 : -1;
  const plane = outward > 0 ? source.max[axis] : source.min[axis];
  const u: Axis = axis === 'x' ? 'y' : 'x';
  const v: Axis = axis === 'z' ? 'y' : 'z';
  const eps = 1e-9;

  return boxes.some((other, otherIndex) => {
    if (otherIndex === index) return false;
    const near = outward > 0 ? other.min[axis] : other.max[axis];
    const far = outward > 0 ? other.max[axis] : other.min[axis];
    const reaches = outward > 0 ? near <= plane + eps : near >= plane - eps;
    const extendsOutward = outward > 0 ? far > plane + eps : far < plane - eps;
    if (!reaches || !extendsOutward) return false;
    return (
      other.min[u] <= source.min[u] + eps &&
      other.max[u] >= source.max[u] - eps &&
      other.min[v] <= source.min[v] + eps &&
      other.max[v] >= source.max[v] - eps
    );
  });
}

function edgeKey(a: number, b: number): string {
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

function firstSpawn(stage: StageData): Vec3 {
  const spawn = stage.spawns[0][0];
  if (!spawn) throw new Error('test data has no spawn');
  return spawn;
}

function hasGround(boxes: readonly Box[], spawn: Vec3, half: Vec3): boolean {
  const foot = spawn.y - half.y;
  return boxes.some(
    (box) =>
      box.max.y === foot &&
      box.min.x <= spawn.x - half.x &&
      box.max.x >= spawn.x + half.x &&
      box.min.z <= spawn.z - half.z &&
      box.max.z >= spawn.z + half.z,
  );
}

function surfaceBelow(boxes: readonly Box[], point: Vec3): number | null {
  let best: number | null = null;
  for (const box of boxes) {
    if (point.x < box.min.x || point.x > box.max.x) continue;
    if (point.z < box.min.z || point.z > box.max.z) continue;
    if (box.max.y > point.y) continue;
    if (best === null || box.max.y > best) best = box.max.y;
  }
  return best;
}

/* ---------- valid data ---------- */

describe('shipped data', () => {
  it('parses the player tuning constants exactly', () => {
    const player = parsePlayerConfig(playerJson);

    expect(player).toEqual({
      halfExtents: { x: 0.3, y: 0.8, z: 0.3 },
      gravity: 20,
      walkSpeed: 6,
      diveSpeed: 9.5,
      enemyInkSpeed: 2.5,
      airControl: 0.5,
      acceleration: 40,
      jumpSpeed: 6.5,
      wallClimbSpeed: 4,
      maxHp: 100,
      enemyInkDps: 4,
      enemyInkMinHp: 10,
      diveHealPerSec: 15,
      respawnSeconds: 5,
      respawnInvulnSeconds: 1.5,
      maxInk: 100,
      inkRegenDive: 30,
      inkRegenIdle: 4,
      diveTransitionSeconds: 0.1,
      fireLockAfterDiveSeconds: 0.1,
    });
  });

  it('parses the weapon catalogue', () => {
    const weapons = parseWeapons(weaponsJson);

    expect(weapons).toEqual([
      {
        id: 'iro-shuriken',
        name: '彩手裏剣',
        kind: 'projectile',
        specialGainPerCell: 1,
        intervalSeconds: 0.125,
        inkCost: 0.9,
        damage: 28,
        muzzleSpeed: 22,
        projectileGravity: 12,
        spreadRadians: 0.03,
        paintRadius: 0.5,
        trailSpacing: 0.5,
        trailRadius: 0.3,
        lifetimeSeconds: 3,
      },
      {
        id: 'oofude',
        name: '大筆',
        kind: 'brush',
        specialGainPerCell: 0.8,
        rollInkPerSec: 6,
        rollWidth: 1.6,
        rollSpacing: 0.25,
        rollSpeedMultiplier: 0.75,
        rollDamage: 40,
        swingIntervalSeconds: 0.5,
        swingReach: 2.4,
        swingArcRadians: 1.2,
        swingDamage: 100,
        swingPaintRadius: 1.2,
        swingInkCost: 8,
      },
      {
        id: 'naga-fukiya',
        name: '長吹き矢',
        kind: 'charge',
        specialGainPerCell: 0.8,
        fullChargeSeconds: 1,
        minChargeFraction: 0.25,
        rangeMin: 8,
        rangeFull: 26,
        damageMin: 40,
        damageFull: 100,
        lineRadius: 0.45,
        lineSpacing: 0.4,
        inkCostFull: 18,
        chargeMoveMultiplier: 0.5,
      },
    ]);
  });

  it('parses the neon-town stage', () => {
    const stage = parseStage(stageJson);

    expect(stage.id).toBe('neon-town');
    expect(stage.cellSize).toBe(0.125);
    expect(stage.spawns[0]).toHaveLength(4);
    expect(stage.spawns[1]).toHaveLength(4);
    expect(stage.waypoints.length).toBeGreaterThanOrEqual(16);
    expect(stage.boxes.length).toBeLessThanOrEqual(120);
    expect(stage.bgm).toBe('battle');
    expect(stage.waypoints.every((waypoint) => Array.isArray(waypoint.tags))).toBe(true);
  });

  it('parses the sub weapon definition', () => {
    expect(parseSub(subsJson)).toEqual({
      id: 'saien-dama',
      name: '彩煙玉',
      kind: 'smokeBomb',
      inkCost: 40,
      throwSpeed: 14,
      throwPitchRadians: 0.6,
      gravity: 20,
      restitution: 0.3,
      fuseSeconds: 1.2,
      blastRadius: 2.2,
      damage: 60,
      cooldownSeconds: 1,
      lifetimeSeconds: 4,
    });
  });

  it('parses the special weapon definition', () => {
    expect(parseSpecial(specialsJson)).toEqual({
      id: 'hyakka-ryoran',
      name: '奥義・百花繚乱',
      kind: 'hyakka',
      gaugeMax: 6000,
      durationSeconds: 8,
      fireRateMultiplier: 1.6,
      paintRadiusMultiplier: 1.5,
      inkCostMultiplier: 0.5,
      bgmId: 'special',
    });
  });

  it('parses the AI profiles', () => {
    expect(parseAi(aiJson)).toEqual({
      easy: {
        reactionSeconds: 0.6,
        aimJitterRadians: 0.12,
        decisionIntervalSeconds: 0.5,
        engageRange: 8,
        weights: { paint: 1, chase: 0.5, support: 0.3, retreat: 0.6 },
        specialUse: false,
      },
      normal: {
        reactionSeconds: 0.35,
        aimJitterRadians: 0.06,
        decisionIntervalSeconds: 0.25,
        engageRange: 12,
        weights: { paint: 1, chase: 0.8, support: 0.5, retreat: 0.7 },
        specialUse: true,
      },
      hard: {
        reactionSeconds: 0.18,
        aimJitterRadians: 0.02,
        decisionIntervalSeconds: 0.2,
        engageRange: 13,
        weights: { paint: 1, chase: 0.9, support: 0.7, retreat: 0.8 },
        specialUse: true,
      },
    });
  });

  it('parses the match configuration', () => {
    expect(parseMatchConfig(matchJson)).toEqual({
      durationSeconds: 180,
      preSeconds: 3,
      lastMinuteAt: 60,
      countdownAt: 10,
      settleSeconds: 0.5,
      teamSize: 4,
    });
  });
});

/* ---------- rejected data ---------- */

describe('loader rejections', () => {
  const player = parsePlayerConfig(playerJson);
  const stage = parseStage(stageJson);
  const [weapon] = parseWeapons(weaponsJson);
  if (!weapon) throw new Error('test data has no weapon');

  it('rejects an unknown player key', () => {
    expect(() => parsePlayerConfig({ ...player, extra: true })).toThrow(/extra/);
  });

  it('rejects an unknown weapon key', () => {
    expect(() => parseWeapons([{ ...weapon, extra: true }])).toThrow(/extra/);
  });

  it('rejects an unknown stage key', () => {
    expect(() => parseStage({ ...stage, extra: true })).toThrow(/extra/);
  });

  it('rejects an unknown nested key', () => {
    const bad = { ...stage, boxes: stage.boxes.map((entry) => ({ ...entry, surprise: 1 })) };
    expect(() => parseStage(bad)).toThrow(/surprise/);
  });

  it('rejects an unsupported weapon kind', () => {
    expect(() => parseWeapons([{ ...weapon, kind: 'melee' }])).toThrow(/weapons\.0\.kind/);
  });

  it('rejects non-positive numbers', () => {
    expect(() => parseWeapons([{ ...weapon, damage: 0 }])).toThrow(/weapons\.0\.damage/);
    expect(() => parsePlayerConfig({ ...player, gravity: 0 })).toThrow(/player\.gravity/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => parsePlayerConfig({ ...player, gravity: Number.NaN })).toThrow(/gravity/);
    expect(() => parsePlayerConfig({ ...player, walkSpeed: Number.POSITIVE_INFINITY })).toThrow(
      /walkSpeed/,
    );
  });

  it('rejects a non-object payload', () => {
    expect(() => parsePlayerConfig(null)).toThrow(/player/);
    expect(() => parseStage('not a stage')).toThrow(/stage/);
  });

  it('rejects an empty weapon list', () => {
    expect(() => parseWeapons([])).toThrow(/weapons/);
  });

  it('rejects a box whose min is not below its max', () => {
    const bad = structuredClone(stage);
    const entry = bad.boxes[0];
    if (!entry) throw new Error('test data has no box');
    entry.box.max.x = entry.box.min.x;
    expect(() => parseStage(bad)).toThrow(/boxes\.0\.box\.min\.x/);
  });

  it('rejects a non-positive cell size', () => {
    expect(() => parseStage({ ...stage, cellSize: 0 })).toThrow(/cellSize/);
    expect(() => parseStage({ ...stage, cellSize: -0.25 })).toThrow(/cellSize/);
  });

  it('rejects repeated or excessive paintable faces on a box', () => {
    const repeated = structuredClone(stage);
    const first = repeated.boxes[0];
    if (!first) throw new Error('test data has no box');
    first.paintable = ['+y', '+y'];
    expect(() => parseStage(repeated)).toThrow(/boxes\.0\.paintable: duplicate face \+y/);
  });

  it('rejects bounds whose min is not below their max', () => {
    const bad = structuredClone(stage);
    bad.bounds.max.z = bad.bounds.min.z;
    expect(() => parseStage(bad)).toThrow(/bounds\.min\.z/);
  });

  it('rejects a spawn outside the bounds', () => {
    const bad = structuredClone(stage);
    firstSpawn(bad).z = stage.bounds.max.z + 1;
    expect(() => parseStage(bad)).toThrow(/spawns\.0\.0: outside bounds/);
  });

  it('rejects a waypoint link to an unknown id', () => {
    const bad = structuredClone(stage);
    const waypoint = bad.waypoints[0];
    if (!waypoint) throw new Error('test data has no waypoint');
    waypoint.links.push(9999);
    expect(() => parseStage(bad)).toThrow(/waypoints\.0\.links\.1: unknown waypoint id 9999/);
  });

  it('rejects duplicate waypoint ids', () => {
    const bad = structuredClone(stage);
    const second = bad.waypoints[1];
    const first = bad.waypoints[0];
    if (!second || !first) throw new Error('test data has too few waypoints');
    second.id = first.id;
    expect(() => parseStage(bad)).toThrow(/waypoints\.1\.id: duplicate id/);
  });

  it('rejects a one-way waypoint link', () => {
    const bad = structuredClone(stage);
    const target = bad.waypoints.find((waypoint) => waypoint.id === 2);
    if (!target) throw new Error('test data has no waypoint 2');
    target.links = target.links.filter((link) => link !== 0);
    expect(() => parseStage(bad)).toThrow(/waypoints\.0\.links\.0: one-way link to 2/);
  });

  it('rejects an unknown sub key', () => {
    const sub = parseSub(subsJson);
    expect(() => parseSub({ ...sub, extra: true })).toThrow(/extra/);
  });

  it('rejects a sub with a non-finite number', () => {
    const sub = parseSub(subsJson);
    expect(() => parseSub({ ...sub, gravity: Number.POSITIVE_INFINITY })).toThrow(/sub\.gravity/);
    expect(() => parseSub({ ...sub, blastRadius: Number.NaN })).toThrow(/sub\.blastRadius/);
  });

  it('rejects an unknown special key', () => {
    const special = parseSpecial(specialsJson);
    expect(() => parseSpecial({ ...special, extra: true })).toThrow(/extra/);
  });

  it('rejects a non-positive special gauge', () => {
    const special = parseSpecial(specialsJson);
    expect(() => parseSpecial({ ...special, gaugeMax: 0 })).toThrow(/special\.gaugeMax/);
  });

  it('rejects an unknown AI key', () => {
    const ai = parseAi(aiJson);
    expect(() => parseAi({ ...ai, extra: true })).toThrow(/extra/);
  });

  it('rejects an AI profile with a negative weight', () => {
    const ai = structuredClone(parseAi(aiJson));
    ai.easy.weights.paint = -1;
    expect(() => parseAi(ai)).toThrow(/ai\.easy\.weights\.paint/);
  });

  it('rejects a missing AI difficulty', () => {
    expect(() => parseAi({ easy: parseAi(aiJson).easy })).toThrow(/ai\.normal/);
  });

  it('rejects an unknown match key', () => {
    const match = parseMatchConfig(matchJson);
    expect(() => parseMatchConfig({ ...match, extra: true })).toThrow(/extra/);
  });

  it('rejects an out-of-range match duration or team size', () => {
    const match = parseMatchConfig(matchJson);
    expect(() => parseMatchConfig({ ...match, durationSeconds: 30 })).toThrow(
      /match\.durationSeconds/,
    );
    expect(() => parseMatchConfig({ ...match, durationSeconds: 301 })).toThrow(
      /match\.durationSeconds/,
    );
    expect(() => parseMatchConfig({ ...match, teamSize: 5 })).toThrow(/match\.teamSize/);
    expect(() => parseMatchConfig({ ...match, teamSize: 0 })).toThrow(/match\.teamSize/);
  });

  it('rejects non-finite or non-positive match timings', () => {
    const match = parseMatchConfig(matchJson);
    expect(() => parseMatchConfig({ ...match, preSeconds: 0 })).toThrow(/match\.preSeconds/);
    expect(() => parseMatchConfig({ ...match, settleSeconds: Number.NaN })).toThrow(
      /match\.settleSeconds/,
    );
  });
});

/* ---------- stage fairness and navigation ---------- */

describe('neon-town stage', () => {
  const stage = parseStage(stageJson);
  const boxes: Box[] = stage.boxes.map((entry) => entry.box);

  it('is point symmetric about the vertical axis', () => {
    const keys = new Set(stage.boxes.map((entry) => boxKey(entry.box)));
    for (const entry of stage.boxes) {
      expect(keys.has(boxKey(mirrorBox(entry.box)))).toBe(true);
    }
  });

  it('mirrors the paintable faces of every box', () => {
    const byBox = new Map(stage.boxes.map((entry) => [boxKey(entry.box), entry]));
    for (const entry of stage.boxes) {
      const mirror = byBox.get(boxKey(mirrorBox(entry.box)));
      expect(mirror).toBeDefined();
      if (!mirror) continue;
      expect([...mirror.paintable].sort()).toEqual(entry.paintable.map(mirrorFace).sort());
    }
  });

  it('has no paintable face fully covered by another box', () => {
    const covered: string[] = [];
    for (const [index, entry] of stage.boxes.entries()) {
      for (const face of entry.paintable) {
        if (isFaceCovered(boxes, index, face)) covered.push(`${index}:${face}`);
      }
    }

    expect(covered).toEqual([]);
  });

  it('mirrors the two spawn sets', () => {
    const teamZero = new Set(stage.spawns[0].map(pointKey));
    const teamOne = new Set(stage.spawns[1].map(pointKey));

    expect(teamZero.size).toBe(teamOne.size);
    for (const spawn of stage.spawns[0]) {
      expect(teamOne.has(pointKey(mirrorPoint(spawn)))).toBe(true);
    }
  });

  it('mirrors the waypoints and their links', () => {
    const idByPos = new Map<string, number>();
    const posById = new Map<number, Vec3>();
    for (const waypoint of stage.waypoints) {
      idByPos.set(pointKey(waypoint.pos), waypoint.id);
      posById.set(waypoint.id, waypoint.pos);
    }

    const edges = new Set<string>();
    for (const waypoint of stage.waypoints) {
      for (const link of waypoint.links) edges.add(edgeKey(waypoint.id, link));
    }

    const mirrorId = (id: number): number | undefined => {
      const pos = posById.get(id);
      return pos ? idByPos.get(pointKey(mirrorPoint(pos))) : undefined;
    };

    for (const waypoint of stage.waypoints) {
      const reflectedSelf = mirrorId(waypoint.id);
      expect(reflectedSelf).toBeDefined();
      for (const link of waypoint.links) {
        const reflectedLink = mirrorId(link);
        expect(reflectedLink).toBeDefined();
        if (reflectedSelf === undefined || reflectedLink === undefined) continue;
        expect(edges.has(edgeKey(reflectedSelf, reflectedLink))).toBe(true);
      }
    }
  });

  it('keeps every spawn clear of boxes with ground directly beneath', () => {
    for (const team of stage.spawns) {
      for (const spawn of team) {
        const playerBox = boxAround(spawn, PLAYER_HALF);
        const overlapping = boxes.filter((box) => boxOverlap(playerBox, box));
        expect(overlapping).toHaveLength(0);
        expect(hasGround(boxes, spawn, PLAYER_HALF)).toBe(true);
      }
    }
  });

  it('keeps every spawn inside the bounds', () => {
    const { min, max } = stage.bounds;
    for (const team of stage.spawns) {
      for (const spawn of team) {
        expect(spawn.x).toBeGreaterThanOrEqual(min.x);
        expect(spawn.x).toBeLessThanOrEqual(max.x);
        expect(spawn.y).toBeGreaterThanOrEqual(min.y);
        expect(spawn.y).toBeLessThanOrEqual(max.y);
        expect(spawn.z).toBeGreaterThanOrEqual(min.z);
        expect(spawn.z).toBeLessThanOrEqual(max.z);
      }
    }
  });

  it('stays within the box budget', () => {
    expect(stage.boxes.length).toBeGreaterThan(0);
    expect(stage.boxes.length).toBeLessThanOrEqual(80);
  });

  it('has only bidirectional waypoint links', () => {
    const byId = new Map(stage.waypoints.map((waypoint) => [waypoint.id, waypoint]));
    for (const waypoint of stage.waypoints) {
      for (const link of waypoint.links) {
        const target = byId.get(link);
        expect(target).toBeDefined();
        expect(target?.links).toContain(waypoint.id);
      }
    }
  });

  it('has a connected waypoint graph', () => {
    const byId = new Map(stage.waypoints.map((waypoint) => [waypoint.id, waypoint]));
    const start = stage.waypoints[0];
    if (!start) throw new Error('stage has no waypoints');

    const seen = new Set<number>();
    const queue: number[] = [start.id];
    while (queue.length > 0) {
      const id = queue.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const node = byId.get(id);
      if (!node) continue;
      for (const link of node.links) {
        if (!seen.has(link)) queue.push(link);
      }
    }

    expect(seen.size).toBe(stage.waypoints.length);
  });

  it('places every waypoint one metre above a walkable top', () => {
    for (const waypoint of stage.waypoints) {
      const top = surfaceBelow(boxes, waypoint.pos);
      expect(top).not.toBeNull();
      if (top === null) continue;
      expect(waypoint.pos.y - top).toBeCloseTo(1, 10);
    }
  });
});
