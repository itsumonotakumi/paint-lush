import type { Box, Face, Vec3 } from '../types';

function safe(n: number): number {
  // `+ 0` also normalises -0 to 0 so comparisons and snapshots stay stable.
  return Number.isFinite(n) ? n + 0 : 0;
}

function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function finiteBox(box: Box): boolean {
  return finiteVec(box.min) && finiteVec(box.max);
}

/**
 * True when the interiors of both boxes share space on all three axes.
 * Boxes that only touch along a face, edge or corner do not overlap.
 */
export function boxOverlap(a: Box, b: Box): boolean {
  if (!finiteBox(a) || !finiteBox(b)) return false;

  const aminX = a.min.x;
  const aminY = a.min.y;
  const aminZ = a.min.z;
  const amaxX = a.max.x;
  const amaxY = a.max.y;
  const amaxZ = a.max.z;
  const bminX = b.min.x;
  const bminY = b.min.y;
  const bminZ = b.min.z;
  const bmaxX = b.max.x;
  const bmaxY = b.max.y;
  const bmaxZ = b.max.z;

  // Inverted boxes never overlap anything.
  if (aminX > amaxX || aminY > amaxY || aminZ > amaxZ) return false;
  if (bminX > bmaxX || bminY > bmaxY || bminZ > bmaxZ) return false;

  return (
    aminX < bmaxX &&
    bminX < amaxX &&
    aminY < bmaxY &&
    bminY < amaxY &&
    aminZ < bmaxZ &&
    bminZ < amaxZ
  );
}

/** Builds an axis-aligned box from a centre and half extents (absolute values). */
export function boxAround(center: Vec3, half: Vec3): Box {
  const cx = safe(center.x);
  const cy = safe(center.y);
  const cz = safe(center.z);
  const hx = Math.abs(safe(half.x));
  const hy = Math.abs(safe(half.y));
  const hz = Math.abs(safe(half.z));
  return {
    min: { x: safe(cx - hx), y: safe(cy - hy), z: safe(cz - hz) },
    max: { x: safe(cx + hx), y: safe(cy + hy), z: safe(cz + hz) },
  };
}

/** Outward unit normal of a face. */
export function faceNormal(face: Face): Vec3 {
  switch (face) {
    case '+x':
      return { x: 1, y: 0, z: 0 };
    case '-x':
      return { x: -1, y: 0, z: 0 };
    case '+y':
      return { x: 0, y: 1, z: 0 };
    case '-y':
      return { x: 0, y: -1, z: 0 };
    case '+z':
      return { x: 0, y: 0, z: 1 };
    case '-z':
      return { x: 0, y: 0, z: -1 };
  }
}

/**
 * Slab-method ray/box intersection.
 *
 * `t` is measured in multiples of `dir` (with a unit direction it is metres),
 * and the hit point is `origin + dir * t`. Returns null when the box is behind
 * the ray, when the hit is farther than `maxDist`, when `dir` is zero, or when
 * the origin starts inside the box. Rays parallel to a slab are accepted when
 * the origin lies within that slab.
 */
export function rayBox(
  origin: Vec3,
  dir: Vec3,
  box: Box,
  maxDist: number,
): { t: number; face: Face } | null {
  const limit = maxDist;
  if (!finiteVec(origin) || !finiteVec(dir) || !finiteBox(box)) return null;
  if (Number.isNaN(limit) || limit < 0) return null;

  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;
  const dx = dir.x;
  const dy = dir.y;
  const dz = dir.z;

  if (dx === 0 && dy === 0 && dz === 0) return null;

  let minX = box.min.x;
  let minY = box.min.y;
  let minZ = box.min.z;
  let maxX = box.max.x;
  let maxY = box.max.y;
  let maxZ = box.max.z;
  if (minX > maxX) {
    const swap = minX;
    minX = maxX;
    maxX = swap;
  }
  if (minY > maxY) {
    const swap = minY;
    minY = maxY;
    maxY = swap;
  }
  if (minZ > maxZ) {
    const swap = minZ;
    minZ = maxZ;
    maxZ = swap;
  }

  let tMin = -Infinity;
  let tMax = Infinity;
  let face: Face | null = null;

  if (dx === 0) {
    if (ox < minX || ox > maxX) return null;
  } else {
    const t1 = (minX - ox) / dx;
    const t2 = (maxX - ox) / dx;
    const near = t1 < t2 ? t1 : t2;
    const far = t1 < t2 ? t2 : t1;
    if (near > tMin) {
      tMin = near;
      face = dx > 0 ? '-x' : '+x';
    }
    if (far < tMax) tMax = far;
  }

  if (dy === 0) {
    if (oy < minY || oy > maxY) return null;
  } else {
    const t1 = (minY - oy) / dy;
    const t2 = (maxY - oy) / dy;
    const near = t1 < t2 ? t1 : t2;
    const far = t1 < t2 ? t2 : t1;
    if (near > tMin) {
      tMin = near;
      face = dy > 0 ? '-y' : '+y';
    }
    if (far < tMax) tMax = far;
  }

  if (dz === 0) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    const t1 = (minZ - oz) / dz;
    const t2 = (maxZ - oz) / dz;
    const near = t1 < t2 ? t1 : t2;
    const far = t1 < t2 ? t2 : t1;
    if (near > tMin) {
      tMin = near;
      face = dz > 0 ? '-z' : '+z';
    }
    if (far < tMax) tMax = far;
  }

  if (face === null) return null;
  if (!Number.isFinite(tMin)) return null;
  if (tMax < tMin || tMax < 0) return null;
  // tMin < 0 means the origin is strictly inside the box.
  if (tMin < 0) return null;
  if (tMin > limit) return null;

  return { t: tMin === 0 ? 0 : tMin, face };
}
