import { aimDirection } from '../../core/math/aim';
import type { PlayerView } from '../../core/snapshot';
import type { Vec3 } from '../../core/types';
import type { ICollision } from '../../game/contracts';

/** Vertical field of view in degrees. */
export const CAMERA_FOV = 70;
/** Distance the camera sits behind the head, along the aim direction. */
export const CAMERA_DISTANCE = 4;
/** Height of the camera above the head. */
export const CAMERA_HEIGHT = 1.6;
/** Distance from the AABB centre to the player's head. */
export const HEAD_HEIGHT = 0.9;
/** The camera stops this far short of a blocking surface. */
export const COLLISION_MARGIN = 0.2;
/** How far ahead of the head the camera looks. */
export const LOOK_AHEAD_DISTANCE = 10;

export interface CameraOutput {
  position: Vec3;
  lookTarget: Vec3;
  fov: number;
}

function safe(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

function safeAngle(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

/**
 * Third-person camera: four metres behind the head along the aim direction and
 * 1.6 m above it, pulled forwards when a surface blocks the line of sight.
 *
 * The caller supplies a reusable `out` object so a per-frame call does not
 * allocate its result.
 */
export function computeCamera(
  view: PlayerView,
  raycast: ICollision['raycast'],
  out: CameraOutput,
): CameraOutput {
  const headX = safe(view.pos.x);
  const headY = safe(view.pos.y) + HEAD_HEIGHT;
  const headZ = safe(view.pos.z);

  const yaw = safeAngle(view.yaw);
  const pitch = safeAngle(view.pitch);
  const aim = aimDirection(yaw, pitch);

  const desiredX = safe(headX - aim.x * CAMERA_DISTANCE);
  const desiredY = safe(headY - aim.y * CAMERA_DISTANCE + CAMERA_HEIGHT);
  const desiredZ = safe(headZ - aim.z * CAMERA_DISTANCE);

  let camX = desiredX;
  let camY = desiredY;
  let camZ = desiredZ;

  const dx = desiredX - headX;
  const dy = desiredY - headY;
  const dz = desiredZ - headZ;
  const dist = Math.hypot(dx, dy, dz);

  if (dist > 1e-6 && Number.isFinite(dist)) {
    const inv = 1 / dist;
    const dirX = dx * inv;
    const dirY = dy * inv;
    const dirZ = dz * inv;
    const hit = raycast({ x: headX, y: headY, z: headZ }, { x: dirX, y: dirY, z: dirZ }, dist);

    if (hit) {
      const hx = hit.pos.x;
      const hy = hit.pos.y;
      const hz = hit.pos.z;
      if (Number.isFinite(hx) && Number.isFinite(hy) && Number.isFinite(hz)) {
        const hitDist = Math.hypot(hx - headX, hy - headY, hz - headZ);
        if (Number.isFinite(hitDist)) {
          const pulled = Math.max(0, hitDist - COLLISION_MARGIN);
          if (pulled < dist) {
            camX = safe(headX + dirX * pulled);
            camY = safe(headY + dirY * pulled);
            camZ = safe(headZ + dirZ * pulled);
          }
        }
      }
    }
  }

  const lookX = safe(headX + aim.x * LOOK_AHEAD_DISTANCE);
  const lookY = safe(headY + aim.y * LOOK_AHEAD_DISTANCE);
  const lookZ = safe(headZ + aim.z * LOOK_AHEAD_DISTANCE);

  out.position.x = camX;
  out.position.y = camY;
  out.position.z = camZ;
  out.lookTarget.x = lookX;
  out.lookTarget.y = lookY;
  out.lookTarget.z = lookZ;
  out.fov = CAMERA_FOV;
  return out;
}
