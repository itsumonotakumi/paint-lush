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
import type { Weapon } from '../data/schemas';

/** Fixed projectile capacity. The oldest live projectile is recycled when full. */
const POOL_SIZE = 256;
/** Maximum distance a trail probe reaches below the projectile. */
const TRAIL_PROBE = 30;
/** Safety cap for pathological spacing/speed combinations. */
const MAX_TRAIL_SAMPLES = 1024;
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
  view: ProjectileView;
}

/** Keeps a number finite, falling back to `fallback`. `+ 0` normalises -0. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value + 0 : fallback;
}

function safeAngle(value: number): number {
  return Number.isFinite(value) ? value : 0;
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

export function createWeaponSystem(
  weapon: Weapon,
  deps: { collision: ICollision; paint: IPaintGrid; rng: Rng },
): IWeaponSystem {
  const { collision, paint, rng } = deps;

  const inkCost = Math.max(0, finiteOr(weapon.inkCost, 0));
  const damage = Math.max(0, finiteOr(weapon.damage, 0));
  const muzzleSpeed = Math.max(0, finiteOr(weapon.muzzleSpeed, 0));
  const gravity = Math.max(0, finiteOr(weapon.projectileGravity, 0));
  const spread = Math.min(Math.PI, Math.max(0, finiteOr(weapon.spreadRadians, 0)));
  const paintRadius = Math.max(0, finiteOr(weapon.paintRadius, 0));
  const trailRadius = Math.max(0, finiteOr(weapon.trailRadius, 0));
  const trailSpacingRaw = finiteOr(weapon.trailSpacing, 0);
  const trailSpacing = trailSpacingRaw > 0 ? trailSpacingRaw : Number.POSITIVE_INFINITY;
  const lifetimeRaw = finiteOr(weapon.lifetimeSeconds, 0);
  const lifetime = lifetimeRaw > 0 ? lifetimeRaw : Number.POSITIVE_INFINITY;
  const intervalRaw = finiteOr(weapon.intervalSeconds, 0);
  const intervalTicks =
    intervalRaw > 0 ? Math.max(0, Math.round(intervalRaw * 60)) : Number.MAX_SAFE_INTEGER;

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
      view,
    });
  }

  /** Reused output array for `projectiles()`. */
  const output: ProjectileView[] = [];
  const lastShot = new Map<EntityId, Tick>();

  let nextId = 0;
  let spawnSerial = 0;

  const scratchOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  const scratchDir: Vec3 = { x: 0, y: 0, z: 0 };
  const scratchBox: Box = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  };

  function allocateSlot(): Slot {
    let oldest: Slot | null = null;
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const slot = slots[i];
      if (slot === undefined) continue;
      if (!slot.active) return slot;
      if (oldest === null || slot.serial < oldest.serial) oldest = slot;
    }
    // The pool is always populated, so the loop above either returned a free
    // slot or set `oldest`.
    if (oldest !== null) return oldest;
    return slots[0]!;
  }

  function tryFire(shooter: ShooterState, tick: Tick): FireResult {
    if (!shooter.canFire) return { fired: false, inkSpent: 0, events: [] };
    // Written as a negated comparison so a non-finite ink value cannot pass.
    if (!(shooter.ink >= inkCost)) return { fired: false, inkSpent: 0, events: [] };
    // A muzzle buried in stage geometry cannot shoot out of it.
    if (collision.containsPoint(shooter.pos)) return { fired: false, inkSpent: 0, events: [] };

    const now = finiteOr(tick, 0);
    const previous = lastShot.get(shooter.id);
    if (previous !== undefined && now - previous < intervalTicks) {
      return { fired: false, inkSpent: 0, events: [] };
    }

    const yaw = safeAngle(shooter.yaw);
    const pitch = safeAngle(shooter.pitch);
    const forward = aimDirection(yaw, pitch);

    let dx = forward.x;
    let dy = forward.y;
    let dz = forward.z;

    if (spread > 0) {
      // Orthonormal basis around the aim direction. `right` is horizontal and
      // perpendicular to `forward` at every pitch, so the cross product is safe.
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
    slot.vel.x = finiteOr(dx * muzzleSpeed, 0);
    slot.vel.y = finiteOr(dy * muzzleSpeed, 0);
    slot.vel.z = finiteOr(dz * muzzleSpeed, 0);
    slot.age = 0;
    slot.trailAccum = 0;
    slot.serial = spawnSerial;
    slot.view.id = slot.id;
    slot.view.team = slot.team;

    nextId += 1;
    spawnSerial += 1;
    lastShot.set(shooter.id, now);

    const eventPos: Vec3 = { x: slot.pos.x, y: slot.pos.y, z: slot.pos.z };
    return {
      fired: true,
      inkSpent: inkCost,
      events: [{ t: 'shoot', weapon: weapon.id, pos: eventPos }],
    };
  }

  function step(dt: number, targets: readonly TargetState[]): StepResult {
    const events: GameEvent[] = [];
    const hits: DamageHit[] = [];

    if (!Number.isFinite(dt) || dt <= 0) return { events, hits };

    for (let i = 0; i < POOL_SIZE; i += 1) {
      const p = slots[i];
      if (p === undefined || !p.active) continue;

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

      // A projectile that starts inside an enemy counts as an immediate hit,
      // even when it does not move this step.
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
            const cells = paint.splatHit(trailHit, trailRadius, p.team);
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
        events.push({ t: 'paint', team: p.team, cells: trailCells, pos: trailPos });
      }

      if (bestKind === 1 && stageHit !== null) {
        const cells = paint.splatHit(stageHit, paintRadius, p.team);
        const impactPos: Vec3 = {
          x: stageHit.pos.x,
          y: stageHit.pos.y,
          z: stageHit.pos.z,
        };
        events.push({ t: 'impact', pos: impactPos });
        if (Number.isFinite(cells) && cells > 0) {
          events.push({ t: 'paint', team: p.team, cells, pos: impactPos });
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
