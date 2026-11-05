import { describe, expect, it } from 'vitest';
import type { Waypoint } from '../contracts';
import { nearestWaypoint, shortestPath } from './graph';

function waypoint(
  id: number,
  x: number,
  z: number,
  links: number[] = [],
  tags: Waypoint['tags'] = [],
): Waypoint {
  return { id, pos: { x, y: 0, z }, links, tags };
}

describe('nearestWaypoint', () => {
  it('returns the closest waypoint', () => {
    const points = [waypoint(0, 0, 0), waypoint(5, 20, 0), waypoint(9, 0, 20)];
    const found = nearestWaypoint({ x: 0, y: 0, z: 12 }, points);
    expect(found?.id).toBe(9);
  });

  it('breaks equal distances by the lower id', () => {
    const points = [waypoint(4, 2, 0), waypoint(2, -2, 0), waypoint(6, 0, 2)];
    const found = nearestWaypoint({ x: 0, y: 0, z: 0 }, points);
    expect(found?.id).toBe(2);
  });

  it('returns null for an empty list', () => {
    expect(nearestWaypoint({ x: 1, y: 2, z: 3 }, [])).toBeNull();
  });

  it('prefers a same-height waypoint over a slightly closer roof node', () => {
    const points = [
      { id: 1, pos: { x: 2, y: 3.4, z: 0 }, links: [], tags: [] },
      { id: 2, pos: { x: 3, y: 0, z: 0 }, links: [], tags: [] },
    ];
    const found = nearestWaypoint({ x: 0, y: 0, z: 0 }, points);
    expect(found?.id).toBe(2);
  });

  it('still picks the roof node when the bot is up there', () => {
    const points = [
      { id: 1, pos: { x: 2, y: 3.4, z: 0 }, links: [], tags: [] },
      { id: 2, pos: { x: 3, y: 0, z: 0 }, links: [], tags: [] },
    ];
    const found = nearestWaypoint({ x: 2, y: 3.4, z: 0 }, points);
    expect(found?.id).toBe(1);
  });
});

describe('shortestPath', () => {
  it('walks a simple chain', () => {
    const points = [
      waypoint(0, 0, 0, [1]),
      waypoint(1, 1, 0, [0, 2]),
      waypoint(2, 2, 0, [1]),
    ];
    expect(shortestPath(0, 2, points).map((point) => point.id)).toEqual([0, 1, 2]);
  });

  it('prefers fewer hops over a longer direct-looking chain', () => {
    const points = [
      waypoint(0, 0, 0, [1, 3]),
      waypoint(1, 1, 0, [2]),
      waypoint(2, 2, 0, [3]),
      waypoint(3, 3, 0, []),
    ];
    expect(shortestPath(0, 3, points).map((point) => point.id)).toEqual([0, 3]);
  });

  it('breaks equal-length routes by lower neighbour id', () => {
    const points = [
      waypoint(0, 0, 0, [2, 1]),
      waypoint(1, 1, 0, [3]),
      waypoint(2, 0, 1, [3]),
      waypoint(3, 2, 0, []),
    ];
    expect(shortestPath(0, 3, points).map((point) => point.id)).toEqual([0, 1, 3]);
  });

  it('treats links as directed edges', () => {
    const points = [waypoint(0, 0, 0, [1]), waypoint(1, 1, 0, [])];
    expect(shortestPath(0, 1, points).map((point) => point.id)).toEqual([0, 1]);
    expect(shortestPath(1, 0, points)).toEqual([]);
  });

  it('returns the start when both ids match', () => {
    const points = [waypoint(7, 0, 0, [])];
    expect(shortestPath(7, 7, points).map((point) => point.id)).toEqual([7]);
  });

  it('returns an empty path for unknown ids and dead ends', () => {
    const points = [waypoint(0, 0, 0, [42]), waypoint(1, 1, 0, [])];
    expect(shortestPath(0, 1, points)).toEqual([]);
    expect(shortestPath(99, 0, points)).toEqual([]);
    expect(shortestPath(Number.NaN, 0, points)).toEqual([]);
  });
});
