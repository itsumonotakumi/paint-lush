import type { DataTexture, Scene } from 'three';
import type { GameEvent } from '../../core/events';
import type { WorldSnapshot } from '../../core/snapshot';

/** A visual subsystem wired into the renderer. Never reads or changes game state beyond its inputs. */
export interface RenderModule {
  update(dtSec: number, prev: WorldSnapshot, curr: WorldSnapshot, alpha: number): void;
  handle?(event: GameEvent): void;
  dispose(): void;
}

export interface RenderModuleDeps {
  scene: Scene;
  teamColors: [number, number];
  /** Shared toon ramp. Owned by the renderer; do not dispose it. */
  gradient: DataTexture;
  localPlayerId: number;
  /** Phone profile: fewer details, no outline hulls, half particle capacity. */
  lowDetail: boolean;
}

/** The effects module also feeds the camera. */
export interface EffectsModule extends RenderModule {
  /** Camera shake offset in metres for this frame. Must not allocate. */
  shake(out: { x: number; y: number; z: number }): void;
  /** Extra field of view in degrees for this frame. */
  fovBoost(): number;
}
