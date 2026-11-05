import { emptyActions } from '../core/actions';
import type { InputActions } from '../core/actions';
import type { GameEvent, MatchPhase } from '../core/events';
import { createRng } from '../core/rng';
import type { PlayerView, WorldSnapshot } from '../core/snapshot';
import { FIXED_DT, type EntityId, type TeamId, type Vec3 } from '../core/types';
import { createInputManager } from '../engine/input/inputManager';
import { createTouchControls } from '../engine/input/touch/touchControls';
import type {
  IAudio,
  IInputSource,
  IRenderer,
  ISaveStore,
  ITouchControls,
  MatchSetup,
  ScreenId,
  ScreenParams,
  TeamLabel,
} from '../engine/ports';
import { createThreeRenderer } from '../engine/render/renderer';
import aiJson from '../data/ai.json';
import matchJson from '../data/match.json';
import playerJson from '../data/player.json';
import specialJson from '../data/specials.json';
import karakuriDecorJson from '../data/stages/karakuri-port.decor.json';
import karakuriPortJson from '../data/stages/karakuri-port.json';
import neonDecorJson from '../data/stages/neon-town.decor.json';
import neonTownJson from '../data/stages/neon-town.json';
import subJson from '../data/subs.json';
import weaponsJson from '../data/weapons.json';
import type { MatchResult } from '../game/contracts';
import {
  parseAi,
  parseMatchConfig,
  parsePlayerConfig,
  parseSpecial,
  parseStage,
  parseSub,
  parseWeapons,
} from '../game/data/load';
import type {
  AiProfiles,
  Difficulty,
  MatchConfig,
  PlayerConfig,
  Weapon,
} from '../game/data/schemas';
import {
  buildRoster,
  buildTrainingRoster,
  createSimulation,
  LOCAL_PLAYER_ID,
} from '../game/sim/simulation';
import { createDebugPanel, type DebugPanel, type DebugParam } from '../ui/debugPanel';
import { createHud, type Hud, type HudTeam } from '../ui/hud';

/** Fixed simulation steps a single frame may run, matching the original boot loop. */
export const MAX_STEPS_PER_FRAME = 5;
/** A stalled tab may not fast-forward more than this many seconds. */
const MAX_FRAME_SECONDS = 0.25;
const MAX_SAVE_COUNT = 1_000_000_000;
const DEFAULT_STAGE_ID = 'neon-town';
const DEFAULT_WEAPON_ID = 'iro-shuriken';
const ZERO_POS: Vec3 = { x: 0, y: 0, z: 0 };
/** Scales the stick sensitivity into the touch look's radians-per-pixel range. */
export const TOUCH_LOOK_SCALE = 0.001;
/** BGM used by every menu-like screen. */
export const MENU_BGM = 'title';

/* ---------- versions of the save data, kept for records ---------- */

const STAGE_FILES = new Map<string, unknown>([
  ['neon-town', neonTownJson],
  ['karakuri-port', karakuriPortJson],
]);

const DECOR_FILES = new Map<string, unknown>([
  ['neon-town', neonDecorJson],
  ['karakuri-port', karakuriDecorJson],
]);

/* ---------- teams ---------- */

/** Team data used by the runner: the colour is always a renderer int. */
export interface MatchTeam extends HudTeam {
  color: number;
}

const GREN: MatchTeam = { name: '紅蓮', reading: 'ぐれん', color: 0xff2e88 };
const SORAI: MatchTeam = { name: '蒼雷', reading: 'そうらい', color: 0x19e6d0 };
const SUZAKU: MatchTeam = { name: '朱雀', reading: 'すざく', color: 0xff8a1f };
const SEIRYU: MatchTeam = { name: '青龍', reading: 'せいりゅう', color: 0x2e7bff };
const SHIDEN: MatchTeam = { name: '紫電', reading: 'しでん', color: 0xb44cff };
const WAKABA: MatchTeam = { name: '若葉', reading: 'わかば', color: 0xb8e62e };
const YAMABUKI: MatchTeam = { name: '山吹', reading: 'やまぶき', color: 0xe69f00 };
const GUNJO: MatchTeam = { name: '群青', reading: 'ぐんじょう', color: 0x0072b2 };

/** Complementary pairs; the local player is always the first team. */
export const TEAM_PAIRS: readonly (readonly [MatchTeam, MatchTeam])[] = [
  [GREN, SORAI],
  [SUZAKU, SEIRYU],
  [SHIDEN, WAKABA],
];

export const COLORBLIND_TEAMS: readonly [MatchTeam, MatchTeam] = [YAMABUKI, GUNJO];

/** Picks a pair from the match seed, or the colour-blind-safe pair when asked. */
export function pickTeams(seed: number, colorblind: boolean): readonly [MatchTeam, MatchTeam] {
  if (colorblind) return COLORBLIND_TEAMS;
  const index = createRng(seed).int(TEAM_PAIRS.length);
  return TEAM_PAIRS[index] ?? COLORBLIND_TEAMS;
}

/**
 * Builds the result screen params for a finished match, carrying the pair that
 * was chosen for it. The local player's team is always index 0, matching the
 * ratio and roster ordering used by the simulation.
 */
export function resultScreenParams(
  result: MatchResult,
  teams: readonly [MatchTeam, MatchTeam],
): ScreenParams {
  const labels: readonly [TeamLabel, TeamLabel] = [
    { name: teams[0].name, reading: teams[0].reading, color: teams[0].color },
    { name: teams[1].name, reading: teams[1].reading, color: teams[1].color },
  ];
  return { kind: 'result', result, localId: LOCAL_PLAYER_ID, teams: labels };
}

/* ---------- seed ---------- */

/** Browser entropy, used once per match. Falls back to zero if crypto is unavailable. */
export function createMatchSeed(): number {
  try {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return 0;
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    const value = values[0];
    return value === undefined ? 0 : value >>> 0;
  } catch {
    return 0;
  }
}

/* ---------- data and frame helpers ---------- */

/** Stage key with the neon-town fallback for unknown save ids. */
export function resolveStageId(stageId: string): string {
  return STAGE_FILES.has(stageId) ? stageId : DEFAULT_STAGE_ID;
}

/** Weapon with the iro-shuriken fallback for unknown save ids. */
export function resolveWeapon(weapons: readonly Weapon[], weaponId: string): Weapon {
  const exact = weapons.find((weapon) => weapon.id === weaponId);
  if (exact !== undefined) return exact;
  const fallback = weapons.find((weapon) => weapon.id === DEFAULT_WEAPON_ID) ?? weapons[0];
  if (fallback === undefined) throw new Error('weapons: at least one weapon is required');
  return fallback;
}

/** Seconds between two rAF timestamps, clamped and made finite. */
export function frameDeltaSeconds(time: number, lastTime: number): number {
  const raw = (time - lastTime) / 1000;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_FRAME_SECONDS);
}

/** Kana call-out for a kill, or null when the local player was not involved. */
export function killLogLine(killer: EntityId, victim: EntityId, localId: EntityId): string | null {
  if (killer === localId && victim !== localId) return 'あなたが やっつけた！';
  if (victim === localId && killer !== localId) return 'やられた！';
  return null;
}

/** Adds one use of the weapon while leaving matches and wins to the result screen. */
export function recordWeaponUse(save: ISaveStore, weaponId: string): void {
  if (!/^[a-z0-9-]{1,32}$/.test(weaponId)) return;
  const current = save.load();
  const previous = current.records.weaponUses[weaponId] ?? 0;
  const next = previous >= MAX_SAVE_COUNT ? MAX_SAVE_COUNT : previous + 1;
  save.save({
    version: 2,
    settings: current.settings,
    records: {
      matches: current.records.matches,
      wins: current.records.wins,
      weaponUses: { ...current.records.weaponUses, [weaponId]: next },
      bestPaintCells: current.records.bestPaintCells,
    },
    last: current.last,
  });
}

function saveCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_SAVE_COUNT, Math.round(value));
}

/**
 * Writes every match record exactly once, at the end of the match. Training
 * never calls this. The result screen only reads the save.
 */
export function recordMatchResult(
  save: ISaveStore,
  weaponId: string,
  localId: EntityId,
  result: MatchResult,
): void {
  const current = save.load();
  let localPaint = 0;
  let localTeam: TeamId | null = null;
  for (const player of result.players) {
    if (player.id === localId) {
      localPaint = saveCount(player.paintCells);
      localTeam = player.team;
      break;
    }
  }
  const won = result.winner !== null && localTeam !== null && result.winner === localTeam;
  const matches = Math.min(MAX_SAVE_COUNT, saveCount(current.records.matches) + 1);
  const wins = Math.min(
    MAX_SAVE_COUNT,
    saveCount(current.records.wins) + (won ? 1 : 0),
  );
  const bestPaintCells = Math.max(saveCount(current.records.bestPaintCells), localPaint);
  let weaponUses = current.records.weaponUses;
  if (/^[a-z0-9-]{1,32}$/.test(weaponId)) {
    const previous = weaponUses[weaponId] ?? 0;
    const next = previous >= MAX_SAVE_COUNT ? MAX_SAVE_COUNT : previous + 1;
    weaponUses = { ...weaponUses, [weaponId]: next };
  }
  save.save({
    version: 2,
    settings: current.settings,
    records: { matches, wins, weaponUses, bestPaintCells },
    last: current.last,
  });
}

/** The urgent phase family shares one track; a special ending restores this. */
export function bgmTrackForPhase(phase: MatchPhase, fallback: string): string {
  if (phase === 'lastMinute' || phase === 'countdown' || phase === 'finished') {
    return 'lastMinute';
  }
  return fallback;
}

/** The settle window keeps ticking even while a pause overlay is shown. */
export function shouldStepMatch(paused: boolean, phase: MatchPhase): boolean {
  return !paused || phase === 'finished';
}

/** Touch-look speed derived from the same setting as the stick, kept finite. */
export function touchLookSensitivity(stickSensitivity: number): number {
  const value = Number.isFinite(stickSensitivity) && stickSensitivity > 0 ? stickSensitivity : 0;
  return Math.min(0.05, Math.max(0.0001, value * TOUCH_LOOK_SCALE));
}

/** True when the primary pointer can hover and click precisely (a mouse). */
export function detectFinePointer(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const query = window.matchMedia('(pointer: fine)');
      return query.matches === true;
    }
  } catch {
    // Fall through to the touch-capability guess.
  }
  return !(typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
}

function matchDuration(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(300, Math.max(60, Math.round(value)));
}

function aiFor(difficulty: Difficulty, profiles: AiProfiles) {
  switch (difficulty) {
    case 'easy':
      return profiles.easy;
    case 'hard':
      return profiles.hard;
    case 'normal':
    default:
      return profiles.normal;
  }
}

function findLocal(players: readonly PlayerView[]): PlayerView | null {
  for (const player of players) {
    if (player.id === LOCAL_PLAYER_ID) return player;
  }
  return null;
}

function tunable(
  cfg: PlayerConfig,
  key: keyof PlayerConfig & string,
  label: string,
  min: number,
  max: number,
  step: number,
): DebugParam {
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

/* ---------- public surface ---------- */

export interface MatchRunnerDeps {
  canvas: HTMLCanvasElement;
  /** Host for the HUD, touch controls and debug panel, usually #ui. */
  root: HTMLElement;
  save: ISaveStore;
  audio: IAudio;
  go(id: ScreenId, params?: ScreenParams): void;
  /** Test seam; defaults to crypto.getRandomValues. */
  createSeed?: () => number;
  /** Test seams for the GPU renderer and the simulation. */
  createRenderer?: (options: Parameters<typeof createThreeRenderer>[0]) => IRenderer;
  createSim?: (options: Parameters<typeof createSimulation>[0]) => ReturnType<typeof createSimulation>;
  /** Test seam; defaults to the matchMedia pointer query. */
  isFinePointer?: () => boolean;
}

export interface MatchRunner {
  /** Starts a match or training session, replacing any session already running. */
  start(setup: MatchSetup | 'training'): void;
  /** Tears the current session down without navigating anywhere. */
  dispose(): void;
}

/**
 * Owns one live match at a time: simulation, renderer, HUD, input, pause and
 * records. Navigation is injected so the runner never touches the router.
 */
export function createMatchRunner(deps: MatchRunnerDeps): MatchRunner {
  let cleanupCurrent: (() => void) | null = null;

  const disposeCurrent = (): void => {
    const cleanup = cleanupCurrent;
    cleanupCurrent = null;
    cleanup?.();
  };

  const start = (setup: MatchSetup | 'training'): void => {
    disposeCurrent();

    const data = deps.save.load();
    const training = setup === 'training';
    const stageId = training ? DEFAULT_STAGE_ID : resolveStageId(setup.stageId);
    const stageFile = STAGE_FILES.get(stageId) ?? STAGE_FILES.get(DEFAULT_STAGE_ID);
    const decorFile = DECOR_FILES.get(stageId) ?? DECOR_FILES.get(DEFAULT_STAGE_ID);
    if (stageFile === undefined || decorFile === undefined) {
      throw new Error('stage data is missing');
    }

    const stage = parseStage(stageFile);
    const weapons = parseWeapons(weaponsJson);
    const selectedWeapon = resolveWeapon(
      weapons,
      training ? DEFAULT_WEAPON_ID : setup.weaponId,
    );
    const playerConfig = parsePlayerConfig(playerJson);
    const sub = parseSub(subJson);
    const special = parseSpecial(specialJson);
    const profiles = parseAi(aiJson);
    const baseMatch = parseMatchConfig(matchJson);
    const match: MatchConfig = training
      ? baseMatch
      : {
          ...baseMatch,
          durationSeconds: matchDuration(setup.durationSeconds, baseMatch.durationSeconds),
        };
    const difficulty: Difficulty = training ? 'normal' : setup.difficulty;
    const ai = aiFor(difficulty, profiles);

    const seed =
      deps.createSeed !== undefined ? deps.createSeed() : createMatchSeed();
    const safeSeed = Number.isFinite(seed) ? seed >>> 0 : 0;
    const teams = pickTeams(safeSeed, data.settings.colorblind);
    const roster = training
      ? buildTrainingRoster(LOCAL_PLAYER_ID, selectedWeapon.id)
      : buildRoster({
          localId: LOCAL_PLAYER_ID,
          localWeaponId: selectedWeapon.id,
          teamSize: match.teamSize,
          weapons,
          seed: safeSeed,
        });

    const sim = (deps.createSim ?? createSimulation)({
      stage,
      weapons,
      sub,
      special,
      player: playerConfig,
      match,
      ai,
      roster,
      seed: safeSeed,
      mode: training ? 'training' : 'match',
    });

    const canvas = deps.canvas;
    const root = deps.root;
    const audio = deps.audio;

    const renderer: IRenderer = (deps.createRenderer ?? createThreeRenderer)({
      canvas,
      stage,
      paint: sim.paint,
      collision: sim.collision,
      teamColors: [teams[0].color, teams[1].color],
      localPlayerId: LOCAL_PLAYER_ID,
      decor: decorFile,
      quality: data.settings.quality,
    });

    const hud: Hud = createHud(root);
    hud.setTeams(teams);

    let debugPanel: DebugPanel | null = null;
    if (import.meta.env.DEV) {
      debugPanel = createDebugPanel(root, [
        tunable(playerConfig, 'walkSpeed', 'あるきのはやさ', 2, 12, 0.1),
        tunable(playerConfig, 'diveSpeed', 'せんとんのはやさ', 4, 16, 0.1),
        tunable(playerConfig, 'enemyInkSpeed', 'てきインクのはやさ', 1, 6, 0.1),
        tunable(playerConfig, 'jumpSpeed', 'ジャンプのはやさ', 3, 12, 0.1),
        tunable(playerConfig, 'gravity', 'じゅうりょく', 8, 40, 0.5),
        tunable(playerConfig, 'acceleration', 'かそくど', 10, 120, 1),
        tunable(playerConfig, 'wallClimbSpeed', 'かべのぼり', 1, 10, 0.1),
        tunable(playerConfig, 'inkRegenDive', 'せんとんかいふく', 5, 80, 1),
      ]);
    }

    const finePointer = (deps.isFinePointer ?? detectFinePointer)();
    const touchCapable =
      typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
    // A hybrid laptop starts in mouse mode; touch controls appear on the first
    // real touch. A coarse-only device starts with them already visible.
    let touchEnabled = !finePointer;
    let touch: ITouchControls | null = null;
    if (touchCapable || !finePointer) {
      touch = createTouchControls({
        layout: data.settings.touchLayout,
        lookSensitivity: touchLookSensitivity(data.settings.stickSensitivity),
      });
      touch.mount(root);
      touch.setVisible(touchEnabled);
    }

    const syncTouch = (): void => {
      touch?.setVisible(touchEnabled && !paused);
    };

    const inputDeps = {
      keyboardTarget: window,
      pointerTarget: canvas,
      getGamepads: () => navigator.getGamepads(),
      isPointerLocked: () => document.pointerLockElement === canvas,
      bindings: data.settings.keys,
      sensitivity: {
        mouse: data.settings.mouseSensitivity,
        stick: data.settings.stickSensitivity,
        invertY: data.settings.invertY,
      },
    };
    const inputDepsWithTouch =
      touch === null ? inputDeps : { ...inputDeps, touch };
    const input: IInputSource = createInputManager(inputDepsWithTouch);

    let paused = false;
    let pauseHeld = false;
    let resumeJumpHeld = false;
    let resumeDiveHeld = false;
    let gamepadLost = false;
    let accumulator = 0;
    let lastTime = 0;
    let ended = false;
    let rafId = 0;
    let cleaned = false;
    let currentPhase: MatchPhase = 'play';
    let specialBgmActive = false;

    let prev: WorldSnapshot = sim.snapshot();
    let curr: WorldSnapshot = prev;

    const releaseLock = (): void => {
      try {
        document.exitPointerLock();
      } catch {
        // The browser may already have released the lock.
      }
    };

    const requestLock = (): void => {
      if (!finePointer || ended) return;
      let pending: unknown;
      try {
        pending = canvas.requestPointerLock();
      } catch {
        return;
      }
      if (typeof pending !== 'object' || pending === null) return;
      const thenFn = Reflect.get(pending, 'then');
      if (typeof thenFn !== 'function') return;
      // A stale request must not land on the result screen (D6).
      Reflect.apply(thenFn, pending, [
        () => {
          if (ended) releaseLock();
        },
        () => undefined,
      ]);
    };

    const setPaused = (value: boolean, reason?: string): void => {
      if (paused === value) return;
      paused = value;
      if (value) {
        // Pointer lock routes every click to the canvas, so the overlay buttons
        // would be unreachable while it stays held.
        releaseLock();
      }
      hud.showPaused(value, reason);
      // Key releases can be lost while pointer lock exits, so never carry held keys across.
      input.reset();
      accumulator = 0;
      resumeJumpHeld = false;
      resumeDiveHeld = false;
      syncTouch();
    };

    hud.onResume(() => {
      setPaused(false);
      requestLock();
    });
    hud.onQuit(() => {
      quit();
    });
    hud.onStart(() => {
      requestLock();
    });

    const resize = (): void => {
      renderer.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio, 2));
    };
    window.addEventListener('resize', resize);
    resize();

    const onCanvasClick = (): void => {
      if (ended) return;
      hud.showStartGate(false);
      if (finePointer && document.pointerLockElement !== canvas) requestLock();
      if (paused) setPaused(false);
    };
    canvas.addEventListener('click', onCanvasClick);

    const onPointerLockChange = (): void => {
      if (ended || !finePointer) return;
      if (document.pointerLockElement === canvas) {
        hud.showStartGate(false);
        return;
      }
      setPaused(true, 'マウスのこていがはずれたよ');
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);

    const onPointerDown = (event: PointerEvent): void => {
      if (ended) return;
      if (event.pointerType === 'touch') {
        if (!touchEnabled) {
          touchEnabled = true;
          hud.showStartGate(false);
          syncTouch();
        }
        return;
      }
      if (event.pointerType === 'mouse' && finePointer && touchEnabled) {
        touchEnabled = false;
        syncTouch();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);

    const onVisibilityChange = (): void => {
      if (ended) return;
      if (document.hidden) setPaused(true, 'がめんをはなれたよ');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const onGamepadDisconnected = (): void => {
      if (ended) return;
      gamepadLost = true;
      setPaused(true, 'コントローラーが はずれたよ');
      // The reason must update even when the overlay was already visible.
      hud.showPaused(true, 'コントローラーが はずれたよ');
    };
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

    const onGamepadConnected = (): void => {
      if (ended || !gamepadLost) return;
      gamepadLost = false;
      if (paused) {
        hud.showPaused(true, 'コントローラーが もどったよ。つづける？');
      } else {
        setPaused(false);
      }
    };
    window.addEventListener('gamepadconnected', onGamepadConnected);

    const cleanup = (silenceMusic: boolean): void => {
      if (cleaned) return;
      cleaned = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      window.removeEventListener('gamepadconnected', onGamepadConnected);
      window.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas.removeEventListener('click', onCanvasClick);
      // Always release, even a request that resolved a moment ago: the result
      // screen must never appear with a hidden cursor (D6).
      if (finePointer) releaseLock();
      if (silenceMusic) audio.setBgm(null);
      debugPanel?.dispose();
      debugPanel = null;
      touch?.dispose();
      touch = null;
      input.dispose();
      hud.dispose();
      renderer.dispose();
    };

    const stop = (): void => {
      if (ended) return;
      ended = true;
      cleanup(true);
    };

    const quit = (): void => {
      if (ended) return;
      ended = true;
      cleanup(true);
      deps.go('menu');
    };

    const finish = (result: MatchResult): void => {
      if (ended) return;
      ended = true;
      // One save at the end of the match; the result screen only reads it (D9).
      if (!training) {
        recordMatchResult(deps.save, selectedWeapon.id, LOCAL_PLAYER_ID, result);
      }
      // The result screen sets win/lose itself, so leave the match music alone.
      cleanup(false);
      deps.go('result', resultScreenParams(result, teams));
    };

    const inputMap = new Map<EntityId, InputActions>();
    const totalCells = sim.paint.totalCells();

    const dispatch = (events: readonly GameEvent[], listener: Vec3): void => {
      for (const event of events) {
        audio.handle(event, listener, LOCAL_PLAYER_ID);
        renderer.handle(event);

        if (event.t === 'voice') {
          if (event.line === 'start') hud.banner('いざ、まいる！');
          else if (event.line === 'lastMinute') hud.banner('ときはきた！');
        } else if (event.t === 'kill') {
          const line = killLogLine(event.killer, event.victim, LOCAL_PLAYER_ID);
          if (line !== null) hud.log(line);
        } else if (event.t === 'phase') {
          currentPhase = event.phase;
          // A running special owns the music until it ends (D3).
          if (
            !specialBgmActive &&
            (event.phase === 'lastMinute' || event.phase === 'countdown')
          ) {
            audio.setBgm(bgmTrackForPhase(event.phase, stage.bgm));
          }
        } else if (event.t === 'special' && event.id === LOCAL_PLAYER_ID) {
          if (event.phase === 'start') {
            specialBgmActive = true;
            audio.setBgm(special.bgmId);
          } else if (event.phase === 'end') {
            specialBgmActive = false;
            // lastMinute and countdown both mean the urgent track (D4).
            audio.setBgm(bgmTrackForPhase(currentPhase, stage.bgm));
          }
        }
      }
    };

    const frame = (time: number): void => {
      if (ended) return;
      rafId = requestAnimationFrame(frame);

      const delta = frameDeltaSeconds(time, lastTime);
      lastTime = time;

      if (paused) {
        const actions = input.poll();
        if (actions.pause && !pauseHeld && input.lastDevice() === 'gamepad') {
          setPaused(false);
          requestLock();
          return;
        }
        if (actions.jump && !resumeJumpHeld) {
          // Gamepad A (or Space) resumes.
          setPaused(false);
          requestLock();
          return;
        }
        if (actions.dive && !resumeDiveHeld) {
          // Gamepad B (or Shift) leaves the match.
          quit();
          return;
        }
        pauseHeld = actions.pause;
        resumeJumpHeld = actions.jump;
        resumeDiveHeld = actions.dive;
      }

      if (shouldStepMatch(paused, curr.phase)) {
        accumulator += delta;
        let steps = 0;
        while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
          const actions = paused ? emptyActions() : input.poll();
          if (!paused) {
            if (actions.pause && !pauseHeld) setPaused(true, 'ポーズボタンをおしたよ');
            pauseHeld = actions.pause;
          }

          prev = curr;
          inputMap.clear();
          inputMap.set(LOCAL_PLAYER_ID, actions);
          const events = sim.step(inputMap);
          curr = sim.snapshot();
          const me = findLocal(curr.players);
          dispatch(events, me?.pos ?? ZERO_POS);

          accumulator = Math.max(0, accumulator - FIXED_DT);
          steps += 1;

          const result = sim.result();
          if (result !== null) {
            finish(result);
            return;
          }
        }
        if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
      }

      const alpha = Math.min(Math.max(accumulator / FIXED_DT, 0), 1);
      renderer.render(prev, curr, alpha, LOCAL_PLAYER_ID);
      const me = findLocal(curr.players);
      if (me !== null) hud.update(me, curr, totalCells);
    };

    cleanupCurrent = () => {
      stop();
    };

    audio.setBgm(stage.bgm);
    // No pointer lock here: start() runs from a timer, not a user gesture (D5).
    hud.showStartGate(finePointer && !touchEnabled);
    rafId = requestAnimationFrame(frame);
  };

  return {
    start,
    dispose: () => {
      disposeCurrent();
    },
  };
}
