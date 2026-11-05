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
}

export interface ProjectileView {
  id: number;
  team: TeamId;
  pos: Vec3;
}

export interface WorldSnapshot {
  tick: number;
  players: PlayerView[];
  projectiles: ProjectileView[];
  /** Painted cell counts by team. */
  counts: [number, number];
}
