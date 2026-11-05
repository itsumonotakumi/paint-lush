import type {
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioGainLike,
  AudioNodeLike,
  AudioOscillatorLike,
  AudioParamLike,
  AudioStereoPannerLike,
} from '../audio';
import type { AudioBiquadFilterLike, BgmAudioContext } from './synth';

export interface FakeParamEvent {
  kind: 'set' | 'linear' | 'exponential' | 'cancel';
  value: number;
  time: number;
}

export class FakeParam implements AudioParamLike {
  value = 0;
  readonly events: FakeParamEvent[] = [];

  private record(kind: FakeParamEvent['kind'], value: number, time: number): void {
    this.events.push({ kind, value, time });
  }

  setValueAtTime(value: number, startTime: number): void {
    this.value = value;
    this.record('set', value, startTime);
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.value = value;
    this.record('linear', value, endTime);
  }

  exponentialRampToValueAtTime(value: number, endTime: number): void {
    this.value = value;
    this.record('exponential', value, endTime);
  }

  cancelScheduledValues(startTime: number): void {
    this.record('cancel', 0, startTime);
  }
}

export class FakeNode implements AudioNodeLike {
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

export class FakeGain extends FakeNode implements AudioGainLike {
  readonly gain = new FakeParam();
}

export class FakePanner extends FakeNode implements AudioStereoPannerLike {
  readonly pan = new FakeParam();
}

export class FakeFilter extends FakeNode implements AudioBiquadFilterLike {
  type = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

export class FakeSource extends FakeNode implements AudioOscillatorLike, AudioBufferSourceLike {
  type = 'sine';
  readonly frequency = new FakeParam();
  readonly playbackRate = new FakeParam();
  buffer: AudioBufferLike | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  startCalls = 0;
  stopCalls = 0;

  start(when?: number): void {
    this.startedAt = when ?? 0;
    this.startCalls += 1;
  }

  stop(when?: number): void {
    this.stoppedAt = when ?? 0;
    this.stopCalls += 1;
  }
}

export class FakeBuffer implements AudioBufferLike {
  private readonly data: Float32Array;

  constructor(length: number) {
    this.data = new Float32Array(Math.max(1, length));
  }

  getChannelData(): Float32Array {
    return this.data;
  }
}

export class FakeContext implements BgmAudioContext {
  currentTime = 0;
  state = 'running';
  readonly sampleRate = 48000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeSource[] = [];
  readonly bufferSources: FakeSource[] = [];
  readonly panners: FakePanner[] = [];
  readonly filters: FakeFilter[] = [];
  readonly buffers: FakeBuffer[] = [];
  resumeCalls = 0;

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): FakeSource {
    const oscillator = new FakeSource();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.bufferSources.push(source);
    return source;
  }

  createBuffer(_channels: number, length: number): FakeBuffer {
    const buffer = new FakeBuffer(length);
    this.buffers.push(buffer);
    return buffer;
  }

  createStereoPanner(): FakePanner {
    const panner = new FakePanner();
    this.panners.push(panner);
    return panner;
  }

  createBiquadFilter(): FakeFilter {
    const filter = new FakeFilter();
    this.filters.push(filter);
    return filter;
  }
}

interface TimerTask {
  id: number;
  at: number;
  callback: () => void;
}

/** Deterministic replacement for setTimeout used by the player. */
export class FakeTimer {
  private nextId = 1;
  private nowMs = 0;
  readonly tasks: TimerTask[] = [];

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.push({ id, at: this.nowMs + Math.max(0, delayMs), callback });
    return id;
  };

  get pending(): number {
    return this.tasks.length;
  }

  advance(ms: number): void {
    this.nowMs += Math.max(0, ms);
    for (let guard = 0; guard < 10000; guard += 1) {
      let dueIndex = -1;
      for (let i = 0; i < this.tasks.length; i += 1) {
        const task = this.tasks[i];
        if (task === undefined) continue;
        if (task.at <= this.nowMs && (dueIndex < 0 || task.at < (this.tasks[dueIndex]?.at ?? Infinity))) {
          dueIndex = i;
        }
      }
      if (dueIndex < 0) return;
      const task = this.tasks.splice(dueIndex, 1)[0];
      task?.callback();
    }
  }
}
