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
  { t: 'special', phase: 'ready' },
  { t: 'special', phase: 'start' },
  { t: 'special', phase: 'end' },
  { t: 'phase', phase: 'pre' },
  { t: 'phase', phase: 'play' },
  { t: 'phase', phase: 'lastMinute' },
  { t: 'phase', phase: 'countdown' },
  { t: 'phase', phase: 'finished' },
];

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
});
