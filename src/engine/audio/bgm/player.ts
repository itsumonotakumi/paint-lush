import type { BgmSource } from '../../ports';
import type { AudioGainLike, AudioNodeLike } from '../audio';
import type { BgmTrack } from './sequencer';
import { notesBetween, trackDurationSeconds } from './sequencer';
import { createBgmSynth, type BgmAudioContext, type BgmSynth } from './synth';
import { getTrack } from './tracks';

/** How far ahead notes are scheduled, in seconds. */
export const BGM_LOOK_AHEAD_SECONDS = 0.2;
/** Crossfade length between two tracks, in seconds. */
export const BGM_CROSSFADE_SECONDS = 1;
/** Fade used by stop(), in seconds. */
export const BGM_STOP_FADE_SECONDS = 0.45;
/** How often the scheduler wakes up, in seconds. */
export const BGM_SCHEDULE_INTERVAL_SECONDS = 0.05;
/** Full-volume level of one track. */
export const BGM_TRACK_LEVEL = 1;

export interface BgmPlayerDeps {
  /** Injected in tests. Only one timer is ever pending. */
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  lookAheadSeconds?: number;
  crossfadeSeconds?: number;
  stopFadeSeconds?: number;
  scheduleIntervalSeconds?: number;
}

interface ActiveTrack {
  id: string;
  track: BgmTrack;
  gain: AudioGainLike;
  synth: BgmSynth;
  startedAt: number;
  /** Next absolute beat that has not been scheduled. */
  nextBeat: number;
  /** Context time at which this track must be silent; Infinity while current. */
  endsAt: number;
  /** Set by stop(): no further notes are scheduled, but the fade continues. */
  silent: boolean;
  duration: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function fadeOut(gain: AudioGainLike, when: number, seconds: number): void {
  const param = gain.gain;
  const level = clamp(param.value, 0, BGM_TRACK_LEVEL);
  param.cancelScheduledValues(when);
  param.setValueAtTime(level, when);
  param.linearRampToValueAtTime(0, when + seconds);
}

/**
 * Procedural BGM player implementing BgmSource. Tracks crossfade over about a
 * second, notes are scheduled 0.2 s ahead, and a single injected timer drives
 * the look-ahead loop.
 */
export function createBgmPlayer(
  context: BgmAudioContext,
  output: AudioNodeLike,
  deps: BgmPlayerDeps = {},
): BgmSource {
  const lookAhead = clamp(
    finiteOr(deps.lookAheadSeconds ?? BGM_LOOK_AHEAD_SECONDS, BGM_LOOK_AHEAD_SECONDS),
    0.01,
    2,
  );
  const crossfade = clamp(
    finiteOr(deps.crossfadeSeconds ?? BGM_CROSSFADE_SECONDS, BGM_CROSSFADE_SECONDS),
    0,
    3,
  );
  const stopFade = clamp(
    finiteOr(deps.stopFadeSeconds ?? BGM_STOP_FADE_SECONDS, BGM_STOP_FADE_SECONDS),
    0,
    2,
  );
  const intervalSeconds = clamp(
    finiteOr(deps.scheduleIntervalSeconds ?? BGM_SCHEDULE_INTERVAL_SECONDS, BGM_SCHEDULE_INTERVAL_SECONDS),
    0.01,
    1,
  );
  const intervalMs = intervalSeconds * 1000;
  const setTimer =
    deps.setTimer ?? ((callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs));

  const active: ActiveTrack[] = [];
  let currentId: string | null = null;
  let timerPending = false;
  /** Cancel hook for the newest scheduler timer, when the injected timer exposes one. */
  let pendingTimer: (() => void) | null = null;

  function safeNow(): number {
    const now = context.currentTime;
    return Number.isFinite(now) && now > 0 ? now : 0;
  }

  function sanitizeWhen(when: number): number {
    const now = safeNow();
    return Number.isFinite(when) && when > now ? when : now;
  }

  function removeActive(entry: ActiveTrack): void {
    const index = active.indexOf(entry);
    if (index >= 0) active.splice(index, 1);
  }

  function retire(entry: ActiveTrack): void {
    entry.synth.dispose();
    try {
      entry.gain.disconnect();
    } catch {
      // The gain may already have been detached.
    }
    removeActive(entry);
  }

  function cleanupAt(entry: ActiveTrack): number {
    if (entry.track.loop) return entry.endsAt;
    return Math.min(entry.endsAt, entry.startedAt + entry.duration + 0.3);
  }

  function scheduleEntry(entry: ActiveTrack, now: number, horizon: number): void {
    if (entry.silent) return;
    const bpm = finiteOr(entry.track.bpm, 0);
    if (bpm <= 0) return;
    const secondsPerBeat = 60 / bpm;
    const startBeat = entry.nextBeat;
    let endBeat = (horizon - entry.startedAt) / secondsPerBeat;
    if (!entry.track.loop) {
      const passBeats = entry.duration / secondsPerBeat;
      endBeat = Math.min(endBeat, passBeats);
    }
    if (Number.isFinite(entry.endsAt)) {
      endBeat = Math.min(endBeat, (entry.endsAt - entry.startedAt) / secondsPerBeat);
    }
    if (!(endBeat > startBeat)) return;

    const notes = notesBetween(entry.track, startBeat, endBeat);
    for (const note of notes) {
      const at = entry.startedAt + note.beat * secondsPerBeat;
      if (at < now - 0.02) continue;
      if (at > horizon + 0.001) continue;
      if (Number.isFinite(entry.endsAt) && at >= entry.endsAt) continue;
      const seconds = Math.max(0.03, note.length * secondsPerBeat);
      entry.synth.play(note.instrument, note.midi, note.velocity, at, seconds);
    }
    entry.nextBeat = endBeat;
  }

  function tick(): void {
    const now = safeNow();
    const horizon = now + lookAhead;

    for (let i = active.length - 1; i >= 0; i -= 1) {
      const entry = active[i];
      if (entry === undefined) continue;
      if (now >= cleanupAt(entry)) {
        retire(entry);
        continue;
      }
      scheduleEntry(entry, now, horizon);
    }
  }

  /** Turns a returned timer handle into a cancel function without assuming its shape. */
  function cancelHook(handle: unknown): (() => void) | null {
    if (typeof handle === 'number') {
      return () => clearTimeout(handle);
    }
    if (typeof handle !== 'object' || handle === null) return null;
    const cancel = Reflect.get(handle, 'cancel');
    if (typeof cancel !== 'function') return null;
    return () => {
      Reflect.apply(cancel, handle, []);
    };
  }

  function cancelPendingTimer(): void {
    const cancel = pendingTimer;
    pendingTimer = null;
    if (cancel !== null) cancel();
  }

  function scheduleTick(): void {
    if (timerPending) return;
    if (active.length === 0) {
      // Nothing left to schedule: stop the underlying timer so it does not
      // wake the page forever after the music has stopped.
      cancelPendingTimer();
      return;
    }
    timerPending = true;
    const handle: unknown = setTimer(() => {
      timerPending = false;
      tick();
      if (active.length === 0) {
        cancelPendingTimer();
        return;
      }
      // Keep the handle that owns the running timer; replace it with the new one.
      pendingTimer = null;
      scheduleTick();
    }, intervalMs);
    pendingTimer = cancelHook(handle);
  }

  function makeActive(track: BgmTrack, when: number): ActiveTrack {
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(output);
    if (crossfade > 0) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(BGM_TRACK_LEVEL, when + crossfade);
    } else {
      gain.gain.setValueAtTime(BGM_TRACK_LEVEL, when);
    }
    const parts = track.parts.length;
    const duration = trackDurationSeconds(track);
    return {
      id: track.id,
      track,
      gain,
      synth: createBgmSynth(context, gain),
      startedAt: when,
      nextBeat: 0,
      endsAt: Infinity,
      silent: false,
      duration: Number.isFinite(duration) && duration > 0 && parts > 0 ? duration : 0,
    };
  }

  return {
    start(id: string, when: number): void {
      const track = getTrack(id);
      if (track === null) return;
      if (currentId === id && active.some((entry) => entry.id === id && !entry.silent)) return;

      const at = sanitizeWhen(when);
      for (const entry of active) {
        if (entry.silent) continue;
        entry.endsAt = Math.min(entry.endsAt, at + crossfade);
        fadeOut(entry.gain, at, crossfade);
      }

      const entry = makeActive(track, at);
      active.push(entry);
      currentId = id;
      tick();
      scheduleTick();
    },

    stop(when: number): void {
      const at = sanitizeWhen(when);
      let changed = false;
      for (const entry of active) {
        if (entry.silent) continue;
        entry.silent = true;
        entry.endsAt = Math.min(entry.endsAt, at + stopFade);
        fadeOut(entry.gain, at, stopFade);
        changed = true;
      }
      currentId = null;
      if (changed) scheduleTick();
    },
  };
}
