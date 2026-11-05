import type { Vec3 } from '../../core/types';
import type { Waypoint } from '../contracts';

/** Keeps a coordinate finite so bad runtime data cannot poison a distance. */
function safe(value: number): number {
  return Number.isFinite(value) ? value + 0 : 0;
}

/**
 * Height is weighted much more heavily than horizontal distance when picking
 * the nearest waypoint. A bot standing at the foot of a tower must not treat
 * the node on its roof as "closest" and then walk straight into the wall.
 */
const NEAREST_HEIGHT_WEIGHT = 4;

function routeDistanceSquared(a: Vec3, b: Vec3): number {
  const dx = safe(a.x) - safe(b.x);
  const dy = safe(a.y) - safe(b.y);
  const dz = safe(a.z) - safe(b.z);
  const value = dx * dx + dy * dy * NEAREST_HEIGHT_WEIGHT * NEAREST_HEIGHT_WEIGHT + dz * dz;
  return Number.isFinite(value) ? value : Number.MAX_VALUE;
}

/** Index lookup that tolerates duplicate or missing ids (first entry wins). */
function buildIndex(waypoints: readonly Waypoint[]): Map<number, number> {
  const index = new Map<number, number>();
  for (let i = 0; i < waypoints.length; i += 1) {
    const waypoint = waypoints[i];
    if (waypoint === undefined) continue;
    if (!index.has(waypoint.id)) index.set(waypoint.id, i);
  }
  return index;
}

/** Nearest waypoint by 3D distance. Ties choose the lower id. */
export function nearestWaypoint(pos: Vec3, waypoints: readonly Waypoint[]): Waypoint | null {
  let best: Waypoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < waypoints.length; i += 1) {
    const waypoint = waypoints[i];
    if (waypoint === undefined) continue;
    const distance = routeDistanceSquared(pos, waypoint.pos);
    if (best === null || distance < bestDistance || (distance === bestDistance && waypoint.id < best.id)) {
      best = waypoint;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * Breadth-first shortest path over the waypoint graph. Links are treated as
 * directed edges, exactly as authored in the stage data. Neighbours are visited
 * in ascending id order so equal-length routes always resolve the same way.
 */
export function shortestPath(fromId: number, toId: number, waypoints: readonly Waypoint[]): Waypoint[] {
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) return [];

  const index = buildIndex(waypoints);
  const start = index.get(fromId);
  const goal = index.get(toId);
  if (start === undefined || goal === undefined) return [];

  if (start === goal) {
    const only = waypoints[start];
    return only === undefined ? [] : [only];
  }

  const size = waypoints.length;
  const visited = new Uint8Array(size);
  const parent = new Int32Array(size);
  parent.fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  visited[start] = 1;
  queue[tail] = start;
  tail += 1;

  while (head < tail && visited[goal] === 0) {
    const current = queue[head];
    head += 1;
    if (current === undefined) continue;

    const waypoint = waypoints[current];
    if (waypoint === undefined) continue;

    const neighbours: number[] = [];
    for (let i = 0; i < waypoint.links.length; i += 1) {
      const linked = waypoint.links[i];
      if (linked === undefined) continue;
      const next = index.get(linked);
      if (next === undefined || next === current) continue;
      if (neighbours.includes(next)) continue;
      neighbours.push(next);
    }

    neighbours.sort((a, b) => {
      const idA = waypoints[a]?.id ?? 0;
      const idB = waypoints[b]?.id ?? 0;
      return idA - idB;
    });

    for (let i = 0; i < neighbours.length; i += 1) {
      const next = neighbours[i];
      if (next === undefined || visited[next] !== 0) continue;
      visited[next] = 1;
      parent[next] = current;
      queue[tail] = next;
      tail += 1;
      if (next === goal) break;
    }
  }

  if (visited[goal] === 0) return [];

  const reversed: Waypoint[] = [];
  let cursor = goal;
  let guard = 0;
  while (cursor !== -1 && guard <= size) {
    const waypoint = waypoints[cursor];
    if (waypoint === undefined) return [];
    reversed.push(waypoint);
    if (cursor === start) break;
    cursor = parent[cursor] ?? -1;
    guard += 1;
  }

  if (cursor !== start) return [];
  reversed.reverse();
  return reversed;
}
