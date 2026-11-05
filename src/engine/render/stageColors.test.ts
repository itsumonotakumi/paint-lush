import { describe, expect, it } from 'vitest';
import type { Box } from '../../core/types';
import {
  FLOOR_COLOR,
  PERIMETER_WALL_COLOR,
  PLASTER_COLOR,
  TOP_COLORS,
  boxTop,
  surfaceBase,
} from './stageColors';
import type { BoxTop } from './stageColors';

function top(overrides: Partial<BoxTop> = {}): BoxTop {
  return { x: 0, z: 0, y: 0, width: 10, depth: 10, ...overrides };
}

describe('boxTop', () => {
  it('reports the centre, highest point and horizontal extents', () => {
    const box: Box = {
      min: { x: -3, y: 0, z: 4 },
      max: { x: 5, y: 2, z: 10 },
    };
    expect(boxTop(box)).toEqual({ x: 1, z: 7, y: 2, width: 8, depth: 6 });
  });

  it('normalises inverted bounds and broken numbers', () => {
    const box: Box = {
      min: { x: 5, y: 4, z: Number.NaN },
      max: { x: -3, y: 1, z: 2 },
    };
    expect(boxTop(box)).toEqual({ x: 1, z: 1, y: 4, width: 8, depth: 2 });
  });
});

describe('surfaceBase', () => {
  it('paints the floor plate at y = 0 as warm stone', () => {
    expect(surfaceBase(0, '+y', top({ y: 0 }))).toBe(FLOOR_COLOR);
    expect(surfaceBase(0, '+y', top({ y: -1 }))).toBe(FLOOR_COLOR);
  });

  it('cycles raised tops through the town palette on |x| + |z|', () => {
    expect(surfaceBase(0, '+y', top({ x: 0, z: 0, y: 1 }))).toBe(TOP_COLORS[0]);
    expect(surfaceBase(7, '+y', top({ x: 1, z: 0, y: 1 }))).toBe(TOP_COLORS[1]);
    expect(surfaceBase(3, '+y', top({ x: 2, z: 0, y: 1 }))).toBe(TOP_COLORS[2]);
    expect(surfaceBase(9, '+y', top({ x: 3, z: 0, y: 1 }))).toBe(TOP_COLORS[3]);
    expect(surfaceBase(1, '+y', top({ x: 4, z: 0, y: 1 }))).toBe(TOP_COLORS[4]);
    // Five keys later the cycle repeats.
    expect(surfaceBase(1, '+y', top({ x: 9, z: 0, y: 1 }))).toBe(TOP_COLORS[4]);
  });

  it('gives mirrored blocks the same colour despite different indices', () => {
    const east = surfaceBase(8, '+y', top({ x: 11.2, z: 8.7, y: 1.5 }));
    const west = surfaceBase(9, '+y', top({ x: -11.2, z: 8.7, y: 1.5 }));
    const south = surfaceBase(10, '+y', top({ x: 11.2, z: -8.7, y: 1.5 }));
    const north = surfaceBase(11, '+y', top({ x: -11.2, z: -8.7, y: 1.5 }));

    expect(east).toBe(west);
    expect(east).toBe(south);
    expect(east).toBe(north);
  });

  it('uses plaster on raised sides and deeper cream on perimeter walls', () => {
    expect(surfaceBase(5, '+x', top({ y: 1.5, width: 6, depth: 6 }))).toBe(PLASTER_COLOR);
    expect(surfaceBase(5, '-z', top({ y: 1.5, width: 6, depth: 6 }))).toBe(PLASTER_COLOR);
    expect(surfaceBase(1, '-z', top({ y: 6, width: 40, depth: 0.5 }))).toBe(
      PERIMETER_WALL_COLOR,
    );
    expect(surfaceBase(2, '+x', top({ y: 6, width: 0.5, depth: 39.5 }))).toBe(
      PERIMETER_WALL_COLOR,
    );
  });

  it('keeps every colour finite for hostile or missing geometry', () => {
    const broken = top({
      x: Number.NaN,
      z: Number.POSITIVE_INFINITY,
      y: Number.NaN,
      width: Number.NaN,
      depth: -4,
    });
    for (const face of ['+x', '-x', '+y', '-y', '+z', '-z'] as const) {
      const color = surfaceBase(0, face, broken);
      expect(Number.isFinite(color)).toBe(true);
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('never returns a colour outside the defined palette', () => {
    const allowed = new Set<number>([
      FLOOR_COLOR,
      PLASTER_COLOR,
      PERIMETER_WALL_COLOR,
      ...TOP_COLORS,
    ]);
    for (let x = -20; x <= 20; x += 3.5) {
      for (let z = -20; z <= 20; z += 3.5) {
        for (const face of ['+x', '+y', '+z'] as const) {
          const color = surfaceBase(0, face, top({ x, z, y: x === 0 && z === 0 ? 0 : 2 }));
          expect(allowed.has(color)).toBe(true);
        }
      }
    }
  });
});
