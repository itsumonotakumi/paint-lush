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

/** Seconds the opening sweep spends orbiting the stage before easing out. */
export const PRE_ORBIT_SECONDS = 2.2;
/** Seconds the opening sweep spends easing into the player's normal camera. */
export const PRE_BLEND_SECONDS = 0.8;
/** Total length of the opening sweep, in seconds (plan ch. 3, step 1). */
export const PRE_SWEEP_SECONDS = PRE_ORBIT_SECONDS + PRE_BLEND_SECONDS;
/** Horizontal radius of the opening orbit, in metres. */
export const PRE_ORBIT_RADIUS = 26;
/** Height of the opening orbit above the stage centre, in metres. */
export const PRE_ORBIT_HEIGHT = 14;
/** Arc the opening orbit sweeps through, in radians. */
export const PRE_ORBIT_ARC = Math.PI * 0.6;

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

/** Reused across frames so computeCamera does not allocate on the render path. */
const rayOrigin: Vec3 = { x: 0, y: 0, z: 0 };
const rayDirection: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Third-person camera: four metres behind the head along the aim direction and
 * 1.6 m above it, pulled forwards when a surface blocks the line of sight.
 *
 * The caller supplies a reusable `out` object so a per-frame call does not
 * allocate its result. The aim vector and ray arguments are also scratch.
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
  const cosPitch = Math.cos(pitch);
  const aimX = Math.sin(yaw) * cosPitch;
  const aimY = Math.sin(pitch);
  const aimZ = -Math.cos(yaw) * cosPitch;

  const desiredX = safe(headX - aimX * CAMERA_DISTANCE);
  const desiredY = safe(headY - aimY * CAMERA_DISTANCE + CAMERA_HEIGHT);
  const desiredZ = safe(headZ - aimZ * CAMERA_DISTANCE);

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

    rayOrigin.x = headX;
    rayOrigin.y = headY;
    rayOrigin.z = headZ;
    rayDirection.x = dirX;
    rayDirection.y = dirY;
    rayDirection.z = dirZ;
    const hit = raycast(rayOrigin, rayDirection, dist);

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

  const lookX = safe(headX + aimX * LOOK_AHEAD_DISTANCE);
  const lookY = safe(headY + aimY * LOOK_AHEAD_DISTANCE);
  const lookZ = safe(headZ + aimZ * LOOK_AHEAD_DISTANCE);

  out.position.x = camX;
  out.position.y = camY;
  out.position.z = camZ;
  out.lookTarget.x = lookX;
  out.lookTarget.y = lookY;
  out.lookTarget.z = lookZ;
  out.fov = CAMERA_FOV;
  return out;
}

/**
 * Ease weight from the opening orbit (0) to the player's normal camera (1).
 *
 * `timeLeftInPre` is the seconds left in the pre-match phase, derived from the
 * snapshot tick by the caller. The first {@link PRE_ORBIT_SECONDS} keep the
 * orbit fully in charge; the last {@link PRE_BLEND_SECONDS} smoothstep into the
 * player camera. Non-finite input is treated as the start of the sweep.
 */
export function preCameraBlend(timeLeftInPre: number): number {
  const left = Number.isFinite(timeLeftInPre)
    ? Math.min(PRE_SWEEP_SECONDS, Math.max(0, timeLeftInPre))
    : PRE_SWEEP_SECONDS;
  const elapsed = PRE_SWEEP_SECONDS - left;
  const t = Math.min(1, Math.max(0, (elapsed - PRE_ORBIT_SECONDS) / PRE_BLEND_SECONDS));
  return t * t * (3 - 2 * t);
}

/**
 * Opening camera: a slow orbit over the stage centre at {@link PRE_ORBIT_RADIUS}
 * metres out and {@link PRE_ORBIT_HEIGHT} metres up. The orbit freezes after
 * {@link PRE_ORBIT_SECONDS}; the renderer then crossfades its output toward the
 * player's camera using {@link preCameraBlend}.
 *
 * Writes into `out` and allocates nothing, so it can run every frame. The
 * optional centre defaults to the world origin, matching the shipped stages.
 * All outputs stay finite for hostile input.
 */
export function preCamera(
  timeLeftInPre: number,
  out: CameraOutput,
  centerX = 0,
  centerY = 0,
  centerZ = 0,
): CameraOutput {
  const left = Number.isFinite(timeLeftInPre)
    ? Math.min(PRE_SWEEP_SECONDS, Math.max(0, timeLeftInPre))
    : PRE_SWEEP_SECONDS;
  const elapsed = PRE_SWEEP_SECONDS - left;
  const orbitElapsed = Math.min(elapsed, PRE_ORBIT_SECONDS);
  const angle = PRE_ORBIT_ARC * (orbitElapsed / PRE_ORBIT_SECONDS);

  const cx = safe(centerX);
  const cy = safe(centerY);
  const cz = safe(centerZ);

  out.position.x = safe(cx + Math.sin(angle) * PRE_ORBIT_RADIUS);
  out.position.y = safe(cy + PRE_ORBIT_HEIGHT);
  out.position.z = safe(cz + Math.cos(angle) * PRE_ORBIT_RADIUS);
  out.lookTarget.x = cx;
  out.lookTarget.y = cy;
  out.lookTarget.z = cz;
  out.fov = CAMERA_FOV;
  return out;
}
