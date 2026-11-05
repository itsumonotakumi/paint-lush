import { boxAround, boxOverlap } from '../../core/math/aabb';
import type { Box, Vec3 } from '../../core/types';
import type { StageData } from './schemas';

const EPS = 1e-6;
const MIN_WAYPOINTS = 16;
const MAX_WAYPOINTS = 40;
const MAX_BOXES = 120;
const MIN_LINKS = 1;
const MAX_LINKS = 4;
const SPAWN_TAG_RANGE = 3;
const MIN_WAYPOINT_HEIGHT = 0.5;
const MAX_WAYPOINT_HEIGHT = 1.5;
const MAX_SPAWN_GROUND_GAP = 3;

type Waypoint = StageData['waypoints'][number];

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}

function insideBounds(point: Vec3, bounds: Box): boolean {
  return (
    point.x >= bounds.min.x - EPS &&
    point.x <= bounds.max.x + EPS &&
    point.y >= bounds.min.y - EPS &&
    point.y <= bounds.max.y + EPS &&
    point.z >= bounds.min.z - EPS &&
    point.z <= bounds.max.z + EPS
  );
}

function coversXZ(point: Vec3, box: Box): boolean {
  return (
    point.x >= box.min.x - EPS &&
    point.x <= box.max.x + EPS &&
    point.z >= box.min.z - EPS &&
    point.z <= box.max.z + EPS
  );
}

/** Highest box top at or below `limitY` directly under the point, or null. */
function surfaceTopBelow(boxes: readonly Box[], point: Vec3, limitY: number): number | null {
  let best: number | null = null;
  for (const box of boxes) {
    if (!coversXZ(point, box)) continue;
    if (box.max.y > limitY + EPS) continue;
    if (best === null || box.max.y > best) best = box.max.y;
  }
  return best;
}

function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function hasMirrorBox(boxes: readonly Box[], box: Box): boolean {
  return boxes.some(
    (other) =>
      close(other.min.x, -box.max.x) &&
      close(other.max.x, -box.min.x) &&
      close(other.min.y, box.min.y) &&
      close(other.max.y, box.max.y) &&
      close(other.min.z, -box.max.z) &&
      close(other.max.z, -box.min.z),
  );
}

function hasMirrorPoint(points: readonly Vec3[], point: Vec3): boolean {
  return points.some(
    (other) => close(other.x, -point.x) && close(other.y, point.y) && close(other.z, -point.z),
  );
}

function lintSpawns(
  stage: StageData,
  boxes: readonly Box[],
  half: Vec3,
  problems: string[],
): void {
  for (const [teamIndex, team] of stage.spawns.entries()) {
    for (const [spawnIndex, spawn] of team.entries()) {
      const where = `spawns.${teamIndex}.${spawnIndex}`;
      const playerBox = boxAround(spawn, half);

      for (const [boxIndex, box] of boxes.entries()) {
        if (boxOverlap(playerBox, box)) {
          problems.push(`${where}: overlaps box ${boxIndex}`);
          break;
        }
      }

      const foot = spawn.y - Math.abs(half.y);
      const top = surfaceTopBelow(boxes, spawn, foot);
      if (top === null) {
        problems.push(`${where}: no ground below`);
      } else if (foot - top > MAX_SPAWN_GROUND_GAP + EPS) {
        problems.push(`${where}: ground is more than 3 m below`);
      }
    }
  }
}

function lintSpawnTags(stage: StageData, problems: string[]): void {
  const rangeSquared = SPAWN_TAG_RANGE * SPAWN_TAG_RANGE;
  for (const teamIndex of [0, 1] as const) {
    const tag = teamIndex === 0 ? 'spawn0' : 'spawn1';
    const team = stage.spawns[teamIndex];
    const found = stage.waypoints.some(
      (waypoint) =>
        waypoint.tags.includes(tag) &&
        team.some((spawn) => distanceSquared(waypoint.pos, spawn) <= rangeSquared + EPS),
    );
    if (!found) {
      problems.push(`waypoints: team ${teamIndex} needs a ${tag} waypoint within 3 m of a spawn`);
    }
  }

  if (!stage.waypoints.some((waypoint) => waypoint.tags.includes('mid'))) {
    problems.push('waypoints: at least one waypoint needs the mid tag');
  }
}

function lintWaypoints(stage: StageData, boxes: readonly Box[], problems: string[]): void {
  if (stage.waypoints.length < MIN_WAYPOINTS || stage.waypoints.length > MAX_WAYPOINTS) {
    problems.push(
      `waypoints: count must be ${MIN_WAYPOINTS} to ${MAX_WAYPOINTS} (got ${stage.waypoints.length})`,
    );
  }

  for (const [index, waypoint] of stage.waypoints.entries()) {
    const where = `waypoints.${index}`;

    if (!insideBounds(waypoint.pos, stage.bounds)) {
      problems.push(`${where}: outside bounds`);
    }

    if (waypoint.links.length < MIN_LINKS || waypoint.links.length > MAX_LINKS) {
      problems.push(`${where}: links must be ${MIN_LINKS} to ${MAX_LINKS} (got ${waypoint.links.length})`);
    }

    const top = surfaceTopBelow(boxes, waypoint.pos, waypoint.pos.y);
    if (top === null) {
      problems.push(`${where}: no surface directly below`);
    } else {
      const height = waypoint.pos.y - top;
      if (height < MIN_WAYPOINT_HEIGHT - EPS || height > MAX_WAYPOINT_HEIGHT + EPS) {
        problems.push(`${where}: must be 0.5 to 1.5 m above a surface (got ${height})`);
      }
    }
  }
}

function lintLinks(stage: StageData, problems: string[]): void {
  const byId = new Map<number, Waypoint>();
  for (const waypoint of stage.waypoints) {
    byId.set(waypoint.id, waypoint);
  }

  for (const [index, waypoint] of stage.waypoints.entries()) {
    for (const [linkIndex, link] of waypoint.links.entries()) {
      const target = byId.get(link);
      if (!target) {
        problems.push(`waypoints.${index}.links.${linkIndex}: unknown waypoint ${link}`);
        continue;
      }
      if (!target.links.includes(waypoint.id)) {
        problems.push(`waypoints.${index}.links.${linkIndex}: one-way link to ${link}`);
      }
    }
  }

  if (stage.waypoints.length === 0) return;

  const start = stage.waypoints[0];
  if (!start) return;
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

  if (seen.size !== stage.waypoints.length) {
    problems.push(`waypoints: graph is not connected (${seen.size}/${stage.waypoints.length})`);
  }
}

function lintSymmetry(stage: StageData, problems: string[]): void {
  const boxes: Box[] = stage.boxes.map((entry) => entry.box);
  for (const [index, box] of boxes.entries()) {
    if (!hasMirrorBox(boxes, box)) {
      problems.push(`boxes.${index}: stage is not point symmetric in x and z`);
    }
  }

  const spawnPoints: Vec3[] = [...stage.spawns[0], ...stage.spawns[1]];
  for (const [teamIndex, team] of stage.spawns.entries()) {
    for (const [spawnIndex, spawn] of team.entries()) {
      if (!hasMirrorPoint(spawnPoints, spawn)) {
        problems.push(`spawns.${teamIndex}.${spawnIndex}: stage is not point symmetric in x and z`);
      }
    }
  }

  const waypointPoints = stage.waypoints.map((waypoint) => waypoint.pos);
  for (const [index, waypoint] of stage.waypoints.entries()) {
    if (!hasMirrorPoint(waypointPoints, waypoint.pos)) {
      problems.push(`waypoints.${index}: stage is not point symmetric in x and z`);
    }
  }
}

/**
 * Returns every problem that would make a stage unfair or unusable, and an
 * empty array for a valid stage. `half` is the player AABB half extent.
 */
export function lintStage(stage: StageData, half: Vec3): string[] {
  const problems: string[] = [];
  const boxes: Box[] = stage.boxes.map((entry) => entry.box);

  if (boxes.length > MAX_BOXES) {
    problems.push(`boxes: count must be at most ${MAX_BOXES} (got ${boxes.length})`);
  }

  lintSpawns(stage, boxes, half, problems);
  lintSpawnTags(stage, problems);
  lintWaypoints(stage, boxes, problems);
  lintLinks(stage, problems);
  lintSymmetry(stage, problems);

  return problems;
}
