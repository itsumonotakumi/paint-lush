import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NO_TEAM } from '../../core/types';
import type { Face, SurfaceHit, TeamId, Vec3 } from '../../core/types';
import { faceNormal } from '../../core/math/aabb';
import type { SurfaceGrid } from '../contracts';
import type { StageData } from '../data/schemas';
import { createPaintGrid } from './paintGrid';

interface BoxSpec {
  min: Vec3;
  max: Vec3;
  paintable: Face[];
}

function makeStage(cellSize: number, boxes: BoxSpec[]): Pick<StageData, 'boxes' | 'cellSize'> {
  return {
    cellSize,
    boxes: boxes.map((spec) => ({ box: { min: spec.min, max: spec.max }, paintable: spec.paintable })),
  };
}

function hitAt(pos: Vec3, face: Face, boxIndex = 0): SurfaceHit {
  return { pos, normal: faceNormal(face), boxIndex, face };
}

function paintedCells(data: Uint8Array): number {
  let n = 0;
  for (const value of data) {
    if (value !== NO_TEAM) n += 1;
  }
  return n;
}

/** Counts allocated cells whose centre lies inside the exact face rectangle. */
function existingCells(surface: SurfaceGrid): number {
  let n = 0;
  for (let cv = 0; cv < surface.h; cv += 1) {
    if ((cv + 0.5) * surface.cellSize > surface.vLength + 1e-9) continue;
    for (let cu = 0; cu < surface.w; cu += 1) {
      if ((cu + 0.5) * surface.cellSize > surface.uLength + 1e-9) continue;
      n += 1;
    }
  }
  return n;
}

function unitBox(paintable: Face[]): BoxSpec {
  return { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, paintable };
}

describe('createPaintGrid surfaces', () => {
  it('builds one grid per paintable face in box then paintable order', () => {
    const grid = createPaintGrid(
      makeStage(0.1, [
        { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 }, paintable: ['+y', '-x'] },
        { min: { x: 2, y: 0, z: 0 }, max: { x: 3, y: 1, z: 1 }, paintable: ['+z'] },
      ]),
    );

    expect(grid.surfaces.map((s) => [s.id, s.boxIndex, s.face])).toEqual([
      [0, 0, '+y'],
      [1, 0, '-x'],
      [2, 1, '+z'],
    ]);
    expect(grid.surfaceAt(0, '+y')).toBe(0);
    expect(grid.surfaceAt(0, '-x')).toBe(1);
    expect(grid.surfaceAt(1, '+z')).toBe(2);
    expect(grid.surfaceAt(0, '+x')).toBeNull();
    expect(grid.surfaceAt(5, '+y')).toBeNull();
  });

  it('derives axes, origin and cell counts from the face plane', () => {
    const grid = createPaintGrid(
      makeStage(0.1, [{ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 }, paintable: ['+y', '-x'] }]),
    );
    const floor = grid.surfaces[0];
    const wall = grid.surfaces[1];
    if (!floor || !wall) throw new Error('missing surfaces');

    expect(floor.w).toBe(10);
    expect(floor.h).toBe(30);
    expect(floor.cellSize).toBe(0.1);
    expect(floor.origin).toEqual({ x: 0, y: 2, z: 0 });
    expect(floor.axisU).toEqual({ x: 1, y: 0, z: 0 });
    expect(floor.axisV).toEqual({ x: 0, y: 0, z: 1 });

    expect(wall.w).toBe(20);
    expect(wall.h).toBe(30);
    expect(wall.origin).toEqual({ x: 0, y: 0, z: 0 });
    expect(wall.axisU).toEqual({ x: 0, y: 1, z: 0 });
    expect(wall.axisV).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('stores the exact face size and ignores centres beyond the real face', () => {
    const grid = createPaintGrid(
      makeStage(0.5, [{ min: { x: 0, y: 0, z: 0 }, max: { x: 1.05, y: 0.2, z: 0.3 }, paintable: ['+y'] }]),
    );
    const floor = grid.surfaces[0];
    if (!floor) throw new Error('missing surface');

    expect(floor.uLength).toBeCloseTo(1.05);
    expect(floor.vLength).toBeCloseTo(0.3);
    // Allocation rounds up: 3 columns are allocated but only 2 centres fit.
    expect([floor.w, floor.h]).toEqual([3, 1]);
    expect(grid.totalCells()).toBe(2);

    // The dead trailing column must not accept paint or hits.
    expect(grid.splat(0, 1.25, 0.25, 0.1, 0)).toBe(0);
    expect(grid.sampleHit(hitAt({ x: 1.2, y: 0.2, z: 0.15 }, '+y'))).toBe(NO_TEAM);
    expect(grid.splat(0, 0.75, 0.25, 0.1, 0)).toBe(1);
    expect(grid.sampleHit(hitAt({ x: 0.75, y: 0.2, z: 0.25 }, '+y'))).toBe(0);
  });

  it('fills every cell with NO_TEAM and reports the total', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y', '+x'])]));
    expect(grid.totalCells()).toBe(200);
    expect(grid.counts()).toEqual([0, 0]);
    for (const surface of grid.surfaces) {
      expect(surface.data.length).toBe(surface.w * surface.h);
      for (const value of surface.data) expect(value).toBe(NO_TEAM);
    }
  });

  it('always allocates at least one cell per axis', () => {
    const grid = createPaintGrid(
      makeStage(1, [{ min: { x: 0, y: 0, z: 0 }, max: { x: 0.01, y: 0.01, z: 0.01 }, paintable: ['+y'] }]),
    );
    const floor = grid.surfaces[0];
    if (!floor) throw new Error('missing surface');
    expect([floor.w, floor.h]).toEqual([1, 1]);
  });
});

describe('splat', () => {
  it('paints exactly the cells whose centres lie inside the disc', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    expect(grid.splat(0, 0.5, 0.5, 0.2, 0)).toBe(12);
    expect(grid.counts()).toEqual([12, 0]);
    expect(paintedCells(grid.surfaces[0]?.data ?? new Uint8Array())).toBe(12);
  });

  it('clips discs that cross the grid edge', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    expect(grid.splat(0, 0, 0, 0.22, 0)).toBe(4);
    expect(grid.splat(0, 1, 1, 0.22, 1)).toBe(4);
    expect(grid.counts()).toEqual([4, 4]);
    expect(grid.splat(0, 5, 5, 0.5, 0)).toBe(0);
    expect(grid.counts()).toEqual([4, 4]);
  });

  it('moves a count between teams when painting over the enemy', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    expect(grid.splat(0, 0.5, 0.5, 0.2, 0)).toBe(12);
    expect(grid.splat(0, 0.5, 0.5, 0.2, 1)).toBe(12);
    expect(grid.counts()).toEqual([0, 12]);
    expect(paintedCells(grid.surfaces[0]?.data ?? new Uint8Array())).toBe(12);
  });

  it('returns 0 when repainting the same team', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    expect(grid.splat(0, 0.5, 0.5, 0.2, 1)).toBe(12);
    expect(grid.splat(0, 0.5, 0.5, 0.2, 1)).toBe(0);
    expect(grid.counts()).toEqual([0, 12]);
  });

  it('rejects unknown surfaces and non-finite or non-positive input', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    expect(grid.splat(99, 0.5, 0.5, 0.2, 0)).toBe(0);
    expect(grid.splat(-1, 0.5, 0.5, 0.2, 0)).toBe(0);
    expect(grid.splat(0, Number.NaN, 0.5, 0.2, 0)).toBe(0);
    expect(grid.splat(0, 0.5, Number.POSITIVE_INFINITY, 0.2, 0)).toBe(0);
    expect(grid.splat(0, 0.5, 0.5, 0, 0)).toBe(0);
    expect(grid.splat(0, 0.5, 0.5, -1, 0)).toBe(0);
    expect(grid.splat(0, 0.5, 0.5, Number.NaN, 0)).toBe(0);
    expect(grid.splat(0, 0.5, 0.5, Number.POSITIVE_INFINITY, 0)).toBe(0);
    expect(grid.splat(0, 0.5, 0.5, 0.2, 2 as TeamId)).toBe(0);
    expect(grid.counts()).toEqual([0, 0]);
  });
});

describe('takeDirty', () => {
  it('returns changed surfaces once and then clears', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y', '+x'])]));
    expect(grid.takeDirty()).toEqual([]);

    expect(grid.splat(1, 0.5, 0.5, 0.2, 0)).toBe(12);
    expect(grid.takeDirty()).toEqual([1]);
    expect(grid.takeDirty()).toEqual([]);

    expect(grid.splat(0, 0.5, 0.5, 0.2, 0)).toBe(12);
    expect(grid.takeDirty()).toEqual([0]);
    expect(grid.takeDirty()).toEqual([]);
  });

  it('does not report a surface when a splat changes nothing', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    grid.splat(0, 0.5, 0.5, 0.2, 0);
    grid.takeDirty();
    expect(grid.splat(0, 0.5, 0.5, 0.2, 0)).toBe(0);
    expect(grid.takeDirty()).toEqual([]);
    expect(grid.splat(0, 5, 5, 0.1, 1)).toBe(0);
    expect(grid.takeDirty()).toEqual([]);
  });

  it('reports several surfaces sorted by id', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y', '+x', '+z'])]));
    grid.splat(2, 0.5, 0.5, 0.2, 0);
    grid.splat(0, 0.5, 0.5, 0.2, 0);
    expect(grid.takeDirty()).toEqual([0, 2]);
  });
});

describe('splatHit', () => {
  it('paints the hit surface and wraps onto an adjoining wall', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y', '+x'])]));
    const floor = grid.surfaces[0];
    const wall = grid.surfaces[1];
    if (!floor || !wall) throw new Error('missing surfaces');

    const hit = hitAt({ x: 0.9, y: 1, z: 0.5 }, '+y');
    expect(grid.splatHit(hit, 0.3, 0)).toBe(34);

    expect(paintedCells(floor.data)).toBe(22);
    expect(paintedCells(wall.data)).toBe(12);
    expect(grid.counts()).toEqual([34, 0]);
    expect(grid.sampleHit(hit)).toBe(0);
    expect(grid.sampleHit(hitAt({ x: 1, y: 0.9, z: 0.5 }, '+x'))).toBe(0);
  });

  it('does not paint the floor underneath a box standing on it', () => {
    const grid = createPaintGrid(
      makeStage(0.5, [
        { min: { x: -2, y: -0.5, z: -2 }, max: { x: 2, y: 0, z: 2 }, paintable: ['+y'] },
        { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 0.2, z: 0.5 }, paintable: ['+y'] },
      ]),
    );
    const floor = grid.surfaces[0];
    const top = grid.surfaces[1];
    if (!floor || !top) throw new Error('missing surfaces');

    const hit = hitAt({ x: 0, y: 0.2, z: 0 }, '+y', 1);
    expect(grid.splatHit(hit, 0.5, 0)).toBe(4);
    expect(paintedCells(floor.data)).toBe(0);
    expect(paintedCells(top.data)).toBe(4);
    expect(grid.counts()).toEqual([4, 0]);
  });

  it('wraps from a floor onto a clear adjoining wall', () => {
    const grid = createPaintGrid(
      makeStage(0.1, [
        { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0.2, z: 1 }, paintable: ['+y'] },
        { min: { x: 1, y: 0, z: 0 }, max: { x: 1.2, y: 1, z: 1 }, paintable: ['-x'] },
      ]),
    );
    const wall = grid.surfaces[1];
    if (!wall) throw new Error('missing wall');

    const hit = hitAt({ x: 0.9, y: 0.2, z: 0.5 }, '+y');
    expect(grid.splatHit(hit, 0.3, 1)).toBeGreaterThan(0);
    expect(paintedCells(wall.data)).toBeGreaterThan(0);
  });

  it('does not reach the far side of a solid box', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['-x', '+x'])]));
    const near = grid.surfaces[0];
    const far = grid.surfaces[1];
    if (!near || !far) throw new Error('missing surfaces');

    const hit = hitAt({ x: 0, y: 0.5, z: 0.5 }, '-x');
    expect(grid.splatHit(hit, 1.2, 0)).toBeGreaterThan(0);
    expect(paintedCells(near.data)).toBeGreaterThan(0);
    expect(paintedCells(far.data)).toBe(0);
  });

  it('keeps incremental counts equal to a full rescan after wrap hits', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y', '-x', '+x', '+z', '-z'])]));

    grid.splatHit(hitAt({ x: 0.5, y: 1, z: 0.5 }, '+y'), 1.1, 0);
    grid.splatHit(hitAt({ x: 0, y: 0.5, z: 0.5 }, '-x'), 1.4, 1);
    grid.splatHit(hitAt({ x: 0.5, y: 0.5, z: 1 }, '+z'), 0.7, 0);
    grid.splatHit(hitAt({ x: 0.5, y: 1, z: 0.5 }, '+y'), 0.4, 1);

    const expected: [number, number] = [0, 0];
    for (const surface of grid.surfaces) {
      for (const value of surface.data) {
        if (value === 0) expected[0] += 1;
        else if (value === 1) expected[1] += 1;
        else expect(value).toBe(NO_TEAM);
      }
    }
    expect(grid.counts()).toEqual(expected);
  });

  it('skips surfaces that are beyond the radius', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y', '+x'])]));
    const hit = hitAt({ x: 0.5, y: 1, z: 0.5 }, '+y');
    expect(grid.splatHit(hit, 0.2, 1)).toBe(12);
    expect(grid.counts()).toEqual([0, 12]);
    const wall = grid.surfaces[1];
    if (!wall) throw new Error('missing surface');
    expect(paintedCells(wall.data)).toBe(0);
  });

  it('rejects non-finite hits and radii', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    expect(grid.splatHit(hitAt({ x: Number.NaN, y: 1, z: 0.5 }, '+y'), 0.2, 0)).toBe(0);
    expect(grid.splatHit(hitAt({ x: 0.5, y: 1, z: 0.5 }, '+y'), 0, 0)).toBe(0);
    expect(grid.splatHit(hitAt({ x: 0.5, y: 1, z: 0.5 }, '+y'), Number.NaN, 0)).toBe(0);
    expect(grid.splatHit(hitAt({ x: 0.5, y: 0, z: 0.5 }, '-y'), 0.2, 0)).toBe(0);
    expect(grid.counts()).toEqual([0, 0]);
  });
});

describe('sampleHit', () => {
  it('clamps hits on an exact grid edge to a valid cell', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    expect(grid.splat(0, 0.5, 0.5, 1, 1)).toBe(100);
    expect(grid.sampleHit(hitAt({ x: 0, y: 1, z: 0 }, '+y'))).toBe(1);
    expect(grid.sampleHit(hitAt({ x: 1, y: 1, z: 1 }, '+y'))).toBe(1);
    expect(grid.sampleHit(hitAt({ x: 0.5, y: 1, z: 0.5 }, '+y'))).toBe(1);
  });

  it('returns NO_TEAM for unpainted or unpaintable surfaces', () => {
    const grid = createPaintGrid(makeStage(0.1, [unitBox(['+y'])]));
    expect(grid.sampleHit(hitAt({ x: 0.5, y: 1, z: 0.5 }, '+y'))).toBe(NO_TEAM);
    expect(grid.sampleHit(hitAt({ x: 0.5, y: 1, z: 0.5 }, '-y'))).toBe(NO_TEAM);
    expect(grid.sampleHit(hitAt({ x: 0.5, y: 1, z: 0.5 }, '+y', 7))).toBe(NO_TEAM);
    expect(grid.sampleHit(hitAt({ x: Number.NaN, y: 1, z: 0.5 }, '+y'))).toBe(NO_TEAM);
  });
});

describe('incremental counts', () => {
  const faceArb: fc.Arbitrary<Face> = fc.constantFrom<Face>('+x', '-x', '+y', '-y', '+z', '-z');
  const vecArb: fc.Arbitrary<Vec3> = fc.record({
    x: fc.double({ min: -2, max: 2, noNaN: true }),
    y: fc.double({ min: -2, max: 2, noNaN: true }),
    z: fc.double({ min: -2, max: 2, noNaN: true }),
  });
  const sizeArb = fc.double({ min: 0.1, max: 2, noNaN: true });
  const boxArb = fc
    .tuple(vecArb, sizeArb, sizeArb, sizeArb)
    .map(([min, sx, sy, sz]) => ({
      min,
      max: { x: min.x + sx, y: min.y + sy, z: min.z + sz },
    }));
  const stageArb = fc.record({
    cellSize: fc.constantFrom(0.25, 0.5, 1),
    boxes: fc.array(
      fc.record({
        box: boxArb,
        paintable: fc.uniqueArray(faceArb, { minLength: 1, maxLength: 4 }),
      }),
      { minLength: 1, maxLength: 2 },
    ),
  });
  const opArb = fc.record({
    surfaceId: fc.nat({ max: 50 }),
    u: fc.double({ min: -3, max: 5, noNaN: true }),
    v: fc.double({ min: -3, max: 5, noNaN: true }),
    radius: fc.double({ min: 0, max: 2, noNaN: true }),
    team: fc.constantFrom<TeamId>(0, 1),
  });

  it('match a full rescan after random splats', () => {
    fc.assert(
      fc.property(stageArb, fc.array(opArb, { maxLength: 60 }), (stage, ops) => {
        const grid = createPaintGrid(stage);
        const surfaceCount = grid.surfaces.length;
        expect(surfaceCount).toBeGreaterThan(0);

        for (const op of ops) {
          const before = grid.counts();
          const changed = grid.splat(op.surfaceId % surfaceCount, op.u, op.v, op.radius, op.team);
          const after = grid.counts();
          // Every changed cell ends up owned by `team`; cells already owned are skipped.
          expect(changed).toBe(after[op.team] - before[op.team]);
        }

        const expected: [number, number] = [0, 0];
        let cells = 0;
        for (const surface of grid.surfaces) {
          cells += existingCells(surface);
          for (const value of surface.data) {
            if (value === 0) expected[0] += 1;
            else if (value === 1) expected[1] += 1;
            else expect(value).toBe(NO_TEAM);
          }
        }
        expect(grid.counts()).toEqual(expected);
        expect(grid.totalCells()).toBe(cells);
      }),
      { numRuns: 80 },
    );
  });
});
