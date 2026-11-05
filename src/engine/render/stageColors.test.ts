import { describe, expect, it } from 'vitest';
import type { Box } from '../../core/types';
import {
  CONCRETE_FLOOR_COLOR,
  CONTAINER_COLORS,
  FLOOR_COLOR,
  HARBOR_STAGE_ID,
  PERIMETER_WALL_COLOR,
  PLASTER_COLOR,
  TOP_COLORS,
  boxTop,
  surfaceBase,
} from './stageColors';
import type { BoxTop } from './stageColors';

const NEON = 'neon-town';

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
    expect(surfaceBase(0, '+y', top({ y: 0 }), NEON)).toBe(FLOOR_COLOR);
    expect(surfaceBase(0, '+y', top({ y: -1 }), NEON)).toBe(FLOOR_COLOR);
  });

  it('cycles raised tops through the town palette on |x| + |z|', () => {
    expect(surfaceBase(0, '+y', top({ x: 0, z: 0, y: 1 }), NEON)).toBe(TOP_COLORS[0]);
    expect(surfaceBase(7, '+y', top({ x: 1, z: 0, y: 1 }), NEON)).toBe(TOP_COLORS[1]);
    expect(surfaceBase(3, '+y', top({ x: 2, z: 0, y: 1 }), NEON)).toBe(TOP_COLORS[2]);
    expect(surfaceBase(9, '+y', top({ x: 3, z: 0, y: 1 }), NEON)).toBe(TOP_COLORS[3]);
    expect(surfaceBase(1, '+y', top({ x: 4, z: 0, y: 1 }), NEON)).toBe(TOP_COLORS[4]);
    // Five keys later the cycle repeats.
    expect(surfaceBase(1, '+y', top({ x: 9, z: 0, y: 1 }), NEON)).toBe(TOP_COLORS[4]);
  });

  it('gives mirrored blocks the same colour despite different indices', () => {
    const east = surfaceBase(8, '+y', top({ x: 11.2, z: 8.7, y: 1.5 }), NEON);
    const west = surfaceBase(9, '+y', top({ x: -11.2, z: 8.7, y: 1.5 }), NEON);
    const south = surfaceBase(10, '+y', top({ x: 11.2, z: -8.7, y: 1.5 }), NEON);
    const north = surfaceBase(11, '+y', top({ x: -11.2, z: -8.7, y: 1.5 }), NEON);

    expect(east).toBe(west);
    expect(east).toBe(south);
    expect(east).toBe(north);
  });

  it('uses plaster on raised sides and deeper cream on perimeter walls', () => {
    expect(surfaceBase(5, '+x', top({ y: 1.5, width: 6, depth: 6 }), NEON)).toBe(PLASTER_COLOR);
    expect(surfaceBase(5, '-z', top({ y: 1.5, width: 6, depth: 6 }), NEON)).toBe(PLASTER_COLOR);
    expect(surfaceBase(1, '-z', top({ y: 6, width: 40, depth: 0.5 }), NEON)).toBe(
      PERIMETER_WALL_COLOR,
    );
    expect(surfaceBase(2, '+x', top({ y: 6, width: 0.5, depth: 39.5 }), NEON)).toBe(
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
    for (const stageId of [NEON, HARBOR_STAGE_ID]) {
      for (const face of ['+x', '-x', '+y', '-y', '+z', '-z'] as const) {
        const color = surfaceBase(0, face, broken, stageId);
        expect(Number.isFinite(color)).toBe(true);
        expect(color).toBeGreaterThanOrEqual(0);
        expect(color).toBeLessThanOrEqual(0xffffff);
      }
    }
  });

  it('never returns a colour outside the defined palette', () => {
    const allowed = new Set<number>([
      FLOOR_COLOR,
      CONCRETE_FLOOR_COLOR,
      PLASTER_COLOR,
      PERIMETER_WALL_COLOR,
      ...TOP_COLORS,
      ...CONTAINER_COLORS,
    ]);
    for (const stageId of [NEON, HARBOR_STAGE_ID]) {
      for (let x = -20; x <= 20; x += 3.5) {
        for (let z = -20; z <= 20; z += 3.5) {
          for (const face of ['+x', '+y', '+z'] as const) {
            const color = surfaceBase(0, face, top({ x, z, y: x === 0 && z === 0 ? 0 : 2 }), stageId);
            expect(allowed.has(color)).toBe(true);
          }
        }
      }
    }
  });
});

describe('harbour palette', () => {
  it('uses concrete on floor tops and undersides', () => {
    expect(surfaceBase(0, '+y', top({ y: 0 }), HARBOR_STAGE_ID)).toBe(CONCRETE_FLOOR_COLOR);
    expect(surfaceBase(0, '+y', top({ y: -1 }), HARBOR_STAGE_ID)).toBe(CONCRETE_FLOOR_COLOR);
    expect(surfaceBase(0, '-y', top({ y: 0 }), HARBOR_STAGE_ID)).toBe(CONCRETE_FLOOR_COLOR);
  });

  it('cycles raised tops through the container palette', () => {
    for (let key = 0; key < 12; key += 1) {
      const color = surfaceBase(0, '+y', top({ x: key, z: 0, y: 1 }), HARBOR_STAGE_ID);
      expect(color).toBe(CONTAINER_COLORS[key % CONTAINER_COLORS.length]);
    }
  });

  it('keeps point symmetry across the origin', () => {
    const spots: [number, number][] = [
      [7.5, 2.5],
      [12.3, -8.1],
      [0, 0],
      [17, 17],
    ];
    for (const [x, z] of spots) {
      const base = surfaceBase(0, '+y', top({ x, z, y: 2 }), HARBOR_STAGE_ID);
      expect(surfaceBase(99, '+y', top({ x: -x, z: -z, y: 2 }), HARBOR_STAGE_ID)).toBe(base);
      expect(surfaceBase(3, '+y', top({ x: -x, z, y: 2 }), HARBOR_STAGE_ID)).toBe(base);
      expect(surfaceBase(3, '+y', top({ x, z: -z, y: 2 }), HARBOR_STAGE_ID)).toBe(base);
    }
  });

  it('wraps raised container sides in the same container palette', () => {
    const topColor = surfaceBase(0, '+y', top({ x: 8, z: 3, y: 2.5 }), HARBOR_STAGE_ID);
    expect(surfaceBase(0, '+x', top({ x: 8, z: 3, y: 2.5, width: 4, depth: 4 }), HARBOR_STAGE_ID)).toBe(
      topColor,
    );
    expect(surfaceBase(0, '-z', top({ x: 8, z: 3, y: 2.5, width: 4, depth: 4 }), HARBOR_STAGE_ID)).toBe(
      topColor,
    );
    // Long tall perimeter walls keep the lighter guard colour.
    expect(
      surfaceBase(0, '-z', top({ x: 0, z: 19.75, y: 6, width: 40, depth: 0.5 }), HARBOR_STAGE_ID),
    ).toBe(PERIMETER_WALL_COLOR);
  });

  it('keeps the concrete floor readable against both team colours', () => {
    const teams = [0xff2e88, 0x19e6d0] as const;
    const channel = (hex: number, shift: number): number =>
      ((Math.trunc(hex) >> shift) & 0xff) / 255;
    const distance = (a: number, b: number): number => {
      const dr = channel(a, 16) - channel(b, 16);
      const dg = channel(a, 8) - channel(b, 8);
      const db = channel(a, 0) - channel(b, 0);
      return Math.hypot(dr, dg, db);
    };
    for (const team of teams) {
      expect(distance(CONCRETE_FLOOR_COLOR, team)).toBeGreaterThan(0.35);
    }
  });
});
