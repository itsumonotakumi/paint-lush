import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { GameEvent } from '../../core/events';
import type { BgmSource } from '../ports';
import {
  createAudio,
  MAX_VOICES,
  PAINT_INTERVAL_SECONDS,
  type AudioBufferLike,
  type AudioBufferSourceLike,
  type AudioContextLike,
  type AudioGainLike,
  type AudioNodeLike,
  type AudioOscillatorLike,
  type AudioParamLike,
  type AudioStereoPannerLike,
} from './audio';
import { seSpecFor } from './seSpec';

interface ParamEvent {
  kind: 'set' | 'linear' | 'exponential';
  value: number;
  time: number;
}

class FakeParam implements AudioParamLike {
  value = 0;
  readonly events: ParamEvent[] = [];

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: 'set', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: 'linear', value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: 'exponential', value, time });
  }

  cancelScheduledValues(): void {
    this.events.length = 0;
  }

  get maxValue(): number {
    return this.events.reduce((max, event) => Math.max(max, event.value), 0);
  }
}

class FakeNode implements AudioNodeLike {
  connected: AudioNodeLike[] = [];
  disconnected = false;

  connect(destination: AudioNodeLike): void {
    this.connected.push(destination);
  }

  disconnect(): void {
    this.disconnected = true;
    this.connected.length = 0;
  }
}

class FakeGain extends FakeNode implements AudioGainLike {
  readonly gain = new FakeParam();
}

class FakePanner extends FakeNode implements AudioStereoPannerLike {
  readonly pan = new FakeParam();
}

class FakeVoiceSource extends FakeNode implements AudioOscillatorLike, AudioBufferSourceLike {
  type = 'sine';
  readonly frequency = new FakeParam();
  readonly playbackRate = new FakeParam();
  buffer: AudioBufferLike | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;

  start(when?: number): void {
    this.startedAt = when ?? 0;
  }

  stop(when?: number): void {
    this.stoppedAt = when ?? 0;
  }
}

class FakeBuffer implements AudioBufferLike {
  private readonly data: Float32Array;

  constructor(length: number) {
    this.data = new Float32Array(Math.max(1, length));
  }

  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  state = 'suspended';
  readonly sampleRate = 48000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeVoiceSource[] = [];
  readonly bufferSources: FakeVoiceSource[] = [];
  readonly panners: FakePanner[] = [];
  resumeCalls = 0;

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  createGain(): AudioGainLike {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): AudioOscillatorLike {
    const oscillator = new FakeVoiceSource();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBufferSource(): AudioBufferSourceLike {
    const source = new FakeVoiceSource();
    this.bufferSources.push(source);
    return source;
  }

  createBuffer(_channels: number, length: number): AudioBufferLike {
    return new FakeBuffer(length);
  }

  createStereoPanner(): AudioStereoPannerLike {
    const panner = new FakePanner();
    this.panners.push(panner);
    return panner;
  }
}

const listener = { x: 0, y: 0, z: 0 };

function setup(
  bgm?: BgmSource,
  createBgm?: (context: AudioContextLike, output: AudioNodeLike) => BgmSource,
) {
  const context = new FakeContext();
  const audio = createAudio({
    createContext: () => context,
    ...(bgm === undefined ? {} : { bgm }),
    ...(createBgm === undefined ? {} : { createBgm }),
  });
  return { context, audio };
}

function sourceCount(context: FakeContext): number {
  return context.oscillators.length + context.bufferSources.length;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAudio', () => {
  it('is a silent no-op before unlock and creates the context lazily', async () => {
    const context = new FakeContext();
    let created = 0;
    const audio = createAudio({
      createContext: () => {
        created += 1;
        return context;
      },
    });

    expect(() => audio.handle({ t: 'shoot', weapon: 'test', pos: listener }, listener, 1)).not.toThrow();
    expect(() => audio.handle({ t: 'paint', team: 0, cells: 9, pos: listener }, listener, 1)).not.toThrow();
    expect(created).toBe(0);
    expect(context.oscillators.length).toBe(0);

    await audio.unlock();
    await audio.unlock();
    expect(created).toBe(1);
    expect(context.resumeCalls).toBe(1);
  });

  it('sets the three buses from volumes and clamps bad input', async () => {
    const { audio, context } = setup();
    audio.setVolumes({ bgm: 0.2, se: 0.3, voice: 0.4 });
    await audio.unlock();

    expect(context.gains.length).toBe(3);
    expect(context.gains[0]?.gain.value).toBeCloseTo(0.2);
    expect(context.gains[1]?.gain.value).toBeCloseTo(0.3);
    expect(context.gains[2]?.gain.value).toBeCloseTo(0.4);

    audio.setVolumes({ bgm: 5, se: -2, voice: Number.NaN });
    expect(context.gains[0]?.gain.value).toBe(1);
    expect(context.gains[1]?.gain.value).toBe(0);
    expect(context.gains[2]?.gain.value).toBe(0);
  });

  it('throttles paint to one sound per 50 ms and sums cells meanwhile', async () => {
    const { audio, context } = setup();
    await audio.unlock();

    audio.handle({ t: 'paint', team: 0, cells: 4, pos: listener }, listener, 1);
    expect(context.oscillators.length).toBe(2);

    audio.handle({ t: 'paint', team: 0, cells: 6, pos: listener }, listener, 1);
    context.currentTime = 0.02;
    audio.handle({ t: 'paint', team: 0, cells: 6, pos: listener }, listener, 1);
    expect(context.oscillators.length).toBe(2);

    context.currentTime = PAINT_INTERVAL_SECONDS;
    audio.handle({ t: 'paint', team: 0, cells: 7, pos: listener }, listener, 1);
    expect(context.oscillators.length).toBe(4);

    const expected = seSpecFor({ t: 'paint', team: 0, cells: 19, pos: listener });
    const expectedLayer = expected?.layers[0];
    const firstOscillator = context.oscillators[2];
    expect(firstOscillator?.frequency.events[0]?.value).toBeCloseTo(expectedLayer?.startFreq ?? -1);
  });

  it('keeps at most 16 voices and evicts the lowest priority', async () => {
    const { audio, context } = setup();
    await audio.unlock();

    const land: GameEvent = { t: 'land', id: 1, pos: listener };
    for (let i = 0; i < MAX_VOICES; i += 1) audio.handle(land, listener, 1);

    expect(context.panners.length).toBe(MAX_VOICES);
    const created = sourceCount(context);
    expect(created).toBe(MAX_VOICES * 2);

    // Paint is lower priority than land, so the new voice is dropped.
    audio.handle({ t: 'paint', team: 0, cells: 1, pos: listener }, listener, 1);
    expect(context.panners.length).toBe(MAX_VOICES);
    expect(sourceCount(context)).toBe(created);

    // Special start outranks land: one voice is disconnected and replaced.
    audio.handle({ t: 'special', id: 1, phase: 'start' }, listener, 1);
    expect(context.panners.length).toBe(MAX_VOICES + 1);
    expect(context.panners.filter((panner) => panner.disconnected).length).toBe(1);
    expect(context.panners.filter((panner) => !panner.disconnected).length).toBe(MAX_VOICES);
    expect(sourceCount(context)).toBe(created + 3);
  });

  it('attenuates with distance and goes silent past 40 m', async () => {
    const { audio, context } = setup();
    await audio.unlock();

    const peakAt = (z: number): number => {
      const before = context.gains.length;
      audio.handle({ t: 'impact', pos: { x: 0, y: 0, z } }, listener, 1);
      const envelope = context.gains[before];
      return envelope?.gain.maxValue ?? -1;
    };

    const full = peakAt(2);
    const edge = peakAt(3);
    const mid = peakAt(10);
    expect(full).toBeGreaterThan(0);
    expect(edge).toBeCloseTo(full);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(full);

    const before = context.gains.length;
    audio.handle({ t: 'impact', pos: { x: 0, y: 0, z: 45 } }, listener, 1);
    expect(context.gains.length).toBe(before);
  });

  it('pans by the horizontal offset', async () => {
    const { audio, context } = setup();
    await audio.unlock();

    audio.handle({ t: 'impact', pos: { x: 5, y: 0, z: 0 } }, listener, 1);
    expect(context.panners[0]?.pan.value).toBeCloseTo(0.5);

    audio.handle({ t: 'impact', pos: { x: -50, y: 0, z: 0 } }, listener, 1);
    expect(context.panners.length).toBe(1);
  });

  it('delegates background music to an injected source', async () => {
    const started: Array<{ id: string; when: number }> = [];
    const stopped: number[] = [];
    const bgm: BgmSource = {
      start(id, when) {
        started.push({ id, when });
      },
      stop(when) {
        stopped.push(when);
      },
    };
    const { audio } = setup(bgm);

    audio.setBgm('menu');
    expect(started.length).toBe(0);

    await audio.unlock();
    expect(started).toEqual([{ id: 'menu', when: 0 }]);

    audio.setBgm('battle');
    expect(started).toHaveLength(2);
    expect(started[1]?.id).toBe('battle');

    audio.setBgm(null);
    expect(stopped).toHaveLength(1);
  });

  it('creates injected music in unlock and connects it to the bgm bus', async () => {
    const created: Array<{ context: AudioContextLike; output: AudioNodeLike }> = [];
    const started: Array<{ id: string; when: number }> = [];
    const source: BgmSource = {
      start(id, when) {
        started.push({ id, when });
      },
      stop() {
        // Not used here.
      },
    };
    const { audio, context } = setup(undefined, (ctx, output) => {
      created.push({ context: ctx, output });
      return source;
    });

    audio.setBgm('menu');
    expect(created).toHaveLength(0);

    await audio.unlock();
    expect(created).toHaveLength(1);
    expect(created[0]?.context).toBe(context);
    expect(created[0]?.output).toBe(context.gains[0]);
    expect(started).toEqual([{ id: 'menu', when: 0 }]);

    await audio.unlock();
    expect(created).toHaveLength(1);
  });

  it('ignores repeated bgm ids and remembers the id requested before unlock', async () => {
    const started: string[] = [];
    const stopped: number[] = [];
    const source: BgmSource = {
      start(id) {
        started.push(id);
      },
      stop(when) {
        stopped.push(when);
      },
    };
    const { audio } = setup(undefined, () => source);

    audio.setBgm('menu');
    audio.setBgm('menu');
    expect(started).toHaveLength(0);

    await audio.unlock();
    expect(started).toEqual(['menu']);

    audio.setBgm('menu');
    expect(started).toEqual(['menu']);

    audio.setBgm('battle');
    expect(started).toEqual(['menu', 'battle']);
    audio.setBgm('battle');
    expect(started).toEqual(['menu', 'battle']);

    audio.setBgm(null);
    expect(stopped).toHaveLength(1);
    audio.setBgm(null);
    expect(stopped).toHaveLength(1);

    audio.setBgm('battle');
    expect(started).toEqual(['menu', 'battle', 'battle']);
  });

  it('skips special and charge cues that belong to another player', async () => {
    const { audio, context } = setup();
    await audio.unlock();

    audio.handle({ t: 'special', id: 2, phase: 'start' }, listener, 1);
    audio.handle({ t: 'charge', id: 2, level: 2 }, listener, 1);
    expect(context.panners).toHaveLength(0);

    audio.handle({ t: 'special', id: 1, phase: 'start' }, listener, 1);
    audio.handle({ t: 'charge', id: 1, level: 2 }, listener, 1);
    expect(context.panners).toHaveLength(2);
  });

  it('routes voice to the voice bus and countdown/ui to the se bus without attenuation', async () => {
    const { audio, context } = setup();
    await audio.unlock();
    const far = { x: 400, y: 0, z: 400 };

    const take = (event: GameEvent) => {
      const pannerIndex = context.panners.length;
      const gainIndex = context.gains.length;
      audio.handle(event, far, 1);
      return {
        panner: context.panners[pannerIndex],
        envelope: context.gains[gainIndex],
      };
    };

    const voice = take({ t: 'voice', line: 'start' });
    expect(voice.panner?.connected[0]).toBe(context.gains[2]);
    expect(voice.envelope?.gain.maxValue).toBeGreaterThan(0);

    const countdown = take({ t: 'countdown', n: 3 });
    expect(countdown.panner?.connected[0]).toBe(context.gains[1]);
    expect(countdown.envelope?.gain.maxValue).toBeGreaterThan(0);

    const ui = take({ t: 'ui', kind: 'ok' });
    expect(ui.panner?.connected[0]).toBe(context.gains[1]);
    expect(ui.envelope?.gain.maxValue).toBeGreaterThan(0);
  });

  it('keeps delay-based jingle layers alive until their tail ends', async () => {
    const { audio, context } = setup();
    await audio.unlock();

    audio.handle({ t: 'voice', line: 'win' }, listener, 1);
    expect(context.oscillators.some((node) => (node.startedAt ?? 0) > 0)).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(context.panners[0]?.disconnected).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(context.panners[0]?.disconnected).toBe(true);
  });

  it('disconnects every node after the voice ends', async () => {
    const { audio, context } = setup();
    await audio.unlock();

    audio.handle({ t: 'land', id: 1, pos: listener }, listener, 1);
    expect(context.panners[0]?.disconnected).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(context.panners[0]?.disconnected).toBe(true);
    expect(context.oscillators.every((node) => node.disconnected)).toBe(true);
    expect(context.bufferSources.every((node) => node.disconnected)).toBe(true);
  });

  it('accepts a real AudioContext without a cast', () => {
    expectTypeOf<AudioContext>().toExtend<AudioContextLike>();
  });
});
