import type { InputActions, InputDevice } from '../core/actions';
import type { GameEvent } from '../core/events';
import type { WorldSnapshot } from '../core/snapshot';
import type { SaveData } from '../game/data/schemas';

export interface IRenderer {
  /** Interpolates between prev and curr by alpha in [0, 1]. */
  render(prev: WorldSnapshot, curr: WorldSnapshot, alpha: number, cameraPlayerId: number): void;
  /** Feeds visual effects. Called once per event. */
  handle(event: GameEvent): void;
  resize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

export interface IAudio {
  /** Must be called from a user gesture. Safe to call repeatedly. */
  unlock(): Promise<void>;
  handle(event: GameEvent, listener: { x: number; y: number; z: number }): void;
  setBgm(id: string | null): void;
  setVolumes(volumes: { bgm: number; se: number; voice: number }): void;
}

/** Lets procedural music be replaced by file playback without touching callers. */
export interface BgmSource {
  start(id: string, when: number): void;
  stop(when: number): void;
}

export interface IInputSource {
  poll(): InputActions;
  lastDevice(): InputDevice;
  dispose(): void;
}

export interface ISaveStore {
  /** Never throws. Returns defaults for missing, corrupt, or oversized data. */
  load(): SaveData;
  /** Never throws. Returns false when storage rejects the write. */
  save(data: SaveData): boolean;
}
