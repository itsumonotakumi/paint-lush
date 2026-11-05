import type { InputActions, InputDevice } from '../core/actions';
import type { GameEvent } from '../core/events';
import type { WorldSnapshot } from '../core/snapshot';
import type { MatchResult } from '../game/contracts';
import type { Difficulty, SaveData } from '../game/data/schemas';

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
  /** Sounds tied to another player's special are skipped; `localId` is the listener's player. */
  handle(event: GameEvent, listener: { x: number; y: number; z: number }, localId: number): void;
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
  /** Forgets held keys and pending look, e.g. when pausing, where key releases can be lost. */
  reset(): void;
  lastDevice(): InputDevice;
  dispose(): void;
}

/** On-screen stick and buttons. */
export interface ITouchControls {
  mount(root: HTMLElement): void;
  read(): InputActions;
  /** Drops held buttons and pending look, as IInputSource.reset does. */
  reset(): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface ISaveStore {
  /** Never throws. Returns defaults for missing, corrupt, or oversized data. */
  load(): SaveData;
  /** Never throws. Returns false when storage rejects the write. */
  save(data: SaveData): boolean;
}

/* ---------- screens ---------- */

export type ScreenId = 'boot' | 'title' | 'menu' | 'setup' | 'loading' | 'result' | 'settings' | 'credits';

export interface MatchSetup {
  weaponId: string;
  stageId: string;
  difficulty: Difficulty;
  durationSeconds: number;
}

/** Team name, its kana reading, and colour as 0xRRGGBB for this match. */
export interface TeamLabel {
  name: string;
  reading: string;
  color: number;
}

export type ScreenParams =
  | { kind: 'none' }
  | { kind: 'loading'; setup: MatchSetup | 'training' }
  | { kind: 'result'; result: MatchResult; localId: number; teams: readonly [TeamLabel, TeamLabel] };

export interface ScreenContext {
  save: ISaveStore;
  audio: IAudio;
  /** Shows a screen. */
  go(id: ScreenId, params?: ScreenParams): void;
  /** Starts a match or training; called by the loading screen when ready. */
  start(setup: MatchSetup | 'training'): void;
  /** Returns to the previous screen, used by settings. */
  back(): void;
}

export interface IScreen {
  mount(root: HTMLElement, ctx: ScreenContext, params: ScreenParams): void;
  unmount(): void;
}
