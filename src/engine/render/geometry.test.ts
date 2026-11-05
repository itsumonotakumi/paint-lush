import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { faceNormal } from '../../core/math/aabb';
import { NO_TEAM } from '../../core/types';
import type { Face, SurfaceId, Vec3 } from '../../core/types';
import type { IPaintGrid, SurfaceGrid } from '../../game/contracts';
import type { StageData } from '../../game/data/schemas';
import {
  QUAD_VERTEX_COUNT,
  buildStaticFaces,
  buildSurfaceQuad,
} from './geometry';
import { PALETTE } from './palette';

function makeSurface(overrides: Partial<SurfaceGrid> = {}): SurfaceGrid {
  return {
    id: 1,
    boxIndex: 0,
    face: '+y',
    w: 4,
    h: 3,
    cellSize: 0.5,
    uLength: 2,
    vLength: 1.5,
    origin: { x: 0, y: 0, z: 0 },
    axisU: { x: 1, y: 0, z: 0 },
    axisV: { x: 0, y: 0, z: 1 },
    data: new Uint8Array(12),
    ...overrides,
  };
}

function paintStub(paintable: ReadonlyMap<string, SurfaceId>): IPaintGrid {
  return {
    surfaces: [],
    surfaceAt(boxIndex, face) {
      return paintable.get(`${boxIndex}:${face}`) ?? null;
    },
    sampleHit() {
      return NO_TEAM;
    },
    splatHit() {
      return 0;
    },
    splat() {
      return 0;
    },
    counts() {
      return [0, 0];
    },
    totalCells() {
      return 0;
    },
    takeDirty() {
      return [];
    },
  };
}

function makeStage(): StageData {
  return {
    id: 'test-arena',
    cellSize: 0.5,
    boxes: [
      {
        box: { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 1, z: 2 } },
        paintable: ['+y'],
      },
      {
        box: { min: { x: 3, y: 0, z: -2 }, max: { x: 4, y: 2, z: 2 } },
        paintable: ['+x'],
      },
    ],
    spawns: [[{ x: -1, y: 0, z: -1 }], [{ x: 1, y: 0, z: 1 }]],
    waypoints: [],
    bounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 6, y: 3, z: 5 } },
  };
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  return {
    x: uy * vz - uz * vy,
    y: uz * vx - ux * vz,
    z: ux * vy - uy * vx,
  };
}

function vertexAt(positions: Float32Array, index: number): Vec3 {
  return {
    x: positions[index * 3] ?? 0,
    y: positions[index * 3 + 1] ?? 0,
    z: positions[index * 3 + 2] ?? 0,
  };
}

const FACES: readonly Face[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

/** sRGB byte value to the linear working space expected by vertex colours. */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function paletteLinear(hex: number): [number, number, number] {
  return [
    srgbToLinear((hex >> 16) & 0xff),
    srgbToLinear((hex >> 8) & 0xff),
    srgbToLinear(hex & 0xff),
  ];
}

/** Colour of the first vertex of a face in the batch's FACES order. */
function faceColor(
  batch: ReturnType<typeof buildStaticFaces>,
  face: Face,
): [number, number, number] {
  const offset = FACES.indexOf(face) * QUAD_VERTEX_COUNT * 3;
  return [
    batch.colors[offset] ?? 0,
    batch.colors[offset + 1] ?? 0,
    batch.colors[offset + 2] ?? 0,
  ];
}

function luminance(color: readonly [number, number, number]): number {
  return color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
}

/** In-plane U/V axes matching the paint grid, cross(U, V) may face either way. */
const FACE_AXES: Record<Face, { u: Vec3; v: Vec3 }> = {
  '+x': { u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  '-x': { u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  '+y': { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  '-y': { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  '+z': { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
  '-z': { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
};

function surfaceForFace(face: Face): SurfaceGrid {
  return makeSurface({
    face,
    w: 3,
    h: 2,
    cellSize: 0.5,
    uLength: 1.5,
    vLength: 1,
    origin: { x: 1, y: 2, z: 3 },
    axisU: FACE_AXES[face].u,
    axisV: FACE_AXES[face].v,
  });
}

/** Asserts one triangle's geometric normal agrees with its outward normal. */
function expectOutward(positions: Float32Array, startVertex: number, normal: Vec3): void {
  const a = vertexAt(positions, startVertex);
  const b = vertexAt(positions, startVertex + 1);
  const c = vertexAt(positions, startVertex + 2);
  const geometric = triangleNormal(a, b, c);
  const dot = geometric.x * normal.x + geometric.y * normal.y + geometric.z * normal.z;
  expect(dot).toBeGreaterThan(0);
}

describe('buildSurfaceQuad', () => {
  it('emits two triangles that span the exact face size with scaled UVs', () => {
    // The allocated grid is 2 x 1.5 m, but the real face is 1.6 x 1.2 m.
    const quad = buildSurfaceQuad(makeSurface({ uLength: 1.6, vLength: 1.2 }));

    expect(quad.vertexCount).toBe(QUAD_VERTEX_COUNT);
    expect(quad.positions).toHaveLength(QUAD_VERTEX_COUNT * 3);
    expect(quad.normals).toHaveLength(QUAD_VERTEX_COUNT * 3);
    expect(quad.uvs).toHaveLength(QUAD_VERTEX_COUNT * 2);

    for (let i = 0; i < quad.vertexCount; i += 1) {
      expect(quad.normals[i * 3]).toBeCloseTo(0);
      expect(quad.normals[i * 3 + 1]).toBeCloseTo(1);
      expect(quad.normals[i * 3 + 2]).toBeCloseTo(0);
    }

    const xs = [0, 1, 2, 3, 4, 5].map((i) => quad.positions[i * 3] ?? 0);
    const ys = [0, 1, 2, 3, 4, 5].map((i) => quad.positions[i * 3 + 1] ?? 0);
    const zs = [0, 1, 2, 3, 4, 5].map((i) => quad.positions[i * 3 + 2] ?? 0);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(1.6);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(0);
    expect(Math.min(...zs)).toBeCloseTo(0);
    expect(Math.max(...zs)).toBeCloseTo(1.2);

    for (let i = 0; i < quad.vertexCount; i += 1) {
      const u = quad.uvs[i * 2] ?? 0;
      const v = quad.uvs[i * 2 + 1] ?? 0;
      expect(u === 0 || Math.abs(u - 0.8) < 1e-6).toBe(true);
      expect(v === 0 || Math.abs(v - 0.8) < 1e-6).toBe(true);
    }
  });

  it('sizes a 0.3 m stair face exactly and scales UVs to its cells', () => {
    const quad = buildSurfaceQuad(
      makeSurface({
        face: '+y',
        w: 4,
        h: 3,
        cellSize: 0.1,
        uLength: 0.3,
        vLength: 0.25,
        origin: { x: 1, y: 0.5, z: 0 },
        axisU: { x: 1, y: 0, z: 0 },
        axisV: { x: 0, y: 0, z: 1 },
      }),
    );

    const xs = [0, 1, 2, 3, 4, 5].map((i) => quad.positions[i * 3] ?? 0);
    const zs = [0, 1, 2, 3, 4, 5].map((i) => quad.positions[i * 3 + 2] ?? 0);
    expect(Math.min(...xs)).toBeCloseTo(1);
    expect(Math.max(...xs)).toBeCloseTo(1.3);
    expect(Math.min(...zs)).toBeCloseTo(0);
    expect(Math.max(...zs)).toBeCloseTo(0.25);

    for (let i = 0; i < quad.vertexCount; i += 1) {
      const u = quad.uvs[i * 2] ?? 0;
      const v = quad.uvs[i * 2 + 1] ?? 0;
      expect(u === 0 || Math.abs(u - 0.3 / 0.4) < 1e-6).toBe(true);
      expect(v === 0 || Math.abs(v - 0.25 / 0.3) < 1e-6).toBe(true);
    }
  });

  it('winds triangles so the geometric normal matches the face normal', () => {
    const quad = buildSurfaceQuad(makeSurface());
    const normal = { x: 0, y: 1, z: 0 };

    for (let triangle = 0; triangle < 2; triangle += 1) {
      const a = vertexAt(quad.positions, triangle * 3);
      const b = vertexAt(quad.positions, triangle * 3 + 1);
      const c = vertexAt(quad.positions, triangle * 3 + 2);
      const geometric = triangleNormal(a, b, c);
      const dot = geometric.x * normal.x + geometric.y * normal.y + geometric.z * normal.z;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('winds both triangles outward for every face direction', () => {
    for (const face of FACES) {
      const quad = buildSurfaceQuad(surfaceForFace(face));
      const normal = faceNormal(face);

      for (let triangle = 0; triangle < 2; triangle += 1) {
        expectOutward(quad.positions, triangle * 3, normal);
      }
    }
  });

  it('winds outward even when the surface axes are reversed', () => {
    for (const face of FACES) {
      const axes = FACE_AXES[face];
      const quad = buildSurfaceQuad(
        makeSurface({
          face,
          origin: { x: -1, y: 0.5, z: 2 },
          axisU: axes.v,
          axisV: axes.u,
        }),
      );
      const normal = faceNormal(face);

      for (let triangle = 0; triangle < 2; triangle += 1) {
        expectOutward(quad.positions, triangle * 3, normal);
      }
    }
  });

  it('keeps non-finite input components finite', () => {
    const quad = buildSurfaceQuad(
      makeSurface({
        cellSize: Number.NaN,
        uLength: Number.NaN,
        vLength: Number.NEGATIVE_INFINITY,
        origin: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 0 },
        axisU: { x: Number.NaN, y: 4, z: 0 },
        axisV: { x: 0, y: 0, z: Number.NEGATIVE_INFINITY },
      }),
    );

    for (const value of quad.positions) expect(Number.isFinite(value)).toBe(true);
    for (const value of quad.normals) expect(Number.isFinite(value)).toBe(true);
    for (const value of quad.uvs) expect(Number.isFinite(value)).toBe(true);
  });

  it('accepts arbitrary face orientations', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Face>('+x', '-x', '+y', '-y', '+z', '-z'),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.double({ min: 0.05, max: 4, noNaN: true }),
        (face, w, h, cellSize) => {
          const quad = buildSurfaceQuad(
            makeSurface({ face, w, h, cellSize, uLength: w * cellSize, vLength: h * cellSize }),
          );
          expect(quad.vertexCount).toBe(QUAD_VERTEX_COUNT);

          const expected = {
            '+x': { x: 1, y: 0, z: 0 },
            '-x': { x: -1, y: 0, z: 0 },
            '+y': { x: 0, y: 1, z: 0 },
            '-y': { x: 0, y: -1, z: 0 },
            '+z': { x: 0, y: 0, z: 1 },
            '-z': { x: 0, y: 0, z: -1 },
          }[face];

          for (let i = 0; i < quad.vertexCount; i += 1) {
            expect(quad.normals[i * 3]).toBeCloseTo(expected.x);
            expect(quad.normals[i * 3 + 1]).toBeCloseTo(expected.y);
            expect(quad.normals[i * 3 + 2]).toBeCloseTo(expected.z);
            const point = vertexAt(quad.positions, i);
            expect(Number.isFinite(point.x)).toBe(true);
            expect(Number.isFinite(point.y)).toBe(true);
            expect(Number.isFinite(point.z)).toBe(true);
          }
        },
      ),
    );
  });
});

describe('buildStaticFaces', () => {
  it('merges exactly the faces that are not paintable', () => {
    const stage = makeStage();
    const paint = paintStub(new Map([['0:+y', 0 as SurfaceId]]));
    const batch = buildStaticFaces(stage, paint);

    const expectedFaces = stage.boxes.length * 6 - 1;
    expect(batch.vertexCount).toBe(expectedFaces * QUAD_VERTEX_COUNT);
    expect(batch.positions).toHaveLength(batch.vertexCount * 3);
    expect(batch.normals).toHaveLength(batch.vertexCount * 3);
    expect(batch.colors).toHaveLength(batch.vertexCount * 3);
  });

  it('emits outward-facing triangles and finite colours in range', () => {
    const stage = makeStage();
    const batch = buildStaticFaces(stage, paintStub(new Map([['0:+y', 0 as SurfaceId]])));

    for (let i = 0; i < batch.vertexCount; i += 3) {
      const a = vertexAt(batch.positions, i);
      const b = vertexAt(batch.positions, i + 1);
      const c = vertexAt(batch.positions, i + 2);
      const normal = {
        x: batch.normals[i * 3] ?? 0,
        y: batch.normals[i * 3 + 1] ?? 0,
        z: batch.normals[i * 3 + 2] ?? 0,
      };
      const geometric = triangleNormal(a, b, c);
      const dot = geometric.x * normal.x + geometric.y * normal.y + geometric.z * normal.z;
      expect(dot).toBeGreaterThan(0);
      expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1);
    }

    for (const value of batch.colors) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }

    const distinct = new Set<string>();
    for (let i = 0; i < batch.vertexCount; i += 1) {
      distinct.add(
        `${batch.colors[i * 3]},${batch.colors[i * 3 + 1]},${batch.colors[i * 3 + 2]}`,
      );
    }
    expect(distinct.size).toBeGreaterThan(1);

    const xs = Array.from(batch.positions).filter((_, index) => index % 3 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(stage.bounds.min.x);
    expect(Math.max(...xs)).toBeLessThanOrEqual(stage.bounds.max.x);
  });

  it('winds both triangles outward for every static face direction', () => {
    const stage = makeStage();
    const batch = buildStaticFaces(stage, paintStub(new Map()));

    let faceIndex = 0;
    for (const entry of stage.boxes) {
      expect(entry).toBeDefined();
      for (const face of FACES) {
        const start = faceIndex * QUAD_VERTEX_COUNT;
        const normal = faceNormal(face);
        expectOutward(batch.positions, start, normal);
        expectOutward(batch.positions, start + 3, normal);
        faceIndex += 1;
      }
    }

    expect(batch.vertexCount).toBe(faceIndex * QUAD_VERTEX_COUNT);
  });

  it('uses bright palette colours in linear space for walls, tops and undersides', () => {
    const stage = makeStage();
    const batch = buildStaticFaces(stage, paintStub(new Map()));

    const [wallR, wallG, wallB] = paletteLinear(PALETTE.wall);
    const [groundR, groundG, groundB] = paletteLinear(PALETTE.ground);
    const [underR, underG, underB] = paletteLinear(PALETTE.groundUnderside);

    for (const face of ['+x', '-x', '+z', '-z'] as const) {
      const color = faceColor(batch, face);
      const [r, g, b] = color;
      const checks: readonly (readonly [number, number])[] = [
        [r, wallR],
        [g, wallG],
        [b, wallB],
      ];
      for (const [value, base] of checks) {
        expect(value).toBeGreaterThanOrEqual(base * 0.94 - 1e-9);
        expect(value).toBeLessThanOrEqual(Math.min(1, base * 1.06) + 1e-9);
      }
      expect(luminance(color)).toBeGreaterThan(0.4);
    }

    const top = faceColor(batch, '+y');
    expect(top[0]).toBeCloseTo(groundR);
    expect(top[1]).toBeCloseTo(groundG);
    expect(top[2]).toBeCloseTo(groundB);

    const bottom = faceColor(batch, '-y');
    expect(bottom[0]).toBeCloseTo(underR);
    expect(bottom[1]).toBeCloseTo(underG);
    expect(bottom[2]).toBeCloseTo(underB);

    // Facing directions must stay distinguishable so the town reads in 3D.
    expect(faceColor(batch, '+z')[1]).toBeGreaterThan(faceColor(batch, '-z')[1]);
    expect(faceColor(batch, '+x')[2]).toBeGreaterThan(faceColor(batch, '-x')[2]);
    expect(luminance(top)).toBeGreaterThan(0.4);
    expect(luminance(bottom)).toBeGreaterThan(0.3);
  });

  it('returns empty arrays when every face is paintable', () => {
    const stage = makeStage();
    const all = new Map<string, SurfaceId>();
    for (let boxIndex = 0; boxIndex < stage.boxes.length; boxIndex += 1) {
      for (const face of ['+x', '-x', '+y', '-y', '+z', '-z'] as const) {
        all.set(`${boxIndex}:${face}`, boxIndex * 6);
      }
    }

    const batch = buildStaticFaces(stage, paintStub(all));
    expect(batch.vertexCount).toBe(0);
    expect(batch.positions).toHaveLength(0);
    expect(batch.normals).toHaveLength(0);
    expect(batch.colors).toHaveLength(0);
  });
});
