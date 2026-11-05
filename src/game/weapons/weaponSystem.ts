import type { GameEvent } from '../../core/events';
import type { Rng } from '../../core/rng';
import type { ProjectileView } from '../../core/snapshot';
import type { Box, EntityId, SurfaceHit, TeamId, Tick, Vec3 } from '../../core/types';
import { aimDirection } from '../../core/math/aim';
import { rayBox } from '../../core/math/aabb';
import type {
  DamageHit,
  FireResult,
  ICollision,
  IPaintGrid,
  IWeaponSystem,
  ShooterState,
  StepResult,
  TargetState,
} from '../contracts';
import type { BrushWeapon, ChargeWeapon, ProjectileWeapon, Weapon } from '../data/schemas';

/** Fixed projectile capacity. The oldest live projectile is recycled when full. */
const POOL_SIZE = 512;
/** Maximum distance a trail probe reaches below the projectile. */
const TRAIL_PROBE = 30;
/** Safety cap for pathological spacing/speed combinations. */
const MAX_TRAIL_SAMPLES = 1024;
/** Safety cap on strip samples produced by a single tick. */
const MAX_ROLL_SAMPLES = 64;
/** Hold time before a grounded brush starts rolling. */
const ROLL_DELAY_SECONDS = 0.2;
/** How far below a point the paint probes look. */
const PAINT_PROBE = 30;
const TAU = Math.PI * 2;
const EPS = 1e-9;
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

interface Slot {
  active: boolean;
  id: number;
  team: TeamId;
  owner: EntityId;
  /** Shared with `view.pos`; never replaced, only mutated. */
  pos: Vec3;
  vel: Vec3;
  age: number;
  trailAccum: number;
  serial: number;
  lifetime: number;
  gravity: number;
  damage: number;
  paintRadius: number;
  trailRadius: number;
  trailSpacing: number;
  view: ProjectileView;
}

interface Runtime {
  /** Tick of the last projectile or brush swing, null before the first. */
  lastShotTick: number | null;
  lastSwingTick: number | null;
  /** Fire button state on the previous call. */
  prevHold: boolean;
  /** Tick the current hold began, or null when not holding a usable button. */
  holdStartTick: number | null;
  charge: number;
  chargeLevel: 0 | 1 | 2;
  /** Previous muzzle position, for measuring rolled distance. */
  lastPos: Vec3;
  lastPosValid: boolean;
  rolling: boolean;
  rollAccum: number;
  /** Last rolled hit tick per target, so each target is hit once per interval. */
  rollHits: Map<EntityId, number>;
}

/** Keeps a number finite, falling back to `fallback`. `+ 0` normalises -0. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value + 0 : fallback;
}

function nonNegative(value: number, fallback = 0): number {
  const v = finiteOr(value, fallback);
  return v >= 0 ? v : 0;
}

/** Multipliers default to 1 when the value is unusable. */
function multiplier(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function safeAngle(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function addSafe(a: number, b: number): number {
  const sum = a + b;
  return Number.isFinite(sum) ? sum : a;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Overflow-safe length; never returns NaN or Infinity. */
function vecLength(x: number, y: number, z: number): number {
  const max = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (!Number.isFinite(max) || max === 0) return 0;
  const len = Math.hypot(x / max, y / max, z / max) * max;
  if (!Number.isFinite(len)) return Number.MAX_VALUE;
  return len + 0;
}

function copyVec(v: Vec3): Vec3 {
  return { x: finiteOr(v.x, 0), y: finiteOr(v.y, 0), z: finiteOr(v.z, 0) };
}

function inside(
  x: number,
  y: number,
  z: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
}

function emptyResult(charging = 0, moveMultiplier = 1): FireResult {
  return {
    fired: false,
    inkSpent: 0,
    events: [],
    charging,
    moveMultiplier,
    hits: [],
  };
}

function intervalTicks(seconds: number, fireRateMul: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const scaled = seconds / fireRateMul;
  if (!Number.isFinite(scaled) || scaled <= 0) return 0;
  return Math.max(0, Math.round(scaled * 60));
}

export function createWeaponSystem(
  weapons: readonly Weapon[],
  deps: { collision: ICollision; paint: IPaintGrid; rng: Rng },
): IWeaponSystem {
  const { collision, paint, rng } = deps;

  const weaponById = new Map<string, Weapon>();
  for (let i = 0; i < weapons.length; i += 1) {
    const weapon = weapons[i];
    if (weapon === undefined) continue;
    if (!weaponById.has(weapon.id)) weaponById.set(weapon.id, weapon);
  }

  const slots: Slot[] = [];
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const pos: Vec3 = { x: 0, y: 0, z: 0 };
    const view: ProjectileView = { id: 0, team: 0, pos };
    slots.push({
      active: false,
      id: 0,
      team: 0,
      owner: 0,
      pos,
      vel: { x: 0, y: 0, z: 0 },
      age: 0,
      trailAccum: 0,
      serial: 0,
      lifetime: Number.POSITIVE_INFINITY,
      gravity: 0,
      damage: 0,
      paintRadius: 0,
      trailRadius: 0,
      trailSpacing: Number.POSITIVE_INFINITY,
      view,
    });
  }

  /** Reused output array for `projectiles()`. */
  const output: ProjectileView[] = [];
  const runtimes = new Map<EntityId, Runtime>();

  let nextId = 0;
  let spawnSerial = 0;

  const scratchOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  const scratchDir: Vec3 = { x: 0, y: 0, z: 0 };
  const scratchBox: Box = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  };

  function runtimeFor(id: EntityId): Runtime {
    const existing = runtimes.get(id);
    if (existing !== undefined) return existing;
    const created: Runtime = {
      lastShotTick: null,
      lastSwingTick: null,
      prevHold: false,
      holdStartTick: null,
      charge: 0,
      chargeLevel: 0,
      lastPos: { x: 0, y: 0, z: 0 },
      lastPosValid: false,
      rolling: false,
      rollAccum: 0,
      rollHits: new Map(),
    };
    runtimes.set(id, created);
    return created;
  }

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

  /** Paints down from a point and accumulates the changed cells. */
  function splatDown(
    x: number,
    y: number,
    z: number,
    radius: number,
    team: TeamId,
  ): { cells: number; pos: Vec3 | null } {
    scratchOrigin.x = x;
    scratchOrigin.y = y;
    scratchOrigin.z = z;
    const hit = collision.raycast(scratchOrigin, DOWN, PAINT_PROBE);
    if (hit === null) return { cells: 0, pos: null };
    const cells = paint.splatHit(hit, radius, team);
    if (!Number.isFinite(cells) || cells <= 0) return { cells: 0, pos: null };
    return { cells, pos: copyVec(hit.pos) };
  }

  /* ---------- projectile ---------- */

  function fireProjectile(
    state: Runtime,
    shooter: ShooterState,
    weapon: ProjectileWeapon,
    now: Tick,
    paintMul: number,
    inkMul: number,
    fireRateMul: number,
  ): FireResult {
    // tryFire runs every tick, so a projectile weapon must only fire while the button is held.
    if (!shooter.canFire || !shooter.holdFire) return emptyResult();
    const inkCost = nonNegative(weapon.inkCost) * inkMul;
    if (!(shooter.ink >= inkCost)) return emptyResult();
    if (collision.containsPoint(shooter.pos)) return emptyResult();

    const interval = intervalTicks(weapon.intervalSeconds, fireRateMul);
    if (state.lastShotTick !== null && now - state.lastShotTick < interval) {
      return emptyResult();
    }

    const yaw = safeAngle(shooter.yaw);
    const pitch = safeAngle(shooter.pitch);
    const forward = aimDirection(yaw, pitch);
    const spread = Math.min(Math.PI, nonNegative(weapon.spreadRadians));

    let dx = forward.x;
    let dy = forward.y;
    let dz = forward.z;

    if (spread > 0) {
      const rightX = Math.cos(yaw);
      const rightZ = Math.sin(yaw);
      const upX = -rightZ * forward.y;
      const upY = rightZ * forward.x - rightX * forward.z;
      const upZ = rightX * forward.y;

      const alpha = spread * Math.sqrt(rng.next());
      const theta = rng.next() * TAU;
      const sinAlpha = Math.sin(alpha);
      const cosAlpha = Math.cos(alpha);
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      const radialX = rightX * cosTheta + upX * sinTheta;
      const radialY = upY * sinTheta;
      const radialZ = rightZ * cosTheta + upZ * sinTheta;

      dx = forward.x * cosAlpha + radialX * sinAlpha;
      dy = forward.y * cosAlpha + radialY * sinAlpha;
      dz = forward.z * cosAlpha + radialZ * sinAlpha;

      const len = vecLength(dx, dy, dz);
      if (len > 0 && Number.isFinite(len)) {
        dx /= len;
        dy /= len;
        dz /= len;
      } else {
        dx = forward.x;
        dy = forward.y;
        dz = forward.z;
      }
    }

    const slot = allocateSlot();
    slot.active = true;
    slot.id = nextId;
    slot.team = shooter.team;
    slot.owner = shooter.id;
    slot.pos.x = finiteOr(shooter.pos.x, 0);
    slot.pos.y = finiteOr(shooter.pos.y, 0);
    slot.pos.z = finiteOr(shooter.pos.z, 0);
    slot.vel.x = finiteOr(dx * nonNegative(weapon.muzzleSpeed), 0);
    slot.vel.y = finiteOr(dy * nonNegative(weapon.muzzleSpeed), 0);
    slot.vel.z = finiteOr(dz * nonNegative(weapon.muzzleSpeed), 0);
    slot.age = 0;
    slot.trailAccum = 0;
    slot.serial = spawnSerial;
    slot.view.id = slot.id;
    slot.view.team = slot.team;
    const lifetimeRaw = nonNegative(weapon.lifetimeSeconds);
    slot.lifetime = lifetimeRaw > 0 ? lifetimeRaw : Number.POSITIVE_INFINITY;
    slot.gravity = nonNegative(weapon.projectileGravity);
    slot.damage = nonNegative(weapon.damage);
    slot.paintRadius = nonNegative(weapon.paintRadius) * paintMul;
    slot.trailRadius = nonNegative(weapon.trailRadius) * paintMul;
    const trailRaw = nonNegative(weapon.trailSpacing);
    slot.trailSpacing = trailRaw > 0 ? trailRaw : Number.POSITIVE_INFINITY;

    nextId += 1;
    spawnSerial += 1;
    state.lastShotTick = now;

    const eventPos: Vec3 = { x: slot.pos.x, y: slot.pos.y, z: slot.pos.z };
    return {
      fired: true,
      inkSpent: inkCost,
      events: [{ t: 'shoot', weapon: weapon.id, pos: eventPos, id: shooter.id }],
      charging: 0,
      moveMultiplier: 1,
      hits: [],
    };
  }

  /* ---------- brush ---------- */

  function fireBrush(
    state: Runtime,
    shooter: ShooterState,
    weapon: BrushWeapon,
    targets: readonly TargetState[],
    now: Tick,
    paintMul: number,
    inkMul: number,
    fireRateMul: number,
  ): FireResult {
    const result = emptyResult();
    const sx = finiteOr(shooter.pos.x, 0);
    const sy = finiteOr(shooter.pos.y, 0);
    const sz = finiteOr(shooter.pos.z, 0);
    const yaw = safeAngle(shooter.yaw);
    const fx = Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = Math.sin(yaw);

    const canFire = shooter.canFire;
    const hold = shooter.holdFire;

    if (!canFire) {
      state.holdStartTick = null;
      state.rolling = false;
      state.rollAccum = 0;
      return result;
    }

    if (!hold) {
      state.holdStartTick = null;
      state.rolling = false;
      state.rollAccum = 0;
      state.lastPosValid = false;
      return result;
    }

    // The roll delay only counts time spent grounded; landing starts it again.
    if (!shooter.grounded) {
      state.holdStartTick = null;
    } else if (state.holdStartTick === null) {
      state.holdStartTick = now;
    }

    const rising = !state.prevHold;
    const blocked = collision.containsPoint(shooter.pos);

    // A fresh press swings once, if ink and cooldown allow it.
    const swingCost = nonNegative(weapon.swingInkCost) * inkMul;
    const swingInterval = intervalTicks(weapon.swingIntervalSeconds, fireRateMul);
    if (
      rising &&
      !blocked &&
      shooter.ink >= swingCost &&
      (state.lastSwingTick === null || now - state.lastSwingTick >= swingInterval)
    ) {
      state.lastSwingTick = now;
      state.lastShotTick = now;

      const reach = nonNegative(weapon.swingReach);
      const arc = Math.min(TAU, nonNegative(weapon.swingArcRadians));
      const halfArc = arc / 2;
      const paintRadius = nonNegative(weapon.swingPaintRadius) * paintMul;
      const events: GameEvent[] = [{ t: 'swing', id: shooter.id, pos: { x: sx, y: sy, z: sz } }];
      const hits: DamageHit[] = [];

      // Damage every enemy centre inside the arc with a clear line of sight.
      for (let ti = 0; ti < targets.length; ti += 1) {
        const target = targets[ti];
        if (target === undefined || target.team === shooter.team || !target.hittable) continue;
        const relX = finiteOr(target.pos.x, 0) - sx;
        const relY = finiteOr(target.pos.y, 0) - sy;
        const relZ = finiteOr(target.pos.z, 0) - sz;
        const horizontal = vecLength(relX, 0, relZ);
        if (horizontal > reach + EPS) continue;
        const dot = horizontal > EPS ? (relX * fx + relZ * fz) / horizontal : 1;
        const angle = Math.acos(clamp(dot, -1, 1));
        if (angle > halfArc + EPS) continue;

        const dist = vecLength(relX, relY, relZ);
        if (dist > EPS) {
          scratchDir.x = relX / dist;
          scratchDir.y = relY / dist;
          scratchDir.z = relZ / dist;
          scratchOrigin.x = sx;
          scratchOrigin.y = sy;
          scratchOrigin.z = sz;
          if (collision.raycast(scratchOrigin, scratchDir, dist) !== null) continue;
        }

        hits.push({
          target: target.id,
          attacker: shooter.id,
          damage: nonNegative(weapon.swingDamage),
          pos: copyVec(target.pos),
        });
      }

      // Three splats spread along the arc.
      let cells = 0;
      let firstPos: Vec3 | null = null;
      for (let i = 0; i < 3; i += 1) {
        const angle = -halfArc + (arc * i) / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const dx = fx * cos + rx * sin;
        const dz = fz * cos + rz * sin;
        const splat = splatDown(sx + dx * reach, sy, sz + dz * reach, paintRadius, shooter.team);
        if (splat.pos !== null) {
          cells = addSafe(cells, splat.cells);
          if (firstPos === null) firstPos = splat.pos;
        }
      }
      if (cells > 0 && firstPos !== null) {
        events.push({ t: 'paint', team: shooter.team, cells, pos: firstPos, by: shooter.id });
      }

      return {
        fired: true,
        inkSpent: swingCost,
        events,
        charging: 0,
        moveMultiplier: 1,
        hits,
      };
    }

    // Holding long enough while grounded rolls a strip.
    const heldSeconds = state.holdStartTick === null ? 0 : (now - state.holdStartTick) / 60;
    const perTick = (nonNegative(weapon.rollInkPerSec) / 60) * inkMul;
    const wantsRoll = shooter.grounded && heldSeconds >= ROLL_DELAY_SECONDS && !blocked;
    if (!wantsRoll || !(shooter.ink >= perTick)) {
      state.rolling = false;
      state.rollAccum = 0;
      state.lastPosValid = true;
      state.lastPos.x = sx;
      state.lastPos.y = sy;
      state.lastPos.z = sz;
      return result;
    }

    const width = nonNegative(weapon.rollWidth) * paintMul;
    const spacing = nonNegative(weapon.rollSpacing);
    const ahead = width / 2;
    const discRadius = width / 4;
    const hitInterval = intervalTicks(weapon.swingIntervalSeconds, fireRateMul);
    const damage = nonNegative(weapon.rollDamage);
    const events: GameEvent[] = [];
    const hits: DamageHit[] = [];
    if (!state.rolling || !state.lastPosValid) {
      state.rolling = true;
      state.rollAccum = 0;
    } else {
      const prevX = state.lastPos.x;
      const prevZ = state.lastPos.z;
      const moveX = sx - prevX;
      const moveZ = sz - prevZ;
      const moved = vecLength(moveX, 0, moveZ);
      if (moved > EPS && spacing > 0) {
        const dirX = moveX / moved;
        const dirZ = moveZ / moved;
        state.rollAccum = addSafe(state.rollAccum, moved);
        let samples = 0;
        while (state.rollAccum >= spacing && samples < MAX_ROLL_SAMPLES) {
          state.rollAccum -= spacing;
          samples += 1;
          const back = state.rollAccum;
          const px = sx - dirX * back;
          const pz = sz - dirZ * back;
          const cx = px + fx * ahead;
          const cz = pz + fz * ahead;

          let cells = 0;
          let paintPos: Vec3 | null = null;
          for (let d = -1; d <= 1; d += 1) {
            const splat = splatDown(cx + rx * discRadius * d, sy, cz + rz * discRadius * d, discRadius, shooter.team);
            if (splat.pos !== null) {
              cells = addSafe(cells, splat.cells);
              if (paintPos === null) paintPos = splat.pos;
            }
          }
          if (cells > 0 && paintPos !== null) {
            events.push({ t: 'paint', team: shooter.team, cells, pos: paintPos, by: shooter.id });
          }

          for (let ti = 0; ti < targets.length; ti += 1) {
            const target = targets[ti];
            if (target === undefined || target.team === shooter.team || !target.hittable) continue;
            const relX = finiteOr(target.pos.x, 0) - cx;
            const relZ = finiteOr(target.pos.z, 0) - cz;
            const lateral = Math.abs(relX * rx + relZ * rz);
            const forward = Math.abs(relX * fx + relZ * fz);
            const halfX = Math.abs(finiteOr(target.half.x, 0));
            const halfZ = Math.abs(finiteOr(target.half.z, 0));
            const lateralReach = width / 2 + Math.abs(rx) * halfX + Math.abs(rz) * halfZ;
            const forwardReach = Math.abs(fx) * halfX + Math.abs(fz) * halfZ + spacing / 2;
            if (lateral > lateralReach || forward > forwardReach) continue;
            const previous = state.rollHits.get(target.id);
            if (previous !== undefined && now - previous < hitInterval) continue;
            state.rollHits.set(target.id, now);
            hits.push({
              target: target.id,
              attacker: shooter.id,
              damage,
              pos: copyVec(target.pos),
            });
          }
        }
      }
    }

    state.lastPos.x = sx;
    state.lastPos.y = sy;
    state.lastPos.z = sz;
    state.lastPosValid = true;

    result.fired = true;
    result.inkSpent = perTick;
    result.events = events;
    result.hits = hits;
    result.moveMultiplier = clamp(nonNegative(weapon.rollSpeedMultiplier), 0, 1);
    return result;
  }

  /* ---------- charge ---------- */

  function fireCharge(
    state: Runtime,
    shooter: ShooterState,
    weapon: ChargeWeapon,
    targets: readonly TargetState[],
    now: Tick,
    paintMul: number,
    inkMul: number,
  ): FireResult {
    const canFire = shooter.canFire;
    const hold = shooter.holdFire;

    if (!canFire) {
      state.charge = 0;
      state.chargeLevel = 0;
      state.holdStartTick = null;
      return emptyResult(0, 1);
    }

    const fullSeconds = nonNegative(weapon.fullChargeSeconds);
    const chargeFromHold = (): number => {
      if (state.holdStartTick === null || fullSeconds <= 0) return state.charge;
      const seconds = (now - state.holdStartTick) / 60;
      if (!Number.isFinite(seconds)) return state.charge;
      return clamp01(seconds / fullSeconds);
    };

    if (hold) {
      const events: GameEvent[] = [];
      if (state.holdStartTick === null) {
        state.holdStartTick = now;
        state.charge = 0;
        state.chargeLevel = 0;
        events.push({ t: 'charge', id: shooter.id, level: 0 });
      } else {
        state.charge = chargeFromHold();
      }

      if (state.charge >= 0.5 && state.chargeLevel < 1) {
        state.chargeLevel = 1;
        events.push({ t: 'charge', id: shooter.id, level: 1 });
      }
      if (state.charge >= 1 && state.chargeLevel < 2) {
        state.chargeLevel = 2;
        events.push({ t: 'charge', id: shooter.id, level: 2 });
      }

      return {
        fired: false,
        inkSpent: 0,
        events,
        charging: state.charge,
        moveMultiplier: clamp(nonNegative(weapon.chargeMoveMultiplier), 0, 1),
        hits: [],
      };
    }

    // Not holding: a release from a tracked hold is the only way to fire.
    if (state.holdStartTick === null) {
      state.charge = 0;
      state.chargeLevel = 0;
      return emptyResult(0, 1);
    }

    const charge = chargeFromHold();
    state.charge = 0;
    state.chargeLevel = 0;
    state.holdStartTick = null;

    const minFraction = clamp01(nonNegative(weapon.minChargeFraction));
    if (charge < minFraction) return emptyResult(0, 1);

    const inkCost = nonNegative(weapon.inkCostFull) * charge * inkMul;
    if (!(shooter.ink >= inkCost)) return emptyResult(0, 1);
    if (collision.containsPoint(shooter.pos)) return emptyResult(0, 1);

    const yaw = safeAngle(shooter.yaw);
    const pitch = safeAngle(shooter.pitch);
    const forward = aimDirection(yaw, pitch);
    const originX = finiteOr(shooter.pos.x, 0);
    const originY = finiteOr(shooter.pos.y, 0);
    const originZ = finiteOr(shooter.pos.z, 0);

    const rangeMin = nonNegative(weapon.rangeMin);
    const rangeFull = nonNegative(weapon.rangeFull);
    const range = rangeMin + (rangeFull - rangeMin) * charge;
    if (!(range > 0)) return emptyResult(0, 1);

    const damageMin = nonNegative(weapon.damageMin);
    const damageFull = nonNegative(weapon.damageFull);
    const damage = damageMin + (damageFull - damageMin) * charge;

    scratchOrigin.x = originX;
    scratchOrigin.y = originY;
    scratchOrigin.z = originZ;

    let stageDist = Number.POSITIVE_INFINITY;
    const stage = collision.raycast(scratchOrigin, forward, range);
    if (stage !== null) {
      const dist = vecLength(stage.pos.x - originX, stage.pos.y - originY, stage.pos.z - originZ);
      if (Number.isFinite(dist)) stageDist = dist;
    }

    let bestTarget: TargetState | null = null;
    let targetDist = Number.POSITIVE_INFINITY;
    for (let ti = 0; ti < targets.length; ti += 1) {
      const target = targets[ti];
      if (target === undefined || target.team === shooter.team || !target.hittable) continue;
      const px = finiteOr(target.pos.x, 0);
      const py = finiteOr(target.pos.y, 0);
      const pz = finiteOr(target.pos.z, 0);
      const hx = Math.abs(finiteOr(target.half.x, 0));
      const hy = Math.abs(finiteOr(target.half.y, 0));
      const hz = Math.abs(finiteOr(target.half.z, 0));
      scratchBox.min.x = px - hx;
      scratchBox.min.y = py - hy;
      scratchBox.min.z = pz - hz;
      scratchBox.max.x = px + hx;
      scratchBox.max.y = py + hy;
      scratchBox.max.z = pz + hz;
      const boxHit = rayBox(scratchOrigin, forward, scratchBox, range);
      if (boxHit !== null && boxHit.t < targetDist) {
        targetDist = boxHit.t;
        bestTarget = target;
      }
    }

    const hitsTarget = bestTarget !== null && targetDist < stageDist;
    const endDist = Math.min(range, stageDist, targetDist);
    const safeEnd = Number.isFinite(endDist) && endDist >= 0 ? endDist : range;

    const lineRadius = nonNegative(weapon.lineRadius) * paintMul;
    const spacing = nonNegative(weapon.lineSpacing);
    let cells = 0;
    let paintPos: Vec3 | null = null;

    if (spacing > 0) {
      let along = spacing;
      let samples = 0;
      while (along < safeEnd - EPS && samples < MAX_TRAIL_SAMPLES) {
        const splat = splatDown(
          originX + forward.x * along,
          originY + forward.y * along,
          originZ + forward.z * along,
          lineRadius,
          shooter.team,
        );
        if (splat.pos !== null) {
          cells = addSafe(cells, splat.cells);
          if (paintPos === null) paintPos = splat.pos;
        }
        along += spacing;
        samples += 1;
      }
    }

    const endSplat = splatDown(
      originX + forward.x * safeEnd,
      originY + forward.y * safeEnd,
      originZ + forward.z * safeEnd,
      lineRadius,
      shooter.team,
    );
    if (endSplat.pos !== null) {
      cells = addSafe(cells, endSplat.cells);
      if (paintPos === null) paintPos = endSplat.pos;
    }

    const events: GameEvent[] = [
      { t: 'shoot', weapon: weapon.id, pos: { x: originX, y: originY, z: originZ }, id: shooter.id },
    ];
    if (cells > 0 && paintPos !== null) {
      events.push({ t: 'paint', team: shooter.team, cells, pos: paintPos, by: shooter.id });
    }

    const hits: DamageHit[] = [];
    if (hitsTarget && bestTarget !== null) {
      hits.push({
        target: bestTarget.id,
        attacker: shooter.id,
        damage,
        pos: {
          x: addSafe(originX, forward.x * targetDist),
          y: addSafe(originY, forward.y * targetDist),
          z: addSafe(originZ, forward.z * targetDist),
        },
      });
    }

    return {
      fired: true,
      inkSpent: inkCost,
      events,
      charging: 0,
      moveMultiplier: 1,
      hits,
    };
  }

  function tryFire(shooter: ShooterState, targets: readonly TargetState[], tick: Tick): FireResult {
    const now = finiteOr(tick, 0);
    const state = runtimeFor(shooter.id);
    const weapon = weaponById.get(shooter.weaponId);
    const fireRateMul = multiplier(shooter.mods.fireRateMul);
    const paintMul = nonNegative(shooter.mods.paintMul, 1);
    const inkMul = nonNegative(shooter.mods.inkCostMul, 1);

    let result: FireResult;
    if (weapon === undefined) {
      result = emptyResult();
    } else if (weapon.kind === 'projectile') {
      result = fireProjectile(state, shooter, weapon, now, paintMul, inkMul, fireRateMul);
    } else if (weapon.kind === 'brush') {
      result = fireBrush(state, shooter, weapon, targets, now, paintMul, inkMul, fireRateMul);
    } else {
      result = fireCharge(state, shooter, weapon, targets, now, paintMul, inkMul);
    }

    state.prevHold = shooter.holdFire;
    return result;
  }

  function step(dt: number, targets: readonly TargetState[]): StepResult {
    const events: GameEvent[] = [];
    const hits: DamageHit[] = [];

    if (!Number.isFinite(dt) || dt <= 0) return { events, hits };

    for (let i = 0; i < POOL_SIZE; i += 1) {
      const p = slots[i];
      if (p === undefined || !p.active) continue;

      const lifetime = p.lifetime;
      const gravity = p.gravity;
      const damage = p.damage;
      const basePaint = p.paintRadius;
      const baseTrail = p.trailRadius;
      const trailSpacing = p.trailSpacing;

      if (p.age >= lifetime) {
        p.active = false;
        continue;
      }

      const remaining = lifetime - p.age;
      const stepDt = remaining < dt ? remaining : dt;
      if (!(stepDt > 0) || !Number.isFinite(stepDt)) {
        p.active = false;
        continue;
      }
      p.age += dt;

      const vy = p.vel.y - gravity * stepDt;
      p.vel.y = finiteOr(vy, 0);
      p.vel.x = finiteOr(p.vel.x, 0);
      p.vel.z = finiteOr(p.vel.z, 0);

      const sx = p.pos.x;
      const sy = p.pos.y;
      const sz = p.pos.z;
      const segX = finiteOr(p.vel.x * stepDt, 0);
      const segY = finiteOr(p.vel.y * stepDt, 0);
      const segZ = finiteOr(p.vel.z * stepDt, 0);
      const dist = vecLength(segX, segY, segZ);
      const invDist = dist > 0 ? 1 / dist : 0;
      const dirX = segX * invDist;
      const dirY = segY * invDist;
      const dirZ = segZ * invDist;

      let bestKind: 0 | 1 | 2 = 0;
      let bestT = Number.POSITIVE_INFINITY;
      let stageHit: SurfaceHit | null = null;
      let bestTarget: TargetState | null = null;

      for (let ti = 0; ti < targets.length; ti += 1) {
        const target = targets[ti];
        if (target === undefined || target.team === p.team || !target.hittable) continue;
        const px = finiteOr(target.pos.x, 0);
        const py = finiteOr(target.pos.y, 0);
        const pz = finiteOr(target.pos.z, 0);
        const hx = Math.abs(finiteOr(target.half.x, 0));
        const hy = Math.abs(finiteOr(target.half.y, 0));
        const hz = Math.abs(finiteOr(target.half.z, 0));
        if (inside(sx, sy, sz, px - hx, py - hy, pz - hz, px + hx, py + hy, pz + hz)) {
          bestTarget = target;
          bestT = 0;
          bestKind = 2;
          break;
        }
      }

      if (bestKind === 0 && dist > 0) {
        scratchOrigin.x = sx;
        scratchOrigin.y = sy;
        scratchOrigin.z = sz;
        scratchDir.x = dirX;
        scratchDir.y = dirY;
        scratchDir.z = dirZ;

        const stage = collision.raycast(scratchOrigin, scratchDir, dist);
        if (stage !== null) {
          const hitDist = vecLength(stage.pos.x - sx, stage.pos.y - sy, stage.pos.z - sz);
          if (Number.isFinite(hitDist) && hitDist <= dist + EPS) {
            stageHit = stage;
            bestT = hitDist;
            bestKind = 1;
          }
        }

        for (let ti = 0; ti < targets.length; ti += 1) {
          const target = targets[ti];
          if (target === undefined || target.team === p.team || !target.hittable) continue;
          const px = finiteOr(target.pos.x, 0);
          const py = finiteOr(target.pos.y, 0);
          const pz = finiteOr(target.pos.z, 0);
          const hx = Math.abs(finiteOr(target.half.x, 0));
          const hy = Math.abs(finiteOr(target.half.y, 0));
          const hz = Math.abs(finiteOr(target.half.z, 0));

          scratchBox.min.x = px - hx;
          scratchBox.min.y = py - hy;
          scratchBox.min.z = pz - hz;
          scratchBox.max.x = px + hx;
          scratchBox.max.y = py + hy;
          scratchBox.max.z = pz + hz;

          const boxHit = rayBox(scratchOrigin, scratchDir, scratchBox, dist);
          if (boxHit !== null && boxHit.t < bestT) {
            bestTarget = target;
            bestT = boxHit.t;
            bestKind = 2;
            stageHit = null;
          }
        }
      }

      let travelDist = dist;
      if (bestKind !== 0) travelDist = bestT < dist ? bestT : dist;
      if (!(travelDist > 0)) travelDist = 0;

      let trailCells = 0;
      let trailPos: Vec3 | null = null;

      if (Number.isFinite(trailSpacing) && travelDist > 0) {
        const startAccum = p.trailAccum;
        let sampleDistance = trailSpacing - startAccum;
        if (!(sampleDistance > 0)) sampleDistance = trailSpacing;
        let samples = 0;

        while (sampleDistance <= travelDist + EPS && samples < MAX_TRAIL_SAMPLES) {
          const f = sampleDistance / dist;
          scratchOrigin.x = addSafe(sx, segX * f);
          scratchOrigin.y = addSafe(sy, segY * f);
          scratchOrigin.z = addSafe(sz, segZ * f);

          const trailHit = collision.raycast(scratchOrigin, DOWN, TRAIL_PROBE);
          if (trailHit !== null) {
            const cells = paint.splatHit(trailHit, baseTrail, p.team);
            if (Number.isFinite(cells) && cells > 0) {
              trailCells = addSafe(trailCells, cells);
              trailPos = { x: trailHit.pos.x, y: trailHit.pos.y, z: trailHit.pos.z };
            }
          }

          samples += 1;
          sampleDistance = (samples + 1) * trailSpacing - startAccum;
        }

        const accum = (startAccum + travelDist) % trailSpacing;
        p.trailAccum = Number.isFinite(accum) && accum >= 0 ? accum : 0;
      }

      if (trailCells > 0 && trailPos !== null) {
        events.push({ t: 'paint', team: p.team, cells: trailCells, pos: trailPos, by: p.owner });
      }

      if (bestKind === 1 && stageHit !== null) {
        const cells = paint.splatHit(stageHit, basePaint, p.team);
        const impactPos: Vec3 = {
          x: stageHit.pos.x,
          y: stageHit.pos.y,
          z: stageHit.pos.z,
        };
        events.push({ t: 'impact', pos: impactPos });
        if (Number.isFinite(cells) && cells > 0) {
          events.push({ t: 'paint', team: p.team, cells, pos: impactPos, by: p.owner });
        }
        p.active = false;
      } else if (bestKind === 2 && bestTarget !== null) {
        const hitX = addSafe(sx, dirX * bestT);
        const hitY = addSafe(sy, dirY * bestT);
        const hitZ = addSafe(sz, dirZ * bestT);
        hits.push({
          target: bestTarget.id,
          attacker: p.owner,
          damage,
          pos: { x: hitX, y: hitY, z: hitZ },
        });
        p.active = false;
      } else {
        p.pos.x = addSafe(sx, segX);
        p.pos.y = addSafe(sy, segY);
        p.pos.z = addSafe(sz, segZ);
      }

      if (p.age >= lifetime) p.active = false;
    }

    return { events, hits };
  }

  function projectiles(): readonly ProjectileView[] {
    let count = 0;
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const p = slots[i];
      if (p === undefined || !p.active) continue;
      p.view.id = p.id;
      p.view.team = p.team;
      output[count] = p.view;
      count += 1;
    }
    output.length = count;
    return output;
  }

  return { tryFire, step, projectiles };
}
