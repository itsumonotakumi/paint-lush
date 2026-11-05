import type { CellValue, EntityId, Face, SurfaceHit, SurfaceId, TeamId, Tick, Vec3 } from '../core/types';
import type { GameEvent } from '../core/events';
import type { InputActions } from '../core/actions';
import type { PlayerStateName, ProjectileView, WorldSnapshot } from '../core/snapshot';

/* ---------- physics: src/game/physics ---------- */

export interface MoveResult {
  pos: Vec3;
  /** Input velocity with blocked axes zeroed. */
  vel: Vec3;
  grounded: boolean;
  /** Surface under the feet when grounded. */
  ground: SurfaceHit | null;
  /** First side surface blocked this move. */
  wall: SurfaceHit | null;
}

export interface ICollision {
  /** Moves a vertical AABB (centre `pos`, half extents `half`) with per-axis resolution. */
  moveAndSlide(pos: Vec3, vel: Vec3, half: Vec3, dt: number): MoveResult;
  /** Nearest hit along a unit `dir` within `maxDist`, or null. An origin inside a box ignores that box. */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): SurfaceHit | null;
  /** True when the point lies strictly inside any stage box. */
  containsPoint(pos: Vec3): boolean;
}

/* ---------- paint: src/game/paint ---------- */

/** One paintable face rasterised to cells. World = origin + axisU*u + axisV*v, with u,v in metres. */
export interface SurfaceGrid {
  id: SurfaceId;
  boxIndex: number;
  face: Face;
  /** Cell counts. */
  w: number;
  h: number;
  cellSize: number;
  /** Exact face size in metres. May be less than w*cellSize and h*cellSize. */
  uLength: number;
  vLength: number;
  origin: Vec3;
  axisU: Vec3;
  axisV: Vec3;
  /** Length w*h, row-major (index = cv*w + cu). Values are CellValue. */
  data: Uint8Array;
}

export interface IPaintGrid {
  readonly surfaces: readonly SurfaceGrid[];
  /** null when that face is not paintable. */
  surfaceAt(boxIndex: number, face: Face): SurfaceId | null;
  /** Team at a hit, or NO_TEAM for unpainted or unpaintable surfaces. */
  sampleHit(hit: SurfaceHit): CellValue;
  /** Paints a disc on the hit's surface. Returns cells that changed owner. */
  splatHit(hit: SurfaceHit, radius: number, team: TeamId): number;
  /** Paints a disc in surface metres. Returns cells that changed owner. Out-of-range cells are ignored. */
  splat(surfaceId: SurfaceId, u: number, v: number, radius: number, team: TeamId): number;
  /** Incremental painted cell counts per team. */
  counts(): [number, number];
  /** Total paintable cells. */
  totalCells(): number;
  /** Returns surfaces changed since the previous call, then clears the set. */
  takeDirty(): SurfaceId[];
}

/* ---------- player: src/game/player ---------- */

export interface PlayerState {
  id: EntityId;
  team: TeamId;
  state: PlayerStateName;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  ink: number;
  /** Seconds left of the dive transition; 0 when complete. */
  diveTransition: number;
  /** Seconds before firing is allowed. */
  fireLock: number;
  /** Seconds left until respawn while state is 'down' or 'respawn'. */
  respawnTimer: number;
  /** Seconds of remaining invulnerability. */
  invuln: number;
  /** Previous tick's dive and jump buttons, for edge detection. */
  prevDive: boolean;
  prevJump: boolean;
}

/** Applied to a player from outside, e.g. a projectile hit. */
export interface DamageHit {
  target: EntityId;
  attacker: EntityId;
  damage: number;
  pos: Vec3;
}

/* ---------- weapons: src/game/weapons ---------- */

export interface ShooterState {
  id: EntityId;
  team: TeamId;
  /** Muzzle position. */
  pos: Vec3;
  yaw: number;
  pitch: number;
  ink: number;
  /** False while diving, down, or locked out. */
  canFire: boolean;
}

export interface TargetState {
  id: EntityId;
  team: TeamId;
  pos: Vec3;
  half: Vec3;
  /** False while invulnerable or down. */
  hittable: boolean;
}

export interface FireResult {
  fired: boolean;
  inkSpent: number;
  events: GameEvent[];
}

export interface StepResult {
  events: GameEvent[];
  hits: DamageHit[];
}

export interface IWeaponSystem {
  /** Call once per tick per shooter holding fire. Enforces the interval and the ink cost. */
  tryFire(shooter: ShooterState, tick: Tick): FireResult;
  /** Advances all projectiles by one fixed step. */
  step(dt: number, targets: readonly TargetState[]): StepResult;
  projectiles(): readonly ProjectileView[];
}

/* ---------- simulation: src/game/sim (organizer) ---------- */

export interface ISimulation {
  step(inputs: ReadonlyMap<EntityId, InputActions>): GameEvent[];
  snapshot(): WorldSnapshot;
}
