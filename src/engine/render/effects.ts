import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { GameEvent } from '../../core/events';
import type { WorldSnapshot } from '../../core/snapshot';
import type { EntityId } from '../../core/types';
import { PALETTE } from './palette';
import { createToonMaterial } from './toon';
import {
  DROPLET_CAPACITY,
  DROPLET_CAPACITY_LOW,
  FovBoostState,
  ParticleSystem,
  ShakeState,
} from './particles';
import type { ParticlePool, Rgb, Vec3Like } from './particles';
import type { EffectsModule, RenderModuleDeps } from './module';

/** Radius of one droplet octahedron, in metres. */
export const DROPLET_RADIUS = 0.06;
/** Where confetti appears above the local player. */
const CONFETTI_HEIGHT = 3.5;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Palette hex to the linear RGB triple the particle pools store. */
function rgbFromHex(hex: number): Rgb {
  const color = new Color(Number.isFinite(hex) ? hex : 0xffffff);
  return { r: color.r, g: color.g, b: color.b };
}

/**
 * Droplets, kill smoke, leaves and confetti, plus the camera shake and field
 * of view offsets that go with them. All pools are preallocated; update only
 * writes into existing typed arrays and instance buffers.
 */
export function createEffects(deps: RenderModuleDeps): EffectsModule {
  const { scene, gradient, localPlayerId } = deps;
  const capacity = deps.lowDetail ? DROPLET_CAPACITY_LOW : DROPLET_CAPACITY;

  const particles = new ParticleSystem(capacity);
  const shakeState = new ShakeState();
  const fovState = new FovBoostState();

  const teamColors: [Rgb, Rgb] = [rgbFromHex(deps.teamColors[0]), rgbFromHex(deps.teamColors[1])];
  const impactColor: Rgb = { r: 1, g: 1, b: 1 };
  const shootColor = rgbFromHex(PALETTE.signYellow);
  const smokeColor = rgbFromHex(PALETTE.smoke);
  const leafColor = rgbFromHex(PALETTE.leaf);

  /* ---------- meshes ---------- */

  const dropletGeometry = new OctahedronGeometry(DROPLET_RADIUS, 0);
  const dropletMaterial = new MeshBasicMaterial({ toneMapped: false });
  const droplets = new InstancedMesh(dropletGeometry, dropletMaterial, capacity);
  droplets.instanceMatrix.setUsage(DynamicDrawUsage);
  droplets.frustumCulled = false;
  droplets.count = 0;

  const smokeGeometry = new SphereGeometry(0.16, 8, 6);
  const smokeMaterial = createToonMaterial(PALETTE.smoke, gradient);
  const smoke = new InstancedMesh(smokeGeometry, smokeMaterial, particles.smoke.capacity);
  smoke.instanceMatrix.setUsage(DynamicDrawUsage);
  smoke.frustumCulled = false;
  smoke.count = 0;

  const leafGeometry = new PlaneGeometry(0.1, 0.15);
  const leafMaterial = new MeshBasicMaterial({
    color: PALETTE.leaf,
    side: DoubleSide,
    toneMapped: false,
  });
  const leaves = new InstancedMesh(leafGeometry, leafMaterial, particles.leaves.capacity);
  leaves.instanceMatrix.setUsage(DynamicDrawUsage);
  leaves.frustumCulled = false;
  leaves.count = 0;

  scene.add(droplets, smoke, leaves);

  /* ---------- per-frame scratch, never reallocated ---------- */

  const scratchMatrix = new Matrix4();
  const scratchQuaternion = new Quaternion();
  const scratchEuler = new Euler();
  const scratchPosition = new Vector3();
  const scratchScale = new Vector3();
  const scratchColor = new Color();

  const focus: Vec3Like = { x: 0, y: 0, z: 0 };
  const positionById = new Map<EntityId, Vec3Like>();
  const confettiOrigin: Vec3Like = { x: 0, y: CONFETTI_HEIGHT, z: 0 };

  let disposed = false;

  /* ---------- helpers ---------- */

  function syncPool(pool: ParticlePool, mesh: InstancedMesh, perInstanceColor: boolean): void {
    const total = pool.count;
    for (let i = 0; i < total; i += 1) {
      const lifeMax = pool.lifeMax[i] ?? 0;
      const life = pool.life[i] ?? 0;
      const progress = lifeMax > 0 ? clamp01(1 - life / lifeMax) : 1;

      const start = pool.sizeStart[i] ?? 1;
      const end = pool.sizeEnd[i] ?? 0;
      const scale = Math.max(0, finite(start + (end - start) * progress, 0));

      scratchPosition.set(pool.x[i] ?? 0, pool.y[i] ?? 0, pool.z[i] ?? 0);
      scratchScale.set(scale, scale, scale);
      scratchEuler.set(pool.rotX[i] ?? 0, pool.rotY[i] ?? 0, pool.rotZ[i] ?? 0);
      scratchQuaternion.setFromEuler(scratchEuler);
      scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);

      mesh.setMatrixAt(i, scratchMatrix);
      if (perInstanceColor) {
        scratchColor.setRGB(pool.r[i] ?? 1, pool.g[i] ?? 1, pool.b[i] ?? 1);
        mesh.setColorAt(i, scratchColor);
      }
    }

    mesh.count = total;
    if (total > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (perInstanceColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Remembers where the local player is so the finish confetti has a place to pop. */
  function trackFocus(curr: WorldSnapshot): void {
    let found = curr.players[0];
    for (let i = 0; i < curr.players.length; i += 1) {
      const player = curr.players[i];
      if (player !== undefined && player.id === localPlayerId) {
        found = player;
        break;
      }
    }
    if (!found) return;
    focus.x = finite(found.pos.x);
    focus.y = finite(found.pos.y);
    focus.z = finite(found.pos.z);
    for (let i = 0; i < curr.players.length; i += 1) {
      const player = curr.players[i];
      if (player === undefined) continue;
      let slot = positionById.get(player.id);
      if (slot === undefined) {
        slot = { x: 0, y: 0, z: 0 };
        positionById.set(player.id, slot);
      }
      slot.x = finite(player.pos.x);
      slot.y = finite(player.pos.y);
      slot.z = finite(player.pos.z);
    }
  }

  /* ---------- RenderModule ---------- */

  function update(dtSec: number, _prev: WorldSnapshot, curr: WorldSnapshot): void {
    const step = Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0;

    particles.update(step);
    shakeState.update(step);
    fovState.update(step);
    trackFocus(curr);

    syncPool(particles.droplets, droplets, true);
    syncPool(particles.smoke, smoke, false);
    syncPool(particles.leaves, leaves, false);
  }

  function handle(event: GameEvent): void {
    switch (event.t) {
      case 'paint':
        particles.spawnPaint(event.pos, teamColors[event.team]);
        break;
      case 'impact':
        particles.spawnImpact(event.pos, impactColor);
        break;
      case 'shoot':
        particles.spawnShootFlash(event.pos, shootColor);
        break;
      case 'hit':
        if (event.target === localPlayerId) shakeState.trigger();
        break;
      case 'kill':
        particles.spawnKill(event.pos, smokeColor, leafColor);
        break;
      case 'special':
        // Only the local player's special changes this camera.
        if (event.id !== localPlayerId) break;
        if (event.phase === 'start') fovState.start();
        else if (event.phase === 'end') fovState.end();
        break;
      case 'sub':
        if (event.phase === 'burst') {
          particles.spawnBombBurst(event.pos, teamColors[event.team], smokeColor);
        }
        break;
      case 'charge': {
        const pos = positionById.get(event.id) ?? focus;
        particles.spawnCharge(pos, shootColor);
        break;
      }
      case 'swing':
        particles.spawnSwing(event.pos, shootColor);
        break;
      case 'phase':
        if (event.phase === 'finished') {
          confettiOrigin.x = focus.x;
          confettiOrigin.y = finite(focus.y + CONFETTI_HEIGHT, CONFETTI_HEIGHT);
          confettiOrigin.z = focus.z;
          particles.spawnConfetti(confettiOrigin, teamColors[0], teamColors[1]);
        }
        break;
      default:
        break;
    }
  }

  function shake(out: { x: number; y: number; z: number }): void {
    shakeState.read(out);
  }

  function fovBoost(): number {
    return fovState.value();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    scene.remove(droplets, smoke, leaves);

    dropletGeometry.dispose();
    dropletMaterial.dispose();
    smokeGeometry.dispose();
    smokeMaterial.dispose();
    leafGeometry.dispose();
    leafMaterial.dispose();
  }

  return { update, handle, shake, fovBoost, dispose };
}
