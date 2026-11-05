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
  /** Seconds after the event before this layer starts. Omitted means zero. */
  readonly delay?: number;
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
/** Longest delay used by a voice jingle; keeps the sound start-to-end below 2 s. */
const MAX_DELAY = 2;

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
  delay = 0,
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
    delay: clamp(finiteOr(delay, 0), 0, MAX_DELAY),
  };
}

/** Rounded, finite priority. */
function priority(value: number): number {
  return Math.round(clamp(finiteOr(value, 0), 0, 1000));
}

function spec(priorityValue: number, layers: readonly SeLayer[]): SeSpec {
  return { priority: priority(priorityValue), layers };
}

/** Compile-time proof that every event variant is covered. */
function assertNever(value: never): never {
  return value;
}

/** The three weapons keep clearly different shots so players can hear who fires. */
function shootSpec(weapon: string): SeSpec {
  switch (weapon) {
    case 'iro-shuriken':
      return spec(56, [
        layer('square', 980, 340, 0.075, 0.17, 0.002, 0.04),
        layer('noise', 5600, 2400, 0.05, 0.1, 0.001, 0.035),
      ]);
    case 'oofude':
      return spec(56, [
        layer('triangle', 300, 520, 0.12, 0.16, 0.004, 0.07),
        layer('noise', 1500, 420, 0.1, 0.12, 0.002, 0.06),
      ]);
    case 'naga-fukiya':
      return spec(56, [
        layer('sine', 1500, 620, 0.09, 0.14, 0.003, 0.05),
        layer('noise', 7200, 1400, 0.07, 0.07, 0.001, 0.045),
      ]);
    default:
      return spec(55, [
        layer('square', 760, 260, 0.09, 0.18, 0.003, 0.05),
        layer('noise', 4200, 1800, 0.055, 0.08, 0.001, 0.04),
      ]);
  }
}

/** Original taiko-and-flute jingles. No recorded or synthesised speech is used. */
function voiceSpec(line: 'start' | 'lastMinute' | 'win' | 'lose'): SeSpec {
  switch (line) {
    case 'start':
      return spec(95, [
        layer('noise', 1800, 160, 0.45, 0.18, 0.002, 0.3),
        layer('sine', 120, 68, 0.5, 0.16, 0.003, 0.34),
        layer('triangle', 660, 760, 0.32, 0.1, 0.02, 0.18, 0.05),
        layer('sine', 880, 990, 0.3, 0.08, 0.02, 0.16, 0.36),
        layer('triangle', 990, 1320, 0.5, 0.1, 0.03, 0.25, 0.68),
      ]);
    case 'lastMinute':
      return spec(96, [
        layer('noise', 2400, 180, 0.35, 0.2, 0.002, 0.24),
        layer('sine', 150, 75, 0.4, 0.15, 0.003, 0.28),
        layer('square', 1040, 1040, 0.12, 0.1, 0.004, 0.07),
        layer('triangle', 780, 780, 0.14, 0.08, 0.006, 0.08, 0.18),
        layer('square', 1040, 1040, 0.12, 0.1, 0.004, 0.07, 0.36),
        layer('triangle', 780, 1200, 0.5, 0.09, 0.02, 0.28, 0.55),
      ]);
    case 'win':
      return spec(94, [
        layer('noise', 2200, 150, 0.5, 0.18, 0.002, 0.34),
        layer('sine', 130, 70, 0.55, 0.14, 0.003, 0.38),
        layer('triangle', 660, 660, 0.28, 0.1, 0.01, 0.16, 0.02),
        layer('sine', 880, 880, 0.28, 0.09, 0.01, 0.16, 0.34),
        layer('triangle', 1100, 1100, 0.3, 0.1, 0.01, 0.17, 0.66),
        layer('sine', 1320, 1320, 0.55, 0.1, 0.02, 0.32, 0.95),
      ]);
    case 'lose':
      return spec(80, [
        layer('noise', 1200, 120, 0.5, 0.15, 0.002, 0.36),
        layer('sine', 110, 60, 0.55, 0.13, 0.003, 0.4),
        layer('triangle', 700, 620, 0.35, 0.1, 0.01, 0.2, 0.05),
        layer('sine', 520, 460, 0.35, 0.08, 0.01, 0.2, 0.4),
        layer('triangle', 390, 300, 0.6, 0.09, 0.02, 0.36, 0.75),
      ]);
    default:
      return assertNever(line);
  }
}

function uiSpec(kind: 'cursor' | 'ok' | 'cancel'): SeSpec {
  switch (kind) {
    case 'cursor':
      return spec(30, [
        layer('square', 1200, 900, 0.035, 0.06, 0.001, 0.02),
        layer('sine', 1800, 1500, 0.025, 0.03, 0.001, 0.015),
      ]);
    case 'ok':
      return spec(50, [
        layer('sine', 660, 990, 0.12, 0.1, 0.004, 0.07),
        layer('triangle', 990, 1320, 0.1, 0.06, 0.003, 0.06),
      ]);
    case 'cancel':
      return spec(50, [
        layer('triangle', 520, 260, 0.14, 0.1, 0.003, 0.09),
        layer('square', 360, 180, 0.1, 0.06, 0.003, 0.06),
      ]);
    default:
      return assertNever(kind);
  }
}

function chargeSpec(level: 0 | 1 | 2): SeSpec {
  switch (level) {
    case 0:
      return spec(40, [
        layer('sine', 420, 500, 0.12, 0.08, 0.004, 0.07),
        layer('triangle', 840, 1000, 0.08, 0.04, 0.003, 0.05),
      ]);
    case 1:
      return spec(46, [
        layer('triangle', 560, 740, 0.16, 0.1, 0.005, 0.09),
        layer('sine', 1120, 1480, 0.1, 0.05, 0.004, 0.06),
      ]);
    case 2:
      return spec(58, [
        layer('square', 760, 1080, 0.22, 0.14, 0.006, 0.13),
        layer('sine', 1520, 2160, 0.16, 0.07, 0.004, 0.1),
      ]);
    default:
      return assertNever(level);
  }
}

/**
 * Returns the procedural sound for an event, or null when the event is silent.
 * Pure and deterministic: the same event always yields the same spec.
 */
export function seSpecFor(event: GameEvent): SeSpec | null {
  switch (event.t) {
    case 'shoot':
      return shootSpec(event.weapon);

    case 'impact':
      return spec(48, [
        layer('noise', 3200, 700, 0.11, 0.14, 0.001, 0.08),
        layer('triangle', 190, 80, 0.1, 0.12, 0.002, 0.07),
      ]);

    case 'paint': {
      const cells = clamp(finiteOr(event.cells, 0), 0, PAINT_MAX_CELLS);
      const rise = cells / PAINT_MAX_CELLS;
      const base = 300 + 360 * rise;
      const gain = 0.1 + 0.1 * rise;
      return spec(24 + cells * 0.5, [
        layer('triangle', base, base * 1.25, 0.085, gain, 0.004, 0.05),
        layer('sine', base * 2, base * 2.4, 0.06, gain * 0.45, 0.002, 0.04),
      ]);
    }

    case 'hit':
      return spec(65, [
        layer('square', 540, 170, 0.1, 0.17, 0.002, 0.07),
        layer('noise', 2600, 900, 0.07, 0.1, 0.001, 0.05),
      ]);

    case 'kill':
      return spec(88, [
        layer('sawtooth', 300, 55, 0.34, 0.22, 0.005, 0.24),
        layer('noise', 6000, 900, 0.24, 0.16, 0.001, 0.18),
        layer('sine', 950, 1300, 0.18, 0.09, 0.002, 0.12),
      ]);

    case 'respawn':
      return spec(72, [
        layer('sine', 300, 900, 0.3, 0.14, 0.01, 0.16),
        layer('triangle', 600, 1800, 0.26, 0.08, 0.008, 0.14),
      ]);

    case 'dive':
      return event.in
        ? spec(42, [
            layer('noise', 2400, 300, 0.22, 0.16, 0.002, 0.14),
            layer('sine', 520, 170, 0.18, 0.1, 0.003, 0.11),
          ])
        : spec(42, [
            layer('noise', 400, 2600, 0.18, 0.13, 0.002, 0.11),
            layer('sine', 180, 640, 0.16, 0.1, 0.003, 0.1),
          ]);

    case 'jump':
      return spec(38, [
        layer('square', 300, 640, 0.1, 0.12, 0.002, 0.06),
        layer('noise', 1200, 2100, 0.06, 0.06, 0.001, 0.04),
      ]);

    case 'land':
      return spec(32, [
        layer('noise', 1200, 180, 0.13, 0.16, 0.001, 0.09),
        layer('sine', 140, 70, 0.12, 0.12, 0.002, 0.08),
      ]);

    case 'special': {
      const phase = event.phase;
      switch (phase) {
        case 'ready':
          return spec(74, [
            layer('sine', 660, 990, 0.18, 0.12, 0.006, 0.1),
            layer('triangle', 990, 1320, 0.2, 0.08, 0.006, 0.12),
          ]);
        case 'start':
          return spec(98, [
            layer('sawtooth', 220, 880, 0.4, 0.2, 0.01, 0.26),
            layer('square', 440, 1760, 0.35, 0.13, 0.008, 0.22),
            layer('noise', 3000, 9000, 0.2, 0.12, 0.002, 0.14),
          ]);
        case 'end':
          return spec(82, [
            layer('sawtooth', 700, 180, 0.38, 0.16, 0.008, 0.24),
            layer('sine', 880, 220, 0.34, 0.1, 0.006, 0.2),
          ]);
        default:
          return assertNever(phase);
      }
    }

    case 'phase': {
      const phase = event.phase;
      switch (phase) {
        case 'pre':
          return spec(50, [
            layer('sine', 220, 330, 0.5, 0.1, 0.08, 0.3),
            layer('triangle', 330, 440, 0.46, 0.05, 0.06, 0.26),
          ]);
        case 'play':
          return spec(60, [
            layer('square', 660, 990, 0.16, 0.13, 0.004, 0.09),
            layer('triangle', 990, 1320, 0.14, 0.07, 0.003, 0.08),
          ]);
        case 'lastMinute':
          return spec(90, [
            layer('sawtooth', 440, 660, 0.26, 0.17, 0.006, 0.15),
            layer('square', 880, 1320, 0.22, 0.09, 0.004, 0.12),
          ]);
        case 'countdown':
          return spec(86, [
            layer('square', 1000, 1000, 0.08, 0.2, 0.001, 0.05),
            layer('noise', 5000, 2500, 0.05, 0.08, 0.001, 0.03),
          ]);
        case 'finished':
          return spec(92, [
            layer('triangle', 880, 440, 0.6, 0.16, 0.01, 0.4),
            layer('sine', 660, 330, 0.55, 0.1, 0.008, 0.36),
          ]);
        default:
          return assertNever(phase);
      }
    }

    case 'sub':
      return event.phase === 'throw'
        ? spec(52, [
            layer('noise', 700, 3200, 0.16, 0.12, 0.002, 0.1),
            layer('square', 260, 520, 0.12, 0.1, 0.003, 0.08),
          ])
        : spec(84, [
            layer('noise', 5000, 300, 0.35, 0.2, 0.001, 0.25),
            layer('sine', 160, 55, 0.32, 0.18, 0.003, 0.22),
            layer('square', 320, 90, 0.18, 0.1, 0.002, 0.12),
          ]);

    case 'swing':
      return spec(45, [
        layer('noise', 1800, 600, 0.12, 0.13, 0.001, 0.09),
        layer('triangle', 700, 300, 0.14, 0.09, 0.003, 0.1),
      ]);

    case 'charge':
      return chargeSpec(event.level);

    case 'countdown': {
      const urgent = Number.isFinite(event.n) && event.n <= 3;
      return urgent
        ? spec(88, [
            layer('square', 1320, 1320, 0.09, 0.2, 0.001, 0.05),
            layer('sine', 2640, 2640, 0.07, 0.09, 0.001, 0.04),
            layer('noise', 6000, 4000, 0.04, 0.06, 0.001, 0.03),
          ])
        : spec(70, [
            layer('square', 880, 880, 0.08, 0.16, 0.001, 0.05),
            layer('sine', 1760, 1760, 0.06, 0.07, 0.001, 0.035),
          ]);
    }

    case 'voice':
      return voiceSpec(event.line);

    case 'ui':
      return uiSpec(event.kind);

    default:
      return assertNever(event);
  }
}
