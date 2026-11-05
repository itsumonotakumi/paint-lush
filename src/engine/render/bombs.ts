import { Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import type { WorldSnapshot } from '../../core/snapshot';
import type { RenderModule, RenderModuleDeps } from './module';

/** Maximum simultaneous bombs the renderer draws. */
export const BOMB_CAPACITY = 32;
/** Radius of one chubby bomb, in metres. */
export const BOMB_RADIUS = 0.28;
/** Vertical squash so the sphere reads as a plump little bomb. */
export const BOMB_SQUASH = 0.9;
/** Pulse speed in radians per second when the fuse is at its longest. */
export const BOMB_PULSE_SLOW = 7;
/** Pulse speed in radians per second when the fuse is about to blow. */
export const BOMB_PULSE_FAST = 34;
/** Extra scale at the peak of the pulse. */
export const BOMB_PULSE_AMOUNT = 0.18;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Pulse rate scaled by the remaining fuse: slower while the fuse is long,
 * frantic as it falls towards zero. Pure and allocation-free.
 */
export function bombPulseRate(fuse: number): number {
  const remaining = clamp01(finite(fuse, 0));
  return BOMB_PULSE_SLOW + (BOMB_PULSE_FAST - BOMB_PULSE_SLOW) * (1 - remaining);
}

/** Chubby scale for one bomb at a moment in time. Always finite and positive. */
export function bombPulseScale(fuse: number, elapsed: number): number {
  const phase = finite(elapsed, 0) * bombPulseRate(fuse);
  const wave = Math.sin(Number.isFinite(phase) ? phase : 0);
  const scale = 1 + BOMB_PULSE_AMOUNT * (0.5 + 0.5 * wave);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * Draws every smoke bomb in the snapshot as a pulsing team-coloured sphere.
 * The instance buffers are preallocated, so a frame never allocates.
 */
export function createBombs(deps: RenderModuleDeps): RenderModule {
  const { scene } = deps;

  const geometry: BufferGeometry = new SphereGeometry(BOMB_RADIUS, 14, 10);
  const material = new MeshBasicMaterial({ toneMapped: false });
  const bombs = new InstancedMesh(geometry, material, BOMB_CAPACITY);
  bombs.instanceMatrix.setUsage(DynamicDrawUsage);
  bombs.frustumCulled = false;
  bombs.count = 0;
  scene.add(bombs);

  const colors: [Color, Color] = [new Color(0xffffff), new Color(0xffffff)];
  colors[0].setHex(Number.isFinite(deps.teamColors[0]) ? deps.teamColors[0] : 0xffffff);
  colors[1].setHex(Number.isFinite(deps.teamColors[1]) ? deps.teamColors[1] : 0xffffff);

  const scratchMatrix = new Matrix4();
  const scratchPosition = new Vector3();
  const scratchScale = new Vector3();

  let elapsed = 0;
  let disposed = false;

  function update(dtSec: number, _prev: WorldSnapshot, curr: WorldSnapshot): void {
    if (disposed) return;
    const dt = finite(dtSec, 0);
    elapsed = Number.isFinite(elapsed + dt) ? elapsed + dt : 0;

    let count = 0;
    for (let i = 0; i < curr.bombs.length && count < BOMB_CAPACITY; i += 1) {
      const bomb = curr.bombs[i];
      if (bomb === undefined) continue;

      const scale = bombPulseScale(bomb.fuse, elapsed);
      scratchPosition.set(finite(bomb.pos.x), finite(bomb.pos.y), finite(bomb.pos.z));
      scratchScale.set(scale, scale * BOMB_SQUASH, scale);
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(scratchPosition);

      bombs.setMatrixAt(count, scratchMatrix);
      bombs.setColorAt(count, bomb.team === 0 ? colors[0] : colors[1]);
      count += 1;
    }

    bombs.count = count;
    if (count > 0) {
      bombs.instanceMatrix.needsUpdate = true;
      if (bombs.instanceColor) bombs.instanceColor.needsUpdate = true;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    scene.remove(bombs);
    geometry.dispose();
    material.dispose();
  }

  return { update, dispose };
}
