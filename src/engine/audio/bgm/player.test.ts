import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeContext, FakeGain, FakeNode, FakeTimer } from './fakes';
import {
  BGM_CROSSFADE_SECONDS,
  BGM_LOOK_AHEAD_SECONDS,
  BGM_STOP_FADE_SECONDS,
  createBgmPlayer,
  type BgmPlayerDeps,
} from './player';

function setup(deps: Omit<BgmPlayerDeps, 'setTimer'> = {}) {
  const context = new FakeContext();
  const output = new FakeNode();
  const timer = new FakeTimer();
  const player = createBgmPlayer(context, output, { ...deps, setTimer: timer.setTimer });
  return { context, output, timer, player };
}

function advance(context: FakeContext, timer: FakeTimer, seconds: number): void {
  context.currentTime += seconds;
  timer.advance(seconds * 1000);
}

function trackGain(context: FakeContext, index: number): FakeGain | null {
  const candidates = context.gains.filter((gain) =>
    gain.gain.events.some((event) => event.kind === 'linear' && event.value === 1),
  );
  const node = candidates[index];
  return node instanceof FakeGain ? node : null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createBgmPlayer', () => {
  it('ignores unknown ids and schedules the first notes inside the look-ahead window', () => {
    const { context, output, timer, player } = setup();
    player.start('not-a-track', 0);
    expect(context.gains).toHaveLength(0);
    expect(output.connected).toHaveLength(0);
    expect(timer.pending).toBe(0);

    player.start('title', 0);
    expect(context.oscillators.length + context.bufferSources.length).toBeGreaterThan(0);
    for (const source of context.oscillators) {
      expect(source.startedAt ?? -1).toBeGreaterThanOrEqual(0);
      expect(source.startedAt ?? Infinity).toBeLessThanOrEqual(BGM_LOOK_AHEAD_SECONDS + 0.0001);
    }
    for (const source of context.bufferSources) {
      expect(source.startedAt ?? -1).toBeGreaterThanOrEqual(0);
      expect(source.startedAt ?? Infinity).toBeLessThanOrEqual(BGM_LOOK_AHEAD_SECONDS + 0.0001);
    }
    expect(timer.pending).toBeGreaterThan(0);
  });

  it('is idempotent for repeated start calls', () => {
    const { context, player } = setup();
    player.start('title', 0);
    const gains = context.gains.length;
    const oscillators = context.oscillators.length;
    const buffers = context.bufferSources.length;

    player.start('title', 0);
    expect(context.gains.length).toBe(gains);
    expect(context.oscillators.length).toBe(oscillators);
    expect(context.bufferSources.length).toBe(buffers);
  });

  it('crossfades from the previous track over about one second', () => {
    const { context, timer, player } = setup();
    player.start('title', 0);
    const oldGain = trackGain(context, 0);
    expect(oldGain).not.toBeNull();
    if (oldGain === null) return;

    advance(context, timer, 1.2);
    player.start('battle', 2);

    const newGain = trackGain(context, 1);
    expect(newGain).not.toBeNull();
    if (newGain === null) return;

    const fadeOut = oldGain.gain.events.some(
      (event) =>
        event.kind === 'linear' &&
        event.value === 0 &&
        Math.abs(event.time - (2 + BGM_CROSSFADE_SECONDS)) < 0.0001,
    );
    expect(fadeOut).toBe(true);

    const fadeInSet = newGain.gain.events.some(
      (event) => event.kind === 'set' && event.value === 0 && Math.abs(event.time - 2) < 0.0001,
    );
    const fadeInRamp = newGain.gain.events.some(
      (event) =>
        event.kind === 'linear' &&
        event.value === 1 &&
        Math.abs(event.time - (2 + BGM_CROSSFADE_SECONDS)) < 0.0001,
    );
    expect(fadeInSet).toBe(true);
    expect(fadeInRamp).toBe(true);
  });

  it('fades on stop, is idempotent, and schedules nothing afterwards', () => {
    const { context, timer, player } = setup();
    player.start('title', 0);
    advance(context, timer, 0.5);
    const gain = trackGain(context, 0);
    expect(gain).not.toBeNull();
    if (gain === null) return;

    player.stop(1);
    const fadeEvent = gain.gain.events.some(
      (event) =>
        event.kind === 'linear' &&
        event.value === 0 &&
        Math.abs(event.time - (1 + BGM_STOP_FADE_SECONDS)) < 0.0001,
    );
    expect(fadeEvent).toBe(true);

    const before = context.oscillators.length + context.bufferSources.length;
    const eventCount = gain.gain.events.length;
    player.stop(1);
    expect(gain.gain.events.length).toBe(eventCount);

    advance(context, timer, 2);
    expect(context.oscillators.length + context.bufferSources.length).toBe(before);
    expect(gain.disconnected).toBe(true);
  });

  it('schedules further ahead as context time advances', () => {
    const { context, timer, player } = setup();
    player.start('battle', 0);
    const first = context.oscillators.length;
    for (const source of context.oscillators) {
      expect(source.startedAt ?? 0).toBeLessThanOrEqual(BGM_LOOK_AHEAD_SECONDS + 0.0001);
    }

    advance(context, timer, 0.16);
    const added = context.oscillators.slice(first);
    expect(added.length).toBeGreaterThan(0);
    for (const source of added) {
      expect(source.startedAt ?? Infinity).toBeLessThanOrEqual(0.16 + BGM_LOOK_AHEAD_SECONDS + 0.001);
    }
    expect(added.some((source) => (source.startedAt ?? 0) > BGM_LOOK_AHEAD_SECONDS)).toBe(true);
  });

  it('lets a non-looping jingle finish and disconnect on its own', () => {
    const { context, timer, player } = setup();
    player.start('win', 0);
    const gain = trackGain(context, 0);
    expect(gain).not.toBeNull();
    if (gain === null) return;

    advance(context, timer, 13);
    const finished = context.oscillators.length + context.bufferSources.length;
    expect(gain.disconnected).toBe(true);

    advance(context, timer, 6);
    expect(context.oscillators.length + context.bufferSources.length).toBe(finished);
  });

  it('can restart the same track after a stop', () => {
    const { context, timer, player } = setup();
    player.start('title', 0);
    player.stop(0.5);
    advance(context, timer, 1);
    player.start('title', 2);
    expect(context.gains.length).toBeGreaterThanOrEqual(2);
    expect(trackGain(context, 1)).not.toBeNull();

    const gains = context.gains.length;
    player.start('title', 2);
    expect(context.gains.length).toBe(gains);
  });

  it('cancels the scheduler timer once the music has faded out', () => {
    const context = new FakeContext();
    const output = new FakeNode();
    const cancel = vi.fn();
    let callback: (() => void) | null = null;

    const player = createBgmPlayer(context, output, {
      setTimer: (run) => {
        callback = run;
        return { cancel };
      },
    });

    player.start('title', 0);
    expect(callback).not.toBeNull();

    player.stop(0);
    context.currentTime = 2;
    const run = callback as (() => void) | null;
    if (run !== null) run();

    expect(cancel).toHaveBeenCalled();
    expect(context.gains[0]?.disconnected).toBe(true);
  });
});
