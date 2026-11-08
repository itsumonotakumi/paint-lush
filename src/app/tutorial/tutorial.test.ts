import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { InputDevice } from '../../core/actions';
import { emptyActions } from '../../core/actions';
import type { GameEvent } from '../../core/events';
import type { PlayerView, WorldSnapshot } from '../../core/snapshot';
import type { TeamId, Vec3 } from '../../core/types';
import { createTutorial } from './tutorial';
import type { TutorialController, TutorialFrame } from './types';

const LOCAL_ID = 7;
const POS: Vec3 = { x: 0, y: 0, z: 0 };

function makePlayer(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    id: LOCAL_ID,
    team: 0,
    state: 'stance',
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    ink: 0.5,
    weaponId: 'brush',
    gauge: 0,
    specialActive: false,
    charge: 0,
    kills: 0,
    ...overrides,
  };
}

function makeSnapshot(): WorldSnapshot {
  return {
    tick: 0,
    players: [],
    projectiles: [],
    bombs: [],
    phase: 'play',
    timeLeft: 0,
    counts: [0, 0],
  };
}

interface FrameOptions {
  me?: PlayerView | null;
  events?: readonly GameEvent[];
  dtSec?: number;
  device?: InputDevice;
  localId?: number;
}

function makeFrame(options: FrameOptions = {}): TutorialFrame {
  const me = options.me === undefined ? makePlayer() : options.me;
  return {
    localId: options.localId ?? LOCAL_ID,
    me,
    snapshot: makeSnapshot(),
    events: options.events ?? [],
    actions: emptyActions(),
    dtSec: options.dtSec ?? 1 / 60,
    device: options.device ?? 'keyboard',
  };
}

function paintEvent(cells: number, by?: number): GameEvent {
  return by === undefined
    ? { t: 'paint', team: 0, cells, pos: POS }
    : { t: 'paint', team: 0, cells, pos: POS, by };
}

function paintEventTeam(cells: number, team: TeamId): GameEvent {
  return { t: 'paint', team, cells, pos: POS };
}

function jumpEvent(id: number = LOCAL_ID): GameEvent {
  return { t: 'jump', id, pos: POS };
}

function killEvent(killer: number): GameEvent {
  return { t: 'kill', killer, victim: 99, pos: POS };
}

function subThrow(team: TeamId): GameEvent {
  return { t: 'sub', phase: 'throw', team, pos: POS };
}

function specialEvent(id: number, phase: 'ready' | 'start' | 'end'): GameEvent {
  return { t: 'special', id, phase };
}

/** Skips straight to the given zero-based step. */
function atStep(stepIndex: number): TutorialController {
  const tutorial = createTutorial();
  for (let i = 0; i < stepIndex; i += 1) tutorial.skipStep();
  return tutorial;
}

/** A tick with no events and nothing to do, used to burn celebration time. */
function idleFrame(dtSec = 1.2): TutorialFrame {
  return makeFrame({ dtSec });
}

describe('createTutorial', () => {
  it('starts on the move step with a keyboard hint and no progress', () => {
    const view = createTutorial().view();
    expect(view.stepId).toBe('move');
    expect(view.index).toBe(0);
    expect(view.total).toBe(8);
    expect(view.title).toBe('うごいて みよう');
    expect(view.hint).toContain('WASD');
    expect(view.progress).toBe(0);
    expect(view.celebrating).toBe(false);
    expect(view.finished).toBe(false);
  });

  it('reuses one view object across ticks', () => {
    const tutorial = createTutorial();
    const first = tutorial.update(makeFrame());
    const second = tutorial.update(makeFrame({ device: 'touch' }));
    expect(second).toBe(first);
    expect(tutorial.view()).toBe(first);
  });

  it('words the hint for the device in use', () => {
    const tutorial = createTutorial();
    const keyboardHint = tutorial.update(makeFrame({ device: 'keyboard' })).hint;
    const gamepadHint = tutorial.update(makeFrame({ device: 'gamepad' })).hint;
    const touchHint = tutorial.update(makeFrame({ device: 'touch' })).hint;
    expect(keyboardHint).toContain('WASD');
    expect(gamepadHint).toContain('ひだりスティック');
    expect(touchHint).toContain('ひだりがわ');
    expect(new Set([keyboardHint, gamepadHint, touchHint]).size).toBe(3);
  });

  it('completes the move step after four metres of walking', () => {
    const tutorial = createTutorial();
    let view = tutorial.update(makeFrame({ me: makePlayer() }));
    for (let i = 1; i <= 16; i += 1) {
      view = tutorial.update(makeFrame({ me: makePlayer({ pos: { x: i * 0.25, y: 0, z: 0 } }) }));
      if (i === 8) expect(view.progress).toBeCloseTo(0.5, 10);
    }
    expect(view.progress).toBe(1);
    expect(view.celebrating).toBe(true);
    expect(view.stepId).toBe('move');
    expect(view.title).toBe('できた！');
  });

  it('ignores per-tick jumps of more than two metres (teleports)', () => {
    const tutorial = createTutorial();
    tutorial.update(makeFrame({ me: makePlayer() }));
    const view = tutorial.update(makeFrame({ me: makePlayer({ pos: { x: 0, y: 0, z: 5 } }) }));
    expect(view.progress).toBe(0);
    expect(view.celebrating).toBe(false);
  });

  it('does not count movement while respawning', () => {
    const tutorial = createTutorial();
    tutorial.update(makeFrame({ me: makePlayer({ state: 'respawn' }) }));
    tutorial.update(makeFrame({ me: makePlayer({ state: 'respawn', pos: { x: 1, y: 0, z: 0 } }) }));
    expect(tutorial.view().progress).toBe(0);
    // The first tick after the respawn only records a new baseline.
    tutorial.update(makeFrame({ me: makePlayer({ pos: { x: 3, y: 0, z: 0 } }) }));
    expect(tutorial.view().progress).toBe(0);
  });

  it('accumulates wrapped yaw for the look step', () => {
    const tutorial = atStep(1);
    expect(tutorial.view().stepId).toBe('look');
    let view = tutorial.view();
    // The first tick only records the yaw baseline, so one extra tick is needed.
    for (let i = 0; i <= 16; i += 1) {
      view = tutorial.update(makeFrame({ me: makePlayer({ yaw: i * 0.2 }) }));
    }
    expect(view.celebrating).toBe(true);

    const wrapping = atStep(1);
    wrapping.update(makeFrame({ me: makePlayer({ yaw: 3.1 }) }));
    const wrapped = wrapping.update(makeFrame({ me: makePlayer({ yaw: -3.1 }) }));
    expect(wrapped.progress).toBeGreaterThan(0);
    expect(wrapped.progress).toBeLessThan(0.1);
  });

  it('counts only paint added by the local player for the shoot step', () => {
    const tutorial = atStep(2);
    expect(tutorial.view().stepId).toBe('shoot');
    let view = tutorial.update(makeFrame({ events: [paintEvent(60, LOCAL_ID), paintEvent(50, 99)] }));
    expect(view.progress).toBeCloseTo(0.5, 10);
    view = tutorial.update(makeFrame({ events: [paintEventTeam(20, 1), paintEventTeam(60, 0)] }));
    expect(view.progress).toBe(1);
    expect(view.celebrating).toBe(true);
  });

  it('needs dive time and a full ink refill for the dive step', () => {
    const tutorial = atStep(3);
    expect(tutorial.view().stepId).toBe('dive');
    let view = tutorial.view();
    for (let i = 0; i < 15; i += 1) {
      view = tutorial.update(makeFrame({ dtSec: 0.1, me: makePlayer({ state: 'dive', ink: 0.5 }) }));
    }
    expect(view.progress).toBe(0.9);
    expect(view.celebrating).toBe(false);
    view = tutorial.update(makeFrame({ dtSec: 0.1, me: makePlayer({ state: 'dive', ink: 0.96 }) }));
    expect(view.progress).toBe(1);
    expect(view.celebrating).toBe(true);
  });

  it('requires two local jumps for the jump step', () => {
    const tutorial = atStep(4);
    expect(tutorial.view().stepId).toBe('jump');
    let view = tutorial.update(makeFrame({ events: [jumpEvent()] }));
    expect(view.progress).toBe(0.5);
    view = tutorial.update(makeFrame({ events: [jumpEvent(99)] }));
    expect(view.progress).toBe(0.5);
    view = tutorial.update(makeFrame({ events: [jumpEvent()] }));
    expect(view.celebrating).toBe(true);
  });

  it('clears the bomb step only on a throw by the local team', () => {
    const tutorial = atStep(5);
    expect(tutorial.view().stepId).toBe('bomb');
    let view = tutorial.update(makeFrame({ events: [subThrow(1)] }));
    expect(view.progress).toBe(0);
    expect(view.celebrating).toBe(false);
    view = tutorial.update(makeFrame({ events: [subThrow(0)] }));
    expect(view.progress).toBe(1);
    expect(view.celebrating).toBe(true);
  });

  it('clears the dummy step only on a local kill', () => {
    const tutorial = atStep(6);
    expect(tutorial.view().stepId).toBe('dummy');
    let view = tutorial.update(makeFrame({ events: [killEvent(99)] }));
    expect(view.celebrating).toBe(false);
    view = tutorial.update(makeFrame({ events: [killEvent(LOCAL_ID)] }));
    expect(view.progress).toBe(1);
    expect(view.celebrating).toBe(true);
  });

  it('hints at filling the gauge and clears the special step on start', () => {
    const tutorial = atStep(7);
    expect(tutorial.view().stepId).toBe('special');
    let view = tutorial.update(makeFrame({ me: makePlayer({ gauge: 0.4 }) }));
    expect(view.hint).toContain('ゲージ');
    expect(view.progress).toBeCloseTo(0.4, 10);
    view = tutorial.update(makeFrame({ me: makePlayer({ gauge: 1 }) }));
    expect(view.hint).toBe('Qで おうぎを つかおう');
    view = tutorial.update(
      makeFrame({ me: makePlayer({ gauge: 1 }), events: [specialEvent(LOCAL_ID, 'ready')] }),
    );
    expect(view.celebrating).toBe(false);
    view = tutorial.update(
      makeFrame({ me: makePlayer({ gauge: 0.1 }), events: [specialEvent(LOCAL_ID, 'start')] }),
    );
    expect(view.celebrating).toBe(true);
    expect(view.progress).toBe(1);
  });

  it('ignores events that belong to other steps', () => {
    const tutorial = createTutorial();
    const view = tutorial.update(
      makeFrame({
        events: [jumpEvent(), killEvent(LOCAL_ID), subThrow(0), specialEvent(LOCAL_ID, 'start')],
      }),
    );
    expect(view.stepId).toBe('move');
    expect(view.celebrating).toBe(false);
    expect(view.progress).toBe(0);
  });

  it('celebrates for 1.2 seconds before advancing', () => {
    const tutorial = createTutorial();
    for (let i = 0; i <= 16; i += 1) {
      tutorial.update(makeFrame({ me: makePlayer({ pos: { x: i * 0.25, y: 0, z: 0 } }) }));
    }
    let view = tutorial.view();
    expect(view.celebrating).toBe(true);
    view = tutorial.update(idleFrame(0.5));
    expect(view.celebrating).toBe(true);
    expect(view.stepId).toBe('move');
    view = tutorial.update(idleFrame(0.6));
    expect(view.celebrating).toBe(true);
    view = tutorial.update(idleFrame(0.15));
    expect(view.celebrating).toBe(false);
    expect(view.stepId).toBe('look');
    expect(view.index).toBe(1);
    expect(view.progress).toBe(0);
    expect(view.title).toBe('まわりを みわたそう');
  });

  it('skips the current step without a celebration and finishes at done', () => {
    const tutorial = createTutorial();
    tutorial.skipStep();
    let view = tutorial.view();
    expect(view.stepId).toBe('look');
    expect(view.index).toBe(1);
    expect(view.celebrating).toBe(false);
    expect(view.progress).toBe(0);

    for (let i = 0; i < 20; i += 1) tutorial.skipStep();
    view = tutorial.view();
    expect(view.stepId).toBe('done');
    expect(view.finished).toBe(true);
    expect(view.index).toBe(8);

    tutorial.skipStep();
    expect(tutorial.view().stepId).toBe('done');
  });

  it('ignores non-finite and negative numbers', () => {
    const tutorial = createTutorial();
    const bad = makePlayer({
      pos: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: Number.NEGATIVE_INFINITY },
      yaw: Number.NaN,
      ink: Number.NaN,
      gauge: Number.NaN,
    });
    let view = tutorial.update(makeFrame({ me: bad, dtSec: Number.NaN }));
    expect(view.progress).toBe(0);
    view = tutorial.update(makeFrame({ me: bad, dtSec: Number.POSITIVE_INFINITY }));
    expect(view.progress).toBe(0);
    expect(view.finished).toBe(false);

    const look = atStep(1);
    view = look.update(makeFrame({ me: makePlayer({ yaw: Number.POSITIVE_INFINITY }) }));
    expect(view.progress).toBe(0);

    const shoot = atStep(2);
    view = shoot.update(
      makeFrame({
        events: [
          paintEvent(Number.NaN, LOCAL_ID),
          paintEvent(Number.NEGATIVE_INFINITY, LOCAL_ID),
          paintEvent(-5, LOCAL_ID),
        ],
      }),
    );
    expect(view.progress).toBe(0);

    const dive = atStep(3);
    view = dive.update(makeFrame({ dtSec: Number.NaN, me: makePlayer({ state: 'dive', ink: 0.99 }) }));
    expect(view.progress).toBeLessThan(0.01);
  });

  it('keeps the done view stable on later updates', () => {
    const tutorial = createTutorial();
    for (let i = 0; i < 8; i += 1) tutorial.skipStep();
    const done = { ...tutorial.view() };
    expect(done.finished).toBe(true);

    for (let i = 0; i < 30; i += 1) {
      tutorial.update(
        makeFrame({
          dtSec: Number.NaN,
          me: makePlayer({ gauge: 0.1, pos: { x: i, y: 0, z: 0 } }),
          events: [paintEvent(500, LOCAL_ID), killEvent(LOCAL_ID), specialEvent(LOCAL_ID, 'start')],
        }),
      );
    }
    expect(tutorial.view()).toEqual(done);
    expect(tutorial.view().stepId).toBe('done');
    expect(tutorial.view().progress).toBe(1);
  });

  it('walks through all eight steps and settles on the done view', () => {
    const tutorial = createTutorial();

    for (let i = 0; i <= 16; i += 1) {
      tutorial.update(makeFrame({ me: makePlayer({ pos: { x: i * 0.25, y: 0, z: 0 } }) }));
    }
    expect(tutorial.view().celebrating).toBe(true);
    tutorial.update(idleFrame());

    for (let i = 0; i <= 16; i += 1) {
      tutorial.update(makeFrame({ me: makePlayer({ yaw: i * 0.2 }) }));
    }
    expect(tutorial.view().celebrating).toBe(true);
    tutorial.update(idleFrame());

    tutorial.update(makeFrame({ events: [paintEvent(120, LOCAL_ID)] }));
    expect(tutorial.view().celebrating).toBe(true);
    tutorial.update(idleFrame());

    for (let i = 0; i < 15; i += 1) {
      tutorial.update(makeFrame({ dtSec: 0.1, me: makePlayer({ state: 'dive', ink: 0.5 }) }));
    }
    tutorial.update(makeFrame({ dtSec: 0.1, me: makePlayer({ state: 'dive', ink: 1 }) }));
    expect(tutorial.view().celebrating).toBe(true);
    tutorial.update(idleFrame());

    tutorial.update(makeFrame({ events: [jumpEvent()] }));
    tutorial.update(makeFrame({ events: [jumpEvent()] }));
    expect(tutorial.view().celebrating).toBe(true);
    tutorial.update(idleFrame());

    tutorial.update(makeFrame({ events: [subThrow(0)] }));
    expect(tutorial.view().celebrating).toBe(true);
    tutorial.update(idleFrame());

    tutorial.update(makeFrame({ events: [killEvent(LOCAL_ID)] }));
    expect(tutorial.view().celebrating).toBe(true);
    tutorial.update(idleFrame());

    tutorial.update(
      makeFrame({ me: makePlayer({ gauge: 1 }), events: [specialEvent(LOCAL_ID, 'start')] }),
    );
    expect(tutorial.view().celebrating).toBe(true);
    expect(tutorial.view().stepId).toBe('special');
    tutorial.update(idleFrame());

    const done = tutorial.view();
    expect(done.stepId).toBe('done');
    expect(done.index).toBe(8);
    expect(done.total).toBe(8);
    expect(done.title).toBe('これで きみも 一人前の 忍者！');
    expect(done.hint).toBe('おわる を おして メニューに もどろう');
    expect(done.finished).toBe(true);
    expect(done.progress).toBe(1);
    expect(done.celebrating).toBe(false);
  });

  it('keeps progress finite and clamped for arbitrary frames', () => {
    fc.assert(
      fc.property(fc.array(fc.double(), { maxLength: 25 }), fc.double(), (values, dtSec) => {
        const tutorial = createTutorial();
        for (const value of values) {
          const view = tutorial.update(
            makeFrame({
              me: makePlayer({
                pos: { x: value, y: value, z: value },
                yaw: value,
                ink: value,
                gauge: value,
                state: value >= 0 ? 'stance' : 'dive',
              }),
              dtSec,
              events: [paintEvent(value, LOCAL_ID), jumpEvent()],
            }),
          );
          expect(Number.isFinite(view.progress)).toBe(true);
          expect(view.progress).toBeGreaterThanOrEqual(0);
          expect(view.progress).toBeLessThanOrEqual(1);
          expect(Number.isFinite(view.index)).toBe(true);
          expect(view.total).toBe(8);
        }
        const after = tutorial.update(idleFrame(5));
        expect(Number.isFinite(after.progress)).toBe(true);
        expect(after.progress).toBeGreaterThanOrEqual(0);
        expect(after.progress).toBeLessThanOrEqual(1);
      }),
      { numRuns: 60 },
    );
  });
});
