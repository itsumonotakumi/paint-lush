/**
 * Pure sequencing helpers for the procedural soundtrack.
 *
 * A track is plain data. Steps are sixteenth notes; a beat is four steps, and a
 * bar is four beats. Nothing in this module touches an audio context.
 */

/** Sixteenth notes per beat. */
export const STEPS_PER_BEAT = 4;
/** Beats per bar in 4/4 time. */
export const BEATS_PER_BAR = 4;

export type BgmInstrumentId =
  | 'kick'
  | 'snare'
  | 'hat'
  | 'bass'
  | 'guitar'
  | 'shamisen'
  | 'shakuhachi';

export interface BgmNote {
  /** Position inside the loop, in sixteenth notes. */
  readonly step: number;
  /** MIDI note number; drums use 36/38/42 for a taiko kit. */
  readonly midi: number;
  /** Length in sixteenth notes. */
  readonly length: number;
  /** Linear velocity in 0..1. */
  readonly velocity: number;
}

export interface BgmPart {
  readonly instrument: BgmInstrumentId;
  readonly notes: readonly BgmNote[];
}

export interface BgmTrack {
  readonly id: string;
  /** Beats per minute, always in the 150..175 range for this soundtrack. */
  readonly bpm: number;
  readonly loopBars: number;
  readonly parts: readonly BgmPart[];
  /** False for the win and lose jingles, which play once. */
  readonly loop: boolean;
}

/** A note resolved to an absolute position in beats. */
export interface ScheduledNote {
  readonly instrument: BgmInstrumentId;
  readonly midi: number;
  /** Start in beats from the beginning of the track, including loop repeats. */
  readonly beat: number;
  /** Length in beats. */
  readonly length: number;
  readonly velocity: number;
}

/** Safety valve so a silly window cannot allocate without bound. */
const MAX_RESULT_NOTES = 4096;
/** Safety valve for extremely large windows over sparse tracks. */
const MAX_CYCLES = 2048;
/** Beyond this cycle index, adding one is still exact but musically absurd. */
const MAX_CYCLE_INDEX = 1e12;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Loop length in beats, or 0 when the track data is unusable. */
export function loopLengthBeats(track: BgmTrack): number {
  const beats = finiteOr(track.loopBars, 0) * BEATS_PER_BAR;
  return Number.isFinite(beats) && beats > 0 ? beats : 0;
}

/** Length of one pass in seconds, or 0 for malformed data. */
export function trackDurationSeconds(track: BgmTrack): number {
  const beats = loopLengthBeats(track);
  const bpm = finiteOr(track.bpm, 0);
  if (beats <= 0 || bpm <= 0) return 0;
  return (beats * 60) / bpm;
}

function isPlayableNote(note: BgmNote, loopSteps: number): boolean {
  return (
    Number.isFinite(note.step) &&
    Number.isFinite(note.midi) &&
    Number.isFinite(note.length) &&
    Number.isFinite(note.velocity) &&
    note.step >= 0 &&
    note.step < loopSteps &&
    note.length > 0
  );
}

function compareNotes(a: ScheduledNote, b: ScheduledNote): number {
  if (a.beat !== b.beat) return a.beat - b.beat;
  if (a.instrument !== b.instrument) return a.instrument < b.instrument ? -1 : 1;
  return a.midi - b.midi;
}

/**
 * Returns the notes that start inside `[fromBeat, toBeat)`, measured from the
 * start of the track. Looping tracks repeat automatically and wrap correctly.
 * A window that starts before zero is treated as starting at zero.
 */
export function notesBetween(
  track: BgmTrack,
  fromBeat: number,
  toBeat: number,
): ScheduledNote[] {
  if (!Number.isFinite(fromBeat) || !Number.isFinite(toBeat)) return [];
  const from = Math.max(0, fromBeat);
  if (!(toBeat > from)) return [];

  const loopBeats = loopLengthBeats(track);
  if (loopBeats <= 0) return [];

  const loopSteps = Math.round(loopBeats * STEPS_PER_BEAT);
  if (!Number.isFinite(loopSteps) || loopSteps <= 0) return [];

  const result: ScheduledNote[] = [];
  let startCycle = track.loop ? Math.floor(from / loopBeats) : 0;
  if (!Number.isFinite(startCycle)) return [];
  if (startCycle < 0) startCycle = 0;
  if (startCycle > MAX_CYCLE_INDEX) return [];

  let endCycle = track.loop ? Math.ceil(toBeat / loopBeats) : 1;
  if (!Number.isFinite(endCycle)) endCycle = startCycle + 1;
  if (endCycle <= startCycle) endCycle = startCycle + 1;
  if (endCycle - startCycle > MAX_CYCLES) endCycle = startCycle + MAX_CYCLES;

  for (let cycle = startCycle; cycle < endCycle; cycle += 1) {
    if (result.length >= MAX_RESULT_NOTES) break;
    const cycleStart = cycle * loopBeats;
    if (!Number.isFinite(cycleStart)) break;
    for (const part of track.parts) {
      for (const note of part.notes) {
        if (result.length >= MAX_RESULT_NOTES) break;
        if (!isPlayableNote(note, loopSteps)) continue;
        const beat = cycleStart + note.step / STEPS_PER_BEAT;
        if (beat < from || beat >= toBeat) continue;
        result.push({
          instrument: part.instrument,
          midi: clamp(note.midi, 0, 127),
          beat,
          length: clamp(note.length / STEPS_PER_BEAT, 0.01, loopBeats),
          velocity: clamp(note.velocity, 0, 1),
        });
      }
    }
  }

  result.sort(compareNotes);
  return result;
}
