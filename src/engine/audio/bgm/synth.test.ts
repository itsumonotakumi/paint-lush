import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BgmInstrumentId } from './sequencer';
import { FakeContext, FakeNode } from './fakes';
import { MAX_BGM_VOICES, createBgmSynth } from './synth';

function setup(): { context: FakeContext; output: FakeNode; synth: ReturnType<typeof createBgmSynth> } {
  const context = new FakeContext();
  const output = new FakeNode();
  return { context, output, synth: createBgmSynth(context, output) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createBgmSynth', () => {
  it('builds a voice for every instrument', () => {
    const { context, output, synth } = setup();
    const instruments: readonly BgmInstrumentId[] = [
      'kick',
      'snare',
      'hat',
      'bass',
      'guitar',
      'shamisen',
      'shakuhachi',
    ];
    instruments.forEach((instrument, index) => {
      synth.play(instrument, 60 + index, 0.8, index * 0.1, 0.5);
    });

    expect(synth.voiceCount()).toBe(instruments.length);
    expect(context.oscillators.length + context.bufferSources.length).toBeGreaterThan(instruments.length);
    expect(context.gains.some((gain) => gain.connected.includes(output))).toBe(true);
    expect(context.filters.length).toBeGreaterThan(0);
  });

  it('caps simultaneous voices and disconnects the stolen oldest voice', () => {
    const { context, synth } = setup();
    for (let i = 0; i < 40; i += 1) {
      synth.play('hat', 42, 0.6, 0, 0.1);
      expect(synth.voiceCount()).toBeLessThanOrEqual(MAX_BGM_VOICES);
    }
    expect(synth.voiceCount()).toBe(MAX_BGM_VOICES);
    const evicted = context.bufferSources[0];
    expect(evicted?.disconnected).toBe(true);
    expect(evicted?.stoppedAt).toBe(0);
  });

  it('stops and disconnects voices after their envelopes finish', () => {
    const { context, synth } = setup();
    synth.play('hat', 42, 0.7, 0, 0.1);
    expect(synth.voiceCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(synth.voiceCount()).toBe(0);
    expect(context.bufferSources[0]?.disconnected).toBe(true);
    expect(context.bufferSources[0]?.stopCalls).toBe(1);
  });

  it('sanitises non-finite notes and times', () => {
    const { context, synth } = setup();
    expect(() =>
      synth.play('bass', Number.NaN, Number.POSITIVE_INFINITY, Number.NaN, -5),
    ).not.toThrow();
    expect(synth.voiceCount()).toBe(1);

    for (const oscillator of context.oscillators) {
      for (const event of oscillator.frequency.events) {
        expect(Number.isFinite(event.value)).toBe(true);
        expect(event.value).toBeGreaterThanOrEqual(20);
      }
    }
    for (const filter of context.filters) {
      expect(Number.isFinite(filter.frequency.value)).toBe(true);
      expect(Number.isFinite(filter.Q.value)).toBe(true);
    }
    for (const gain of context.gains) {
      for (const event of gain.gain.events) {
        expect(Number.isFinite(event.value)).toBe(true);
        expect(event.value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('stopAll stops existing voices at the requested time and cleans them up', () => {
    const { context, synth } = setup();
    synth.play('shamisen', 72, 0.9, 0, 1);
    synth.stopAll(0.4);

    expect(context.oscillators.every((source) => source.stoppedAt === 0.4)).toBe(true);
    expect(context.bufferSources.every((source) => source.stoppedAt === 0.4)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(synth.voiceCount()).toBe(0);
  });

  it('dispose stops everything and releases the noise buffer', () => {
    const { context, synth } = setup();
    synth.play('guitar', 64, 0.8, 0, 0.5);
    synth.dispose();
    expect(synth.voiceCount()).toBe(0);
    expect(context.bufferSources.every((source) => source.disconnected)).toBe(true);
    expect(() => synth.play('hat', 42, 0.5, 0, 0.1)).not.toThrow();
    expect(synth.voiceCount()).toBe(0);
  });
});
