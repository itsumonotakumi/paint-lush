import type { GameEvent } from '../../core/events';
import type { BombView } from '../../core/snapshot';
import type { EntityId, SurfaceHit, TeamId, Tick, Vec3 } from '../../core/types';
import { aimDirection } from '../../core/math/aim';
import type {
  DamageHit,
  FireResult,
  ICollision,
  IPaintGrid,
  ISubSystem,
  ShooterState,
  StepResult,
  TargetState,
} from '../contracts';
import type { SubWeapon } from '../data/schemas';

/** Fixed bomb capacity. The oldest live bomb is recycled when full. */
const POOL_SIZE = 32;
/** Separation kept from a surface after a bounce, in metres. */
const SURFACE_SKIN = 1e-3;
/** A contact with at least this much +Y counts as a floor. */
const FLOOR_NORMAL_Y = 0.7;
/** Below this post-bounce speed a bomb on a floor comes to rest. */
const REST_SPEED = 0.75;
/** Downward probe used to find the surface under a bursting bomb. */
const BLAST_PROBE = 1000;
/** Fraction of centre damage still dealt at the very edge of the blast. */
const EDGE_DAMAGE_FACTOR = 0.3;
const FUSE_EPS = 1e-9;
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

interface Slot {
  active: boolean;
  id: number;
  team: TeamId;
  owner: EntityId;
  /** Shared with `view.pos`; mutated in place so snapshots stay cheap. */
  pos: Vec3;
  vel: Vec3;
  /** Seconds since the throw. */
  age: number;
  fuseStarted: boolean;
  /** Seconds since the fuse was lit. */
  fuseAge: number;
  /** Last stage surface touched, used to burst against a wall. */
  lastHit: SurfaceHit | null;
  /** A bomb resting on a floor stops simulating until it bursts. */
  resting: boolean;
  serial: number;
  view: BombView;
}

/** Keeps a number finite. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value + 0 : fallback;
}

/** Finite, non-negative number. */
function nonNegative(value: number): number {
  const safe = finiteOr(value, 0);
  return safe > 0 ? safe : 0;
}

function addSafe(a: number, b: number): number {
  const sum = a + b;
  return Number.isFinite(sum) ? sum : a;
}

/** Overflow-safe length; never returns NaN or Infinity. */
function vecLength(x: number, y: number, z: number): number {
  const max = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (!Number.isFinite(max) || max === 0) return 0;
  const len = Math.hypot(x / max, y / max, z / max) * max;
  if (!Number.isFinite(len)) return Number.MAX_VALUE;
  return len + 0;
}

function copyPos(v: Vec3): Vec3 {
  return { x: finiteOr(v.x, 0), y: finiteOr(v.y, 0), z: finiteOr(v.z, 0) };
}

function emptyResult(): FireResult {
  return {
    fired: false,
    inkSpent: 0,
    events: [],
    charging: 0,
    moveMultiplier: 1,
    hits: [],
  };
}

/**
 * Creates the thrown-bomb sub system. It owns no cooldown: the caller decides
 * when a throw is allowed and passes a finite tick only to match the contract.
 */
export function createSubSystem(
  sub: SubWeapon,
  deps: { collision: ICollision; paint: IPaintGrid },
): ISubSystem {
  const { collision, paint } = deps;

  const inkCost = nonNegative(sub.inkCost);
  const throwSpeed = nonNegative(sub.throwSpeed);
  const throwPitch = finiteOr(sub.throwPitchRadians, 0);
  const gravity = nonNegative(sub.gravity);
  const restitutionRaw = finiteOr(sub.restitution, 0);
  const restitution = Math.min(1, Math.max(0, restitutionRaw));
  const fuseRaw = finiteOr(sub.fuseSeconds, 0);
  const fuseSeconds = fuseRaw > 0 ? fuseRaw : 1;
  const blastRadius = nonNegative(sub.blastRadius);
  const damage = nonNegative(sub.damage);
  const lifetime = nonNegative(sub.lifetimeSeconds);

  const slots: Slot[] = [];
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const pos: Vec3 = { x: 0, y: 0, z: 0 };
    const view: BombView = { id: 0, team: 0, pos, fuse: 1 };
    slots.push({
      active: false,
      id: 0,
      team: 0,
      owner: 0,
      pos,
      vel: { x: 0, y: 0, z: 0 },
      age: 0,
      fuseStarted: false,
      fuseAge: 0,
      lastHit: null,
      resting: false,
      serial: 0,
      view,
    });
  }

  /** Reused output array for `bombs()`. */
  const output: BombView[] = [];

  let nextId = 0;
  let spawnSerial = 0;

  const scratchOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  const scratchDir: Vec3 = { x: 0, y: 0, z: 0 };

  function allocateSlot(): Slot {
    let oldest: Slot | null = null;
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const slot = slots[i];
      if (slot === undefined) continue;
      if (!slot.active) return slot;
      if (oldest === null || slot.serial < oldest.serial) oldest = slot;
    }
    if (oldest !== null) return oldest;
    return slots[0]!;
  }

  function tryThrow(thrower: ShooterState, tick: Tick): FireResult {
    void tick;
    if (!thrower.canFire) return emptyResult();

    const mods = thrower.mods;
    const multiplierRaw = mods && Number.isFinite(mods.inkCostMul) ? mods.inkCostMul : 1;
    const multiplier = multiplierRaw > 0 ? multiplierRaw : 0;
    let cost = inkCost * multiplier;
    if (!Number.isFinite(cost)) cost = inkCost;
    if (!(cost > 0)) cost = 0;
    if (!(thrower.ink >= cost)) return emptyResult();

    const yaw = finiteOr(thrower.yaw, 0);
    const pitch = finiteOr(thrower.pitch, 0) + throwPitch;
    const direction = aimDirection(yaw, pitch);

    const slot = allocateSlot();
    slot.active = true;
    slot.id = nextId;
    slot.team = thrower.team;
    slot.owner = thrower.id;
    slot.pos.x = finiteOr(thrower.pos.x, 0);
    slot.pos.y = finiteOr(thrower.pos.y, 0);
    slot.pos.z = finiteOr(thrower.pos.z, 0);
    slot.vel.x = finiteOr(direction.x * throwSpeed, 0);
    slot.vel.y = finiteOr(direction.y * throwSpeed, 0);
    slot.vel.z = finiteOr(direction.z * throwSpeed, 0);
    slot.age = 0;
    slot.fuseStarted = false;
    slot.fuseAge = 0;
    slot.lastHit = null;
    slot.resting = false;
    slot.serial = spawnSerial;
    slot.view.id = slot.id;
    slot.view.team = slot.team;
    slot.view.fuse = 1;

    nextId += 1;
    spawnSerial += 1;

    return {
      fired: true,
      inkSpent: cost,
      events: [
        { t: 'sub', phase: 'throw', team: thrower.team, pos: copyPos(slot.pos) },
      ],
      charging: 0,
      moveMultiplier: 1,
      hits: [],
    };
  }

  function burst(
    slot: Slot,
    targets: readonly TargetState[],
    events: GameEvent[],
    hits: DamageHit[],
  ): void {
    slot.active = false;

    const bx = slot.pos.x;
    const by = slot.pos.y;
    const bz = slot.pos.z;

    scratchOrigin.x = bx;
    scratchOrigin.y = by;
    scratchOrigin.z = bz;
    const below = collision.raycast(scratchOrigin, DOWN, BLAST_PROBE);
    const surface = below !== null ? below : slot.lastHit;

    events.push({
      t: 'sub',
      phase: 'burst',
      team: slot.team,
      pos: { x: bx, y: by, z: bz },
    });

    if (surface !== null) {
      const changed = paint.splatHit(surface, blastRadius, slot.team);
      const cells = Number.isFinite(changed) && changed > 0 ? changed : 0;
      events.push({
        t: 'paint',
        team: slot.team,
        cells,
        pos: copyPos(surface.pos),
        by: slot.owner,
      });
    }

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      if (target === undefined) continue;
      if (target.team === slot.team || !target.hittable) continue;

      const tx = target.pos.x;
      const ty = target.pos.y;
      const tz = target.pos.z;
      if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) continue;

      const dx = tx - bx;
      const dy = ty - by;
      const dz = tz - bz;
      const distance = vecLength(dx, dy, dz);
      if (distance > blastRadius) continue;

      if (distance > 0) {
        const inv = 1 / distance;
        scratchOrigin.x = bx;
        scratchOrigin.y = by;
        scratchOrigin.z = bz;
        scratchDir.x = finiteOr(dx * inv, 0);
        scratchDir.y = finiteOr(dy * inv, 0);
        scratchDir.z = finiteOr(dz * inv, 0);
        const blocked = collision.raycast(scratchOrigin, scratchDir, distance);
        if (blocked !== null) continue;
      }

      const ratio = blastRadius > 0 ? Math.min(1, distance / blastRadius) : 0;
      const dealt = damage * (1 - (1 - EDGE_DAMAGE_FACTOR) * ratio);
      hits.push({
        target: target.id,
        attacker: slot.owner,
        damage: Number.isFinite(dealt) ? dealt : damage,
        pos: { x: tx, y: ty, z: tz },
      });
    }
  }

  function step(dt: number, targets: readonly TargetState[]): StepResult {
    const events: GameEvent[] = [];
    const hits: DamageHit[] = [];

    if (!Number.isFinite(dt) || dt <= 0) return { events, hits };

    for (let i = 0; i < POOL_SIZE; i += 1) {
      const slot = slots[i];
      if (slot === undefined || !slot.active) continue;

      slot.age = addSafe(slot.age, dt);

      // Gravity first, then a swept move for the whole step. A bomb that has
      // come to rest on a floor stays put until its fuse runs out.
      let contact = false;
      if (!slot.resting) {
        slot.vel.x = finiteOr(slot.vel.x, 0);
        slot.vel.y = finiteOr(slot.vel.y - gravity * dt, 0);
        slot.vel.z = finiteOr(slot.vel.z, 0);

        const sx = slot.pos.x;
        const sy = slot.pos.y;
        const sz = slot.pos.z;
        const segX = finiteOr(slot.vel.x * dt, 0);
        const segY = finiteOr(slot.vel.y * dt, 0);
        const segZ = finiteOr(slot.vel.z * dt, 0);
        const distance = vecLength(segX, segY, segZ);

        if (distance > 0) {
          const inv = 1 / distance;
          scratchOrigin.x = sx;
          scratchOrigin.y = sy;
          scratchOrigin.z = sz;
          scratchDir.x = finiteOr(segX * inv, 0);
          scratchDir.y = finiteOr(segY * inv, 0);
          scratchDir.z = finiteOr(segZ * inv, 0);

          const hit = collision.raycast(scratchOrigin, scratchDir, distance);
          if (hit !== null) {
            contact = true;
            slot.lastHit = hit;
            slot.pos.x = finiteOr(hit.pos.x + hit.normal.x * SURFACE_SKIN, sx);
            slot.pos.y = finiteOr(hit.pos.y + hit.normal.y * SURFACE_SKIN, sy);
            slot.pos.z = finiteOr(hit.pos.z + hit.normal.z * SURFACE_SKIN, sz);

            const nx = finiteOr(hit.normal.x, 0);
            const ny = finiteOr(hit.normal.y, 0);
            const nz = finiteOr(hit.normal.z, 0);
            const vn = slot.vel.x * nx + slot.vel.y * ny + slot.vel.z * nz;
            if (vn < 0) {
              const impulse = -(1 + restitution) * vn;
              slot.vel.x = finiteOr(slot.vel.x + nx * impulse, 0);
              slot.vel.y = finiteOr(slot.vel.y + ny * impulse, 0);
              slot.vel.z = finiteOr(slot.vel.z + nz * impulse, 0);
            }

            const speed = vecLength(slot.vel.x, slot.vel.y, slot.vel.z);
            if (ny >= FLOOR_NORMAL_Y && speed < REST_SPEED) {
              slot.vel.x = 0;
              slot.vel.y = 0;
              slot.vel.z = 0;
              slot.resting = true;
            }
          } else {
            slot.pos.x = addSafe(sx, segX);
            slot.pos.y = addSafe(sy, segY);
            slot.pos.z = addSafe(sz, segZ);
          }
        }
      }

      if (!slot.fuseStarted) {
        // The fuse lights on the first contact, or when the bomb has existed
        // for its whole lifetime without touching anything.
        if (contact || slot.age >= lifetime) {
          slot.fuseStarted = true;
          slot.fuseAge = 0;
        }
      } else {
        slot.fuseAge = addSafe(slot.fuseAge, dt);
      }

      if (slot.fuseStarted && slot.fuseAge + FUSE_EPS >= fuseSeconds) {
        burst(slot, targets, events, hits);
      }
    }

    return { events, hits };
  }

  function bombs(): readonly BombView[] {
    let count = 0;
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const slot = slots[i];
      if (slot === undefined || !slot.active) continue;

      const remaining = slot.fuseStarted ? 1 - slot.fuseAge / fuseSeconds : 1;
      const fuse = Number.isFinite(remaining) ? remaining : 0;
      slot.view.fuse = fuse < 0 ? 0 : fuse > 1 ? 1 : fuse;
      slot.view.id = slot.id;
      slot.view.team = slot.team;
      output[count] = slot.view;
      count += 1;
    }
    output.length = count;
    return output;
  }

  return { tryThrow, step, bombs };
}
