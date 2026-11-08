import type { InputActions, InputDevice } from '../../core/actions';
import type { GameEvent } from '../../core/events';
import type { PlayerView, WorldSnapshot } from '../../core/snapshot';

/**
 * Contract for the guided tutorial that runs on the training stage.
 * The controller is pure logic (no DOM, no three); the overlay only draws.
 */

export type TutorialStepId =
  | 'move'
  | 'look'
  | 'shoot'
  | 'dive'
  | 'jump'
  | 'bomb'
  | 'dummy'
  | 'special'
  | 'done';

/** Everything the controller may look at for one fixed simulation tick. */
export interface TutorialFrame {
  localId: number;
  /** Local player after this tick; null while not spawned. */
  me: PlayerView | null;
  snapshot: WorldSnapshot;
  /** Events produced by this tick. */
  events: readonly GameEvent[];
  /** Actions the local player sent this tick. */
  actions: InputActions;
  /** Fixed tick length in seconds. */
  dtSec: number;
  /** Device the player used most recently; hints are worded for it. */
  device: InputDevice;
}

export interface TutorialView {
  stepId: TutorialStepId;
  /** 0-based index of the current step; 'done' equals total. */
  index: number;
  /** Number of real steps (excluding 'done'). */
  total: number;
  /** Short headline in hiragana-first child-friendly Japanese. */
  title: string;
  /** How to do it on the current device, e.g. 「ひだりの スティックを うごかそう」. */
  hint: string;
  /** Progress within the current step, 0..1. */
  progress: number;
  /** True for the ticks during the short celebration after a step is cleared. */
  celebrating: boolean;
  /** True once every step is cleared (stepId === 'done'). */
  finished: boolean;
}

export interface TutorialController {
  /** Advances with one tick of game state. Never throws; ignores bad numbers. */
  update(frame: TutorialFrame): TutorialView;
  /** Current view without advancing. */
  view(): TutorialView;
  /** Skips the current step (button 「つぎへ」). No-op when finished. */
  skipStep(): void;
}

export interface TutorialOverlay {
  mount(root: HTMLElement): void;
  /** Redraws only when something visible changed. Must not allocate per call when unchanged. */
  show(view: TutorialView): void;
  /** Wires the 「つぎへ」 (skip step) and 「おわる」 (quit) buttons. */
  onSkip(handler: () => void): void;
  onQuit(handler: () => void): void;
  /** Hides the card (e.g. while paused) without disposing it. */
  setVisible(visible: boolean): void;
  dispose(): void;
}
