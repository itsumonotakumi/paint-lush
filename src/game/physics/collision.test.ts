import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { Face, Vec3 } from '../../core/types';
import type { StageData } from '../data/schemas';
import { createCollision, STEP_HEIGHT } from './collision';

interface BoxSpec {
  min: Vec3;
  max: Vec3;
}

const NO_PAINT: Face[] = [];

function entry(box: BoxSpec): StageData['boxes'][number] {
  return { box, paintable: NO_PAINT };
}

function stageOf(boxes: BoxSpec[]): Pick<StageData, 'boxes'> {
  return { boxes: boxes.map(entry) };
}

function box(min: Vec3, max: Vec3): BoxSpec {
  return { min, max };
}

const HALF: Vec3 = { x: 0.3, y: 0.9, z: 0.3 };
const FLOOR = box({ x: -10, y: -1, z: -10 }, { x: 10, y: 0, z: 10 });

function expectVec(actual: Vec3, expected: Vec3): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.z).toBeCloseTo(expected.z, 6);
}

function bodyOverlaps(pos: Vec3, half: Vec3, b: BoxSpec): boolean {
  return (
    pos.x - half.x < b.max.x &&
    b.min.x < pos.x + half.x &&
    pos.y - half.y < b.max.y &&
    b.min.y < pos.y + half.y &&
    pos.z - half.z < b.max.z &&
    b.min.z < pos.z + half.z
  );
}

function isFree(pos: Vec3, half: Vec3, boxes: readonly BoxSpec[]): boolean {
  for (const b of boxes) {
    if (bodyOverlaps(pos, half, b)) return false;
  }
  return true;
}

describe('moveAndSlide', () => {
  it('lands on a floor and reports grounded with a +y ground hit', () => {
    const collision = createCollision(stageOf([FLOOR]));
    const result = collision.moveAndSlide(
      { x: 0, y: 0.9, z: 0 },
      { x: 0, y: -1, z: 0 },
      HALF,
      1 / 60,
    );

    expect(result.grounded).toBe(true);
    expect(result.ground).not.toBeNull();
    expect(result.ground?.face).toBe('+y');
    expect(result.ground?.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(result.ground?.boxIndex).toBe(0);
    expect(result.ground?.pos.y).toBe(0);
    expect(result.ground?.pos.x).toBe(0);
    expect(result.ground?.pos.z).toBe(0);
    expectVec(result.pos, { x: 0, y: 0.9, z: 0 });
    expect(result.vel.y).toBe(0);
    expect(result.wall).toBeNull();
  });

  it('slides along a wall, zeroing only the blocked axis', () => {
    const wall = box({ x: 1, y: 0, z: -5 }, { x: 1.2, y: 2, z: 5 });
    const collision = createCollision(stageOf([FLOOR, wall]));
    const result = collision.moveAndSlide(
      { x: 0, y: 0.9, z: 0 },
      { x: 5, y: 0, z: 2 },
      HALF,
      0.2,
    );

    expectVec(result.pos, { x: 0.7, y: 0.9, z: 0.4 });
    expect(result.vel.x).toBe(0);
    expect(result.vel.z).toBeCloseTo(2, 6);
    expect(result.grounded).toBe(false);
    expect(result.wall?.face).toBe('-x');
    expect(result.wall?.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(result.wall?.boxIndex).toBe(1);
  });

  it('blocks both axes in a corner and keeps the first wall contact', () => {
    const wallX = box({ x: 1, y: 0, z: -5 }, { x: 1.2, y: 2, z: 5 });
    const wallZ = box({ x: -5, y: 0, z: 1 }, { x: 5, y: 2, z: 1.2 });
    const collision = createCollision(stageOf([FLOOR, wallX, wallZ]));
    const result = collision.moveAndSlide(
      { x: 0, y: 0.9, z: 0 },
      { x: 5, y: 0, z: 5 },
      HALF,
      0.2,
    );

    expectVec(result.pos, { x: 0.7, y: 0.9, z: 0.7 });
    expect(result.vel.x).toBe(0);
    expect(result.vel.z).toBe(0);
    expect(result.wall?.face).toBe('-x');
    expect(result.wall?.boxIndex).toBe(1);
  });

  it('stops on a ceiling without claiming to be grounded', () => {
    const ceiling = box({ x: -5, y: 2, z: -5 }, { x: 5, y: 2.4, z: 5 });
    const collision = createCollision(stageOf([ceiling]));
    const result = collision.moveAndSlide(
      { x: 0, y: 0.5, z: 0 },
      { x: 0, y: 3, z: 0 },
      HALF,
      0.3,
    );

    expectVec(result.pos, { x: 0, y: 1.1, z: 0 });
    expect(result.vel.y).toBe(0);
    expect(result.grounded).toBe(false);
    expect(result.ground).toBeNull();
  });

  it('climbs a low step while grounded', () => {
    const step = box({ x: 1, y: 0, z: -5 }, { x: 2, y: 0.3, z: 5 });
    const collision = createCollision(stageOf([FLOOR, step]));
    const result = collision.moveAndSlide(
      { x: 0, y: 0.9, z: 0 },
      { x: 3, y: -0.1, z: 0 },
      HALF,
      0.3,
    );

    expect(result.pos.x).toBeCloseTo(0.9, 6);
    expect(result.pos.y).toBeCloseTo(1.2, 6);
    expect(result.vel.x).toBeCloseTo(3, 6);
    expect(result.grounded).toBe(true);
    expect(result.ground?.face).toBe('+y');
    expect(result.ground?.boxIndex).toBe(1);
    expect(result.wall).toBeNull();
  });

  it('refuses a step taller than STEP_HEIGHT and stops flush', () => {
    const step = box({ x: 1, y: 0, z: -5 }, { x: 2, y: STEP_HEIGHT + 0.15, z: 5 });
    const collision = createCollision(stageOf([FLOOR, step]));
    const result = collision.moveAndSlide(
      { x: 0, y: 0.9, z: 0 },
      { x: 3, y: -0.1, z: 0 },
      HALF,
      0.3,
    );

    expect(result.pos.x).toBeCloseTo(0.7, 6);
    expect(result.pos.y).toBeCloseTo(0.9, 6);
    expect(result.vel.x).toBe(0);
    expect(result.wall?.face).toBe('-x');
    expect(result.wall?.boxIndex).toBe(1);
    expect(result.grounded).toBe(true);
    expect(result.ground?.boxIndex).toBe(0);
  });

  it('does not step up when the headroom is blocked', () => {
    const step = box({ x: 1, y: 0, z: -5 }, { x: 2, y: 0.3, z: 5 });
    const ceiling = box({ x: -5, y: 2, z: -5 }, { x: 5, y: 2.2, z: 5 });
    const collision = createCollision(stageOf([FLOOR, step, ceiling]));
    const result = collision.moveAndSlide(
      { x: 0, y: 0.9, z: 0 },
      { x: 3, y: -0.1, z: 0 },
      HALF,
      0.3,
    );

    expect(result.pos.x).toBeCloseTo(0.7, 6);
    expect(result.pos.y).toBeCloseTo(0.9, 6);
    expect(result.vel.x).toBe(0);
    expect(result.wall?.boxIndex).toBe(1);
  });

  it('cannot tunnel through a 0.1 m wall at 200 m/s', () => {
    const wall = box({ x: 2, y: 0, z: -5 }, { x: 2.1, y: 3, z: 5 });
    const collision = createCollision(stageOf([wall]));
    const result = collision.moveAndSlide(
      { x: 0, y: 2, z: 0 },
      { x: 200, y: 0, z: 0 },
      HALF,
      1 / 60,
    );

    expect(result.pos.x).toBeCloseTo(1.7, 6);
    expect(result.vel.x).toBe(0);
    expect(result.wall?.face).toBe('-x');
    expect(result.wall?.boxIndex).toBe(0);
  });

  it('returns finite values and unchanged position for a zero-time step', () => {
    const collision = createCollision(stageOf([FLOOR]));
    const result = collision.moveAndSlide(
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
      HALF,
      0,
    );

    expectVec(result.pos, { x: 1, y: 2, z: 3 });
    expectVec(result.vel, { x: 4, y: 5, z: 6 });
    expect(result.grounded).toBe(false);
    expect(result.wall).toBeNull();
  });

  it('returns zero velocity for non-finite motion input', () => {
    const collision = createCollision(stageOf([FLOOR]));
    const result = collision.moveAndSlide(
      { x: 1, y: 2, z: 3 },
      { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
      HALF,
      1 / 60,
    );

    expectVec(result.pos, { x: 1, y: 2, z: 3 });
    expectVec(result.vel, { x: 0, y: 0, z: 0 });
    expect(Number.isFinite(result.pos.x)).toBe(true);
  });
});

describe('raycast', () => {
  it('returns the nearest hit among several boxes', () => {
    const boxes = [
      box({ x: 10, y: -1, z: -1 }, { x: 11, y: 1, z: 1 }),
      box({ x: 3, y: -1, z: -1 }, { x: 4, y: 1, z: 1 }),
      box({ x: 20, y: -1, z: -1 }, { x: 21, y: 1, z: 1 }),
    ];
    const collision = createCollision(stageOf(boxes));
    const hit = collision.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 100);

    expect(hit).not.toBeNull();
    expect(hit?.boxIndex).toBe(1);
    expect(hit?.face).toBe('-x');
    expect(hit?.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(hit?.pos.x).toBeCloseTo(3, 6);
  });

  it('returns null for invalid distance or direction inputs', () => {
    const collision = createCollision(stageOf([FLOOR]));
    const origin = { x: 0, y: 5, z: 0 };
    const down = { x: 0, y: -1, z: 0 };

    expect(collision.raycast(origin, down, 0)).toBeNull();
    expect(collision.raycast(origin, down, -1)).toBeNull();
    expect(collision.raycast(origin, down, Number.NaN)).toBeNull();
    expect(collision.raycast(origin, down, Number.POSITIVE_INFINITY)).toBeNull();
    expect(collision.raycast(origin, { x: 0, y: 0, z: 0 }, 10)).toBeNull();
    expect(collision.raycast({ x: Number.NaN, y: 5, z: 0 }, down, 10)).toBeNull();
  });
});

describe('containsPoint', () => {
  const SOLID = box({ x: -1, y: 0, z: -1 }, { x: 1, y: 2, z: 1 });

  it('is true for points strictly inside a box', () => {
    const collision = createCollision(stageOf([SOLID]));

    expect(collision.containsPoint({ x: 0, y: 1, z: 0 })).toBe(true);
    expect(collision.containsPoint({ x: 0.99, y: 0.01, z: -0.99 })).toBe(true);
    expect(collision.containsPoint({ x: -0.5, y: 1.5, z: 0.5 })).toBe(true);
  });

  it('is false for points on a face, edge or corner', () => {
    const collision = createCollision(stageOf([SOLID]));

    expect(collision.containsPoint({ x: 1, y: 1, z: 0 })).toBe(false);
    expect(collision.containsPoint({ x: -1, y: 1, z: 0 })).toBe(false);
    expect(collision.containsPoint({ x: 0, y: 0, z: 0 })).toBe(false);
    expect(collision.containsPoint({ x: 0, y: 2, z: 0 })).toBe(false);
    expect(collision.containsPoint({ x: 0, y: 1, z: 1 })).toBe(false);
    expect(collision.containsPoint({ x: 0, y: 1, z: -1 })).toBe(false);
    expect(collision.containsPoint({ x: 1, y: 0, z: 1 })).toBe(false);
    expect(collision.containsPoint({ x: -1, y: 2, z: -1 })).toBe(false);
  });

  it('is false for points outside every box and checks all boxes', () => {
    const other = box({ x: 10, y: 0, z: 10 }, { x: 12, y: 2, z: 12 });
    const collision = createCollision(stageOf([SOLID, other]));

    expect(collision.containsPoint({ x: 2, y: 1, z: 0 })).toBe(false);
    expect(collision.containsPoint({ x: 11, y: 1, z: 11 })).toBe(true);
  });

  it('returns false for non-finite points', () => {
    const collision = createCollision(stageOf([SOLID]));

    expect(collision.containsPoint({ x: Number.NaN, y: 1, z: 0 })).toBe(false);
    expect(collision.containsPoint({ x: 0, y: Number.POSITIVE_INFINITY, z: 0 })).toBe(false);
    expect(collision.containsPoint({ x: 0, y: 1, z: Number.NEGATIVE_INFINITY })).toBe(false);
  });

  it('treats inverted box bounds as the solid they describe', () => {
    const inverted = box({ x: 1, y: 2, z: 1 }, { x: -1, y: 0, z: -1 });
    const collision = createCollision(stageOf([inverted]));

    expect(collision.containsPoint({ x: 0, y: 1, z: 0 })).toBe(true);
    expect(collision.containsPoint({ x: 2, y: 1, z: 0 })).toBe(false);
  });

  it('agrees with a reference strict-inside test for random points', () => {
    const coord = fc.integer({ min: -30, max: 30 }).map((n) => n / 10);
    const point = fc.record({ x: coord, y: coord, z: coord });

    fc.assert(
      fc.property(point, point, point, (a, b, p) => {
        const solid = box(
          {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            z: Math.min(a.z, b.z),
          },
          {
            x: Math.max(a.x, b.x),
            y: Math.max(a.y, b.y),
            z: Math.max(a.z, b.z),
          },
        );
        const collision = createCollision(stageOf([solid]));
        const expected =
          p.x > solid.min.x &&
          p.x < solid.max.x &&
          p.y > solid.min.y &&
          p.y < solid.max.y &&
          p.z > solid.min.z &&
          p.z < solid.max.z;
        return collision.containsPoint(p) === expected;
      }),
      { numRuns: 200 },
    );
  });
});

describe('moveAndSlide invariants', () => {
  it('never ends a move overlapping a box when it started free', () => {
    const coord = fc.integer({ min: -30, max: 30 }).map((n) => n / 10);
    const boxArb = fc
      .tuple(coord, coord, coord, coord, coord, coord)
      .map(([ax, bx, ay, by, az, bz]) =>
        box(
          { x: Math.min(ax, bx), y: Math.min(ay, by), z: Math.min(az, bz) },
          { x: Math.max(ax, bx), y: Math.max(ay, by), z: Math.max(az, bz) },
        ),
      );
    const halfArb = fc
      .tuple(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
      )
      .map(([x, y, z]) => ({ x: x / 10, y: y / 10, z: z / 10 }));
    const posArb = fc
      .tuple(coord, coord, coord)
      .map(([x, y, z]) => ({ x: x * 1.5, y: y * 1.5, z: z * 1.5 }));
    const velArb = fc
      .tuple(
        fc.integer({ min: -200, max: 200 }),
        fc.integer({ min: -200, max: 200 }),
        fc.integer({ min: -200, max: 200 }),
      )
      .map(([x, y, z]) => ({ x: x / 10, y: y / 10, z: z / 10 }));
    const dtArb = fc.integer({ min: 0, max: 10 }).map((n) => n / 100);

    fc.assert(
      fc.property(
        fc.array(boxArb, { minLength: 1, maxLength: 4 }),
        halfArb,
        posArb,
        velArb,
        dtArb,
        (boxes, half, pos, vel, dt) => {
          fc.pre(isFree(pos, half, boxes));

          const collision = createCollision({ boxes: boxes.map(entry) });
          const result = collision.moveAndSlide(pos, vel, half, dt);
          const finite =
            Number.isFinite(result.pos.x) &&
            Number.isFinite(result.pos.y) &&
            Number.isFinite(result.pos.z) &&
            Number.isFinite(result.vel.x) &&
            Number.isFinite(result.vel.y) &&
            Number.isFinite(result.vel.z);

          return finite && isFree(result.pos, half, boxes);
        },
      ),
      { numRuns: 200 },
    );
  });
});
