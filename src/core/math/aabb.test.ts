import { describe, expect, it } from 'vitest';
import { boxAround, boxOverlap, faceNormal, rayBox } from './aabb';
import { normalize, vec3 } from './vec3';
import type { Box, Face, Vec3 } from '../types';

function box(min: Vec3, max: Vec3): Box {
  return { min, max };
}

const UNIT: Box = box(vec3(-1, -1, -1), vec3(1, 1, 1));

describe('boxOverlap', () => {
  it('detects overlapping boxes', () => {
    expect(boxOverlap(box(vec3(0, 0, 0), vec3(2, 2, 2)), box(vec3(1, 1, 1), vec3(3, 3, 3)))).toBe(true);
  });

  it('treats a contained box as overlapping', () => {
    expect(boxOverlap(UNIT, box(vec3(-0.5, -0.5, -0.5), vec3(0.5, 0.5, 0.5)))).toBe(true);
  });

  it('does not count touching faces as overlap', () => {
    expect(boxOverlap(box(vec3(0, 0, 0), vec3(1, 1, 1)), box(vec3(1, 0, 0), vec3(2, 1, 1)))).toBe(false);
    expect(boxOverlap(box(vec3(0, 0, 0), vec3(1, 1, 1)), box(vec3(0, 1, 0), vec3(1, 2, 1)))).toBe(false);
    expect(boxOverlap(box(vec3(0, 0, 0), vec3(1, 1, 1)), box(vec3(0, 0, 1), vec3(1, 1, 2)))).toBe(false);
  });

  it('does not count touching edges or corners as overlap', () => {
    expect(boxOverlap(box(vec3(0, 0, 0), vec3(1, 1, 1)), box(vec3(1, 1, 0), vec3(2, 2, 1)))).toBe(false);
    expect(boxOverlap(box(vec3(0, 0, 0), vec3(1, 1, 1)), box(vec3(1, 1, 1), vec3(2, 2, 2)))).toBe(false);
  });

  it('rejects disjoint, inverted and non-finite boxes', () => {
    expect(boxOverlap(box(vec3(0, 0, 0), vec3(1, 1, 1)), box(vec3(2, 2, 2), vec3(3, 3, 3)))).toBe(false);
    expect(boxOverlap(box(vec3(1, 1, 1), vec3(0, 0, 0)), UNIT)).toBe(false);
    expect(boxOverlap(box({ x: Number.NaN, y: 0, z: 0 }, vec3(1, 1, 1)), UNIT)).toBe(false);
  });

  it('is symmetric', () => {
    const a = box(vec3(0, 0, 0), vec3(2, 2, 2));
    const b = box(vec3(1.5, -1, 0.5), vec3(4, 1, 3));
    expect(boxOverlap(a, b)).toBe(boxOverlap(b, a));
  });
});

describe('boxAround', () => {
  it('builds a box from centre and half extents', () => {
    expect(boxAround(vec3(1, 2, 3), vec3(2, 0.5, 4))).toEqual({
      min: { x: -1, y: 1.5, z: -1 },
      max: { x: 3, y: 2.5, z: 7 },
    });
  });

  it('uses absolute half extents and produces a valid box', () => {
    const result = boxAround(vec3(0, 0, 0), vec3(-1, -2, -3));
    expect(result).toEqual({ min: { x: -1, y: -2, z: -3 }, max: { x: 1, y: 2, z: 3 } });
    expect(boxOverlap(result, UNIT)).toBe(true);
  });
});

describe('faceNormal', () => {
  it('returns the outward unit normal for every face', () => {
    const expected: ReadonlyArray<[Face, Vec3]> = [
      ['+x', { x: 1, y: 0, z: 0 }],
      ['-x', { x: -1, y: 0, z: 0 }],
      ['+y', { x: 0, y: 1, z: 0 }],
      ['-y', { x: 0, y: -1, z: 0 }],
      ['+z', { x: 0, y: 0, z: 1 }],
      ['-z', { x: 0, y: 0, z: -1 }],
    ];
    for (const [face, normal] of expected) {
      expect(faceNormal(face)).toEqual(normal);
      expect(normal.x ** 2 + normal.y ** 2 + normal.z ** 2).toBe(1);
    }
  });
});

describe('rayBox', () => {
  it('hits each of the six faces with the correct t and face', () => {
    const cases: ReadonlyArray<[Vec3, Vec3, Face]> = [
      [vec3(3, 0, 0), vec3(-1, 0, 0), '+x'],
      [vec3(-3, 0, 0), vec3(1, 0, 0), '-x'],
      [vec3(0, 3, 0), vec3(0, -1, 0), '+y'],
      [vec3(0, -3, 0), vec3(0, 1, 0), '-y'],
      [vec3(0, 0, 3), vec3(0, 0, -1), '+z'],
      [vec3(0, 0, -3), vec3(0, 0, 1), '-z'],
    ];
    for (const [origin, dir, face] of cases) {
      const hit = rayBox(origin, dir, UNIT, 10);
      expect(hit).not.toBeNull();
      expect(hit?.t).toBeCloseTo(2, 12);
      expect(hit?.face).toBe(face);
    }
  });

  it('returns null when the origin is inside the box', () => {
    expect(rayBox(vec3(0, 0, 0), vec3(1, 0, 0), UNIT, 10)).toBeNull();
    expect(rayBox(vec3(0.5, -0.5, 0.25), vec3(0, 1, 0), UNIT, 10)).toBeNull();
  });

  it('returns null for boxes behind the ray', () => {
    expect(rayBox(vec3(-3, 0, 0), vec3(-1, 0, 0), UNIT, 10)).toBeNull();
  });

  it('respects maxDist, including an exact hit', () => {
    expect(rayBox(vec3(-3, 0, 0), vec3(1, 0, 0), UNIT, 2)).toEqual({ t: 2, face: '-x' });
    expect(rayBox(vec3(-3, 0, 0), vec3(1, 0, 0), UNIT, 1.999)).toBeNull();
    expect(rayBox(vec3(-3, 0, 0), vec3(1, 0, 0), UNIT, Number.POSITIVE_INFINITY)).toEqual({
      t: 2,
      face: '-x',
    });
  });

  it('handles zero direction components', () => {
    // Parallel to the x axis, inside the y/z slabs.
    expect(rayBox(vec3(-3, 0.25, -0.5), vec3(1, 0, 0), UNIT, 10)).toEqual({ t: 2, face: '-x' });
    // Parallel and outside the y slab.
    expect(rayBox(vec3(-3, 1.5, 0), vec3(1, 0, 0), UNIT, 10)).toBeNull();
    // Parallel exactly along the +y surface is still accepted.
    expect(rayBox(vec3(-3, 1, 0), vec3(1, 0, 0), UNIT, 10)).toEqual({ t: 2, face: '-x' });
  });

  it('returns null for a zero direction', () => {
    expect(rayBox(vec3(-3, 0, 0), vec3(0, 0, 0), UNIT, 10)).toBeNull();
  });

  it('does not treat a boundary origin pointing inwards as inside', () => {
    expect(rayBox(vec3(-1, 0, 0), vec3(1, 0, 0), UNIT, 10)).toEqual({ t: 0, face: '-x' });
    // Pointing outwards leaves the box immediately.
    expect(rayBox(vec3(-1, 0, 0), vec3(-1, 0, 0), UNIT, 10)).toBeNull();
  });

  it('measures t in units of dir', () => {
    expect(rayBox(vec3(-3, 0, 0), vec3(2, 0, 0), UNIT, 10)).toEqual({ t: 1, face: '-x' });
  });

  it('reports the entry face for a diagonal ray', () => {
    const hit = rayBox(vec3(-3, -3, -3), normalize(vec3(1, 1, 1)), UNIT, 10);
    expect(hit).not.toBeNull();
    expect(hit?.t).toBeCloseTo(2 * Math.sqrt(3), 12);
    expect(hit?.face).toBe('-x');
  });

  it('guards non-finite inputs', () => {
    expect(rayBox(vec3(-3, 0, 0), vec3(1, 0, 0), UNIT, Number.NaN)).toBeNull();
    expect(rayBox(vec3(-3, 0, 0), vec3(1, 0, 0), UNIT, -1)).toBeNull();
    expect(rayBox({ x: Number.NaN, y: 0, z: 0 }, vec3(1, 0, 0), UNIT, 10)).toBeNull();
    expect(rayBox(vec3(-3, 0, 0), { x: Number.POSITIVE_INFINITY, y: 0, z: 0 }, UNIT, 10)).toBeNull();
    // A tiny direction would overflow t; the result must not be Infinity.
    expect(rayBox(vec3(-3, 0, 0), vec3(5e-324, 0, 0), UNIT, Number.POSITIVE_INFINITY)).toBeNull();
    expect(
      rayBox(vec3(-3, 0, 0), vec3(1, 0, 0), box(vec3(-1, -1, -1), { x: Number.NaN, y: 1, z: 1 }), 10),
    ).toBeNull();
  });
});
