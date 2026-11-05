// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '../core/events';
import type { WorldSnapshot } from '../core/snapshot';
import type { ICollision, IPaintGrid, MatchResult } from '../game/contracts';
import { defaultSave } from '../engine/save/saveStore';
import type { ISaveStore, IRenderer } from '../engine/ports';
import type { GamepadLike } from '../engine/input/inputManager';
import { LOCAL_PLAYER_ID } from '../game/sim/simulation';
import type { Simulation } from '../game/sim/simulation';
import type { SaveData } from '../game/data/schemas';
import { createMatchRunner, type MatchRunner } from './matchRunner';

const roots: HTMLElement[] = [];
const runners: MatchRunner[] = [];

function snapshot(phase: WorldSnapshot['phase'] = 'play'): WorldSnapshot {
  return {
    tick: 0,
    players: [],
    projectiles: [],
    bombs: [],
    phase,
    timeLeft: 120,
    counts: [0, 0],
  };
}

function memoryStore(initial: SaveData): {
  store: ISaveStore;
  data: () => SaveData;
  saves: () => number;
} {
  let current = initial;
  let writes = 0;
  return {
    store: {
      load: () => current,
      save: (next) => {
        current = next;
        writes += 1;
        return true;
      },
    },
    data: () => current,
    saves: () => writes,
  };
}

interface SessionOptions {
  finePointer?: boolean;
  maxTouchPoints?: number;
  deferLock?: boolean;
}

interface Session {
  runner: MatchRunner;
  canvas: HTMLCanvasElement;
  root: HTMLElement;
  bgm: Array<string | null>;
  go: Array<string>;
  save: ReturnType<typeof memoryStore>;
  sim: {
    state: WorldSnapshot;
    queue: GameEvent[];
    resultValue: MatchResult | null;
    steps: number;
  };
  locked: () => boolean;
  lockRequests: () => number;
  finishLock: () => void;
  setPads: (pads: readonly (GamepadLike | null)[]) => void;
}

function makeRenderer(): IRenderer {
  return {
    render: () => undefined,
    handle: () => undefined,
    resize: () => undefined,
    dispose: () => undefined,
  };
}

function makeCollision(): ICollision {
  return {
    moveAndSlide: (pos, vel) => ({ pos, vel, grounded: false, ground: null, wall: null }),
    raycast: () => null,
    containsPoint: () => false,
  };
}

function makePaint(): IPaintGrid {
  return {
    surfaces: [],
    surfaceAt: () => null,
    sampleHit: () => 0,
    splatHit: () => 0,
    splat: () => 0,
    counts: () => [0, 0],
    totalCells: () => 1000,
    takeDirty: () => [],
  };
}

let frameCallback: FrameRequestCallback | null = null;

function runFrame(timeMs: number): void {
  const callback = frameCallback;
  if (callback !== null) callback(timeMs);
}

function makeSession(options: SessionOptions = {}): Session {
  const canvas = document.createElement('canvas');
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);

  let locked: Element | null = null;
  let lockRequests = 0;
  let finishLock: () => void = () => undefined;
  Object.defineProperty(canvas, 'requestPointerLock', {
    configurable: true,
    value: () => {
      lockRequests += 1;
      if (options.deferLock === true) {
        return new Promise<void>((resolve) => {
          finishLock = () => {
            locked = canvas;
            document.dispatchEvent(new Event('pointerlockchange'));
            resolve();
          };
        });
      }
      locked = canvas;
      document.dispatchEvent(new Event('pointerlockchange'));
      return Promise.resolve();
    },
  });
  Object.defineProperty(document, 'pointerLockElement', {
    configurable: true,
    get: () => locked,
  });
  Object.defineProperty(document, 'exitPointerLock', {
    configurable: true,
    value: () => {
      if (locked !== null) {
        locked = null;
        document.dispatchEvent(new Event('pointerlockchange'));
      }
    },
  });

  let pads: readonly (GamepadLike | null)[] = [];
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => pads,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    value: options.maxTouchPoints ?? 0,
  });

  const state = {
    current: snapshot(),
    queue: [] as GameEvent[],
    resultValue: null as MatchResult | null,
    steps: 0,
  };
  const sim: Simulation = {
    collision: makeCollision(),
    paint: makePaint(),
    step: () => {
      state.steps += 1;
      const events = state.queue;
      state.queue = [];
      return events;
    },
    snapshot: () => state.current,
    result: () => state.resultValue,
  };

  const bgm: Array<string | null> = [];
  const go: string[] = [];
  const save = memoryStore(defaultSave());

  const runner = createMatchRunner({
    canvas,
    root,
    save: save.store,
    audio: {
      unlock: () => Promise.resolve(),
      handle: () => undefined,
      setBgm: (id) => bgm.push(id),
      setVolumes: () => undefined,
    },
    go: (id) => go.push(id),
    createSeed: () => 7,
    createRenderer: makeRenderer,
    createSim: () => sim,
    isFinePointer: () => options.finePointer ?? true,
  });
  runners.push(runner);
  runner.start({
    weaponId: 'iro-shuriken',
    stageId: 'neon-town',
    difficulty: 'normal',
    durationSeconds: 180,
  });

  return {
    runner,
    canvas,
    root,
    bgm,
    go,
    save,
    sim: {
      get state() {
        return state.current;
      },
      set state(next: WorldSnapshot) {
        state.current = next;
      },
      get queue() {
        return state.queue;
      },
      set queue(next: GameEvent[]) {
        state.queue = next;
      },
      get resultValue() {
        return state.resultValue;
      },
      set resultValue(next: MatchResult | null) {
        state.resultValue = next;
      },
      get steps() {
        return state.steps;
      },
    },
    locked: () => locked === canvas,
    lockRequests: () => lockRequests,
    finishLock: () => finishLock(),
    setPads: (next) => {
      pads = next;
    },
  };
}

function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
}

function pointerDown(pointerType: 'touch' | 'mouse'): void {
  const event = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  window.dispatchEvent(event);
}

function button(pressed: boolean, value = pressed ? 1 : 0): { pressed: boolean; value: number } {
  return { pressed, value };
}

function pad(buttons: Record<number, boolean>, axes: readonly number[] = [0, 0, 0, 0]): GamepadLike {
  const list: Array<{ pressed: boolean; value: number }> = [];
  for (let index = 0; index < 16; index += 1) {
    list.push(button(buttons[index] === true));
  }
  return { axes, buttons: list, connected: true };
}

beforeEach(() => {
  frameCallback = null;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameCallback = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frameCallback = null;
  });
});

afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
  for (const root of roots.splice(0)) root.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('match runner pointer lock and pause', () => {
  it('releases pointer lock on pause and reacquires it on resume', () => {
    const session = makeSession();
    session.canvas.click();
    expect(session.locked()).toBe(true);

    press('Escape');
    runFrame(16.7);

    expect(session.root.querySelector<HTMLElement>('.pr-paused')?.hidden).toBe(false);
    expect(session.locked()).toBe(false);

    const resume = session.root.querySelector<HTMLButtonElement>('.pr-paused__button');
    expect(resume).not.toBeNull();
    resume?.click();

    expect(session.root.querySelector<HTMLElement>('.pr-paused')?.hidden).toBe(true);
    expect(session.locked()).toBe(true);
  });

  it('releases a lock that is still held when the match is disposed', () => {
    const session = makeSession();
    session.canvas.click();
    expect(session.locked()).toBe(true);

    session.runner.dispose();

    expect(session.locked()).toBe(false);
  });

  it('clears a pending lock request that resolves after the match ended', async () => {
    const session = makeSession({ deferLock: true });
    session.canvas.click();
    expect(session.locked()).toBe(false);

    session.runner.dispose();
    session.finishLock();
    await Promise.resolve();

    expect(session.locked()).toBe(false);
  });
});

describe('match runner music', () => {
  it('stops the match music when the player quits to the menu', () => {
    const session = makeSession();
    press('Escape');
    runFrame(16.7);

    const quit = session.root.querySelector<HTMLButtonElement>('.pr-paused__quit');
    expect(quit).not.toBeNull();
    quit?.click();

    expect(session.go).toEqual(['menu']);
    expect(session.bgm[session.bgm.length - 1]).toBeNull();
  });

  it('lets an active special keep its track through lastMinute', () => {
    const session = makeSession();
    runFrame(16.7);

    session.sim.queue = [
      { t: 'special', id: LOCAL_PLAYER_ID, phase: 'start' },
      { t: 'phase', phase: 'lastMinute' },
    ];
    runFrame(33.4);

    expect(session.bgm).toContain('special');
    expect(session.bgm[session.bgm.length - 1]).toBe('special');

    session.sim.queue = [
      { t: 'phase', phase: 'countdown' },
      { t: 'special', id: LOCAL_PLAYER_ID, phase: 'end' },
    ];
    runFrame(50.1);

    // Both lastMinute and countdown restore the urgent track.
    expect(session.bgm[session.bgm.length - 1]).toBe('lastMinute');
  });
});

describe('match runner start gate', () => {
  it('does not request lock at start and offers たたかう instead', () => {
    const session = makeSession();
    expect(session.lockRequests()).toBe(0);

    const gate = session.root.querySelector<HTMLElement>('.pr-start-gate');
    expect(gate?.hidden).toBe(false);

    const buttonEl = session.root.querySelector<HTMLButtonElement>('.pr-start-gate__button');
    expect(buttonEl?.textContent).toBe('たたかう!');
    buttonEl?.click();

    expect(session.lockRequests()).toBe(1);
    expect(session.locked()).toBe(true);
    expect(gate?.hidden).toBe(true);
  });
});

describe('match runner touch detection', () => {
  it('keeps touch controls hidden on a hybrid laptop until a real touch', () => {
    const session = makeSession({ finePointer: true, maxTouchPoints: 4 });
    const touch = session.root.querySelector<HTMLElement>('.pr-touch');
    expect(touch).not.toBeNull();
    expect(touch?.hidden).toBe(true);
    expect(session.root.querySelector<HTMLElement>('.pr-start-gate')?.hidden).toBe(false);

    pointerDown('touch');
    expect(touch?.hidden).toBe(false);

    pointerDown('mouse');
    expect(touch?.hidden).toBe(true);
  });

  it('shows touch controls immediately when no fine pointer exists', () => {
    const session = makeSession({ finePointer: false, maxTouchPoints: 4 });
    expect(session.root.querySelector<HTMLElement>('.pr-touch')?.hidden).toBe(false);
    expect(session.root.querySelector<HTMLElement>('.pr-start-gate')?.hidden).toBe(true);
  });
});

describe('match runner gamepad pause', () => {
  it('pauses on disconnect, announces reconnect and resumes with A', () => {
    const session = makeSession();
    runFrame(16.7);

    window.dispatchEvent(new Event('gamepaddisconnected'));
    expect(session.root.querySelector<HTMLElement>('.pr-paused')?.hidden).toBe(false);
    expect(session.root.querySelector<HTMLElement>('.pr-paused__reason')?.textContent).toContain(
      'はずれた',
    );

    window.dispatchEvent(new Event('gamepadconnected'));
    expect(session.root.querySelector<HTMLElement>('.pr-paused__reason')?.textContent).toContain(
      'もどった',
    );
    expect(session.root.querySelector<HTMLElement>('.pr-paused')?.hidden).toBe(false);

    session.setPads([pad({ 0: true })]);
    runFrame(33.4);

    expect(session.root.querySelector<HTMLElement>('.pr-paused')?.hidden).toBe(true);
  });

  it('quits on B while paused', () => {
    const session = makeSession();
    runFrame(16.7);

    window.dispatchEvent(new Event('gamepaddisconnected'));
    session.setPads([pad({ 1: true })]);
    runFrame(33.4);

    expect(session.go).toEqual(['menu']);
  });
});

describe('match runner settle window', () => {
  it('keeps stepping while paused once the whistle has blown and records once', () => {
    const session = makeSession();
    runFrame(16.7);

    session.sim.state = snapshot('finished');
    runFrame(33.4);

    press('Escape');
    runFrame(50.1);
    expect(session.root.querySelector<HTMLElement>('.pr-paused')?.hidden).toBe(false);

    session.sim.resultValue = {
      winner: 0,
      ratio: [60, 40],
      players: [{ id: LOCAL_PLAYER_ID, team: 0, paintCells: 42, kills: 1, deaths: 0 }],
    };
    const stepsBefore = session.sim.steps;

    runFrame(66.8);

    expect(session.sim.steps).toBeGreaterThan(stepsBefore);
    expect(session.go).toEqual(['result']);
    expect(session.save.saves()).toBe(1);
    expect(session.save.data().records.matches).toBe(1);
    expect(session.save.data().records.wins).toBe(1);
    expect(session.save.data().records.bestPaintCells).toBe(42);
  });
});
