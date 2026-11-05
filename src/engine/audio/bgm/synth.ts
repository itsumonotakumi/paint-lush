import { createRng } from '../../../core/rng';
import type {
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioContextLike,
  AudioNodeLike,
  AudioOscillatorLike,
  AudioParamLike,
  AudioSourceLike,
} from '../audio';
import type { BgmInstrumentId } from './sequencer';

/**
 * Web Audio view used by the music engine. The only addition to the audio
 * module's structural contract is a biquad filter, which a real AudioContext
 * provides, so real code fits without casts.
 */
export interface AudioBiquadFilterLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface BgmAudioContext extends AudioContextLike {
  createBiquadFilter(): AudioBiquadFilterLike;
}

/** Hard ceiling on simultaneous musical voices. */
export const MAX_BGM_VOICES = 24;

const NOISE_SECONDS = 1;
const MIN_DURATION = 0.03;
const MAX_DURATION = 8;
const MIN_FREQUENCY = 20;
const MAX_FREQUENCY = 12000;

export interface BgmSynthOptions {
  /** Defaults to MAX_BGM_VOICES and is itself capped there. */
  maxVoices?: number;
}

export interface BgmSynth {
  /** Schedules one note. Times and pitches are sanitised before reaching the graph. */
  play(
    instrument: BgmInstrumentId,
    midi: number,
    velocity: number,
    when: number,
    durationSeconds: number,
  ): void;
  /** Voices still scheduled, including notes that are fading out. */
  voiceCount(): number;
  /** Stops every voice at `when` and disconnects them after the stop time. */
  stopAll(when: number): void;
  dispose(): void;
}

interface Voice {
  end: number;
  nodes: AudioNodeLike[];
  sources: AudioSourceLike[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface FilterSpec {
  type: 'lowpass' | 'highpass' | 'bandpass';
  frequency: number;
  q: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function midiToHz(midi: number): number {
  const note = clamp(finiteOr(midi, 60), 0, 127);
  return clamp(440 * Math.pow(2, (note - 69) / 12), MIN_FREQUENCY, MAX_FREQUENCY);
}

function safeNow(context: BgmAudioContext): number {
  const now = context.currentTime;
  return Number.isFinite(now) && now > 0 ? now : 0;
}

function scheduleEnvelope(
  param: AudioParamLike,
  when: number,
  duration: number,
  peak: number,
  attack: number,
  release: number,
): void {
  const dur = clamp(duration, MIN_DURATION, MAX_DURATION);
  const att = clamp(attack, 0.001, dur * 0.5);
  const rel = clamp(release, 0.005, dur * 0.9);
  const level = clamp(peak, 0, 1);
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(level, when + att);
  const sustainAt = when + Math.max(att, dur - rel);
  if (sustainAt > when + att) param.setValueAtTime(level, sustainAt);
  param.linearRampToValueAtTime(0, when + dur);
}

function schedulePitch(
  param: AudioParamLike,
  when: number,
  duration: number,
  from: number,
  to: number,
): void {
  const start = clamp(from, MIN_FREQUENCY, MAX_FREQUENCY);
  const end = clamp(to, MIN_FREQUENCY, MAX_FREQUENCY);
  param.setValueAtTime(start, when);
  if (start !== end) param.exponentialRampToValueAtTime(end, when + duration);
}

/**
 * Procedural instrument bank. Every note is a short-lived voice with its own
 * gain envelope and optional filter; finished voices are stopped, disconnected
 * and forgotten. No samples or external files are used.
 */
export function createBgmSynth(
  context: BgmAudioContext,
  output: AudioNodeLike,
  options: BgmSynthOptions = {},
): BgmSynth {
  const maxVoices = Math.round(clamp(options.maxVoices ?? MAX_BGM_VOICES, 1, MAX_BGM_VOICES));
  const voices: Voice[] = [];
  let noiseBuffer: AudioBufferLike | null = null;
  let disposed = false;

  function ensureNoise(): AudioBufferLike {
    if (noiseBuffer !== null) return noiseBuffer;
    const sampleRate = clamp(finiteOr(context.sampleRate, 44100), 8000, 192000);
    const length = Math.max(1, Math.floor(sampleRate * NOISE_SECONDS));
    const buffer = context.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const rng = createRng(0x7a1ce5);
    for (let i = 0; i < data.length; i += 1) data[i] = rng.next() * 2 - 1;
    noiseBuffer = buffer;
    return buffer;
  }

  function clearVoiceTimer(voice: Voice): void {
    if (voice.timer !== null) {
      clearTimeout(voice.timer);
      voice.timer = null;
    }
  }

  function disconnectVoice(voice: Voice): void {
    for (const node of voice.nodes) {
      try {
        node.disconnect();
      } catch {
        // The node may already have left the graph.
      }
    }
    voice.nodes.length = 0;
    voice.sources.length = 0;
  }

  function stopSources(voice: Voice, when: number): void {
    for (const source of voice.sources) {
      try {
        source.stop(when);
      } catch {
        // Stopping an already-finished source is harmless.
      }
    }
  }

  function removeVoice(voice: Voice): void {
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
  }

  function finishVoice(voice: Voice): void {
    clearVoiceTimer(voice);
    removeVoice(voice);
    disconnectVoice(voice);
  }

  function prune(now: number): void {
    for (let i = voices.length - 1; i >= 0; i -= 1) {
      const voice = voices[i];
      if (voice !== undefined && voice.end <= now) finishVoice(voice);
    }
  }

  function scheduleCleanup(voice: Voice, stopAt: number): void {
    clearVoiceTimer(voice);
    const now = safeNow(context);
    const delay = Math.min(60000, Math.max(0, stopAt - now) * 1000 + 60);
    voice.timer = setTimeout(() => {
      finishVoice(voice);
    }, delay);
  }

  function newVoice(): Voice {
    return { end: 0, nodes: [], sources: [], timer: null };
  }

  function addFilter(
    voice: Voice,
    spec: FilterSpec,
    destination: AudioNodeLike,
  ): AudioNodeLike {
    const filter = context.createBiquadFilter();
    filter.type = spec.type;
    filter.frequency.value = clamp(spec.frequency, MIN_FREQUENCY, MAX_FREQUENCY);
    filter.Q.value = clamp(spec.q, 0, 30);
    filter.connect(destination);
    voice.nodes.push(filter);
    return filter;
  }

  function addTone(
    voice: Voice,
    type: string,
    fromHz: number,
    toHz: number,
    when: number,
    duration: number,
    peak: number,
    attack: number,
    release: number,
    filter: FilterSpec | null,
  ): void {
    const target = filter === null ? output : addFilter(voice, filter, output);
    const gain = context.createGain();
    scheduleEnvelope(gain.gain, when, duration, peak, attack, release);
    gain.connect(target);
    voice.nodes.push(gain);

    const oscillator: AudioOscillatorLike = context.createOscillator();
    oscillator.type = type;
    schedulePitch(oscillator.frequency, when, duration * 0.7, fromHz, toHz);
    oscillator.connect(gain);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.02);
    voice.nodes.push(oscillator);
    voice.sources.push(oscillator);
  }

  function addNoise(
    voice: Voice,
    when: number,
    duration: number,
    peak: number,
    attack: number,
    release: number,
    filter: FilterSpec | null,
    playbackRate = 1,
  ): void {
    const target = filter === null ? output : addFilter(voice, filter, output);
    const gain = context.createGain();
    scheduleEnvelope(gain.gain, when, duration, peak, attack, release);
    gain.connect(target);
    voice.nodes.push(gain);

    const source: AudioBufferSourceLike = context.createBufferSource();
    source.buffer = ensureNoise();
    source.playbackRate.value = clamp(playbackRate, 0.25, 4);
    source.connect(gain);
    source.start(when);
    source.stop(when + duration + 0.02);
    voice.nodes.push(source);
    voice.sources.push(source);
  }

  function buildKick(voice: Voice, midi: number, velocity: number, when: number): void {
    const base = midiToHz(midi);
    addTone(voice, 'sine', base * 4.2, base, when, 0.3, 0.55 * velocity, 0.002, 0.25, null);
    addNoise(
      voice,
      when,
      0.09,
      0.13 * velocity,
      0.001,
      0.08,
      { type: 'lowpass', frequency: 420, q: 0.7 },
    );
    voice.end = Math.max(voice.end, when + 0.31);
  }

  function buildSnare(voice: Voice, midi: number, velocity: number, when: number): void {
    const base = midiToHz(midi);
    addNoise(
      voice,
      when,
      0.16,
      0.22 * velocity,
      0.001,
      0.13,
      { type: 'highpass', frequency: 1400, q: 0.8 },
    );
    addTone(voice, 'triangle', base * 6, base * 3.4, when, 0.12, 0.09 * velocity, 0.002, 0.1, null);
    voice.end = Math.max(voice.end, when + 0.17);
  }

  function buildHat(voice: Voice, velocity: number, when: number): void {
    addNoise(
      voice,
      when,
      0.055,
      0.1 * velocity,
      0.001,
      0.05,
      { type: 'highpass', frequency: 7000, q: 1.2 },
    );
    voice.end = Math.max(voice.end, when + 0.06);
  }

  function buildBass(
    voice: Voice,
    midi: number,
    velocity: number,
    when: number,
    duration: number,
  ): void {
    const base = midiToHz(midi);
    addTone(
      voice,
      'triangle',
      base,
      base * 0.995,
      when,
      duration,
      0.24 * velocity,
      0.008,
      Math.min(0.18, duration * 0.4),
      { type: 'lowpass', frequency: 760, q: 1.1 },
    );
    addTone(voice, 'sine', base / 2, base / 2, when, duration, 0.14 * velocity, 0.008, 0.12, null);
    voice.end = Math.max(voice.end, when + duration);
  }

  function buildGuitar(
    voice: Voice,
    midi: number,
    velocity: number,
    when: number,
    duration: number,
  ): void {
    const base = midiToHz(midi);
    const length = clamp(Math.min(duration * 0.85, 0.5), 0.08, 0.5);
    addTone(
      voice,
      'sawtooth',
      base * 1.006,
      base * 1.004,
      when,
      length,
      0.06 * velocity,
      0.002,
      0.13,
      { type: 'lowpass', frequency: 2300, q: 0.9 },
    );
    addTone(
      voice,
      'sawtooth',
      base * 0.994,
      base * 0.992,
      when,
      length,
      0.055 * velocity,
      0.002,
      0.13,
      { type: 'lowpass', frequency: 1900, q: 0.9 },
    );
    addNoise(
      voice,
      when,
      0.045,
      0.03 * velocity,
      0.001,
      0.04,
      { type: 'bandpass', frequency: 2600, q: 0.8 },
    );
    voice.end = Math.max(voice.end, when + length);
  }

  function buildShamisen(
    voice: Voice,
    midi: number,
    velocity: number,
    when: number,
    duration: number,
  ): void {
    const base = midiToHz(midi);
    const length = clamp(duration, 0.09, 1.1);
    addTone(
      voice,
      'sawtooth',
      base * 1.012,
      base,
      when,
      length,
      0.12 * velocity,
      0.002,
      0.16,
      { type: 'bandpass', frequency: base * 2.4, q: 1.6 },
    );
    addTone(voice, 'triangle', base * 2, base * 1.98, when, length * 0.8, 0.05 * velocity, 0.002, 0.12, null);
    addNoise(
      voice,
      when,
      0.05,
      0.07 * velocity,
      0.001,
      0.045,
      { type: 'highpass', frequency: 2600, q: 1.1 },
    );
    voice.end = Math.max(voice.end, when + length);
  }

  function buildShakuhachi(
    voice: Voice,
    midi: number,
    velocity: number,
    when: number,
    duration: number,
  ): void {
    const base = midiToHz(midi);
    const length = clamp(duration, 0.35, MAX_DURATION);
    addTone(
      voice,
      'sine',
      base * 0.985,
      base,
      when,
      length,
      0.1 * velocity,
      0.12,
      Math.min(0.8, length * 0.5),
      null,
    );
    addTone(
      voice,
      'triangle',
      base * 2,
      base * 2,
      when,
      length * 0.9,
      0.026 * velocity,
      0.18,
      Math.min(0.6, length * 0.4),
      null,
    );
    addNoise(
      voice,
      when,
      length,
      0.035 * velocity,
      0.16,
      Math.min(0.65, length * 0.45),
      { type: 'bandpass', frequency: 1250, q: 0.6 },
    );
    voice.end = Math.max(voice.end, when + length);
  }

  function play(
    instrument: BgmInstrumentId,
    midi: number,
    velocity: number,
    when: number,
    durationSeconds: number,
  ): void {
    if (disposed) return;
    const now = safeNow(context);
    const start = Math.max(finiteOr(when, now), now);
    const safeVelocity = clamp(velocity, 0, 1);
    const safeMidi = clamp(finiteOr(midi, 60), 0, 127);
    const duration = clamp(finiteOr(durationSeconds, 0.2), MIN_DURATION, MAX_DURATION);

    prune(now);
    while (voices.length >= maxVoices) {
      const oldest = voices[0];
      if (oldest === undefined) break;
      stopSources(oldest, now);
      finishVoice(oldest);
    }

    const voice = newVoice();
    switch (instrument) {
      case 'kick':
        buildKick(voice, safeMidi, safeVelocity, start);
        break;
      case 'snare':
        buildSnare(voice, safeMidi, safeVelocity, start);
        break;
      case 'hat':
        buildHat(voice, safeVelocity, start);
        break;
      case 'bass':
        buildBass(voice, safeMidi, safeVelocity, start, duration);
        break;
      case 'guitar':
        buildGuitar(voice, safeMidi, safeVelocity, start, duration);
        break;
      case 'shamisen':
        buildShamisen(voice, safeMidi, safeVelocity, start, duration);
        break;
      case 'shakuhachi':
        buildShakuhachi(voice, safeMidi, safeVelocity, start, duration);
        break;
    }

    if (voice.nodes.length === 0) return;
    if (voice.end <= start) voice.end = start + 0.05;
    voices.push(voice);
    scheduleCleanup(voice, voice.end);
  }

  return {
    play,

    voiceCount(): number {
      return voices.length;
    },

    stopAll(when: number): void {
      if (disposed) return;
      const now = safeNow(context);
      const stopAt = Math.max(finiteOr(when, now), now);
      for (const voice of voices) {
        stopSources(voice, stopAt);
        voice.end = Math.min(voice.end, stopAt);
        scheduleCleanup(voice, stopAt);
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      const now = safeNow(context);
      for (const voice of voices) {
        stopSources(voice, now);
        finishVoice(voice);
      }
      voices.length = 0;
      noiseBuffer = null;
    },
  };
}
