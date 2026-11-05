import type { InputActions } from '../../core/actions';
import { emptyActions } from '../../core/actions';
import type { Rng } from '../../core/rng';
import type { TeamId, Vec3 } from '../../core/types';
import { FIXED_DT } from '../../core/types';
import type { AiWorldView, IAiController, PlayerState, Waypoint } from '../contracts';
import type { AiProfile, Weapon } from '../data/schemas';
import { nearestWaypoint, shortestPath } from './graph';

export type AiGoal = 'paint' | 'chase' | 'support' | 'retreat';

export interface GoalScore {
  goal: AiGoal;
  score: number;
}

const GOAL_ORDER: readonly AiGoal[] = ['paint', 'chase', 'support', 'retreat'];

/** Extra score the current goal keeps so small variations do not flip it. */
const GOAL_HYSTERESIS = 0.1;
const ARRIVE_RADIUS = 0.8;
const ARRIVE_RADIUS_SQ = ARRIVE_RADIUS * ARRIVE_RADIUS;
const STUCK_WINDOW_TICKS = 60;
const STUCK_MIN_MOVE = 0.5;
const STUCK_MIN_MOVE_SQ = STUCK_MIN_MOVE * STUCK_MIN_MOVE;
const PAINT_SAMPLE_HEIGHT = 8;
const PAINT_SAMPLE_DEPTH = 30;
const PAINT_UNPAINTED_AT = 0.5;
const SUPPORT_ALLY_RANGE = 12;
const SUPPORT_ENEMY_RANGE = 6;
/** Ink below which a bot stops shooting and looks for own ink to dive on. */
const RETREAT_INK = 30;
/** Ink a refilling bot waits for before it starts shooting again. */
const INK_RESUME = 60;
/** A waypoint counts as a refill spot at this share of its sample points being own ink. */
const REFILL_OWN_MIN = 0.55;
/** Bots never fire with less ink than this, whatever the weapon. */
const MIN_FIRE_INK = 1;
const BRUSH_SWING_RANGE = 2.5;
/** A charge shot is released once it reaches this fraction; full is 1. */
const CHARGE_RELEASE_AT = 0.99;
const SUB_MIN_RANGE = 5;
const SUB_MAX_RANGE = 10;
/** Low enough that a refilled bot can throw; still above the bomb's 40 ink cost. */
const SUB_INK_MIN = 45;
const SUB_CHANCE = 0.06;
const SPECIAL_CHANCE = 0.5;
const PITCH_LIMIT = 1.2;
const MAX_LOOK_PER_TICK = 0.5;
const TWO_PI = Math.PI * 2;
/** A detour from a stuck spot keeps control for this many ticks. */
const DETOUR_MIN_TICKS = 90;
const DETOUR_MAX_TICKS = 300;
/** First and second path nodes further apart than this are a stair, not a shortcut. */
const SKIP_MAX_HEIGHT = 0.5;
/** How long a waypoint that repeatedly traps a bot stays out of paint selection. */
const BLOCKED_WAYPOINT_TICKS = 600;

const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

/** Nine probe points well inside a 6 m disc around a candidate area. */
const SAMPLE_OFFSETS: readonly { x: number; z: number }[] = [
  { x: 0, z: 0 },
  { x: -4, z: 0 },
  { x: 4, z: 0 },
  { x: 0, z: -4 },
  { x: 0, z: 4 },
  { x: -2.8, z: -2.8 },
  { x: 2.8, z: -2.8 },
  { x: -2.8, z: 2.8 },
  { x: 2.8, z: 2.8 },
];

interface EnemyChoice {
  enemy: PlayerState;
  distance: number;
}

interface SupportChoice {
  ally: PlayerState;
  threat: PlayerState | null;
  distance: number;
}

interface PaintChoice {
  waypoint: Waypoint;
  fraction: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value + 0 : fallback;
}

function nonNegative(value: number, fallback: number): number {
  const safe = finiteOr(value, fallback);
  return safe > 0 ? safe : 0;
}

function clamp(value: number, min: number, max: number): number {
  const safe = Number.isFinite(value) ? value : min;
  if (safe < min) return min;
  if (safe > max) return max;
  return safe;
}

function wrapAngle(value: number): number {
  if (!Number.isFinite(value)) return 0;
  let wrapped = value - TWO_PI * Math.floor((value + Math.PI) / TWO_PI);
  if (wrapped <= -Math.PI) wrapped = Math.PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  return wrapped;
}

function horizontalDistanceSquared(a: Vec3, b: Vec3): number {
  const dx = finiteOr(a.x, 0) - finiteOr(b.x, 0);
  const dz = finiteOr(a.z, 0) - finiteOr(b.z, 0);
  const value = dx * dx + dz * dz;
  return Number.isFinite(value) ? value : Number.MAX_VALUE;
}

function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = finiteOr(a.x, 0) - finiteOr(b.x, 0);
  const dy = finiteOr(a.y, 0) - finiteOr(b.y, 0);
  const dz = finiteOr(a.z, 0) - finiteOr(b.z, 0);
  const value = dx * dx + dy * dy + dz * dz;
  return Number.isFinite(value) ? value : Number.MAX_VALUE;
}

function isLive(player: PlayerState): boolean {
  if (player.state === 'down' || player.state === 'respawn') return false;
  return finiteOr(player.hp, 0) > 0;
}

function enemyTeamOf(team: TeamId): TeamId {
  return team === 0 ? 1 : 0;
}

function spawnTagOf(team: TeamId): 'spawn0' | 'spawn1' {
  return team === 0 ? 'spawn0' : 'spawn1';
}

/** Chooses the best goal, giving the current one a small bonus. Ties favour paint. */
export function pickGoal(scores: readonly GoalScore[], current: AiGoal | null): AiGoal {
  let best: AiGoal = 'paint';
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < GOAL_ORDER.length; i += 1) {
    const goal = GOAL_ORDER[i];
    if (goal === undefined) continue;

    let score = 0;
    for (let s = 0; s < scores.length; s += 1) {
      const entry = scores[s];
      if (entry === undefined || entry.goal !== goal) continue;
      score = finiteOr(entry.score, 0);
      break;
    }
    if (goal === current) score += GOAL_HYSTERESIS;

    const wins = score > bestScore || (score === bestScore && goal === current);
    if (wins) {
      best = goal;
      bestScore = score;
    }
  }

  return best;
}

/** Creates a deterministic bot controller for one player. */
export function createBot(profile: AiProfile, rng: Rng, phaseOffsetTicks: number): IAiController {
  const reactionSeconds = Math.max(FIXED_DT, nonNegative(profile.reactionSeconds, 0.25));
  const jitterRadians = nonNegative(profile.aimJitterRadians, 0);
  const intervalTicks = Math.max(1, Math.round(nonNegative(profile.decisionIntervalSeconds, 0.25) * 60));
  const engageRange = nonNegative(profile.engageRange, 0);
  const weightPaint = nonNegative(profile.weights.paint, 0);
  const weightChase = nonNegative(profile.weights.chase, 0);
  const weightSupport = nonNegative(profile.weights.support, 0);
  const weightRetreat = nonNegative(profile.weights.retreat, 0);
  const specialUse = profile.specialUse === true;

  const rawOffset = Math.round(finiteOr(phaseOffsetTicks, 0));
  const phaseOffset = ((rawOffset % intervalTicks) + intervalTicks) % intervalTicks;

  let goal: AiGoal | null = null;
  let paintTargetId: number | null = null;
  let chaseEnemyId: number | null = null;
  let supportAllyId: number | null = null;
  let retreatWaypointId: number | null = null;
  let destination: Vec3 | null = null;
  let path: Waypoint[] = [];
  let pathIndex = 0;
  let jitterYaw = 0;
  let jitterPitch = 0;
  let prevFire = false;
  let pendingSub = false;
  let pendingSpecial = false;
  let pendingJump = false;
  let lastDecisionTick: number | null = null;
  let nextDecisionTick = 0;
  let stuckTick: number | null = null;
  let stuckStrikes = 0;
  let detourUntilTick = 0;
  let refilling = false;
  let refillWaypointId: number | null = null;
  let blockedWaypointId: number | null = null;
  let blockedUntilTick = 0;
  let nowTick = 0;

  const selfPos: Vec3 = { x: 0, y: 0, z: 0 };
  const stuckAnchor: Vec3 = { x: 0, y: 0, z: 0 };
  const sampleOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  const groundOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  const losDir: Vec3 = { x: 0, y: 0, z: 0 };

  function readSelf(view: AiWorldView): void {
    selfPos.x = finiteOr(view.self.pos.x, 0);
    selfPos.y = finiteOr(view.self.pos.y, 0);
    selfPos.z = finiteOr(view.self.pos.z, 0);
  }

  function copySelfTo(target: Vec3): void {
    target.x = selfPos.x;
    target.y = selfPos.y;
    target.z = selfPos.z;
  }

  function waypointById(view: AiWorldView, id: number | null): Waypoint | null {
    if (id === null) return null;
    for (let i = 0; i < view.waypoints.length; i += 1) {
      const waypoint = view.waypoints[i];
      if (waypoint !== undefined && waypoint.id === id) return waypoint;
    }
    return null;
  }

  function playerById(players: readonly PlayerState[], id: number | null): PlayerState | null {
    if (id === null) return null;
    for (let i = 0; i < players.length; i += 1) {
      const player = players[i];
      if (player !== undefined && player.id === id) return player;
    }
    return null;
  }

  function nearestSpawn(view: AiWorldView, team: TeamId, pos: Vec3): Waypoint | null {
    const tag = spawnTagOf(team);
    let best: Waypoint | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < view.waypoints.length; i += 1) {
      const waypoint = view.waypoints[i];
      if (waypoint === undefined || !waypoint.tags.includes(tag)) continue;
      const distance = distanceSquared(pos, waypoint.pos);
      if (best === null || distance < bestDistance || (distance === bestDistance && waypoint.id < best.id)) {
        best = waypoint;
        bestDistance = distance;
      }
    }

    return best;
  }

  function spawnCenter(view: AiWorldView, team: TeamId): Vec3 | null {
    const tag = spawnTagOf(team);
    let x = 0;
    let y = 0;
    let z = 0;
    let count = 0;

    for (let i = 0; i < view.waypoints.length; i += 1) {
      const waypoint = view.waypoints[i];
      if (waypoint === undefined || !waypoint.tags.includes(tag)) continue;
      x += finiteOr(waypoint.pos.x, 0);
      y += finiteOr(waypoint.pos.y, 0);
      z += finiteOr(waypoint.pos.z, 0);
      count += 1;
    }

    if (count === 0) return null;
    return { x: x / count, y: y / count, z: z / count };
  }

  function sampleUnpaintedFraction(view: AiWorldView, center: Vec3, team: TeamId): number {
    let notOwn = 0;
    for (let i = 0; i < SAMPLE_OFFSETS.length; i += 1) {
      const offset = SAMPLE_OFFSETS[i];
      if (offset === undefined) continue;
      sampleOrigin.x = finiteOr(center.x, 0) + offset.x;
      sampleOrigin.y = finiteOr(center.y, 0) + PAINT_SAMPLE_HEIGHT;
      sampleOrigin.z = finiteOr(center.z, 0) + offset.z;
      const hit = view.collision.raycast(sampleOrigin, DOWN, PAINT_SAMPLE_DEPTH);
      if (hit === null || view.paint.sampleHit(hit) !== team) notOwn += 1;
    }
    return notOwn / SAMPLE_OFFSETS.length;
  }

  /**
   * Picks the closest waypoint standing on own ink. The bot dives there to
   * refill quickly instead of holding fire with an empty tank.
   */
  function chooseRefillWaypoint(view: AiWorldView): number | null {
    let best: Waypoint | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < view.waypoints.length; i += 1) {
      const waypoint = view.waypoints[i];
      if (waypoint === undefined) continue;
      const ownFraction = 1 - sampleUnpaintedFraction(view, waypoint.pos, view.self.team);
      if (ownFraction < REFILL_OWN_MIN) continue;
      const distance = distanceSquared(selfPos, waypoint.pos);
      if (!Number.isFinite(distance)) continue;
      if (best === null || distance < bestDistance || (distance === bestDistance && waypoint.id < best.id)) {
        best = waypoint;
        bestDistance = distance;
      }
    }

    if (best !== null) return best.id;
    const spawn = nearestSpawn(view, view.self.team, selfPos);
    return spawn === null ? null : spawn.id;
  }

  function waypointBlocked(waypoint: Waypoint): boolean {
    return blockedWaypointId !== null && waypoint.id === blockedWaypointId && nowTick < blockedUntilTick;
  }

  function choosePaintTarget(view: AiWorldView, team: TeamId): PaintChoice | null {
    if (view.waypoints.length === 0) return null;

    const candidates: Waypoint[] = [];
    const ownSpawn = spawnCenter(view, team);
    const enemySpawn = spawnCenter(view, enemyTeamOf(team));

    for (let i = 0; i < view.waypoints.length; i += 1) {
      const waypoint = view.waypoints[i];
      if (waypoint === undefined || waypointBlocked(waypoint)) continue;
      let wanted = waypoint.tags.includes('mid');
      if (!wanted && ownSpawn !== null && enemySpawn !== null) {
        wanted = distanceSquared(waypoint.pos, enemySpawn) < distanceSquared(waypoint.pos, ownSpawn);
      }
      if (wanted) candidates.push(waypoint);
    }

    if (candidates.length === 0) {
      for (let i = 0; i < view.waypoints.length; i += 1) {
        const waypoint = view.waypoints[i];
        if (waypoint !== undefined && !waypointBlocked(waypoint)) candidates.push(waypoint);
      }
    }
    if (candidates.length === 0) {
      for (let i = 0; i < view.waypoints.length; i += 1) {
        const waypoint = view.waypoints[i];
        if (waypoint !== undefined) candidates.push(waypoint);
      }
    }
    if (candidates.length === 0) return null;

    const fractions: number[] = [];
    const unpainted: number[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (candidate === undefined) continue;
      const fraction = sampleUnpaintedFraction(view, candidate.pos, team);
      fractions.push(fraction);
      if (fraction > PAINT_UNPAINTED_AT) unpainted.push(i);
    }

    let index: number;
    if (unpainted.length > 0) {
      const pick = unpainted[rng.int(unpainted.length)];
      index = pick === undefined ? 0 : pick;
    } else {
      index = rng.int(candidates.length);
    }

    const waypoint = candidates[index];
    if (waypoint === undefined) return null;
    return { waypoint, fraction: fractions[index] ?? 0 };
  }

  function nearestLiveEnemy(view: AiWorldView, from: Vec3, maxRange: number): EnemyChoice | null {
    let best: PlayerState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < view.enemies.length; i += 1) {
      const enemy = view.enemies[i];
      if (enemy === undefined || enemy.team === view.self.team || !isLive(enemy)) continue;
      const distance = Math.sqrt(distanceSquared(from, enemy.pos));
      if (!(distance <= maxRange)) continue;
      if (best === null || distance < bestDistance || (distance === bestDistance && enemy.id < best.id)) {
        best = enemy;
        bestDistance = distance;
      }
    }

    if (best === null || !Number.isFinite(bestDistance)) return null;
    return { enemy: best, distance: bestDistance };
  }

  function chooseSupport(view: AiWorldView): SupportChoice | null {
    let best: SupportChoice | null = null;

    for (let i = 0; i < view.allies.length; i += 1) {
      const ally = view.allies[i];
      if (ally === undefined || ally.team !== view.self.team || !isLive(ally)) continue;
      const allyDistance = Math.sqrt(distanceSquared(selfPos, ally.pos));
      if (!(allyDistance <= SUPPORT_ALLY_RANGE)) continue;

      let threat: PlayerState | null = null;
      let threatDistance = Number.POSITIVE_INFINITY;
      for (let e = 0; e < view.enemies.length; e += 1) {
        const enemy = view.enemies[e];
        if (enemy === undefined || enemy.team === view.self.team || !isLive(enemy)) continue;
        const distance = Math.sqrt(distanceSquared(ally.pos, enemy.pos));
        if (!(distance <= SUPPORT_ENEMY_RANGE)) continue;
        if (threat === null || distance < threatDistance || (distance === threatDistance && enemy.id < threat.id)) {
          threat = enemy;
          threatDistance = distance;
        }
      }

      if (threat === null) continue;
      if (best === null || allyDistance < best.distance || (allyDistance === best.distance && ally.id < best.ally.id)) {
        best = { ally, threat, distance: allyDistance };
      }
    }

    return best;
  }

  function hasLineOfSight(view: AiWorldView, target: Vec3): boolean {
    const dx = finiteOr(target.x, 0) - selfPos.x;
    const dy = finiteOr(target.y, 0) - selfPos.y;
    const dz = finiteOr(target.z, 0) - selfPos.z;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(distanceSq)) return false;
    if (distanceSq <= 1e-12) return true;

    const distance = Math.sqrt(distanceSq);
    if (!Number.isFinite(distance) || distance <= 0) return true;

    losDir.x = dx / distance;
    losDir.y = dy / distance;
    losDir.z = dz / distance;

    const hit = view.collision.raycast(selfPos, losDir, distance);
    if (hit === null) return true;

    const hx = finiteOr(hit.pos.x, 0) - selfPos.x;
    const hy = finiteOr(hit.pos.y, 0) - selfPos.y;
    const hz = finiteOr(hit.pos.z, 0) - selfPos.z;
    const hitDistanceSq = hx * hx + hy * hy + hz * hz;
    if (!Number.isFinite(hitDistanceSq)) return false;
    return hitDistanceSq >= distanceSq - 1e-6;
  }

  function nearestVisibleEnemy(view: AiWorldView): EnemyChoice | null {
    let best: PlayerState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < view.enemies.length; i += 1) {
      const enemy = view.enemies[i];
      if (enemy === undefined || enemy.team === view.self.team || !isLive(enemy)) continue;
      const distance = Math.sqrt(distanceSquared(selfPos, enemy.pos));
      if (!(distance <= engageRange)) continue;
      if (best !== null && distance >= bestDistance) continue;
      if (!hasLineOfSight(view, enemy.pos)) continue;
      best = enemy;
      bestDistance = distance;
    }

    if (best === null || !Number.isFinite(bestDistance)) return null;
    return { enemy: best, distance: bestDistance };
  }

  function enemyInSubBand(view: AiWorldView): boolean {
    for (let i = 0; i < view.enemies.length; i += 1) {
      const enemy = view.enemies[i];
      if (enemy === undefined || enemy.team === view.self.team || !isLive(enemy)) continue;
      const distance = Math.sqrt(distanceSquared(selfPos, enemy.pos));
      if (distance >= SUB_MIN_RANGE && distance <= SUB_MAX_RANGE) return true;
    }
    return false;
  }

  function onOwnInk(view: AiWorldView): boolean {
    groundOrigin.x = selfPos.x;
    groundOrigin.y = selfPos.y;
    groundOrigin.z = selfPos.z;
    const hit = view.collision.raycast(groundOrigin, DOWN, 3);
    if (hit === null) return false;
    return view.paint.sampleHit(hit) === view.self.team;
  }

  function resolveDestination(view: AiWorldView): Vec3 | null {
    if (goal === 'paint') {
      const waypoint = waypointById(view, paintTargetId);
      return waypoint === null ? null : waypoint.pos;
    }
    if (goal === 'retreat') {
      const waypoint = waypointById(view, retreatWaypointId);
      return waypoint === null ? null : waypoint.pos;
    }
    if (goal === 'chase') {
      const enemy = playerById(view.enemies, chaseEnemyId);
      if (enemy !== null) return enemy.pos;
    }
    if (goal === 'support') {
      const ally = playerById(view.allies, supportAllyId);
      if (ally !== null) return ally.pos;
    }
    return destination;
  }

  /**
   * The nearest node is often just behind the bot. When the bot is already
   * between that node and the next one, skip it so it does not walk backwards.
   */
  function shouldSkipFirstNode(): boolean {
    const first = path[0];
    const second = path[1];
    if (first === undefined || second === undefined) return false;

    const ax = finiteOr(first.pos.x, 0);
    const ay = finiteOr(first.pos.y, 0);
    const az = finiteOr(first.pos.z, 0);
    const by = finiteOr(second.pos.y, 0);
    // A stair link is a climb, not a shortcut: always visit its bottom node.
    if (Math.abs(by - ay) > SKIP_MAX_HEIGHT) return false;
    const abx = finiteOr(second.pos.x, 0) - ax;
    const abz = finiteOr(second.pos.z, 0) - az;
    const asx = selfPos.x - ax;
    const asz = selfPos.z - az;
    const segmentLengthSq = abx * abx + abz * abz;
    const offsetLengthSq = asx * asx + asz * asz;
    if (!(segmentLengthSq > 0) || !(offsetLengthSq < segmentLengthSq)) return false;
    return asx * abx + asz * abz > 0;
  }

  /** Waypoint the current goal is trying to reach, used to avoid retrying it when stuck. */
  function primaryTargetId(): number | null {
    if (goal === 'paint') return paintTargetId;
    if (goal === 'chase') return chaseEnemyId;
    if (goal === 'support') return supportAllyId;
    if (goal === 'retreat') return retreatWaypointId;
    return null;
  }

  function pickDetour(view: AiWorldView): void {
    const from = nearestWaypoint(selfPos, view.waypoints);
    if (from === null) return;

    const avoidId = primaryTargetId();
    let next: Waypoint | null = null;
    let choices = 0;
    for (let i = 0; i < from.links.length; i += 1) {
      const linkId = from.links[i];
      if (linkId === undefined || linkId === avoidId) continue;
      choices += 1;
    }

    if (choices > 0) {
      let pick = rng.int(choices);
      for (let i = 0; i < from.links.length; i += 1) {
        const linkId = from.links[i];
        if (linkId === undefined || linkId === avoidId) continue;
        if (pick === 0) {
          next = waypointById(view, linkId);
          break;
        }
        pick -= 1;
      }
    }

    if (next === null && from.links.length > 0) {
      const linkId = from.links[rng.int(from.links.length)];
      if (linkId !== undefined) next = waypointById(view, linkId);
    }
    if (next === null && view.waypoints.length > 0) {
      const index = rng.int(view.waypoints.length);
      next = view.waypoints[index] ?? null;
    }
    if (next === null) return;

    path = shortestPath(from.id, next.id, view.waypoints);
    pathIndex = 0;
    destination = next.pos;
  }

  /** Builds the path to the nearest own-ink refill spot without changing the goal score. */
  function chooseRefillPath(view: AiWorldView): void {
    goal = 'retreat';
    retreatWaypointId = refillWaypointId;
    paintTargetId = null;
    chaseEnemyId = null;
    supportAllyId = null;

    const waypoint = waypointById(view, refillWaypointId);
    destination = waypoint === null ? null : waypoint.pos;
    const start = nearestWaypoint(selfPos, view.waypoints);
    path =
      start === null || waypoint === null
        ? []
        : shortestPath(start.id, waypoint.id, view.waypoints);
    pathIndex = shouldSkipFirstNode() ? 1 : 0;

    pendingSub = false;
    pendingSpecial = false;
  }

  function chooseGoal(view: AiWorldView): void {
    const paint = choosePaintTarget(view, view.self.team);
    const enemy = engageRange > 0 ? nearestLiveEnemy(view, selfPos, engageRange) : null;
    const support = chooseSupport(view);
    const retreat = nearestSpawn(view, view.self.team, selfPos);

    const hpFraction = clamp(finiteOr(view.self.hp, 0) / 100, 0, 1);
    const ink = finiteOr(view.self.ink, 0);

    const paintScore = paint === null ? 0 : weightPaint * paint.fraction;

    let chaseScore = 0;
    if (enemy !== null && engageRange > 0) {
      chaseScore = weightChase * (1 - enemy.distance / engageRange) * hpFraction;
    }

    let supportScore = 0;
    if (support !== null) {
      const closeness = clamp(1 - support.distance / SUPPORT_ALLY_RANGE, 0, 1);
      supportScore = weightSupport * closeness;
    }

    // Ink pressure counts on its own: a full-HP bot with an empty tank must
    // still fall back towards own ink instead of holding a dry trigger.
    const inkUrgency = ink < RETREAT_INK ? 1 - clamp(ink / RETREAT_INK, 0, 1) : 0;
    const retreatScore =
      retreat === null
        ? 0
        : weightRetreat * Math.max(1 - hpFraction, inkUrgency);

    let chosen = pickGoal(
      [
        { goal: 'paint', score: paintScore },
        { goal: 'chase', score: chaseScore },
        { goal: 'support', score: supportScore },
        { goal: 'retreat', score: retreatScore },
      ],
      goal,
    );

    if (chosen === 'paint' && paint === null) chosen = retreat !== null ? 'retreat' : 'chase';
    if (chosen === 'chase' && enemy === null) chosen = paint !== null ? 'paint' : 'retreat';
    if (chosen === 'support' && support === null) chosen = paint !== null ? 'paint' : 'retreat';
    if (chosen === 'retreat' && retreat === null) chosen = paint !== null ? 'paint' : 'chase';

    goal = chosen;
    paintTargetId = null;
    chaseEnemyId = null;
    supportAllyId = null;
    retreatWaypointId = null;
    destination = null;

    let targetWaypoint: Waypoint | null = null;

    if (chosen === 'paint' && paint !== null) {
      paintTargetId = paint.waypoint.id;
      destination = paint.waypoint.pos;
      targetWaypoint = paint.waypoint;
    } else if (chosen === 'chase' && enemy !== null) {
      chaseEnemyId = enemy.enemy.id;
      destination = enemy.enemy.pos;
      targetWaypoint = nearestWaypoint(destination, view.waypoints);
    } else if (chosen === 'support' && support !== null) {
      supportAllyId = support.ally.id;
      destination = support.ally.pos;
      targetWaypoint = nearestWaypoint(destination, view.waypoints);
    } else if (chosen === 'retreat' && retreat !== null) {
      retreatWaypointId = retreat.id;
      destination = retreat.pos;
      targetWaypoint = retreat;
    }

    const start = nearestWaypoint(selfPos, view.waypoints);
    path =
      start === null || targetWaypoint === null
        ? []
        : shortestPath(start.id, targetWaypoint.id, view.waypoints);
    pathIndex = shouldSkipFirstNode() ? 1 : 0;

    jitterYaw = rng.range(-jitterRadians, jitterRadians);
    jitterPitch = rng.range(-jitterRadians, jitterRadians);

    pendingSub = false;
    pendingSpecial = false;
    const canThrowNow =
      !refilling &&
      view.self.state !== 'dive' &&
      finiteOr(view.self.fireLock, 0) <= 0 &&
      finiteOr(view.self.diveTransition, 0) <= 0;
    if (canThrowNow && ink >= SUB_INK_MIN && enemyInSubBand(view)) {
      pendingSub = rng.next() < SUB_CHANCE;
    }
    if (specialUse) pendingSpecial = rng.next() < SPECIAL_CHANCE;
  }

  function fireDecision(
    weapon: Weapon,
    target: EnemyChoice | null,
    moving: boolean,
    charge: number,
    ink: number,
  ): boolean {
    if (refilling || ink < MIN_FIRE_INK) return false;

    if (weapon.kind === 'charge') {
      // The shot only leaves on release and costs ink at full charge. Hold
      // until the meter is full, then release; never trickle a weak shot out.
      if (charge >= CHARGE_RELEASE_AT) return false;
      if (ink < weapon.inkCostFull) return false;
      return target !== null || moving || goal === 'paint';
    }

    if (target !== null) {
      if (weapon.kind === 'brush') {
        return target.distance <= BRUSH_SWING_RANGE ? !prevFire : true;
      }
      return true;
    }

    if (goal === 'paint') return true;
    if (weapon.kind === 'brush' && moving) return true;
    return false;
  }

  function alignedAfter(tick: number): number {
    const remainder = (((tick - phaseOffset) % intervalTicks) + intervalTicks) % intervalTicks;
    return tick + (remainder === 0 ? intervalTicks : intervalTicks - remainder);
  }

  function decide(view: AiWorldView): InputActions {
    if (view.phase === 'pre' || view.phase === 'finished') {
      pendingSub = false;
      pendingSpecial = false;
      pendingJump = false;
      return emptyActions();
    }

    readSelf(view);
    const tick = Math.floor(finiteOr(view.tick, 0));
    nowTick = tick;
    const ink = nonNegative(view.self.ink, 0);

    let refillChanged = false;
    if (!refilling && ink < RETREAT_INK) {
      refilling = true;
      refillWaypointId = chooseRefillWaypoint(view);
      refillChanged = true;
    } else if (refilling && ink >= INK_RESUME) {
      refilling = false;
      refillWaypointId = null;
      refillChanged = true;
    }

    const wentBack = lastDecisionTick !== null && tick < lastDecisionTick;
    const due = lastDecisionTick === null || wentBack || tick >= nextDecisionTick || refillChanged;

    if (due) {
      lastDecisionTick = tick;
      nextDecisionTick = alignedAfter(tick);
      if (tick >= detourUntilTick || refillChanged) {
        if (refilling) chooseRefillPath(view);
        else chooseGoal(view);
      }
    }

    let moveTarget: Vec3 | null = null;
    while (pathIndex < path.length) {
      const waypoint = path[pathIndex];
      if (waypoint === undefined) {
        pathIndex += 1;
        continue;
      }
      if (horizontalDistanceSquared(selfPos, waypoint.pos) <= ARRIVE_RADIUS_SQ) {
        pathIndex += 1;
        continue;
      }
      moveTarget = waypoint.pos;
      break;
    }

    const liveDestination = resolveDestination(view);
    if (moveTarget === null) {
      if (goal === 'chase' || goal === 'support') {
        moveTarget = liveDestination;
      } else if (path.length === 0) {
        moveTarget = liveDestination;
      }
    }

    const selfOnOwnInk = onOwnInk(view);
    // A refilling bot standing on own ink stops and dives; that is its fastest
    // path back to a healthy tank.
    if (refilling && selfOnOwnInk) moveTarget = null;

    if (moveTarget !== null) {
      if (stuckTick === null) {
        copySelfTo(stuckAnchor);
        stuckTick = tick;
      } else if (tick - stuckTick >= STUCK_WINDOW_TICKS) {
        if (horizontalDistanceSquared(selfPos, stuckAnchor) < STUCK_MIN_MOVE_SQ) {
          // Jump at the first sign of a ledge, then steer away for long enough
          // that the next decision cannot send the bot straight back in.
          stuckStrikes += 1;
          pendingJump = true;
          const stuckTarget = primaryTargetId();
          if (stuckStrikes >= 2 && (goal === 'paint' || goal === 'retreat') && stuckTarget !== null) {
            // The waypoint itself is unreachable from here (a tower face or a
            // stair side), so stop choosing it for a while.
            blockedWaypointId = stuckTarget;
            blockedUntilTick = tick + BLOCKED_WAYPOINT_TICKS;
            lastDecisionTick = null;
            detourUntilTick = 0;
          } else {
            pickDetour(view);
            detourUntilTick = tick + Math.min(DETOUR_MAX_TICKS, DETOUR_MIN_TICKS + (stuckStrikes - 1) * 60);
          }
        } else {
          stuckStrikes = 0;
        }
        copySelfTo(stuckAnchor);
        stuckTick = tick;
      }
    } else {
      stuckTick = null;
      stuckStrikes = 0;
    }

    const visible = nearestVisibleEnemy(view);
    let hasAim = false;
    let aimX = 0;
    let aimY = 0;
    let aimZ = 0;

    if (visible !== null) {
      hasAim = true;
      aimX = finiteOr(visible.enemy.pos.x, 0);
      aimY = finiteOr(visible.enemy.pos.y, 0);
      aimZ = finiteOr(visible.enemy.pos.z, 0);
    } else if (moveTarget !== null) {
      hasAim = true;
      aimX = finiteOr(moveTarget.x, 0);
      aimY = finiteOr(moveTarget.y, 0);
      aimZ = finiteOr(moveTarget.z, 0);
    } else if (liveDestination !== null) {
      hasAim = true;
      aimX = finiteOr(liveDestination.x, 0);
      aimY = finiteOr(liveDestination.y, 0);
      aimZ = finiteOr(liveDestination.z, 0);
    }

    let lookX = 0;
    let lookY = 0;
    if (hasAim) {
      const dx = aimX - selfPos.x;
      const dy = aimY - selfPos.y;
      const dz = aimZ - selfPos.z;
      const horizontalSq = dx * dx + dz * dz;
      const currentYaw = finiteOr(view.self.yaw, 0);
      const currentPitch = clamp(finiteOr(view.self.pitch, 0), -PITCH_LIMIT, PITCH_LIMIT);

      let desiredYaw = currentYaw;
      let desiredPitch = currentPitch;
      if (Number.isFinite(horizontalSq) && horizontalSq > 1e-12) {
        desiredYaw = Math.atan2(dx, -dz);
        desiredPitch = Math.atan2(dy, Math.sqrt(horizontalSq));
      }
      desiredYaw += jitterYaw;
      desiredPitch = clamp(desiredPitch + jitterPitch, -PITCH_LIMIT, PITCH_LIMIT);

      const follow = clamp(FIXED_DT / reactionSeconds, 0, 1);
      lookX = clamp(wrapAngle(desiredYaw - currentYaw) * follow, -MAX_LOOK_PER_TICK, MAX_LOOK_PER_TICK);
      lookY = clamp((desiredPitch - currentPitch) * follow, -MAX_LOOK_PER_TICK, MAX_LOOK_PER_TICK);
    }

    const charge = clamp(finiteOr(view.self.charge, 0), 0, 1);
    const fire = fireDecision(view.weapon, visible, moveTarget !== null, charge, ink);
    // Charge shots need a full second of not diving, so charge bots only dive
    // to refill; other weapons may also dive for speed between fights.
    const diving =
      selfOnOwnInk &&
      (refilling ||
        (view.weapon.kind !== 'charge' && moveTarget !== null && visible === null));

    const actions: InputActions = {
      move: [0, moveTarget === null ? 0 : 1],
      look: [finiteOr(lookX, 0), finiteOr(lookY, 0)],
      fire,
      jump: pendingJump,
      dive: diving,
      sub: pendingSub,
      special: pendingSpecial,
      pause: false,
    };

    pendingJump = false;
    pendingSub = false;
    pendingSpecial = false;
    prevFire = fire;

    return actions;
  }

  return { decide };
}
