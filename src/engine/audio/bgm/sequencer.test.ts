import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { BgmInstrumentId, BgmTrack } from './sequencer';
import {
  BEATS_PER_BAR,
  STEPS_PER_BEAT,
  loopLengthBeats,
  notesBetween,
  trackDurationSeconds,
} from './sequencer';
import { TRACKS, TRACK_IDS, getTrack } from './tracks';

const INSTRUMENTS: readonly BgmInstrumentId[] = [
  'kick',
  'snare',
  'hat',
  'bass',
  'guitar',
  'shamisen',
  'shakuhachi',
];

function simpleTrack(loop: boolean): BgmTrack {
  return {
    id: 'test',
    bpm: 120,
    loopBars: 1,
    loop,
    parts: [
      {
        instrument: 'shamisen',
        notes: [
          { step: 0, midi: 60, length: 2, velocity: 0.5 },
          { step: 4, midi: 62, length: 1, velocity: 0.6 },
          { step: 8, midi: 64, length: 1, velocity: 0.7 },
          { step: 12, midi: 65, length: 1, velocity: 0.8 },
        ],
      },
    ],
  };
}

describe('track data', () => {
  it('provides the six required track ids', () => {
    expect(TRACK_IDS).toEqual(['title', 'battle', 'lastMinute', 'win', 'lose', 'special']);
    expect(TRACKS).toHaveLength(6);
    for (const id of TRACK_IDS) {
      const track = getTrack(id);
      expect(track).not.toBeNull();
      expect(track?.id).toBe(id);
    }
    expect(getTrack('unknown')).toBeNull();
  });

  it('keeps every note finite, ordered and inside the loop', () => {
    for (const track of TRACKS) {
      expect(Number.isFinite(track.bpm)).toBe(true);
      expect(track.bpm).toBeGreaterThanOrEqual(150);
      expect(track.bpm).toBeLessThanOrEqual(175);
      expect(Number.isInteger(track.loopBars)).toBe(true);
      expect(track.loopBars).toBeGreaterThan(0);
      expect(track.parts.length).toBeGreaterThan(0);
      const loopSteps = track.loopBars * BEATS_PER_BAR * STEPS_PER_BEAT;
      expect(loopLengthBeats(track)).toBeCloseTo(track.loopBars * BEATS_PER_BAR);

      for (const part of track.parts) {
        expect(INSTRUMENTS).toContain(part.instrument);
        expect(part.notes.length).toBeGreaterThan(0);
        let previousStep = -1;
        for (const note of part.notes) {
          expect(Number.isFinite(note.step)).toBe(true);
          expect(Number.isFinite(note.midi)).toBe(true);
          expect(Number.isFinite(note.length)).toBe(true);
          expect(Number.isFinite(note.velocity)).toBe(true);
          expect(Number.isInteger(note.step)).toBe(true);
          expect(note.step).toBeGreaterThanOrEqual(0);
          expect(note.step).toBeLessThan(loopSteps);
          expect(note.step).toBeGreaterThanOrEqual(previousStep);
          expect(note.midi).toBeGreaterThanOrEqual(0);
          expect(note.midi).toBeLessThanOrEqual(127);
          expect(note.length).toBeGreaterThan(0);
          expect(note.velocity).toBeGreaterThanOrEqual(0);
          expect(note.velocity).toBeLessThanOrEqual(1);
          previousStep = note.step;
        }
      }
    }
  });

  it('uses the requested bar counts and non-looping jingles', () => {
    expect(getTrack('title')?.loopBars).toBe(16);
    expect(getTrack('battle')?.loopBars).toBe(32);
    expect(getTrack('lastMinute')?.loopBars).toBe(16);
    expect(getTrack('special')?.loopBars).toBe(8);
    expect(getTrack('title')?.loop).toBe(true);
    expect(getTrack('battle')?.loop).toBe(true);
    expect(getTrack('lastMinute')?.loop).toBe(true);
    expect(getTrack('special')?.loop).toBe(true);
    expect(getTrack('win')?.loop).toBe(false);
    expect(getTrack('lose')?.loop).toBe(false);

    const win = getTrack('win');
    const lose = getTrack('lose');
    expect(win === null ? 0 : trackDurationSeconds(win)).toBeGreaterThan(11);
    expect(win === null ? 0 : trackDurationSeconds(win)).toBeLessThan(13);
    expect(lose === null ? 0 : trackDurationSeconds(lose)).toBeGreaterThan(11.5);
    expect(lose === null ? 0 : trackDurationSeconds(lose)).toBeLessThan(13.5);
  });
});

describe('notesBetween', () => {
  it('returns notes whose onset lies in the half-open window', () => {
    const track = simpleTrack(true);
    const result = notesBetween(track, 0, 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.beat).toBe(0);
    expect(result[0]?.length).toBeCloseTo(0.5);
    expect(result[0]?.instrument).toBe('shamisen');
  });

  it('wraps a looping track across the loop boundary', () => {
    const track = simpleTrack(true);
    const result = notesBetween(track, 3.5, 5.5);
    expect(result.map((note) => note.beat)).toEqual([4, 5]);
    expect(result.map((note) => note.midi)).toEqual([60, 62]);
  });

  it('does not wrap a non-looping track', () => {
    const looping = notesBetween(simpleTrack(true), 2.5, 20);
    const once = notesBetween(simpleTrack(false), 2.5, 20);
    expect(looping.length).toBeGreaterThan(once.length);
    expect(once.map((note) => note.beat)).toEqual([3]);
  });

  it('wraps the real title track at 64 beats', () => {
    const title = getTrack('title');
    expect(title).not.toBeNull();
    if (title === null) return;
    const result = notesBetween(title, 63.9, 64.1);
    expect(result.length).toBeGreaterThan(0);
    for (const note of result) {
      expect(note.beat).toBeGreaterThanOrEqual(63.9);
      expect(note.beat).toBeLessThan(64.1);
    }
    expect(result.some((note) => note.beat === 64)).toBe(true);
  });

  it('guards bad windows and huge spans', () => {
    const track = simpleTrack(true);
    expect(notesBetween(track, Number.NaN, 4)).toEqual([]);
    expect(notesBetween(track, 0, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(notesBetween(track, 4, 4)).toEqual([]);
    expect(notesBetween(track, 5, 4)).toEqual([]);
    expect(notesBetween(track, -10, 0.5).map((note) => note.beat)).toEqual([0]);
    expect(notesBetween(simpleTrack(true), 0, 1_000_000).length).toBeLessThanOrEqual(4096);
    expect(notesBetween(simpleTrack(true), 1e300, 1.7e308)).toEqual([]);
    expect(notesBetween(simpleTrack(true), 0, 1e308).length).toBeLessThanOrEqual(4096);
  });

  it('always returns sorted, finite notes in the requested window', () => {
    const title = getTrack('title');
    expect(title).not.toBeNull();
    if (title === null) return;
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 256, noNaN: true }),
        fc.double({ min: 0, max: 16, noNaN: true }),
        (start, span) => {
          const end = start + span;
          const result = notesBetween(title, start, end);
          let previous = Number.NEGATIVE_INFINITY;
          for (const note of result) {
            expect(Number.isFinite(note.beat)).toBe(true);
            expect(Number.isFinite(note.length)).toBe(true);
            expect(Number.isFinite(note.velocity)).toBe(true);
            expect(Number.isFinite(note.midi)).toBe(true);
            expect(note.beat).toBeGreaterThanOrEqual(start);
            expect(note.beat).toBeLessThan(end);
            expect(note.beat).toBeGreaterThanOrEqual(previous);
            expect(note.midi).toBeGreaterThanOrEqual(0);
            expect(note.midi).toBeLessThanOrEqual(127);
            expect(note.velocity).toBeGreaterThanOrEqual(0);
            expect(note.velocity).toBeLessThanOrEqual(1);
            previous = note.beat;
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});
