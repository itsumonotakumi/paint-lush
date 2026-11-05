import type { GameEvent } from './core/events';
import type { WorldSnapshot } from './core/snapshot';
import { FIXED_DT } from './core/types';
import { createAudio } from './engine/audio/audio';
import { createInputManager } from './engine/input/inputManager';
import { createThreeRenderer } from './engine/render/renderer';
import { createSaveStore } from './engine/save/saveStore';
import playerJson from './data/player.json';
import stageJson from './data/stages/neon-town.json';
import weaponsJson from './data/weapons.json';
import { parsePlayerConfig, parseStage, parseWeapons } from './game/data/load';
import type { PlayerConfig } from './game/data/schemas';
import { createSimulation, LOCAL_PLAYER_ID } from './game/sim/simulation';
import { createDebugPanel, type DebugParam } from './ui/debugPanel';
import { createHud } from './ui/hud';

const MAX_STEPS_PER_FRAME = 5;
const TEAM_COLORS: [number, number] = [0xff2e88, 0x19e6d0];

function requireElement<T extends Element>(selector: string, type: new () => T): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`missing element ${selector}`);
  return element;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function tunable(cfg: PlayerConfig, key: keyof PlayerConfig & string, label: string, min: number, max: number, step: number): DebugParam {
  return {
    key,
    label,
    min,
    max,
    step,
    get: () => {
      const value = cfg[key];
      return typeof value === 'number' ? value : 0;
    },
    set: (value) => {
      if (key !== 'halfExtents') cfg[key] = value;
    },
  };
}

/** GitHub Pages cannot send frame-ancestors, so refuse to run inside a frame. */
function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function boot(): void {
  const canvas = requireElement('#game', HTMLCanvasElement);
  const uiRoot = requireElement('#ui', HTMLDivElement);

  const stage = parseStage(stageJson);
  const weapon = parseWeapons(weaponsJson)[0];
  if (weapon === undefined) throw new Error('no weapon defined');
  const player = parsePlayerConfig(playerJson);
  const save = createSaveStore(safeStorage()).load();

  const sim = createSimulation({ stage, weapon, player, seed: 20261105 });
  const renderer = createThreeRenderer({
    canvas,
    stage,
    paint: sim.paint,
    collision: sim.collision,
    teamColors: TEAM_COLORS,
    localPlayerId: LOCAL_PLAYER_ID,
  });
  const audio = createAudio({ createContext: () => new AudioContext() });
  audio.setVolumes(save.settings.volume);

  const input = createInputManager({
    keyboardTarget: window,
    pointerTarget: canvas,
    getGamepads: () => navigator.getGamepads(),
    isPointerLocked: () => document.pointerLockElement === canvas,
    bindings: save.settings.keys,
    sensitivity: {
      mouse: save.settings.mouseSensitivity,
      stick: save.settings.stickSensitivity,
      invertY: save.settings.invertY,
    },
  });

  const hud = createHud(uiRoot);
  createDebugPanel(uiRoot, [
    tunable(player, 'walkSpeed', '歩行速度', 2, 12, 0.1),
    tunable(player, 'diveSpeed', '染遁速度', 4, 16, 0.1),
    tunable(player, 'enemyInkSpeed', '敵インク上速度', 1, 6, 0.1),
    tunable(player, 'jumpSpeed', 'ジャンプ初速', 3, 12, 0.1),
    tunable(player, 'gravity', '重力', 8, 40, 0.5),
    tunable(player, 'acceleration', '加速度', 10, 120, 1),
    tunable(player, 'wallClimbSpeed', '壁登り速度', 1, 10, 0.1),
    tunable(player, 'inkRegenDive', '染遁ペンキ回復', 5, 80, 1),
  ]);

  const resize = (): void => {
    renderer.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio, 2));
  };
  window.addEventListener('resize', resize);
  resize();

  let running = false;
  let paused = false;
  let curr: WorldSnapshot = sim.snapshot();
  let prev: WorldSnapshot = curr;
  let accumulator = 0;
  let lastTime = 0;

  const requestLock = (): void => {
    const pending = canvas.requestPointerLock() as Promise<void> | undefined;
    pending?.catch(() => undefined);
  };

  const setPaused = (value: boolean): void => {
    paused = value;
    hud.showPaused(value);
    accumulator = 0;
  };

  hud.showStart(() => {
    hud.hideStart();
    void audio.unlock();
    running = true;
    requestLock();
  });

  canvas.addEventListener('click', () => {
    if (!running) return;
    if (document.pointerLockElement !== canvas) requestLock();
    if (paused) setPaused(false);
  });

  document.addEventListener('pointerlockchange', () => {
    if (running && document.pointerLockElement !== canvas) setPaused(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (running && document.hidden) setPaused(true);
  });

  const dispatch = (events: readonly GameEvent[], listener: WorldSnapshot['players'][number]['pos']): void => {
    for (const event of events) {
      audio.handle(event, listener);
      renderer.handle(event);
    }
  };

  const frame = (time: number): void => {
    requestAnimationFrame(frame);
    const delta = Math.min((time - lastTime) / 1000, 0.25);
    lastTime = time;

    if (running && !paused) {
      accumulator += delta;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        const actions = input.poll();
        if (actions.pause) setPaused(true);
        prev = curr;
        const events = sim.step(new Map([[LOCAL_PLAYER_ID, actions]]));
        curr = sim.snapshot();
        const me = curr.players.find((p) => p.id === LOCAL_PLAYER_ID);
        if (me !== undefined) dispatch(events, me.pos);
        accumulator -= FIXED_DT;
        steps += 1;
      }
      if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
    }

    renderer.render(prev, curr, Math.min(accumulator / FIXED_DT, 1), LOCAL_PLAYER_ID);
    const me = curr.players.find((p) => p.id === LOCAL_PLAYER_ID);
    if (me !== undefined) hud.update(me, curr.counts, sim.paint.totalCells());
  };
  requestAnimationFrame(frame);
}

if (!isFramed()) boot();
