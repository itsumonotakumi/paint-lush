import { faceNormal } from '../../core/math/aabb';
import type { Box, Face, Vec3 } from '../../core/types';
import type { IPaintGrid, SurfaceGrid } from '../../game/contracts';
import type { StageData } from '../../game/data/schemas';

/** Number of vertices in one emitted quad (two triangles, no index buffer). */
export const QUAD_VERTEX_COUNT = 6;

const FACES: readonly Face[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

/** Clockwise/counter-clockwise triangle orders for the corner sequence 0,1,2,3. */
const TRIANGLES_CCW: readonly number[] = [0, 1, 2, 0, 2, 3];
const TRIANGLES_CW: readonly number[] = [0, 3, 2, 0, 2, 1];

/** Interleaved geometry for one paintable surface, in world space. */
export interface SurfaceQuad {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  vertexCount: number;
}

/** Merged geometry for every face that has no paint grid. */
export interface StaticFaceBatch {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  vertexCount: number;
}

interface QuadPoint {
  pos: Vec3;
  u: number;
  v: number;
}

interface FaceAxes {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

/** Keeps generated attributes finite; non-finite inputs collapse to zero. */
function safe(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function extent(count: number, cellSize: number): number {
  return Math.abs(safe(safe(count) * safe(cellSize)));
}

/**
 * UV span for one axis. The quad covers `length` metres while the texture covers
 * `count * cellSize`, so scaling the UVs keeps texels aligned with cells.
 */
function uvSpan(length: number, count: number, cellSize: number): number {
  const textureLength = extent(count, cellSize);
  const faceLength = safe(length);
  if (!(textureLength > 0) || !Number.isFinite(textureLength)) return 0;
  const span = faceLength / textureLength;
  return Number.isFinite(span) && span > 0 ? span : 0;
}

/** Four corners in the order (0,0), (uMax,0), (uMax,vMax), (0,vMax). */
function quadPoints(origin: Vec3, u: Vec3, v: Vec3, uMax = 1, vMax = 1): QuadPoint[] {
  const ox = safe(origin.x);
  const oy = safe(origin.y);
  const oz = safe(origin.z);
  const ux = safe(u.x);
  const uy = safe(u.y);
  const uz = safe(u.z);
  const vx = safe(v.x);
  const vy = safe(v.y);
  const vz = safe(v.z);

  return [
    { pos: { x: ox, y: oy, z: oz }, u: 0, v: 0 },
    { pos: { x: safe(ox + ux), y: safe(oy + uy), z: safe(oz + uz) }, u: uMax, v: 0 },
    {
      pos: { x: safe(ox + ux + vx), y: safe(oy + uy + vy), z: safe(oz + uz + vz) },
      u: uMax,
      v: vMax,
    },
    { pos: { x: safe(ox + vx), y: safe(oy + vy), z: safe(oz + vz) }, u: 0, v: vMax },
  ];
}

/** Chooses winding so the front face agrees with the supplied outward normal. */
function triangleOrder(points: readonly QuadPoint[], normal: Vec3): readonly number[] {
  const p0 = points[0];
  const p1 = points[1];
  const p3 = points[3];
  if (!p0 || !p1 || !p3) return TRIANGLES_CCW;

  const e1x = p1.pos.x - p0.pos.x;
  const e1y = p1.pos.y - p0.pos.y;
  const e1z = p1.pos.z - p0.pos.z;
  const e2x = p3.pos.x - p0.pos.x;
  const e2y = p3.pos.y - p0.pos.y;
  const e2z = p3.pos.z - p0.pos.z;

  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  const facing = cx * normal.x + cy * normal.y + cz * normal.z;

  return facing >= 0 ? TRIANGLES_CCW : TRIANGLES_CW;
}

function writeVertex(
  positions: Float32Array,
  normals: Float32Array,
  offset: number,
  pos: Vec3,
  normal: Vec3,
): void {
  positions[offset] = pos.x;
  positions[offset + 1] = pos.y;
  positions[offset + 2] = pos.z;
  normals[offset] = normal.x;
  normals[offset + 1] = normal.y;
  normals[offset + 2] = normal.z;
}

/** Builds the two triangles of one world-space quad. Returns the next vertex index. */
function emitQuad(
  positions: Float32Array,
  normals: Float32Array,
  startVertex: number,
  points: readonly QuadPoint[],
  normal: Vec3,
  uvs: Float32Array | null,
  colors: Float32Array | null,
  color: readonly [number, number, number] | null,
): number {
  const order = triangleOrder(points, normal);
  let vertex = startVertex;

  for (const cornerIndex of order) {
    const corner = points[cornerIndex];
    if (!corner) continue;

    const offset = vertex * 3;
    writeVertex(positions, normals, offset, corner.pos, normal);
    if (uvs) {
      uvs[vertex * 2] = corner.u;
      uvs[vertex * 2 + 1] = corner.v;
    }
    if (colors && color) {
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
    }
    vertex += 1;
  }

  return vertex;
}

/** Builds one paintable face as two world-space triangles. */
export function buildSurfaceQuad(surface: SurfaceGrid): SurfaceQuad {
  const normal = faceNormal(surface.face);
  // The quad spans the real face, which can be shorter than the allocated grid.
  const uLength = Math.max(0, safe(surface.uLength));
  const vLength = Math.max(0, safe(surface.vLength));
  const uMax = uvSpan(uLength, surface.w, surface.cellSize);
  const vMax = uvSpan(vLength, surface.h, surface.cellSize);

  const u = {
    x: safe(safe(surface.axisU.x) * uLength),
    y: safe(safe(surface.axisU.y) * uLength),
    z: safe(safe(surface.axisU.z) * uLength),
  };
  const v = {
    x: safe(safe(surface.axisV.x) * vLength),
    y: safe(safe(surface.axisV.y) * vLength),
    z: safe(safe(surface.axisV.z) * vLength),
  };

  const positions = new Float32Array(QUAD_VERTEX_COUNT * 3);
  const normals = new Float32Array(QUAD_VERTEX_COUNT * 3);
  const uvs = new Float32Array(QUAD_VERTEX_COUNT * 2);
  const points = quadPoints(surface.origin, u, v, uMax, vMax);
  emitQuad(positions, normals, 0, points, normal, uvs, null, null);

  return { positions, normals, uvs, vertexCount: QUAD_VERTEX_COUNT };
}

/** Sorted box corners so inverted boxes still produce stable outward faces. */
function sortedBox(box: Box): { min: Vec3; max: Vec3 } {
  const ax = safe(box.min.x);
  const ay = safe(box.min.y);
  const az = safe(box.min.z);
  const bx = safe(box.max.x);
  const by = safe(box.max.y);
  const bz = safe(box.max.z);
  return {
    min: { x: Math.min(ax, bx), y: Math.min(ay, by), z: Math.min(az, bz) },
    max: { x: Math.max(ax, bx), y: Math.max(ay, by), z: Math.max(az, bz) },
  };
}

/** Origin plus full-length U/V axes for a box face. cross(U, V) points outward. */
function boxFaceAxes(box: Box, face: Face): FaceAxes {
  const { min, max } = sortedBox(box);
  const width = safe(max.x - min.x);
  const height = safe(max.y - min.y);
  const depth = safe(max.z - min.z);
  const normal = faceNormal(face);

  switch (face) {
    case '+x':
      return {
        origin: { x: max.x, y: min.y, z: max.z },
        u: { x: 0, y: 0, z: -depth },
        v: { x: 0, y: height, z: 0 },
        normal,
      };
    case '-x':
      return {
        origin: { x: min.x, y: min.y, z: min.z },
        u: { x: 0, y: 0, z: depth },
        v: { x: 0, y: height, z: 0 },
        normal,
      };
    case '+y':
      return {
        origin: { x: min.x, y: max.y, z: max.z },
        u: { x: width, y: 0, z: 0 },
        v: { x: 0, y: 0, z: -depth },
        normal,
      };
    case '-y':
      return {
        origin: { x: min.x, y: min.y, z: min.z },
        u: { x: width, y: 0, z: 0 },
        v: { x: 0, y: 0, z: depth },
        normal,
      };
    case '+z':
      return {
        origin: { x: min.x, y: min.y, z: max.z },
        u: { x: width, y: 0, z: 0 },
        v: { x: 0, y: height, z: 0 },
        normal,
      };
    case '-z':
      return {
        origin: { x: max.x, y: min.y, z: min.z },
        u: { x: -width, y: 0, z: 0 },
        v: { x: 0, y: height, z: 0 },
        normal,
      };
  }
}

/** Dark neon-town palette, nudged per face direction and box for variation. */
function staticColor(face: Face, boxIndex: number): [number, number, number] {
  const seed = (((boxIndex + 1) * 0x9e3779b1) >>> 0) % 97;
  const jitter = (seed / 97) * 0.018;
  let r = 0.085 + jitter;
  let g = 0.095 + jitter;
  let b = 0.125 + jitter;

  switch (face) {
    case '+x':
      r *= 1.22;
      b *= 1.05;
      break;
    case '-x':
      r *= 0.92;
      b *= 1.2;
      break;
    case '+y':
      r += 0.035;
      g += 0.04;
      b += 0.05;
      break;
    case '-y':
      r *= 0.55;
      g *= 0.55;
      b *= 0.6;
      break;
    case '+z':
      r *= 1.12;
      g *= 1.04;
      b *= 1.18;
      break;
    case '-z':
      r *= 1.16;
      g *= 1.08;
      b *= 1.02;
      break;
  }

  return [clamp01(r), clamp01(g), clamp01(b)];
}

/**
 * Merges every box face that the paint grid does not expose as paintable.
 * Painted faces are rendered separately so they can use the ink shader.
 */
export function buildStaticFaces(stage: StageData, paint: IPaintGrid): StaticFaceBatch {
  let faceCount = 0;
  for (let boxIndex = 0; boxIndex < stage.boxes.length; boxIndex += 1) {
    const entry = stage.boxes[boxIndex];
    if (!entry) continue;
    for (const face of FACES) {
      if (paint.surfaceAt(boxIndex, face) === null) faceCount += 1;
    }
  }

  const vertexCount = faceCount * QUAD_VERTEX_COUNT;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  let vertex = 0;
  for (let boxIndex = 0; boxIndex < stage.boxes.length; boxIndex += 1) {
    const entry = stage.boxes[boxIndex];
    if (!entry) continue;

    for (const face of FACES) {
      if (paint.surfaceAt(boxIndex, face) !== null) continue;

      const axes = boxFaceAxes(entry.box, face);
      const points = quadPoints(axes.origin, axes.u, axes.v);
      vertex = emitQuad(
        positions,
        normals,
        vertex,
        points,
        axes.normal,
        null,
        colors,
        staticColor(face, boxIndex),
      );
    }
  }

  return { positions, normals, colors, vertexCount };
}
