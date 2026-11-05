import { boxOverlap, rayBox } from '../../core/math/aabb';
import { NO_TEAM } from '../../core/types';
import type { Box, CellValue, Face, SurfaceHit, SurfaceId, TeamId, Vec3 } from '../../core/types';
import type { IPaintGrid, SurfaceGrid } from '../contracts';
import type { StageData } from '../data/schemas';

/** Hard cap so hostile stage data cannot request an unbounded allocation. */
const MAX_CELLS_PER_SURFACE = 4_194_304;
/** Distance used to lift segment endpoints off their surfaces, in metres. */
const SURFACE_OFFSET = 0.01;
/** Tolerance for comparisons against exact face lengths. */
const LENGTH_EPSILON = 1e-9;
/** Endpoint slack so a segment that merely grazes a box corner is not a crossing. */
const SEGMENT_ENDPOINT_SLACK = 1e-6;

interface FaceAxes {
  readonly u: Vec3;
  readonly v: Vec3;
  readonly n: Vec3;
}

/** In-plane axes and outward normal for each face. U then V is a right-handed pair in the plane. */
const FACE_AXES: Record<Face, FaceAxes> = {
  '+x': { u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 }, n: { x: 1, y: 0, z: 0 } },
  '-x': { u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 }, n: { x: -1, y: 0, z: 0 } },
  '+y': { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, n: { x: 0, y: 1, z: 0 } },
  '-y': { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, n: { x: 0, y: -1, z: 0 } },
  '+z': { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, n: { x: 0, y: 0, z: 1 } },
  '-z': { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, n: { x: 0, y: 0, z: -1 } },
};

/** Non-finite numbers collapse to 0 and -0 is normalised. */
function safe(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

/** Positive extent between two coordinates; inverted or non-finite spans collapse to 0. */
function extent(a: number, b: number): number {
  const span = safe(b) - safe(a);
  return Number.isFinite(span) && span > 0 ? span : 0;
}

/** The face's minimum corner in world space, i.e. the cell (0, 0) origin. */
function faceOrigin(face: Face, min: Vec3, max: Vec3): Vec3 {
  const minX = safe(min.x);
  const minY = safe(min.y);
  const minZ = safe(min.z);
  const maxX = safe(max.x);
  const maxY = safe(max.y);
  const maxZ = safe(max.z);
  switch (face) {
    case '+x':
      return { x: maxX, y: minY, z: minZ };
    case '-x':
      return { x: minX, y: minY, z: minZ };
    case '+y':
      return { x: minX, y: maxY, z: minZ };
    case '-y':
      return { x: minX, y: minY, z: minZ };
    case '+z':
      return { x: minX, y: minY, z: maxZ };
    case '-z':
      return { x: minX, y: minY, z: minZ };
  }
}

/** Extent of the face along its U and V axes. */
function faceExtents(face: Face, min: Vec3, max: Vec3): [number, number] {
  const dx = extent(min.x, max.x);
  const dy = extent(min.y, max.y);
  const dz = extent(min.z, max.z);
  switch (face) {
    case '+x':
    case '-x':
      return [dy, dz];
    case '+y':
    case '-y':
      return [dx, dz];
    case '+z':
    case '-z':
      return [dx, dy];
  }
}

/** Cells allocated for one axis, always at least one. */
function axisCells(length: number, cellSize: number): number {
  const ratio = length / cellSize;
  if (!Number.isFinite(ratio)) return 1;
  // The tolerance keeps values such as 0.30000000000000004 from adding a whole extra cell.
  const count = Math.ceil(ratio - LENGTH_EPSILON);
  return count < 1 ? 1 : count;
}

/**
 * Cells whose centre really lies within the exact face length. The allocation
 * rounds up, so the far edge may contain cells that do not exist.
 */
function liveCells(length: number, cellSize: number, allocated: number): number {
  if (allocated <= 0) return 0;
  const ratio = length / cellSize;
  if (!Number.isFinite(ratio)) return 0;
  const last = Math.floor(ratio - 0.5 + LENGTH_EPSILON);
  if (!Number.isFinite(last)) return 0;
  const count = last + 1;
  if (count < 0) return 0;
  return Math.min(allocated, count);
}

/** Keeps one surface's allocation bounded without ever producing a zero dimension. */
function boundedGrid(w: number, h: number): [number, number] {
  if (!Number.isFinite(w * h) || w * h > MAX_CELLS_PER_SURFACE) {
    const scale = Math.sqrt(MAX_CELLS_PER_SURFACE / (w * h));
    const cappedW = Number.isFinite(scale) ? Math.max(1, Math.floor(w * scale)) : 1;
    const cappedH = Number.isFinite(scale) ? Math.max(1, Math.floor(h * scale)) : 1;
    return [cappedW, cappedH];
  }
  return [w, h];
}

/** Clamps a cell coordinate into [0, count - 1]; non-finite values land on the first cell. */
function cellIndex(value: number, count: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value >= count) return count - 1;
  return value + 0;
}

function isTeam(team: TeamId): boolean {
  return team === 0 || team === 1;
}

export function createPaintGrid(stage: Pick<StageData, 'boxes' | 'cellSize'>): IPaintGrid {
  const cellSize =
    Number.isFinite(stage.cellSize) && stage.cellSize > 0 ? stage.cellSize + 0 : 1;

  const surfaces: SurfaceGrid[] = [];
  // Parallel per-surface live counts: allocated cells that actually exist.
  const liveWidths: number[] = [];
  const liveHeights: number[] = [];
  const lookup = new Map<string, SurfaceId>();
  let totalCells = 0;

  for (const [boxIndex, entry] of stage.boxes.entries()) {
    const min = entry.box.min;
    const max = entry.box.max;
    for (const face of entry.paintable) {
      const key = `${boxIndex}:${face}`;
      if (lookup.has(key)) continue;
      const axes = FACE_AXES[face];
      const [extentU, extentV] = faceExtents(face, min, max);
      const [w, h] = boundedGrid(axisCells(extentU, cellSize), axisCells(extentV, cellSize));
      const liveW = liveCells(extentU, cellSize, w);
      const liveH = liveCells(extentV, cellSize, h);
      const data = new Uint8Array(w * h);
      data.fill(NO_TEAM);
      const id = surfaces.length;
      surfaces.push({
        id,
        boxIndex,
        face,
        w,
        h,
        cellSize,
        uLength: extentU,
        vLength: extentV,
        origin: faceOrigin(face, min, max),
        axisU: { ...axes.u },
        axisV: { ...axes.v },
        data,
      });
      liveWidths.push(liveW);
      liveHeights.push(liveH);
      lookup.set(key, id);
      totalCells += liveW * liveH;
    }
  }

  let count0 = 0;
  let count1 = 0;
  const dirty = new Set<SurfaceId>();

  function findSurface(boxIndex: number, face: Face): SurfaceId | null {
    const id = lookup.get(`${boxIndex}:${face}`);
    return id === undefined ? null : id;
  }

  /* ---------- occlusion helpers (scratch objects, no per-call allocation) ---------- */

  const pointBox: Box = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  };
  const segmentOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  const segmentDir: Vec3 = { x: 0, y: 0, z: 0 };

  /** Strict interior test: a point on a face does not count as inside. */
  function pointInAnyBox(x: number, y: number, z: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return true;
    pointBox.min.x = x;
    pointBox.min.y = y;
    pointBox.min.z = z;
    pointBox.max.x = x;
    pointBox.max.y = y;
    pointBox.max.z = z;
    for (const entry of stage.boxes) {
      if (boxOverlap(pointBox, entry.box)) return true;
    }
    return false;
  }

  /** True when the segment crosses the interior of any stage box. */
  function segmentHitsBox(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const limit = len - SEGMENT_ENDPOINT_SLACK;
    if (!Number.isFinite(len) || limit <= LENGTH_EPSILON) return false;
    const inv = 1 / len;
    segmentOrigin.x = ax;
    segmentOrigin.y = ay;
    segmentOrigin.z = az;
    segmentDir.x = dx * inv;
    segmentDir.y = dy * inv;
    segmentDir.z = dz * inv;
    for (const entry of stage.boxes) {
      if (rayBox(segmentOrigin, segmentDir, entry.box, limit) !== null) return true;
    }
    return false;
  }

  /** Squared distance from a projected point to the exact face rectangle. */
  function rectangleReachSquared(u: number, v: number, uLength: number, vLength: number): number {
    const du = u < 0 ? -u : u > uLength ? u - uLength : 0;
    const dv = v < 0 ? -v : v > vLength ? v - vLength : 0;
    return du * du + dv * dv;
  }

  /** Paints the disc and keeps the per-team counters in sync. Returns changed cells. */
  function paintDisc(
    surface: SurfaceGrid,
    u: number,
    v: number,
    radius: number,
    team: TeamId,
    skipOccludedCells: boolean,
  ): number {
    const liveW = liveWidths[surface.id] ?? 0;
    const liveH = liveHeights[surface.id] ?? 0;
    if (liveW <= 0 || liveH <= 0) return 0;

    const cs = surface.cellSize;
    const inv = 1 / cs;
    const w = surface.w;
    const data = surface.data;
    const r2 = radius * radius;

    let cu0 = Math.ceil((u - radius) * inv - 0.5);
    let cu1 = Math.floor((u + radius) * inv - 0.5);
    if (cu1 < 0 || cu0 > liveW - 1) return 0;
    let cv0 = Math.ceil((v - radius) * inv - 0.5);
    let cv1 = Math.floor((v + radius) * inv - 0.5);
    if (cv1 < 0 || cv0 > liveH - 1) return 0;

    if (cu0 < 0) cu0 = 0;
    if (cu1 > liveW - 1) cu1 = liveW - 1;
    if (cv0 < 0) cv0 = 0;
    if (cv1 > liveH - 1) cv1 = liveH - 1;

    const ox = surface.origin.x;
    const oy = surface.origin.y;
    const oz = surface.origin.z;
    const ux = surface.axisU.x;
    const uy = surface.axisU.y;
    const uz = surface.axisU.z;
    const vx = surface.axisV.x;
    const vy = surface.axisV.y;
    const vz = surface.axisV.z;

    let changed = 0;
    for (let cv = cv0; cv <= cv1; cv += 1) {
      const vCentre = (cv + 0.5) * cs;
      const dv = vCentre - v;
      const dv2 = dv * dv;
      const row = cv * w;
      const rowX = ox + vx * vCentre;
      const rowY = oy + vy * vCentre;
      const rowZ = oz + vz * vCentre;
      for (let cu = cu0; cu <= cu1; cu += 1) {
        const uCentre = (cu + 0.5) * cs;
        const du = uCentre - u;
        if (du * du + dv2 > r2) continue;
        if (
          skipOccludedCells &&
          pointInAnyBox(rowX + ux * uCentre, rowY + uy * uCentre, rowZ + uz * uCentre)
        ) {
          continue;
        }
        const index = row + cu;
        const old = data[index];
        if (old === team) continue;
        if (old === 0) count0 -= 1;
        else if (old === 1) count1 -= 1;
        data[index] = team;
        if (team === 0) count0 += 1;
        else count1 += 1;
        changed += 1;
      }
    }
    if (changed > 0) dirty.add(surface.id);
    return changed;
  }

  function splat(surfaceId: SurfaceId, u: number, v: number, radius: number, team: TeamId): number {
    const surface = surfaces[surfaceId];
    if (!surface) return 0;
    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(radius)) return 0;
    if (radius <= 0) return 0;
    if (!isTeam(team)) return 0;
    return paintDisc(surface, u, v, radius, team, false);
  }

  function splatHit(hit: SurfaceHit, radius: number, team: TeamId): number {
    if (!Number.isFinite(radius) || radius <= 0) return 0;
    if (!isTeam(team)) return 0;
    const p = hit.pos;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return 0;

    const hitId = findSurface(hit.boxIndex, hit.face);
    const faceAxes = FACE_AXES[hit.face];
    const hitNormal = hit.normal;
    let nx = faceAxes.n.x;
    let ny = faceAxes.n.y;
    let nz = faceAxes.n.z;
    if (
      hitNormal &&
      Number.isFinite(hitNormal.x) &&
      Number.isFinite(hitNormal.y) &&
      Number.isFinite(hitNormal.z)
    ) {
      const lengthSquared =
        hitNormal.x * hitNormal.x + hitNormal.y * hitNormal.y + hitNormal.z * hitNormal.z;
      if (lengthSquared > 1e-12) {
        nx = hitNormal.x;
        ny = hitNormal.y;
        nz = hitNormal.z;
      }
    }

    let total = 0;

    for (const surface of surfaces) {
      const axes = FACE_AXES[surface.face];
      const origin = surface.origin;
      const px = p.x - origin.x;
      const py = p.y - origin.y;
      const pz = p.z - origin.z;
      const u = px * axes.u.x + py * axes.u.y + pz * axes.u.z;
      const v = px * axes.v.x + py * axes.v.y + pz * axes.v.z;
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;

      const isHitSurface = surface.id === hitId;
      let effective: number;
      if (isHitSurface) {
        effective = radius;
      } else {
        const signed = px * axes.n.x + py * axes.n.y + pz * axes.n.z;
        const planeDistance = Math.abs(signed);
        if (!(planeDistance <= radius)) continue;
        if (
          rectangleReachSquared(u, v, surface.uLength, surface.vLength) >
          radius * radius
        ) {
          continue;
        }

        // The projected disc centre must not sit inside solid stage geometry.
        const projX = p.x - axes.n.x * signed;
        const projY = p.y - axes.n.y * signed;
        const projZ = p.z - axes.n.z * signed;
        if (pointInAnyBox(projX, projY, projZ)) continue;

        // The connecting segment must not tunnel through a solid box.
        if (
          segmentHitsBox(
            p.x + nx * SURFACE_OFFSET,
            p.y + ny * SURFACE_OFFSET,
            p.z + nz * SURFACE_OFFSET,
            projX + axes.n.x * SURFACE_OFFSET,
            projY + axes.n.y * SURFACE_OFFSET,
            projZ + axes.n.z * SURFACE_OFFSET,
          )
        ) {
          continue;
        }

        // Stable form of sqrt(r^2 - d^2); both factors are non-negative.
        effective = Math.sqrt((radius - planeDistance) * (radius + planeDistance));
        if (!(effective > 0)) continue;
      }

      // Cheap reject: the nearest existing cell centre must be inside the disc.
      const liveW = liveWidths[surface.id] ?? 0;
      const liveH = liveHeights[surface.id] ?? 0;
      if (liveW <= 0 || liveH <= 0) continue;
      const cs = surface.cellSize;
      const cu = cellIndex(Math.floor(u / cs), liveW);
      const cv = cellIndex(Math.floor(v / cs), liveH);
      const du = (cu + 0.5) * cs - u;
      const dv = (cv + 0.5) * cs - v;
      if (du * du + dv * dv > effective * effective) continue;

      total += paintDisc(surface, u, v, effective, team, !isHitSurface);
    }
    return total;
  }

  function sampleHit(hit: SurfaceHit): CellValue {
    const id = findSurface(hit.boxIndex, hit.face);
    if (id === null) return NO_TEAM;
    const surface = surfaces[id];
    if (!surface) return NO_TEAM;
    const p = hit.pos;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return NO_TEAM;

    const axes = FACE_AXES[surface.face];
    const origin = surface.origin;
    const px = p.x - origin.x;
    const py = p.y - origin.y;
    const pz = p.z - origin.z;
    const u = px * axes.u.x + py * axes.u.y + pz * axes.u.z;
    const v = px * axes.v.x + py * axes.v.y + pz * axes.v.z;
    if (!Number.isFinite(u) || !Number.isFinite(v)) return NO_TEAM;

    // Hits only count when they fall on the real face, not the padded allocation.
    if (
      u < -LENGTH_EPSILON ||
      v < -LENGTH_EPSILON ||
      u > surface.uLength + LENGTH_EPSILON ||
      v > surface.vLength + LENGTH_EPSILON
    ) {
      return NO_TEAM;
    }

    const liveW = liveWidths[surface.id] ?? 0;
    const liveH = liveHeights[surface.id] ?? 0;
    if (liveW <= 0 || liveH <= 0) return NO_TEAM;

    const cu = cellIndex(Math.floor(u / surface.cellSize), liveW);
    const cv = cellIndex(Math.floor(v / surface.cellSize), liveH);
    const value = surface.data[cv * surface.w + cu];
    return value === 0 || value === 1 ? value : NO_TEAM;
  }

  return {
    surfaces,
    surfaceAt: findSurface,
    sampleHit,
    splatHit,
    splat,
    counts(): [number, number] {
      return [count0, count1];
    },
    totalCells(): number {
      return totalCells;
    },
    takeDirty(): SurfaceId[] {
      const out = Array.from(dirty);
      out.sort((a, b) => a - b);
      dirty.clear();
      return out;
    },
  };
}
