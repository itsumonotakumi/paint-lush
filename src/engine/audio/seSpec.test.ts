import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../core/events';
import { seSpecFor, type SeLayer, type SeSpec } from './seSpec';

const pos = { x: 0, y: 0, z: 0 };

function firstLayer(spec: SeSpec): SeLayer {
  const layer = spec.layers[0];
  if (layer === undefined) throw new Error('spec is missing its first layer');
  return layer;
}

function paintSpec(cells: number): SeSpec {
  const spec = seSpecFor({ t: 'paint', team: 0, cells, pos });
  if (spec === null) throw new Error('paint should be audible');
  return spec;
}

const events: GameEvent[] = [
  { t: 'paint', team: 0, cells: 5, pos },
  { t: 'shoot', weapon: 'test-weapon', pos },
  { t: 'impact', pos },
  { t: 'hit', target: 1, damage: 20, pos },
  { t: 'kill', killer: 1, victim: 2, pos },
  { t: 'respawn', id: 2, pos },
  { t: 'dive', id: 1, in: true, pos },
  { t: 'dive', id: 1, in: false, pos },
  { t: 'jump', id: 1, pos },
  { t: 'land', id: 1, pos },
  { t: 'special', id: 1, phase: 'ready' },
  { t: 'special', id: 1, phase: 'start' },
  { t: 'special', id: 1, phase: 'end' },
  { t: 'phase', phase: 'pre' },
  { t: 'phase', phase: 'play' },
  { t: 'phase', phase: 'lastMinute' },
  { t: 'phase', phase: 'countdown' },
  { t: 'phase', phase: 'finished' },
  { t: 'sub', phase: 'throw', team: 0, pos },
  { t: 'sub', phase: 'burst', team: 1, pos },
  { t: 'swing', id: 1, pos },
  { t: 'charge', id: 1, level: 0 },
  { t: 'charge', id: 1, level: 1 },
  { t: 'charge', id: 1, level: 2 },
  { t: 'countdown', n: 5 },
  { t: 'countdown', n: 3 },
  { t: 'voice', line: 'start' },
  { t: 'voice', line: 'lastMinute' },
  { t: 'voice', line: 'win' },
  { t: 'voice', line: 'lose' },
  { t: 'ui', kind: 'cursor' },
  { t: 'ui', kind: 'ok' },
  { t: 'ui', kind: 'cancel' },
];

function required(event: GameEvent): SeSpec {
  const spec = seSpecFor(event);
  if (spec === null) throw new Error(`expected audible ${event.t}`);
  return spec;
}

describe('seSpecFor', () => {
  it('returns playable, finite layers for every event', () => {
    for (const event of events) {
      const spec = seSpecFor(event);
      expect(spec, event.t).not.toBeNull();
      if (spec === null) continue;
      expect(Number.isFinite(spec.priority)).toBe(true);
      expect(spec.layers.length).toBeGreaterThan(0);

      for (const layer of spec.layers) {
        expect(Number.isFinite(layer.startFreq)).toBe(true);
        expect(Number.isFinite(layer.endFreq)).toBe(true);
        expect(Number.isFinite(layer.duration)).toBe(true);
        expect(Number.isFinite(layer.gain)).toBe(true);
        expect(Number.isFinite(layer.attack)).toBe(true);
        expect(Number.isFinite(layer.decay)).toBe(true);
        expect(layer.startFreq).toBeGreaterThan(0);
        expect(layer.endFreq).toBeGreaterThan(0);
        expect(layer.duration).toBeGreaterThan(0);
        expect(layer.gain).toBeGreaterThan(0);
        expect(layer.gain).toBeLessThanOrEqual(1);
        expect(layer.attack).toBeGreaterThanOrEqual(0);
        expect(layer.decay).toBeGreaterThanOrEqual(0);
        expect(layer.attack + layer.decay).toBeLessThanOrEqual(layer.duration + 1e-9);
      }
    }
  });

  it('keeps paint pitch and gain rising with cells, then clamps', () => {
    const cells = [0, 1, 4, 10, 20, 39, 40, 41, 500, 1e9];
    const pitches = cells.map((value) => firstLayer(paintSpec(value)).startFreq);
    const gains = cells.map((value) => firstLayer(paintSpec(value)).gain);

    for (let i = 1; i < cells.length; i += 1) {
      const prevPitch = pitches[i - 1];
      const pitch = pitches[i];
      const prevGain = gains[i - 1];
      const gain = gains[i];
      if (prevPitch === undefined || pitch === undefined) throw new Error('missing pitch');
      if (prevGain === undefined || gain === undefined) throw new Error('missing gain');
      expect(pitch).toBeGreaterThanOrEqual(prevPitch);
      expect(gain).toBeGreaterThanOrEqual(prevGain);
    }

    // Clamped at 40 cells: larger splats sound identical.
    expect(pitches[6]).toBe(pitches[8]);
    expect(pitches[6]).toBe(pitches[9]);
    expect(gains[6]).toBe(gains[9]);
    expect(pitches[0]).toBeLessThan(pitches[6] ?? 0);
  });

  it('treats hostile numeric input as safe', () => {
    for (const cells of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -100]) {
      const spec = paintSpec(cells);
      for (const layer of spec.layers) {
        expect(Number.isFinite(layer.startFreq)).toBe(true);
        expect(Number.isFinite(layer.gain)).toBe(true);
        expect(layer.gain).toBeGreaterThan(0);
      }
    }
  });

  it('gives dive-in and dive-out different pitch contours', () => {
    const diveIn = firstLayer(seSpecFor({ t: 'dive', id: 1, in: true, pos }) ?? paintSpec(0));
    const diveOut = firstLayer(seSpecFor({ t: 'dive', id: 1, in: false, pos }) ?? paintSpec(0));
    expect(diveIn.startFreq).toBeGreaterThan(diveIn.endFreq);
    expect(diveOut.startFreq).toBeLessThan(diveOut.endFreq);
  });

  it('is deterministic', () => {
    expect(seSpecFor({ t: 'kill', killer: 1, victim: 2, pos })).toEqual(
      seSpecFor({ t: 'kill', killer: 1, victim: 2, pos }),
    );
  });

  it('covers at least 30 distinct event sounds', () => {
    const serialized = events.map((event) => JSON.stringify(required(event)));
    expect(new Set(serialized).size).toBeGreaterThanOrEqual(30);
    expect(new Set(serialized).size).toBe(events.length);
  });

  it('gives each named weapon a different shot', () => {
    const shots = ['iro-shuriken', 'oofude', 'naga-fukiya'].map((weapon) =>
      JSON.stringify(required({ t: 'shoot', weapon, pos })),
    );
    expect(new Set(shots).size).toBe(3);
  });

  it('raises charge pitch with every level', () => {
    const pitches = ([0, 1, 2] as const).map(
      (level) => firstLayer(required({ t: 'charge', id: 1, level })).startFreq,
    );
    expect(pitches[0]).toBeLessThan(pitches[1] ?? 0);
    expect(pitches[1]).toBeLessThan(pitches[2] ?? 0);
  });

  it('makes the final countdown ticks brighter and higher', () => {
    const early = firstLayer(required({ t: 'countdown', n: 5 }));
    const final = firstLayer(required({ t: 'countdown', n: 3 }));
    expect(final.startFreq).toBeGreaterThan(early.startFreq);
    expect(required({ t: 'countdown', n: 1 })).toEqual(required({ t: 'countdown', n: 3 }));

    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const spec = required({ t: 'countdown', n });
      expect(Number.isFinite(firstLayer(spec).startFreq)).toBe(true);
    }
  });

  it('keeps every voice jingle between one and two seconds', () => {
    for (const line of ['start', 'lastMinute', 'win', 'lose'] as const) {
      const spec = required({ t: 'voice', line });
      const total = Math.max(
        ...spec.layers.map((layer) => (layer.delay ?? 0) + layer.duration),
      );
      expect(total).toBeGreaterThanOrEqual(1);
      expect(total).toBeLessThanOrEqual(2);
      // Taiko (low) and flute (high) layers coexist in every jingle.
      expect(spec.layers.some((layer) => layer.startFreq <= 160)).toBe(true);
      expect(spec.layers.some((layer) => layer.startFreq >= 600)).toBe(true);
    }
  });

  it('gives sub phases, swings and interface cues distinct sounds', () => {
    const throwSpec = required({ t: 'sub', phase: 'throw', team: 0, pos });
    const burstSpec = required({ t: 'sub', phase: 'burst', team: 0, pos });
    expect(throwSpec).not.toEqual(burstSpec);
    expect(required({ t: 'swing', id: 1, pos })).not.toEqual(throwSpec);

    const cursor = required({ t: 'ui', kind: 'cursor' });
    const ok = required({ t: 'ui', kind: 'ok' });
    const cancel = required({ t: 'ui', kind: 'cancel' });
    expect(cursor).not.toEqual(ok);
    expect(ok).not.toEqual(cancel);
    expect(cancel).not.toEqual(cursor);
  });
});
