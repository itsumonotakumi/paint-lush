import type { Vec3 } from '../types';

/**
 * Orientation convention. Yaw 0 faces -Z and positive yaw turns right.
 * Positive pitch looks up.
 */
export function forwardFromYaw(yaw: number): Vec3 {
  return { x: Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

export function rightFromYaw(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: Math.sin(yaw) };
}

export function aimDirection(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}
