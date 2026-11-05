import type { PlayerStateName } from '../../core/snapshot';

/** Animation channels for one ninja, all in radians or metres. */
export interface NinjaPose {
  legSwing: number;
  armSwing: number;
  lean: number;
  bounce: number;
  tailSwing: number;
}

/** Horizontal speed above which the run cycle takes over from idle. */
export const RUN_SPEED = 0.5;
/** Angular frequency of the run cycle, radians per second. */
export const RUN_FREQUENCY = 14;
/** Angular frequency of the idle breathing cycle, radians per second. */
const IDLE_FREQUENCY = 7;

function safe(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Reusable pose buffer so the renderer can sample every frame without allocating. */
export function createNinjaPose(): NinjaPose {
  return { legSwing: 0, armSwing: 0, lean: 0, bounce: 0, tailSwing: 0 };
}

/**
 * Samples the procedural ninja animation. Pure: no clock, no randomness.
 *
 * `t` is seconds, `speed` is the horizontal speed in metres per second, and
 * `out` may be supplied to avoid allocating in the render loop.
 */
export function pose(
  t: number,
  speed: number,
  state: PlayerStateName,
  out: NinjaPose = createNinjaPose(),
): NinjaPose {
  const time = safe(t);
  const rate = Math.max(0, safe(speed));

  out.legSwing = 0;
  out.armSwing = 0;
  out.lean = 0;
  out.bounce = 0;
  out.tailSwing = 0;

  if (state === 'dive' || state === 'down' || state === 'respawn') return out;

  if (state === 'air') {
    // Tucked legs and arms lifted above the head.
    out.legSwing = -0.9;
    out.armSwing = -2.2;
    out.lean = 0.08;
    return out;
  }

  if (rate > RUN_SPEED) {
    const phase = time * RUN_FREQUENCY;
    const stride = Math.sin(phase);
    out.legSwing = clamp(stride * 0.8, -1.2, 1.2);
    out.armSwing = -out.legSwing;
    out.lean = 0.15;
    out.bounce = Math.abs(stride) * 0.04;
    out.tailSwing = stride * 0.35;
    return out;
  }

  // Idle: a slow breath plus a small arm and tail sway.
  const breath = Math.sin(time * IDLE_FREQUENCY);
  out.bounce = Math.abs(breath) * 0.02;
  out.armSwing = breath * 0.04;
  out.tailSwing = breath * 0.12;
  return out;
}
