import type { InputActions } from '../../core/actions';
import type { GameEvent } from '../../core/events';
import { forwardFromYaw, rightFromYaw } from '../../core/math/aim';
import type { CellValue, EntityId, SurfaceHit, TeamId, Vec3 } from '../../core/types';
import { NO_TEAM } from '../../core/types';
import type { DamageHit, ICollision, IPaintGrid, PlayerState } from '../contracts';
import type { PlayerConfig } from '../data/schemas';

export interface PlayerEnv {
  collision: ICollision;
  paint: IPaintGrid;
  spawn: Vec3;
}

const TWO_PI = Math.PI * 2;
const PITCH_LIMIT = 1.2;
/** Small help onto a ledge after a wall climb. */
const LEDGE_NUDGE_MIN = 0.15;
const LEDGE_NUDGE_MAX = 0.5;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number): number {
  const v = finiteOr(value, 0);
  return v > 0 ? v : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Maps arbitrary runtime values onto the two teams or NO_TEAM. */
function normaliseCell(value: CellValue): CellValue {
  return value === 0 || value === 1 ? value : NO_TEAM;
}

function wrapYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  let wrapped = yaw - TWO_PI * Math.floor((yaw + Math.PI) / TWO_PI);
  if (wrapped <= -Math.PI) wrapped = Math.PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  return wrapped;
}

function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0;
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
}

function axisAction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

function tickTimer(value: number, dt: number): number {
  const next = finiteOr(value, 0) - dt;
  return next > 0 ? next : 0;
}

function eventPos(p: PlayerState): Vec3 {
  return {
    x: finiteOr(p.pos.x, 0),
    y: finiteOr(p.pos.y, 0),
    z: finiteOr(p.pos.z, 0),
  };
}

/**
 * The ground and wall used for this tick come from the previous collision
 * solve. Keeping the last move result mirrors the contract wording and avoids
 * extra raycasts. The entry is discarded whenever the player is teleported.
 */
const lastMove = new WeakMap<PlayerState, ReturnType<ICollision['moveAndSlide']>>();

export function createPlayer(id: EntityId, team: TeamId, spawn: Vec3, cfg: PlayerConfig): PlayerState {
  return {
    id,
    team,
    state: 'stance',
    pos: {
      x: finiteOr(spawn.x, 0),
      y: finiteOr(spawn.y, 0),
      z: finiteOr(spawn.z, 0),
    },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: Math.max(0, finiteOr(cfg.maxHp, 0)),
    ink: Math.max(0, finiteOr(cfg.maxInk, 0)),
    diveTransition: 0,
    fireLock: 0,
    respawnTimer: 0,
    invuln: 0,
    prevDive: false,
    prevJump: false,
  };
}

export function canFire(p: PlayerState): boolean {
  return (p.state === 'stance' || p.state === 'air') && p.fireLock <= 0 && p.diveTransition <= 0;
}

/** The forms a living player can move in. */
type ActiveState = 'stance' | 'dive' | 'air';

/** Every exit from dive runs through here so the fire lock is never skipped. */
function leaveDive(p: PlayerState, cfg: PlayerConfig): void {
  if (p.state !== 'dive') return;
  p.fireLock = nonNegative(cfg.fireLockAfterDiveSeconds);
}

/**
 * Central transition for the live forms. Releasing dive, jumping out of it and
 * stepping off a ledge into 'air' all arm the fire lock via `leaveDive`.
 */
function setForm(
  p: PlayerState,
  next: ActiveState,
  events: GameEvent[],
  cfg: PlayerConfig,
): void {
  if (p.state === next) return;
  const wasDive = p.state === 'dive';
  const enteringDive = next === 'dive';
  leaveDive(p, cfg);
  p.state = next;
  if (next !== 'air') {
    p.diveTransition = nonNegative(cfg.diveTransitionSeconds);
  }
  if (wasDive || enteringDive) {
    events.push({ t: 'dive', id: p.id, in: enteringDive, pos: eventPos(p) });
  }
}

function isOwnInkWall(
  hit: SurfaceHit | null,
  env: PlayerEnv,
  team: TeamId,
): boolean {
  if (hit === null) return false;
  return normaliseCell(env.paint.sampleHit(hit)) === team;
}

function moveToSpawn(p: PlayerState, spawn: Vec3): void {
  p.pos.x = finiteOr(spawn.x, 0);
  p.pos.y = finiteOr(spawn.y, 0);
  p.pos.z = finiteOr(spawn.z, 0);
  p.vel.x = 0;
  p.vel.y = 0;
  p.vel.z = 0;
}

function stepDead(p: PlayerState, input: InputActions, env: PlayerEnv, cfg: PlayerConfig, dt: number): GameEvent[] {
  const events: GameEvent[] = [];
  p.vel.x = 0;
  p.vel.y = 0;
  p.vel.z = 0;

  p.diveTransition = tickTimer(p.diveTransition, dt);
  p.fireLock = tickTimer(p.fireLock, dt);
  p.invuln = tickTimer(p.invuln, dt);

  const timer = tickTimer(p.respawnTimer, dt);
  p.respawnTimer = timer;

  // The last second is spent on the spot: only the label changes here.
  if (p.state === 'down' && timer <= 1) {
    p.state = 'respawn';
  }

  if (p.respawnTimer <= 0) {
    p.state = 'stance';
    p.hp = Math.max(0, finiteOr(cfg.maxHp, 0));
    p.ink = Math.max(0, finiteOr(cfg.maxInk, 0));
    p.invuln = nonNegative(cfg.respawnInvulnSeconds);
    p.respawnTimer = 0;
    // Teleport exactly when the respawn event fires.
    moveToSpawn(p, env.spawn);
    lastMove.delete(p);
    events.push({ t: 'respawn', id: p.id, pos: eventPos(p) });
  }

  p.prevDive = input.dive === true;
  p.prevJump = input.jump === true;
  return events;
}

export function stepPlayer(
  p: PlayerState,
  input: InputActions,
  env: PlayerEnv,
  cfg: PlayerConfig,
  dt: number,
): GameEvent[] {
  const step = nonNegative(dt);

  if (p.state === 'down' || p.state === 'respawn') {
    return stepDead(p, input, env, cfg, step);
  }

  const events: GameEvent[] = [];

  p.diveTransition = tickTimer(p.diveTransition, step);
  p.fireLock = tickTimer(p.fireLock, step);
  p.invuln = tickTimer(p.invuln, step);

  const lookX = finiteOr(input.look[0], 0);
  const lookY = finiteOr(input.look[1], 0);
  p.yaw = wrapYaw(p.yaw + lookX);
  p.pitch = clampPitch(p.pitch + lookY);

  const moveX = axisAction(input.move[0]);
  const moveY = axisAction(input.move[1]);
  const rawLength = Math.hypot(moveX, moveY);
  let normX = moveX;
  let normZ = moveY;
  if (rawLength > 1) {
    normX /= rawLength;
    normZ /= rawLength;
  }
  const hasMove = normX !== 0 || normZ !== 0;
  const diveHeld = input.dive === true;
  const fireHeld = input.fire === true;
  const jumpHeld = input.jump === true;

  // Grounded forms react immediately so this tick already uses the new speed.
  if (p.state === 'stance' || p.state === 'dive') {
    setForm(p, diveHeld ? 'dive' : 'stance', events, cfg);
  }

  const previous = lastMove.get(p) ?? null;
  const groundTeam: CellValue = previous?.ground
    ? normaliseCell(env.paint.sampleHit(previous.ground))
    : NO_TEAM;

  const grounded = p.state === 'stance' || p.state === 'dive';
  const climbing =
    p.state === 'dive' && moveY > 0 && isOwnInkWall(previous?.wall ?? null, env, p.team);

  const wallClimbSpeed = nonNegative(cfg.wallClimbSpeed);
  const gravity = nonNegative(cfg.gravity);

  if (climbing) {
    p.vel.y = wallClimbSpeed;
  } else {
    p.vel.y = finiteOr(p.vel.y, 0) - gravity * step;
  }

  const targetSpeed = (() => {
    if (groundTeam !== NO_TEAM && groundTeam !== p.team) {
      return nonNegative(cfg.enemyInkSpeed);
    }
    if (p.state === 'dive') {
      return groundTeam === p.team
        ? nonNegative(cfg.diveSpeed)
        : nonNegative(cfg.enemyInkSpeed);
    }
    return nonNegative(cfg.walkSpeed);
  })();

  const forward = forwardFromYaw(p.yaw);
  const right = rightFromYaw(p.yaw);
  const targetX = (right.x * normX + forward.x * normZ) * targetSpeed;
  const targetZ = (right.z * normX + forward.z * normZ) * targetSpeed;

  const airControl = clamp(cfg.airControl, 0, 1);
  const acceleration =
    nonNegative(cfg.acceleration) * (p.state === 'air' ? airControl : 1);
  const maxDelta = acceleration * step;
  const deltaX = targetX - finiteOr(p.vel.x, 0);
  const deltaZ = targetZ - finiteOr(p.vel.z, 0);
  const deltaLength = Math.hypot(deltaX, deltaZ);
  if (deltaLength <= maxDelta || deltaLength === 0) {
    p.vel.x = targetX;
    p.vel.z = targetZ;
  } else {
    const scale = maxDelta / deltaLength;
    p.vel.x = finiteOr(p.vel.x, 0) + deltaX * scale;
    p.vel.z = finiteOr(p.vel.z, 0) + deltaZ * scale;
  }

  const jumpEdge = jumpHeld && !p.prevJump;
  if (jumpEdge && grounded) {
    p.vel.y = nonNegative(cfg.jumpSpeed);
    setForm(p, 'air', events, cfg);
    events.push({ t: 'jump', id: p.id, pos: eventPos(p) });
  }

  const result = env.collision.moveAndSlide(p.pos, p.vel, cfg.halfExtents, step);
  p.pos.x = finiteOr(result.pos.x, finiteOr(p.pos.x, 0));
  p.pos.y = finiteOr(result.pos.y, finiteOr(p.pos.y, 0));
  p.pos.z = finiteOr(result.pos.z, finiteOr(p.pos.z, 0));
  p.vel.x = finiteOr(result.vel.x, 0);
  p.vel.y = finiteOr(result.vel.y, 0);
  p.vel.z = finiteOr(result.vel.z, 0);
  lastMove.set(p, result);

  // Reaching the top removes the wall contact. Hop forward so the step lands.
  if (climbing && result.wall === null) {
    const normal = previous?.wall?.normal;
    if (normal) {
      const nx = finiteOr(normal.x, 0);
      const nz = finiteOr(normal.z, 0);
      const normalLength = Math.hypot(nx, nz);
      if (normalLength > 1e-6) {
        const nudge = clamp(
          wallClimbSpeed * step * 3,
          LEDGE_NUDGE_MIN,
          LEDGE_NUDGE_MAX,
        );
        p.pos.x -= (nx / normalLength) * nudge;
        p.pos.z -= (nz / normalLength) * nudge;
      }
    }
  }

  const wallNowOwn =
    p.state === 'dive' && moveY > 0 && isOwnInkWall(result.wall, env, p.team);

  if (p.state === 'air') {
    if (result.grounded && p.vel.y <= 0) {
      events.push({ t: 'land', id: p.id, pos: eventPos(p) });
      setForm(p, diveHeld ? 'dive' : 'stance', events, cfg);
    }
  } else if (p.state === 'stance' || p.state === 'dive') {
    if (!result.grounded && !climbing && !wallNowOwn) {
      setForm(p, 'air', events, cfg);
    } else if (result.grounded) {
      setForm(p, diveHeld ? 'dive' : 'stance', events, cfg);
    }
  }

  const maxHp = Math.max(0, finiteOr(cfg.maxHp, 0));
  const onEnemyInk = groundTeam !== NO_TEAM && groundTeam !== p.team;
  const onOwnInk = groundTeam === p.team;

  if (onEnemyInk) {
    const dps = nonNegative(cfg.enemyInkDps);
    const floor = clamp(cfg.enemyInkMinHp, 0, maxHp);
    const nextHp = finiteOr(p.hp, maxHp) - dps * step;
    p.hp = Math.max(floor, Math.min(maxHp, nextHp));
    p.hp = clamp(p.hp, 0, maxHp);
  } else if (p.state === 'dive' && onOwnInk) {
    const heal = nonNegative(cfg.diveHealPerSec);
    p.hp = Math.min(maxHp, Math.max(0, finiteOr(p.hp, 0) + heal * step));
  }

  const maxInk = Math.max(0, finiteOr(cfg.maxInk, 0));
  if (p.state === 'dive' && onOwnInk) {
    p.ink = Math.min(maxInk, Math.max(0, finiteOr(p.ink, 0) + nonNegative(cfg.inkRegenDive) * step));
  } else if (p.state === 'stance' && !fireHeld && !hasMove) {
    p.ink = Math.min(maxInk, Math.max(0, finiteOr(p.ink, 0) + nonNegative(cfg.inkRegenIdle) * step));
  }

  p.prevDive = diveHeld;
  p.prevJump = jumpHeld;
  return events;
}

export function applyDamage(p: PlayerState, hit: DamageHit, cfg: PlayerConfig): GameEvent[] {
  if (p.invuln > 0 || p.state === 'down' || p.state === 'respawn') return [];

  const damage = nonNegative(hit.damage);
  const maxHp = Math.max(0, finiteOr(cfg.maxHp, 0));
  p.hp = Math.max(0, Math.min(maxHp, finiteOr(p.hp, 0) - damage));

  const hitPos: Vec3 = {
    x: finiteOr(hit.pos.x, 0),
    y: finiteOr(hit.pos.y, 0),
    z: finiteOr(hit.pos.z, 0),
  };
  const events: GameEvent[] = [
    { t: 'hit', target: p.id, damage, pos: hitPos },
  ];

  if (p.hp <= 0) {
    p.hp = 0;
    // Dying while diving still ends the dive, so arm the fire lock centrally.
    leaveDive(p, cfg);
    p.state = 'down';
    p.vel.x = 0;
    p.vel.y = 0;
    p.vel.z = 0;
    p.respawnTimer = nonNegative(cfg.respawnSeconds);
    lastMove.delete(p);
    events.push({
      t: 'kill',
      killer: hit.attacker,
      victim: p.id,
      pos: hitPos,
    });
  }

  return events;
}
