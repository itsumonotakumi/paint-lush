import type { Vec3 } from '../types';

const TAU = Math.PI * 2;

/** Keeps helper results finite; non-finite inputs collapse to 0. */
function safe(n: number): number {
  // `+ 0` also normalises -0 to 0 so comparisons and snapshots stay stable.
  return Number.isFinite(n) ? n + 0 : 0;
}

/** Creates a finite vector. Non-finite components become 0. */
export function vec3(x: number, y: number, z: number): Vec3 {
  return { x: safe(x), y: safe(y), z: safe(z) };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: safe(a.x + b.x), y: safe(a.y + b.y), z: safe(a.z + b.z) };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: safe(a.x - b.x), y: safe(a.y - b.y), z: safe(a.z - b.z) };
}

export function scale(v: Vec3, k: number): Vec3 {
  const factor = safe(k);
  return { x: safe(v.x * factor), y: safe(v.y * factor), z: safe(v.z * factor) };
}

export function dot(a: Vec3, b: Vec3): number {
  return safe(a.x * b.x + a.y * b.y + a.z * b.z);
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: safe(a.y * b.z - a.z * b.y),
    y: safe(a.z * b.x - a.x * b.z),
    z: safe(a.x * b.y - a.y * b.x),
  };
}

export function length(v: Vec3): number {
  const x = safe(v.x);
  const y = safe(v.y);
  const z = safe(v.z);
  const max = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (max === 0) return 0;
  // Scale first so tiny (subnormal) and huge vectors do not underflow/overflow early.
  const len = Math.hypot(x / max, y / max, z / max) * max;
  return Number.isFinite(len) ? len : Number.MAX_VALUE;
}

/** Returns a unit vector, or the zero vector when the input has zero length. */
export function normalize(v: Vec3): Vec3 {
  const x = safe(v.x);
  const y = safe(v.y);
  const z = safe(v.z);
  const max = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (max === 0) return { x: 0, y: 0, z: 0 };
  const sx = x / max;
  const sy = y / max;
  const sz = z / max;
  const len = Math.hypot(sx, sy, sz);
  return { x: safe(sx / len), y: safe(sy / len), z: safe(sz / len) };
}

/** Linear interpolation; `t` is not clamped. */
export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const w = safe(t);
  return {
    x: safe(a.x + (b.x - a.x) * w),
    y: safe(a.y + (b.y - a.y) * w),
    z: safe(a.z + (b.z - a.z) * w),
  };
}

/** Clamps `v` into [min, max]. Reversed bounds are accepted. */
export function clamp(v: number, min: number, max: number): number {
  const lo = safe(min);
  const hi = safe(max);
  const low = lo <= hi ? lo : hi;
  const high = lo <= hi ? hi : lo;
  if (!Number.isFinite(v)) return low;
  return Math.min(high, Math.max(low, v));
}

/**
 * Interpolates angles along the shortest arc. The result may lie outside
 * [-PI, PI] but is always angularly equivalent to the arc between `a` and `b`.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  const from = safe(a);
  const to = safe(b);
  const w = safe(t);
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  else if (delta <= -Math.PI) delta += TAU;
  if (!Number.isFinite(delta)) delta = 0;
  return safe(from + delta * w);
}
