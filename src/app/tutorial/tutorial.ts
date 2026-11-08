import type { InputDevice } from '../../core/actions';
import type { GameEvent } from '../../core/events';
import type { TutorialController, TutorialFrame, TutorialView } from './types';

/**
 * Guided tutorial for the training stage. Pure logic: no DOM, no three, no
 * clocks and no randomness, so the same frames always produce the same view.
 *
 * The view instance is owned by the controller: `update()` and `view()` both
 * return the same mutable object and write the new values into it in place.
 * Callers that need to keep values across ticks must copy the fields they use.
 *
 * Every number that reaches the view is finite and clamped to 0..1. Frames
 * with NaN/Infinity timers or coordinates are treated as "no progress".
 */

/** Steps in teaching order. 'done' is not a step; it is the summary view. */
const STEP_IDS = ['move', 'look', 'shoot', 'dive', 'jump', 'bomb', 'dummy', 'special'] as const;
type RealStepId = (typeof STEP_IDS)[number];

const TOTAL_STEPS = STEP_IDS.length;
const CELEBRATION_SEC = 1.2;
/** A single tick moving further than this is treated as a respawn/teleport. */
const TELEPORT_M = 2;
const MOVE_GOAL_M = 4;
const LOOK_GOAL_RAD = Math.PI * 0.5;
const PAINT_GOAL_CELLS = 120;
const DIVE_GOAL_SEC = 1.5;
const DIVE_INK_MIN = 0.95;
/** Dive progress caps here until the player has refilled ink while diving. */
const DIVE_PROGRESS_WITHOUT_INK = 0.9;
const JUMP_GOAL = 2;
const TAU = Math.PI * 2;

const TITLES: Readonly<Record<RealStepId, string>> = {
  move: 'うごいて みよう',
  look: 'まわりを みわたそう',
  shoot: 'インクを うって ぬろう',
  dive: 'じぶんの インクに もぐって インクを ためよう',
  jump: 'ジャンプ！',
  bomb: 'ボムを なげよう',
  dummy: 'まとの 忍者を たおそう',
  special: 'おうぎを つかおう',
};

const DONE_TITLE = 'これで きみも 一人前の 忍者！';
const DONE_HINT = 'おわる を おして メニューに もどろう';

const CLEAR_TITLES: Readonly<Record<RealStepId, string>> = {
  move: 'できた！',
  look: 'みわたせたね！',
  shoot: 'ぬれたね！',
  dive: 'もぐれたね！',
  jump: 'ジャンプ できた！',
  bomb: 'ボムを なげた！',
  dummy: 'まとを たおした！',
  special: 'おうぎを つかった！',
};

const CLEAR_HINT_NEXT = 'つぎの わざへ すすむよ';
const CLEAR_HINT_LAST = 'ぜんぶ できたよ！';

const HINTS: Readonly<Record<RealStepId, Readonly<Record<InputDevice, string>>>> = {
  move: {
    keyboard: 'WASDキーで あるこう',
    gamepad: 'ひだりスティックで あるこう',
    touch: 'ひだりがわを なぞって あるこう',
  },
  look: {
    keyboard: 'マウスで まわりを みよう',
    gamepad: 'みぎスティックで まわりを みよう',
    touch: 'みぎがわを なぞって まわりを みよう',
  },
  shoot: {
    keyboard: 'ひだりクリックで インクを うとう',
    gamepad: 'RTで インクを うとう',
    touch: '「うつ」ボタンで インクを うとう',
  },
  dive: {
    keyboard: 'ひだりShiftで インクに もぐろう',
    gamepad: 'LTで インクに もぐろう',
    touch: '「もぐる」で インクに もぐろう',
  },
  jump: {
    keyboard: 'Spaceで ジャンプしよう',
    gamepad: 'Aで ジャンプしよう',
    touch: '「ジャンプ」で とんでみよう',
  },
  bomb: {
    keyboard: 'Eで ボムを なげよう',
    gamepad: 'RBで ボムを なげよう',
    touch: '「ボム」で ボムを なげよう',
  },
  dummy: {
    keyboard: 'まとに ねらいを つけて ひだりクリック',
    gamepad: 'まとに ねらいを つけて RT',
    touch: 'まとに ねらいを つけて 「うつ」ボタン',
  },
  special: {
    keyboard: 'Qで おうぎを つかおう',
    gamepad: 'Yで おうぎを つかおう',
    touch: '「おうぎ」ボタンを おそう',
  },
};

const SPECIAL_PAINT_HINTS: Readonly<Record<InputDevice, string>> = {
  keyboard: 'ひだりクリックで ぬって ゲージを いっぱいに しよう',
  gamepad: 'RTで ぬって ゲージを いっぱいに しよう',
  touch: '「うつ」ボタンで ぬって ゲージを いっぱいに しよう',
};

/** Counters for the step that is currently running. Reset on every advance. */
interface StepCounters {
  hasPrevPos: boolean;
  prevX: number;
  prevZ: number;
  walked: number;
  hasPrevYaw: boolean;
  prevYaw: number;
  turned: number;
  painted: number;
  diveSec: number;
  inkReached: boolean;
  jumps: number;
  cleared: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Tick length in seconds; negative and non-finite values count as zero. */
function toSeconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Wraps an angle delta into [-PI, PI]. Non-finite input yields 0. */
function wrapAngle(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  let wrapped = delta % TAU;
  if (wrapped > Math.PI) wrapped -= TAU;
  else if (wrapped < -Math.PI) wrapped += TAU;
  return wrapped;
}

/** Unknown device values fall back to the keyboard wording instead of crashing. */
function normalizeDevice(device: InputDevice): InputDevice {
  if (device === 'gamepad') return 'gamepad';
  if (device === 'touch') return 'touch';
  return 'keyboard';
}

function hintFor(id: RealStepId, device: InputDevice, gaugeLow: boolean): string {
  if (id === 'special' && gaugeLow) return SPECIAL_PAINT_HINTS[device];
  return HINTS[id][device];
}

/**
 * Creates a fresh tutorial controller. Each controller keeps its own progress
 * and its own reusable view object, so two instances never share state.
 */
export function createTutorial(): TutorialController {
  const counters: StepCounters = {
    hasPrevPos: false,
    prevX: 0,
    prevZ: 0,
    walked: 0,
    hasPrevYaw: false,
    prevYaw: 0,
    turned: 0,
    painted: 0,
    diveSec: 0,
    inkReached: false,
    jumps: 0,
    cleared: false,
  };

  const viewState: TutorialView = {
    stepId: 'move',
    index: 0,
    total: TOTAL_STEPS,
    title: TITLES.move,
    hint: hintFor('move', 'keyboard', false),
    progress: 0,
    celebrating: false,
    finished: false,
  };

  let index = 0;
  let current: RealStepId = STEP_IDS[0];
  let currentDevice: InputDevice = 'keyboard';
  let localTeam: number | null = null;
  let lastGauge = 0;
  let celebrating = false;
  let celebrationRemaining = 0;
  let finished = false;
  let pendingProgress = 0;
  let pendingClear = false;

  function resetCounters(): void {
    counters.hasPrevPos = false;
    counters.prevX = 0;
    counters.prevZ = 0;
    counters.walked = 0;
    counters.hasPrevYaw = false;
    counters.prevYaw = 0;
    counters.turned = 0;
    counters.painted = 0;
    counters.diveSec = 0;
    counters.inkReached = false;
    counters.jumps = 0;
    counters.cleared = false;
  }

  function enterStep(next: number): void {
    celebrating = false;
    celebrationRemaining = 0;
    index = next;
    resetCounters();
    pendingProgress = 0;
    pendingClear = false;

    const id = next < TOTAL_STEPS ? STEP_IDS[next] : undefined;
    if (id === undefined) {
      finished = true;
      viewState.stepId = 'done';
      viewState.index = TOTAL_STEPS;
      viewState.title = DONE_TITLE;
      viewState.hint = DONE_HINT;
      viewState.progress = 1;
      viewState.celebrating = false;
      viewState.finished = true;
      return;
    }

    current = id;
    finished = false;
    viewState.stepId = id;
    viewState.index = next;
    viewState.title = TITLES[id];
    viewState.hint = hintFor(id, currentDevice, id === 'special' && lastGauge < 1);
    viewState.progress = 0;
    viewState.celebrating = false;
    viewState.finished = false;
  }

  function beginCelebration(): void {
    celebrating = true;
    celebrationRemaining = CELEBRATION_SEC;
    viewState.celebrating = true;
    viewState.progress = 1;
    viewState.title = CLEAR_TITLES[current];
    viewState.hint = index >= TOTAL_STEPS - 1 ? CLEAR_HINT_LAST : CLEAR_HINT_NEXT;
  }

  function addPaintCells(events: readonly GameEvent[], localId: number): void {
    for (const ev of events) {
      if (ev.t !== 'paint') continue;
      if (!Number.isFinite(ev.cells) || ev.cells <= 0) continue;
      const mine =
        ev.by !== undefined ? ev.by === localId : localTeam !== null && ev.team === localTeam;
      if (mine) {
        counters.painted = Math.min(counters.painted + ev.cells, PAINT_GOAL_CELLS);
      }
    }
  }

  /** Reads one tick into pendingProgress/pendingClear. No allocation. */
  function readStep(frame: TutorialFrame, dt: number): void {
    const me = frame.me ?? null;
    const localId = frame.localId;
    pendingProgress = 0;
    pendingClear = false;

    switch (current) {
      case 'move': {
        const posOk =
          me !== null &&
          me.state !== 'respawn' &&
          Number.isFinite(me.pos.x) &&
          Number.isFinite(me.pos.z);
        if (posOk) {
          if (counters.hasPrevPos) {
            const moved = Math.hypot(me.pos.x - counters.prevX, me.pos.z - counters.prevZ);
            if (Number.isFinite(moved) && moved <= TELEPORT_M) {
              counters.walked = Math.min(counters.walked + moved, MOVE_GOAL_M);
            }
          }
          counters.prevX = me.pos.x;
          counters.prevZ = me.pos.z;
          counters.hasPrevPos = true;
        } else {
          // Not spawned or respawning: do not bridge the gap on the next tick.
          counters.hasPrevPos = false;
        }
        pendingProgress = counters.walked / MOVE_GOAL_M;
        pendingClear = pendingProgress >= 1;
        break;
      }

      case 'look': {
        if (me !== null && Number.isFinite(me.yaw)) {
          if (counters.hasPrevYaw) {
            const turned = Math.abs(wrapAngle(me.yaw - counters.prevYaw));
            counters.turned = Math.min(counters.turned + turned, LOOK_GOAL_RAD);
          }
          counters.prevYaw = me.yaw;
          counters.hasPrevYaw = true;
        } else {
          counters.hasPrevYaw = false;
        }
        pendingProgress = counters.turned / LOOK_GOAL_RAD;
        pendingClear = pendingProgress >= 1;
        break;
      }

      case 'shoot': {
        addPaintCells(frame.events, localId);
        pendingProgress = counters.painted / PAINT_GOAL_CELLS;
        pendingClear = counters.painted >= PAINT_GOAL_CELLS;
        break;
      }

      case 'dive': {
        if (me !== null && me.state === 'dive') {
          counters.diveSec = Math.min(counters.diveSec + dt, DIVE_GOAL_SEC);
          if (Number.isFinite(me.ink) && me.ink >= DIVE_INK_MIN) {
            counters.inkReached = true;
          }
        }
        const timePart = counters.diveSec / DIVE_GOAL_SEC;
        pendingProgress = Math.min(
          timePart,
          counters.inkReached ? 1 : DIVE_PROGRESS_WITHOUT_INK,
        );
        pendingClear = counters.inkReached && counters.diveSec >= DIVE_GOAL_SEC;
        break;
      }

      case 'jump': {
        for (const ev of frame.events) {
          if (ev.t === 'jump' && ev.id === localId) {
            counters.jumps = Math.min(counters.jumps + 1, JUMP_GOAL);
          }
        }
        pendingProgress = counters.jumps / JUMP_GOAL;
        pendingClear = counters.jumps >= JUMP_GOAL;
        break;
      }

      case 'bomb': {
        if (!counters.cleared && localTeam !== null) {
          for (const ev of frame.events) {
            if (ev.t === 'sub' && ev.phase === 'throw' && ev.team === localTeam) {
              counters.cleared = true;
              break;
            }
          }
        }
        pendingProgress = counters.cleared ? 1 : 0;
        pendingClear = counters.cleared;
        break;
      }

      case 'dummy': {
        if (!counters.cleared) {
          for (const ev of frame.events) {
            if (ev.t === 'kill' && ev.killer === localId) {
              counters.cleared = true;
              break;
            }
          }
        }
        pendingProgress = counters.cleared ? 1 : 0;
        pendingClear = counters.cleared;
        break;
      }

      case 'special': {
        if (!counters.cleared) {
          for (const ev of frame.events) {
            if (ev.t === 'special' && ev.id === localId && ev.phase === 'start') {
              counters.cleared = true;
              break;
            }
          }
        }
        pendingProgress = counters.cleared ? 1 : lastGauge;
        pendingClear = counters.cleared;
        break;
      }
    }
  }

  function update(frame: TutorialFrame): TutorialView {
    const dt = toSeconds(frame.dtSec);
    const device = normalizeDevice(frame.device);
    currentDevice = device;

    const me = frame.me ?? null;
    if (me !== null) {
      localTeam = me.team;
      lastGauge = clamp01(me.gauge);
    }

    if (finished) return viewState;

    if (celebrating) {
      celebrationRemaining -= dt;
      if (celebrationRemaining > 0) return viewState;
      celebrationRemaining = 0;
      enterStep(index + 1);
      return viewState;
    }

    readStep(frame, dt);
    if (pendingClear) {
      beginCelebration();
      return viewState;
    }

    viewState.progress = clamp01(pendingProgress);
    viewState.hint = hintFor(current, device, current === 'special' && lastGauge < 1);
    return viewState;
  }

  function view(): TutorialView {
    return viewState;
  }

  function skipStep(): void {
    if (finished) return;
    celebrating = false;
    celebrationRemaining = 0;
    enterStep(index + 1);
  }

  return { update, view, skipStep };
}
