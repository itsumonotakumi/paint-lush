import type { MatchPhase } from './events';
import type { EntityId, TeamId, Vec3 } from './types';

export type PlayerStateName = 'stance' | 'dive' | 'air' | 'down' | 'respawn';

/** Read-only view of a player for rendering and UI. */
export interface PlayerView {
  id: EntityId;
  team: TeamId;
  state: PlayerStateName;
  pos: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  ink: number;
  weaponId: string;
  /** Special gauge in 0..1. */
  gauge: number;
  specialActive: boolean;
  /** Weapon charge in 0..1, 0 when not charging. */
  charge: number;
  kills: number;
}

export interface ProjectileView {
  id: number;
  team: TeamId;
  pos: Vec3;
}

export interface BombView {
  id: number;
  team: TeamId;
  pos: Vec3;
  /** Remaining fuse in 0..1. */
  fuse: number;
}

export interface WorldSnapshot {
  tick: number;
  players: PlayerView[];
  projectiles: ProjectileView[];
  bombs: BombView[];
  phase: MatchPhase;
  /** Seconds left in the match; 0 in training. */
  timeLeft: number;
  /** Painted cell counts by team. */
  counts: [number, number];
}
