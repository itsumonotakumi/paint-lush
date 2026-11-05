import type { GameEvent } from '../../core/events';
import type { Vec3 } from '../../core/types';
import { createRng } from '../../core/rng';
import type { BgmSource, IAudio } from '../ports';
import { seSpecFor, type SeSpec } from './seSpec';

/** Minimal structural view of Web Audio's AudioParam. A real AudioParam fits without a cast. */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
  cancelScheduledValues(startTime: number): void;
}

/** Minimal structural view of Web Audio's AudioNode. */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): void;
  disconnect(): void;
}

export interface AudioGainLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AudioStereoPannerLike extends AudioNodeLike {
  readonly pan: AudioParamLike;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioSourceLike extends AudioNodeLike {
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioOscillatorLike extends AudioSourceLike {
  type: string;
  readonly frequency: AudioParamLike;
}

export interface AudioBufferSourceLike extends AudioSourceLike {
  buffer: AudioBufferLike | null;
  readonly playbackRate: AudioParamLike;
}

/** Minimal structural view of Web Audio's BaseAudioContext. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  readonly state: string;
  readonly sampleRate: number;
  resume(): Promise<void>;
  createOscillator(): AudioOscillatorLike;
  createGain(): AudioGainLike;
  createBufferSource(): AudioBufferSourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createStereoPanner(): AudioStereoPannerLike;
}

export interface AudioDeps {
  createContext: () => AudioContextLike;
  /** Optional file/stream music player. Procedural SE is always synthesised here. */
  bgm?: BgmSource;
}

/** Simultaneous sound-effect voices. */
export const MAX_VOICES = 16;
/** Minimum context-time gap between paint sounds. */
export const PAINT_INTERVAL_SECONDS = 0.05;
/** No attenuation inside this radius. */
const FULL_DISTANCE = 3;
/** Total silence at and beyond this radius. */
const SILENT_DISTANCE = 40;
/** Horizontal distance (metres) that maps to a fully panned sound. */
const PAN_SPAN = 10;
const NOISE_BUFFER_SECONDS = 1;

interface Volumes {
  bgm: number;
  se: number;
  voice: number;
}

interface Buses {
  bgm: AudioGainLike;
  se: AudioGainLike;
  voice: AudioGainLike;
}

interface Disconnectable {
  disconnect(): void;
}

interface Voice {
  priority: number;
  endTime: number;
  nodes: Disconnectable[];
  timer: ReturnType<typeof setTimeout> | null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function clampVolume(value: number): number {
  return clamp(value, 0, 1);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function safeTime(context: AudioContextLike): number {
  const time = context.currentTime;
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function safeFrequency(value: number): number {
  return clamp(finiteOr(value, 440), 20, 16000);
}

/** Full volume within 3 m, inverse falloff, then silent by 40 m. */
function attenuationFor(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance <= FULL_DISTANCE) return 1;
  if (distance >= SILENT_DISTANCE) return 0;
  const inverse = FULL_DISTANCE / distance;
  const fadeOut = (SILENT_DISTANCE - distance) / (SILENT_DISTANCE - FULL_DISTANCE);
  return clamp(inverse * fadeOut, 0, 1);
}

interface Spatial {
  attenuation: number;
  pan: number;
}

function spatialize(pos: Vec3, listener: Vec3): Spatial {
  const dx = finiteOr(pos.x, 0) - finiteOr(listener.x, 0);
  const dy = finiteOr(pos.y, 0) - finiteOr(listener.y, 0);
  const dz = finiteOr(pos.z, 0) - finiteOr(listener.z, 0);
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return {
    attenuation: attenuationFor(distance),
    pan: clamp(dx / PAN_SPAN, -1, 1),
  };
}

function eventPosition(event: GameEvent): Vec3 | null {
  switch (event.t) {
    case 'special':
    case 'phase':
      return null;
    default:
      return event.pos;
  }
}

function scheduleEnvelope(
  param: AudioParamLike,
  start: number,
  duration: number,
  peak: number,
  attack: number,
  decay: number,
): void {
  const attackTime = clamp(attack, 0, duration * 0.4);
  const decayTime = clamp(decay, 0, duration * 0.6);
  const sustain = start + Math.max(attackTime, duration - decayTime);
  param.setValueAtTime(0, start);
  if (attackTime > 0) {
    param.linearRampToValueAtTime(peak, start + attackTime);
  } else {
    param.setValueAtTime(peak, start);
  }
  if (sustain > start + attackTime) param.setValueAtTime(peak, sustain);
  param.linearRampToValueAtTime(0, start + duration);
}

function scheduleFrequency(
  param: AudioParamLike,
  start: number,
  duration: number,
  startFreq: number,
  endFreq: number,
): void {
  const from = safeFrequency(startFreq);
  const to = safeFrequency(endFreq);
  param.setValueAtTime(from, start);
  if (from !== to) param.exponentialRampToValueAtTime(to, start + duration);
}

/**
 * Procedural sound-effect engine. The graph is only built after unlock(), which
 * must be called from a user gesture on browsers that start suspended.
 */
export function createAudio(deps: AudioDeps): IAudio {
  let context: AudioContextLike | null = null;
  let buses: Buses | null = null;
  let unlockPromise: Promise<void> | null = null;
  let volumes: Volumes = { bgm: 0.7, se: 0.8, voice: 0.8 };

  const voices: Voice[] = [];
  let noiseBuffer: AudioBufferLike | null = null;

  let bgmId: string | null = null;
  let bgmStarted = false;

  let paintCells = 0;
  let lastPaintAt: number | null = null;

  function makeBus(ctx: AudioContextLike, value: number): AudioGainLike {
    const gain = ctx.createGain();
    gain.gain.value = value;
    gain.connect(ctx.destination);
    return gain;
  }

  function applyVolumes(target: Buses): void {
    target.bgm.gain.value = volumes.bgm;
    target.se.gain.value = volumes.se;
    target.voice.gain.value = volumes.voice;
  }

  function ensureNoiseBuffer(ctx: AudioContextLike): AudioBufferLike {
    if (noiseBuffer !== null) return noiseBuffer;
    const sampleRate = clamp(finiteOr(ctx.sampleRate, 44100), 8000, 192000);
    const length = Math.max(1, Math.floor(sampleRate * NOISE_BUFFER_SECONDS));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const rng = createRng(0x51ed270b);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = rng.next() * 2 - 1;
    }
    noiseBuffer = buffer;
    return buffer;
  }

  function dispose(voice: Voice): void {
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
    if (voice.timer !== null) {
      clearTimeout(voice.timer);
      voice.timer = null;
    }
    for (const node of voice.nodes) {
      try {
        node.disconnect();
      } catch {
        // A node may already have left the graph.
      }
    }
    voice.nodes.length = 0;
  }

  function prune(now: number): void {
    for (let i = voices.length - 1; i >= 0; i -= 1) {
      const voice = voices[i];
      if (voice !== undefined && now >= voice.endTime) dispose(voice);
    }
  }

  function weakestVoice(): Voice | null {
    let weakest: Voice | null = null;
    for (const voice of voices) {
      if (weakest === null || voice.priority < weakest.priority) weakest = voice;
    }
    return weakest;
  }

  function play(ctx: AudioContextLike, spec: SeSpec, spatial: Spatial): void {
    const now = safeTime(ctx);
    prune(now);

    if (voices.length >= MAX_VOICES) {
      const weakest = weakestVoice();
      // Ties keep the existing voice, so a burst of equally ranked sounds cannot evict itself.
      if (weakest === null || spec.priority <= weakest.priority) return;
      dispose(weakest);
    }

    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(spatial.pan, -1, 1);
    panner.connect(buses === null ? ctx.destination : buses.se);

    const nodes: Disconnectable[] = [panner];
    let end = now;
    let layerCount = 0;

    for (const layer of spec.layers) {
      const duration = clamp(layer.duration, 0.01, 4);
      const peak = clamp(layer.gain * spatial.attenuation, 0, 1);
      if (peak <= 0) continue;

      const envelope = ctx.createGain();
      envelope.connect(panner);
      nodes.push(envelope);
      scheduleEnvelope(envelope.gain, now, duration, peak, layer.attack, layer.decay);

      if (layer.type === 'noise') {
        const source = ctx.createBufferSource();
        source.buffer = ensureNoiseBuffer(ctx);
        source.playbackRate.value = clamp(finiteOr(layer.startFreq, 3000) / 3000, 0.25, 4);
        source.connect(envelope);
        source.start(now);
        source.stop(now + duration);
        nodes.push(source);
      } else {
        const oscillator = ctx.createOscillator();
        oscillator.type = layer.type;
        scheduleFrequency(oscillator.frequency, now, duration, layer.startFreq, layer.endFreq);
        oscillator.connect(envelope);
        oscillator.start(now);
        oscillator.stop(now + duration + 0.01);
        nodes.push(oscillator);
      }

      end = Math.max(end, now + duration);
      layerCount += 1;
    }

    if (layerCount === 0) {
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          // Nothing was connected.
        }
      }
      return;
    }

    const voice: Voice = { priority: spec.priority, endTime: end, nodes, timer: null };
    voices.push(voice);
    const delayMs = Math.max(0, (end - now) * 1000) + 30;
    voice.timer = setTimeout(() => {
      dispose(voice);
    }, delayMs);
  }

  function paintSpec(ctx: AudioContextLike, event: Extract<GameEvent, { t: 'paint' }>): SeSpec | null {
    const cells = Math.max(0, finiteOr(event.cells, 0));
    paintCells = clamp(paintCells + cells, 0, 1000);

    const now = safeTime(ctx);
    if (lastPaintAt !== null) {
      const elapsed = now - lastPaintAt;
      if (elapsed >= 0 && elapsed < PAINT_INTERVAL_SECONDS) return null;
    }
    lastPaintAt = now;
    const summed = paintCells;
    paintCells = 0;
    return seSpecFor({ t: 'paint', team: event.team, cells: summed, pos: event.pos });
  }

  async function startAudio(): Promise<void> {
    if (context === null) {
      context = deps.createContext();
      buses = {
        bgm: makeBus(context, volumes.bgm),
        se: makeBus(context, volumes.se),
        voice: makeBus(context, volumes.voice),
      };
    }
    const ctx = context;

    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // A gesture may still be missing; the next unlock() call retries.
      }
    }

    if (bgmId !== null && deps.bgm !== undefined && !bgmStarted) {
      deps.bgm.start(bgmId, safeTime(ctx));
      bgmStarted = true;
    }
  }

  return {
    unlock(): Promise<void> {
      if (unlockPromise === null) {
        unlockPromise = startAudio().catch(() => {
          unlockPromise = null;
        });
      }
      return unlockPromise;
    },

    handle(event: GameEvent, listener: Vec3): void {
      const ctx = context;
      if (ctx === null || buses === null) return;

      const spec = event.t === 'paint' ? paintSpec(ctx, event) : seSpecFor(event);
      if (spec === null || spec.layers.length === 0) return;

      const pos = eventPosition(event);
      let spatial: Spatial = { attenuation: 1, pan: 0 };
      if (pos !== null) {
        spatial = spatialize(pos, listener);
        if (spatial.attenuation <= 0) return;
      }
      play(ctx, spec, spatial);
    },

    setBgm(id: string | null): void {
      const previous = bgmId;
      bgmId = id;
      if (deps.bgm === undefined || context === null) return;

      const when = safeTime(context);
      if (id === null) {
        if (bgmStarted || previous !== null) deps.bgm.stop(when);
        bgmStarted = false;
      } else if (!bgmStarted || previous !== id) {
        deps.bgm.start(id, when);
        bgmStarted = true;
      }
    },

    setVolumes(next: Volumes): void {
      volumes = {
        bgm: clampVolume(next.bgm),
        se: clampVolume(next.se),
        voice: clampVolume(next.voice),
      };
      if (buses !== null) applyVolumes(buses);
    },
  };
}

/** Re-exported so consumers can narrow layer types without importing seSpec directly. */
export type { SeLayer, SeSpec, SeWaveform } from './seSpec';
