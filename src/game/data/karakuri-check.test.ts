import { describe, expect, it } from 'vitest';
import { boxAround, boxOverlap } from '../../core/math/aabb';
import type { Box, Face, Vec3 } from '../../core/types';
import decorJson from '../../data/stages/karakuri-port.decor.json';
import stageJson from '../../data/stages/karakuri-port.json';
import { parseStage } from './load';
import type { StageData } from './schemas';
import { lintStage } from './stageLint';

const stage: StageData = parseStage(stageJson);
const boxes: Box[] = stage.boxes.map((entry) => entry.box);
const PLAYER_HALF: Vec3 = { x: 0.3, y: 0.8, z: 0.3 };
const EPS = 1e-6;

type Axis = 'x' | 'y' | 'z';

function pointKey(point: Vec3): string {
  return `${point.x},${point.y},${point.z}`;
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

function faceAxis(face: Face): Axis {
  if (face === '+x' || face === '-x') return 'x';
  if (face === '+y' || face === '-y') return 'y';
  return 'z';
}

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
function isFaceCovered(list: readonly Box[], index: number, face: Face): boolean {
  const source = list[index];
  if (!source) return false;
  const axis = faceAxis(face);
  const outward = face[0] === '+' ? 1 : -1;
  const plane = outward > 0 ? source.max[axis] : source.min[axis];
  const u: Axis = axis === 'x' ? 'y' : 'x';
  const v: Axis = axis === 'z' ? 'y' : 'z';

  return list.some((other, otherIndex) => {
    if (otherIndex === index) return false;
    const near = outward > 0 ? other.min[axis] : other.max[axis];
    const far = outward > 0 ? other.max[axis] : other.min[axis];
    const reaches = outward > 0 ? near <= plane + EPS : near >= plane - EPS;
    const extendsOutward = outward > 0 ? far > plane + EPS : far < plane - EPS;
    if (!reaches || !extendsOutward) return false;
    return (
      other.min[u] <= source.min[u] + EPS &&
      other.max[u] >= source.max[u] - EPS &&
      other.min[v] <= source.min[v] + EPS &&
      other.max[v] >= source.max[v] - EPS
    );
  });
}

function surfaceBelow(point: Vec3): number | null {
  let best: number | null = null;
  for (const box of boxes) {
    if (point.x < box.min.x - EPS || point.x > box.max.x + EPS) continue;
    if (point.z < box.min.z - EPS || point.z > box.max.z + EPS) continue;
    if (box.max.y > point.y + EPS) continue;
    if (best === null || box.max.y > best) best = box.max.y;
  }
  return best;
}

function edgeKey(a: number, b: number): string {
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

function hasGround(spawn: Vec3, half: Vec3): boolean {
  const foot = spawn.y - half.y;
  return boxes.some(
    (box) =>
      Math.abs(box.max.y - foot) <= EPS &&
      box.min.x <= spawn.x - half.x &&
      box.max.x >= spawn.x + half.x &&
      box.min.z <= spawn.z - half.z &&
      box.max.z >= spawn.z + half.z,
  );
}

function touchesHorizontalBounds(box: Box): boolean {
  return (
    box.min.x <= stage.bounds.min.x + EPS ||
    box.max.x >= stage.bounds.max.x - EPS ||
    box.min.z <= stage.bounds.min.z + EPS ||
    box.max.z >= stage.bounds.max.z - EPS
  );
}

function widthOf(box: Box, axis: Axis): number {
  return box.max[axis] - box.min[axis];
}

describe('karakuri-port stage identity', () => {
  it('parses as a stage with the harbour id, cell size and battle bgm', () => {
    expect(stage.id).toBe('karakuri-port');
    expect(stage.cellSize).toBe(0.125);
    expect(stage.bgm).toBe('battle');
    expect(stage.spawns[0]).toHaveLength(4);
    expect(stage.spawns[1]).toHaveLength(4);
  });

  it('stays inside the box budget', () => {
    expect(stage.boxes.length).toBeGreaterThan(0);
    expect(stage.boxes.length).toBeLessThanOrEqual(100);
  });

  it('covers a 40 by 40 m floor whose top sits at y = 0', () => {
    const floor = boxes.find(
      (box) =>
        box.min.x === -20 &&
        box.max.x === 20 &&
        box.min.z === -20 &&
        box.max.z === 20 &&
        Math.abs(box.max.y) <= EPS,
    );
    expect(floor).toBeDefined();
    if (!floor) return;
    expect(floor.min.y).toBeLessThan(0);
    expect(stage.bounds.min.x).toBe(-20);
    expect(stage.bounds.max.x).toBe(20);
    expect(stage.bounds.min.z).toBe(-20);
    expect(stage.bounds.max.z).toBe(20);
    expect(stage.boxes[0]?.paintable).toContain('+y');
  });

  it('rings the arena with four 6 m walls painted on their inner faces', () => {
    const walls = stage.boxes.filter((entry) => entry.box.max.y - entry.box.min.y >= 6 - EPS);
    expect(walls).toHaveLength(4);

    const inward = new Set<Face>();
    for (const entry of walls) {
      const { box } = entry;
      const nearX = box.min.x <= stage.bounds.min.x + EPS;
      const farX = box.max.x >= stage.bounds.max.x - EPS;
      const nearZ = box.min.z <= stage.bounds.min.z + EPS;
      const farZ = box.max.z >= stage.bounds.max.z - EPS;
      if (nearX) inward.add('+x');
      if (farX) inward.add('-x');
      if (nearZ) inward.add('+z');
      if (farZ) inward.add('-z');
      expect(entry.paintable).toHaveLength(1);
    }
    expect([...inward].sort()).toEqual(['+x', '+z', '-x', '-z']);
    for (const entry of walls) {
      const face = entry.paintable[0];
      if (face === undefined) continue;
      expect(['+x', '+z', '-x', '-z']).toContain(face);
    }
  });

  it('never overlaps two collision boxes', () => {
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const first = boxes[a];
        const second = boxes[b];
        if (!first || !second) continue;
        expect(boxOverlap(first, second)).toBe(false);
      }
    }
  });
});

describe('karakuri-port fairness', () => {
  it('is point symmetric in x and z for every box', () => {
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

  it('never marks a fully covered face as paintable', () => {
    const covered: string[] = [];
    for (const [index, entry] of stage.boxes.entries()) {
      for (const face of entry.paintable) {
        if (isFaceCovered(boxes, index, face)) covered.push(`${index}:${face}`);
      }
    }
    expect(covered).toEqual([]);
  });

  it('paints every exposed walkable top with +y', () => {
    const missing: string[] = [];
    for (const [index, entry] of stage.boxes.entries()) {
      if (touchesHorizontalBounds(entry.box)) continue;
      if (!entry.paintable.includes('+y') && !isFaceCovered(boxes, index, '+y')) {
        missing.push(`${index}:${boxKey(entry.box)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('mirrors the two spawn sets and keeps them clear of boxes', () => {
    const teamZero = new Set(stage.spawns[0].map(pointKey));
    const teamOne = new Set(stage.spawns[1].map(pointKey));
    expect(teamZero.size).toBe(4);
    expect(teamOne.size).toBe(4);

    for (const spawn of stage.spawns[0]) {
      expect(teamOne.has(pointKey(mirrorPoint(spawn)))).toBe(true);
      expect(spawn.z).toBeGreaterThan(14);
    }
    for (const spawn of stage.spawns[1]) {
      expect(spawn.z).toBeLessThan(-14);
    }

    for (const team of stage.spawns) {
      for (const spawn of team) {
        const playerBox = boxAround(spawn, PLAYER_HALF);
        const overlapping = boxes.filter((box) => boxOverlap(playerBox, box));
        expect(overlapping).toHaveLength(0);
        expect(hasGround(spawn, PLAYER_HALF)).toBe(true);
      }
    }
  });
});

describe('karakuri-port container yard', () => {
  const containerBoxes = boxes.filter((box) => {
    const dx = widthOf(box, 'x');
    const dy = widthOf(box, 'y');
    const dz = widthOf(box, 'z');
    const longX = Math.abs(dx - 6) <= EPS && Math.abs(dy - 2.4) <= EPS && Math.abs(dz - 2.4) <= EPS;
    const longZ = Math.abs(dx - 2.4) <= EPS && Math.abs(dy - 2.4) <= EPS && Math.abs(dz - 6) <= EPS;
    return longX || longZ;
  });

  it('stacks shipping containers in two and three level towers', () => {
    expect(containerBoxes.length).toBeGreaterThanOrEqual(10);

    const stacks = new Map<string, Box[]>();
    for (const box of containerBoxes) {
      const key = `${box.min.x},${box.max.x},${box.min.z},${box.max.z}`;
      const list = stacks.get(key) ?? [];
      list.push(box);
      stacks.set(key, list);
    }

    const levels = [...stacks.values()].map((list) =>
      [...list].sort((a, b) => a.min.y - b.min.y),
    );
    expect(levels.some((list) => list.length === 3)).toBe(true);
    expect(levels.some((list) => list.length === 2)).toBe(true);

    for (const list of levels) {
      for (let i = 1; i < list.length; i += 1) {
        const below = list[i - 1];
        const above = list[i];
        if (!below || !above) continue;
        expect(Math.abs(above.min.y - below.max.y)).toBeLessThanOrEqual(EPS);
      }
    }
  });

  it('provides stairs whose rises are at most 0.3 m and treads at least 0.5 m', () => {
    const steps = boxes.filter((box) => {
      const dy = widthOf(box, 'y');
      const dx = widthOf(box, 'x');
      const dz = widthOf(box, 'z');
      const shortSide = Math.min(dx, dz);
      const longSide = Math.max(dx, dz);
      return (
        Math.abs(box.min.y) <= EPS &&
        dy <= 2.4 + EPS &&
        shortSide >= 0.5 - EPS &&
        shortSide <= 0.6 + EPS &&
        longSide >= 2.4 - EPS
      );
    });
    expect(steps.length).toBeGreaterThanOrEqual(48);

    const flights = new Map<string, Box[]>();
    for (const box of steps) {
      const alongX = widthOf(box, 'x') >= widthOf(box, 'z');
      const longAxis: Axis = alongX ? 'x' : 'z';
      const key = `${longAxis}:${box.min[longAxis]}:${box.max[longAxis]}`;
      const flight = flights.get(key) ?? [];
      flight.push(box);
      flights.set(key, flight);
    }

    let staircases = 0;
    for (const flight of flights.values()) {
      const first = flight[0];
      if (!first) continue;
      const alongX = widthOf(first, 'x') >= widthOf(first, 'z');
      const shortAxis: Axis = alongX ? 'z' : 'x';
      const ordered = [...flight].sort((a, b) => a.min[shortAxis] - b.min[shortAxis]);

      let run: Box[] = [];
      const flush = (): void => {
        if (run.length < 3) return;
        staircases += 1;
        const firstStep = run[0];
        const lastStep = run[run.length - 1];
        if (!firstStep || !lastStep) return;
        const ascending = widthOf(firstStep, 'y') < widthOf(lastStep, 'y');
        for (const [index, step] of run.entries()) {
          expect(step.max[shortAxis] - step.min[shortAxis]).toBeGreaterThanOrEqual(0.5 - EPS);
          const level = ascending ? index + 1 : run.length - index;
          expect(Math.abs(widthOf(step, 'y') - 0.3 * level)).toBeLessThanOrEqual(EPS);
        }
      };

      for (const step of ordered) {
        const previous = run[run.length - 1];
        if (previous && step.min[shortAxis] > previous.max[shortAxis] + EPS) {
          flush();
          run = [];
        }
        run.push(step);
      }
      flush();
    }
    expect(staircases).toBeGreaterThanOrEqual(4);
  });

  it('puts at least three high waypoints on container tops reachable through links', () => {
    const byId = new Map(stage.waypoints.map((waypoint) => [waypoint.id, waypoint]));
    const high = stage.waypoints.filter((waypoint) => waypoint.tags.includes('high'));
    expect(high.length).toBeGreaterThanOrEqual(3);

    for (const waypoint of high) {
      const top = surfaceBelow(waypoint.pos);
      expect(top).not.toBeNull();
      if (top === null) continue;
      const container = containerBoxes.some((box) => Math.abs(box.max.y - top) <= EPS);
      expect(container).toBe(true);
      expect(waypoint.links.length).toBeGreaterThanOrEqual(1);
      for (const link of waypoint.links) expect(byId.has(link)).toBe(true);
    }
  });
});

describe('karakuri-port waypoints', () => {
  it('keeps 20 to 36 waypoints with mirrored positions', () => {
    expect(stage.waypoints.length).toBeGreaterThanOrEqual(20);
    expect(stage.waypoints.length).toBeLessThanOrEqual(36);
    const positions = new Set(stage.waypoints.map((waypoint) => pointKey(waypoint.pos)));
    for (const waypoint of stage.waypoints) {
      expect(positions.has(pointKey(mirrorPoint(waypoint.pos)))).toBe(true);
    }
  });

  it('tags both spawns and the central pier', () => {
    expect(stage.waypoints.some((waypoint) => waypoint.tags.includes('spawn0'))).toBe(true);
    expect(stage.waypoints.some((waypoint) => waypoint.tags.includes('spawn1'))).toBe(true);
    expect(stage.waypoints.some((waypoint) => waypoint.tags.includes('mid'))).toBe(true);
    expect(stage.waypoints.some((waypoint) => waypoint.tags.includes('flank'))).toBe(true);
  });

  it('places every waypoint one metre above a real surface inside the bounds', () => {
    const { min, max } = stage.bounds;
    for (const waypoint of stage.waypoints) {
      const { pos } = waypoint;
      expect(pos.x).toBeGreaterThanOrEqual(min.x - EPS);
      expect(pos.x).toBeLessThanOrEqual(max.x + EPS);
      expect(pos.y).toBeGreaterThanOrEqual(min.y - EPS);
      expect(pos.y).toBeLessThanOrEqual(max.y + EPS);
      expect(pos.z).toBeGreaterThanOrEqual(min.z - EPS);
      expect(pos.z).toBeLessThanOrEqual(max.z + EPS);

      const top = surfaceBelow(pos);
      expect(top).not.toBeNull();
      if (top === null) continue;
      expect(pos.y - top).toBeCloseTo(1, 10);
    }
  });

  it('links every waypoint to one to four neighbours in both directions', () => {
    const byId = new Map(stage.waypoints.map((waypoint) => [waypoint.id, waypoint]));
    for (const waypoint of stage.waypoints) {
      expect(waypoint.links.length).toBeGreaterThanOrEqual(1);
      expect(waypoint.links.length).toBeLessThanOrEqual(4);
      expect(new Set(waypoint.links).size).toBe(waypoint.links.length);
      for (const link of waypoint.links) {
        const target = byId.get(link);
        expect(target).toBeDefined();
        expect(target?.links).toContain(waypoint.id);
      }
    }
  });

  it('mirrors every link edge and keeps the graph connected', () => {
    const byId = new Map(stage.waypoints.map((waypoint) => [waypoint.id, waypoint]));
    const idByPos = new Map(stage.waypoints.map((waypoint) => [pointKey(waypoint.pos), waypoint.id]));
    const edges = new Set<string>();
    for (const waypoint of stage.waypoints) {
      for (const link of waypoint.links) edges.add(edgeKey(waypoint.id, link));
    }

    for (const waypoint of stage.waypoints) {
      const mirroredSelf = idByPos.get(pointKey(mirrorPoint(waypoint.pos)));
      expect(mirroredSelf).toBeDefined();
      for (const link of waypoint.links) {
        const target = byId.get(link);
        if (!target) continue;
        const mirroredLink = idByPos.get(pointKey(mirrorPoint(target.pos)));
        expect(mirroredLink).toBeDefined();
        if (mirroredSelf === undefined || mirroredLink === undefined) continue;
        expect(edges.has(edgeKey(mirroredSelf, mirroredLink))).toBe(true);
      }
    }

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

  it('passes the shared stage lint', () => {
    expect(lintStage(stage, PLAYER_HALF)).toEqual([]);
  });
});

describe('karakuri-port decoration file', () => {
  it('uses the harbour decoration schema with finite, positive values', () => {
    expect(Object.keys(decorJson).sort()).toEqual(
      ['banner', 'cloud', 'crane', 'lantern', 'mountain', 'sea', 'seed', 'theme', 'tree'].sort(),
    );
    expect(decorJson.theme).toBe('harbor');
    expect(Number.isInteger(decorJson.seed)).toBe(true);
    expect(decorJson.seed).toBeGreaterThanOrEqual(0);

    const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
    const nonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
    expect(positive(decorJson.lantern.spacing)).toBe(true);
    expect(positive(decorJson.lantern.lowDetailSpacing)).toBe(true);
    expect(positive(decorJson.lantern.offset)).toBe(true);
    expect(positive(decorJson.lantern.radius)).toBe(true);
    expect(positive(decorJson.lantern.capRadius)).toBe(true);
    expect(positive(decorJson.banner.width)).toBe(true);
    expect(positive(decorJson.banner.height)).toBe(true);
    expect(decorJson.banner.offsets.length).toBeGreaterThanOrEqual(1);
    expect(positive(decorJson.tree.outsideMin)).toBe(true);
    expect(positive(decorJson.tree.outsideMax)).toBe(true);
    expect(decorJson.tree.outsideMax).toBeGreaterThan(decorJson.tree.outsideMin);
    expect(Number.isInteger(decorJson.tree.count)).toBe(true);
    expect(positive(decorJson.mountain.radius)).toBe(true);
    expect(positive(decorJson.mountain.height)).toBe(true);
    expect(Number.isInteger(decorJson.mountain.count)).toBe(true);
    expect(positive(decorJson.crane.xSpread)).toBe(true);
    expect(Number.isFinite(decorJson.crane.z)).toBe(true);
    expect(positive(decorJson.crane.height)).toBe(true);
    expect(positive(decorJson.crane.jibLength)).toBe(true);
    expect(Number.isInteger(decorJson.crane.count)).toBe(true);
    expect(decorJson.crane.count).toBeGreaterThanOrEqual(1);
    expect(nonNegative(decorJson.crane.swayRadians)).toBe(true);
    expect(nonNegative(decorJson.crane.swaySpeed)).toBe(true);
    expect(positive(decorJson.sea.size)).toBe(true);
    expect(positive(decorJson.sea.margin)).toBe(true);
    expect(Number.isInteger(decorJson.sea.count)).toBe(true);
    expect(Number.isFinite(decorJson.sea.y)).toBe(true);
    expect(positive(decorJson.cloud.loopHalfWidth)).toBe(true);
    expect(positive(decorJson.cloud.minRadius)).toBe(true);
    expect(decorJson.cloud.maxRadius).toBeGreaterThanOrEqual(decorJson.cloud.minRadius);
    expect(decorJson.cloud.speed).toBeGreaterThanOrEqual(0);
  });

  it('keeps the background silhouette outside the playable bounds', () => {
    expect(decorJson.crane.z).toBeLessThan(stage.bounds.min.z - 5);
    expect(decorJson.mountain.z).toBeLessThan(stage.bounds.min.z - 5);
    expect(decorJson.tree.outsideMin).toBeGreaterThan(20);
    expect(decorJson.sea.y).toBeLessThan(0);
  });
});
