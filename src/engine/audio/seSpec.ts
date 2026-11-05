import type { GameEvent } from '../../core/events';

/** Waveform used by a single synthesis layer. `noise` plays a filtered white-noise burst. */
export type SeWaveform = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise';

/**
 * One oscillator or noise layer of a sound effect.
 * Times are in seconds and frequencies are in hertz.
 */
export interface SeLayer {
  readonly type: SeWaveform;
  readonly startFreq: number;
  readonly endFreq: number;
  readonly duration: number;
  readonly gain: number;
  /** Linear fade-in time. */
  readonly attack: number;
  /** Linear fade-out time at the tail. */
  readonly decay: number;
}

/** Plain data describing one complete sound effect. */
export interface SeSpec {
  readonly layers: readonly SeLayer[];
  /** Higher wins when the voice budget is exhausted. */
  readonly priority: number;
}

/** Cells beyond this count no longer raise paint pitch or gain. */
const PAINT_MAX_CELLS = 40;
const MIN_DURATION = 0.01;
const MAX_DURATION = 4;
const MIN_FREQ = 1;
const MAX_FREQ = 16000;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Builds a sanitised layer so every spec is finite and playable. */
function layer(
  type: SeWaveform,
  startFreq: number,
  endFreq: number,
  duration: number,
  gain: number,
  attack: number,
  decay: number,
): SeLayer {
  const dur = clamp(finiteOr(duration, 0.08), MIN_DURATION, MAX_DURATION);
  return {
    type,
    startFreq: clamp(finiteOr(startFreq, 440), MIN_FREQ, MAX_FREQ),
    endFreq: clamp(finiteOr(endFreq, 440), MIN_FREQ, MAX_FREQ),
    duration: dur,
    gain: clamp(finiteOr(gain, 0.1), 0, 1),
    attack: clamp(finiteOr(attack, 0.004), 0, dur * 0.4),
    decay: clamp(finiteOr(decay, dur * 0.5), 0, dur * 0.6),
  };
}

/** Rounded, finite priority. */
function priority(value: number): number {
  return Math.round(clamp(finiteOr(value, 0), 0, 1000));
}

/**
 * Returns the procedural sound for an event, or null when the event is silent.
 * Pure and deterministic: the same event always yields the same spec.
 */
export function seSpecFor(event: GameEvent): SeSpec | null {
  switch (event.t) {
    case 'shoot':
      return {
        priority: priority(55),
        layers: [
          layer('square', 760, 260, 0.09, 0.18, 0.003, 0.05),
          layer('noise', 4200, 1800, 0.055, 0.08, 0.001, 0.04),
        ],
      };

    case 'impact':
      return {
        priority: priority(48),
        layers: [
          layer('noise', 3200, 700, 0.11, 0.14, 0.001, 0.08),
          layer('triangle', 190, 80, 0.1, 0.12, 0.002, 0.07),
        ],
      };

    case 'paint': {
      const cells = clamp(finiteOr(event.cells, 0), 0, PAINT_MAX_CELLS);
      const rise = cells / PAINT_MAX_CELLS;
      const base = 300 + 360 * rise;
      const gain = 0.1 + 0.1 * rise;
      return {
        priority: priority(24 + cells * 0.5),
        layers: [
          layer('triangle', base, base * 1.25, 0.085, gain, 0.004, 0.05),
          layer('sine', base * 2, base * 2.4, 0.06, gain * 0.45, 0.002, 0.04),
        ],
      };
    }

    case 'hit':
      return {
        priority: priority(65),
        layers: [
          layer('square', 540, 170, 0.1, 0.17, 0.002, 0.07),
          layer('noise', 2600, 900, 0.07, 0.1, 0.001, 0.05),
        ],
      };

    case 'kill':
      return {
        priority: priority(88),
        layers: [
          layer('sawtooth', 300, 55, 0.34, 0.22, 0.005, 0.24),
          layer('noise', 6000, 900, 0.24, 0.16, 0.001, 0.18),
          layer('sine', 950, 1300, 0.18, 0.09, 0.002, 0.12),
        ],
      };

    case 'respawn':
      return {
        priority: priority(72),
        layers: [
          layer('sine', 300, 900, 0.3, 0.14, 0.01, 0.16),
          layer('triangle', 600, 1800, 0.26, 0.08, 0.008, 0.14),
        ],
      };

    case 'dive':
      return event.in
        ? {
            priority: priority(42),
            layers: [
              layer('noise', 2400, 300, 0.22, 0.16, 0.002, 0.14),
              layer('sine', 520, 170, 0.18, 0.1, 0.003, 0.11),
            ],
          }
        : {
            priority: priority(42),
            layers: [
              layer('noise', 400, 2600, 0.18, 0.13, 0.002, 0.11),
              layer('sine', 180, 640, 0.16, 0.1, 0.003, 0.1),
            ],
          };

    case 'jump':
      return {
        priority: priority(38),
        layers: [
          layer('square', 300, 640, 0.1, 0.12, 0.002, 0.06),
          layer('noise', 1200, 2100, 0.06, 0.06, 0.001, 0.04),
        ],
      };

    case 'land':
      return {
        priority: priority(32),
        layers: [
          layer('noise', 1200, 180, 0.13, 0.16, 0.001, 0.09),
          layer('sine', 140, 70, 0.12, 0.12, 0.002, 0.08),
        ],
      };

    case 'special':
      switch (event.phase) {
        case 'ready':
          return {
            priority: priority(74),
            layers: [
              layer('sine', 660, 990, 0.18, 0.12, 0.006, 0.1),
              layer('triangle', 990, 1320, 0.2, 0.08, 0.006, 0.12),
            ],
          };
        case 'start':
          return {
            priority: priority(98),
            layers: [
              layer('sawtooth', 220, 880, 0.4, 0.2, 0.01, 0.26),
              layer('square', 440, 1760, 0.35, 0.13, 0.008, 0.22),
              layer('noise', 3000, 9000, 0.2, 0.12, 0.002, 0.14),
            ],
          };
        case 'end':
          return {
            priority: priority(82),
            layers: [
              layer('sawtooth', 700, 180, 0.38, 0.16, 0.008, 0.24),
              layer('sine', 880, 220, 0.34, 0.1, 0.006, 0.2),
            ],
          };
        default:
          return null;
      }

    case 'phase':
      switch (event.phase) {
        case 'pre':
          return {
            priority: priority(50),
            layers: [
              layer('sine', 220, 330, 0.5, 0.1, 0.08, 0.3),
              layer('triangle', 330, 440, 0.46, 0.05, 0.06, 0.26),
            ],
          };
        case 'play':
          return {
            priority: priority(60),
            layers: [
              layer('square', 660, 990, 0.16, 0.13, 0.004, 0.09),
              layer('triangle', 990, 1320, 0.14, 0.07, 0.003, 0.08),
            ],
          };
        case 'lastMinute':
          return {
            priority: priority(90),
            layers: [
              layer('sawtooth', 440, 660, 0.26, 0.17, 0.006, 0.15),
              layer('square', 880, 1320, 0.22, 0.09, 0.004, 0.12),
            ],
          };
        case 'countdown':
          return {
            priority: priority(86),
            layers: [
              layer('square', 1000, 1000, 0.08, 0.2, 0.001, 0.05),
              layer('noise', 5000, 2500, 0.05, 0.08, 0.001, 0.03),
            ],
          };
        case 'finished':
          return {
            priority: priority(92),
            layers: [
              layer('triangle', 880, 440, 0.6, 0.16, 0.01, 0.4),
              layer('sine', 660, 330, 0.55, 0.1, 0.008, 0.36),
            ],
          };
        default:
          return null;
      }

    default:
      return null;
  }
}
