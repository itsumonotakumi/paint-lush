import type { EntityId, TeamId, Vec3 } from './types';

export type MatchPhase = 'pre' | 'play' | 'lastMinute' | 'countdown' | 'finished';

/** Discriminated union. Audio and effects react to these and nothing else. */
export type GameEvent =
  | { t: 'paint'; team: TeamId; cells: number; pos: Vec3 }
  | { t: 'shoot'; weapon: string; pos: Vec3 }
  | { t: 'impact'; pos: Vec3 }
  | { t: 'hit'; target: EntityId; damage: number; pos: Vec3 }
  | { t: 'kill'; killer: EntityId; victim: EntityId; pos: Vec3 }
  | { t: 'respawn'; id: EntityId; pos: Vec3 }
  | { t: 'dive'; id: EntityId; in: boolean; pos: Vec3 }
  | { t: 'jump'; id: EntityId; pos: Vec3 }
  | { t: 'land'; id: EntityId; pos: Vec3 }
  | { t: 'special'; phase: 'ready' | 'start' | 'end' }
  | { t: 'phase'; phase: MatchPhase };
