// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchResult } from '../../game/contracts';
import type { SaveData } from '../../game/data/schemas';
import type { IScreen, MatchSetup, ScreenContext, ScreenId, ScreenParams, TeamLabel } from '../../engine/ports';
import { createBootScreen } from './boot';
import { createCreditsScreen } from './credits';
import { createScreens } from './index';
import { createLoadingScreen } from './loading';
import { createMenuScreen } from './menu';
import { createResultScreen } from './result';
import { createSetupScreen } from './setup';
import { createTitleScreen } from './title';

const roots: HTMLElement[] = [];

interface GoCall {
  id: ScreenId;
  params: ScreenParams | undefined;
}

interface HarnessState {
  data: SaveData;
  okSounds: number;
  unlocks: number;
  backs: number;
}

interface Harness {
  ctx: ScreenContext;
  go: GoCall[];
  starts: Array<MatchSetup | 'training'>;
  bgm: Array<string | null>;
  saved: SaveData[];
  state: HarnessState;
}

function makeSaveData(): SaveData {
  return {
    version: 2,
    settings: {
      volume: { bgm: 0.8, se: 0.8, voice: 0.8 },
      mouseSensitivity: 0.001745,
      stickSensitivity: 2.094,
      invertY: false,
      keys: {
        forward: 'KeyW',
        back: 'KeyS',
        left: 'KeyA',
        right: 'KeyD',
        fire: 'Mouse0',
        jump: 'Space',
        dive: 'ShiftLeft',
        sub: 'KeyE',
        special: 'KeyQ',
        pause: 'Escape',
      },
      gyro: false,
      quality: 'auto',
      colorblind: false,
      touchLayout: { scale: 1, offsetX: 0, offsetY: 0 },
    },
    records: {
      matches: 3,
      wins: 1,
      weaponUses: { 'iro-shuriken': 2 },
      bestPaintCells: 500,
    },
    last: {
      weaponId: 'oofude',
      stageId: 'karakuri-port',
      difficulty: 'hard',
      durationSeconds: 120,
    },
  };
}

function harness(initial: SaveData = makeSaveData()): Harness {
  const state: HarnessState = { data: initial, okSounds: 0, unlocks: 0, backs: 0 };
  const go: GoCall[] = [];
  const starts: Array<MatchSetup | 'training'> = [];
  const bgm: Array<string | null> = [];
  const saved: SaveData[] = [];

  const ctx: ScreenContext = {
    save: {
      load: () => state.data,
      save: (next) => {
        saved.push(next);
        state.data = next;
        return true;
      },
    },
    audio: {
      unlock: () => {
        state.unlocks += 1;
        return Promise.resolve();
      },
      handle: (event) => {
        if (event.t === 'ui' && event.kind === 'ok') state.okSounds += 1;
      },
      setBgm: (id) => {
        bgm.push(id);
      },
      setVolumes: () => {
        /* not used by screens */
      },
    },
    go: (id, params) => {
      go.push({ id, params });
    },
    start: (setup) => {
      starts.push(setup);
    },
    back: () => {
      state.backs += 1;
    },
  };

  return { ctx, go, starts, bgm, saved, state };
}

function mount(screen: IScreen, ctx: ScreenContext, params: ScreenParams = { kind: 'none' }): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  screen.mount(root, ctx, params);
  return root;
}

function buttons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
}

function findButton(root: HTMLElement, text: string): HTMLButtonElement {
  const found = buttons(root).find((button) => (button.textContent ?? '').includes(text));
  expect(found, `missing button ${text}`).toBeDefined();
  if (found === undefined) throw new Error(`missing button ${text}`);
  return found;
}

function choice(root: HTMLElement, value: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`.pr-choice[data-value="${value}"]`);
  expect(found, `missing choice ${value}`).not.toBeNull();
  if (found === null) throw new Error(`missing choice ${value}`);
  return found;
}

function find(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  expect(found, `missing ${selector}`).not.toBeNull();
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

function rubyReading(host: HTMLElement, selector: string): string | null {
  const target = selector === '' ? 'rt' : `${selector} rt`;
  return host.querySelector(target)?.textContent ?? null;
}

function matchResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    winner: 0,
    ratio: [62.5, 37.5],
    players: [
      { id: 1, team: 0, paintCells: 1234, kills: 5, deaths: 2 },
      { id: 2, team: 1, paintCells: 700, kills: 3, deaths: 4 },
    ],
    ...overrides,
  };
}

const SETUP: MatchSetup = {
  weaponId: 'iro-shuriken',
  stageId: 'neon-town',
  difficulty: 'normal',
  durationSeconds: 180,
};

const TEAMS: readonly [TeamLabel, TeamLabel] = [
  { name: '朱雀', reading: 'すざく', color: 0xff8a1f },
  { name: '青龍', reading: 'せいりゅう', color: 0x2e7bff },
];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots) root.remove();
  roots.length = 0;
  vi.restoreAllMocks();
});

describe('createScreens', () => {
  it('provides every screen except settings', () => {
    const screens = createScreens();
    expect(Object.keys(screens).sort()).toEqual(['boot', 'credits', 'loading', 'menu', 'result', 'setup', 'title']);
    expect('settings' in screens).toBe(false);
  });

  it('mounts and unmounts each screen without leaving nodes behind', () => {
    const screens = createScreens();
    const h = harness();
    const ids: Array<Exclude<ScreenId, 'settings'>> = ['boot', 'title', 'menu', 'setup', 'loading', 'result', 'credits'];

    for (const id of ids) {
      const params: ScreenParams =
        id === 'loading'
          ? { kind: 'loading', setup: SETUP }
          : id === 'result'
            ? { kind: 'result', result: matchResult(), localId: 1, teams: TEAMS }
            : { kind: 'none' };
      const screen = screens[id];
      const root = mount(screen, h.ctx, params);
      expect(root.childElementCount, id).toBe(1);
      screen.unmount();
      expect(root.childElementCount, id).toBe(0);
    }
  });
});

describe('boot screen', () => {
  it('unlocks audio, plays the ok sound and goes to the title', () => {
    const h = harness();
    const screen = createBootScreen();
    const root = mount(screen, h.ctx);

    findButton(root, 'タップしてスタート').click();

    expect(h.state.unlocks).toBe(1);
    expect(h.go).toEqual([{ id: 'title', params: undefined }]);
    expect(h.state.okSounds).toBe(1);
    screen.unmount();
    expect(root.childElementCount).toBe(0);
  });

  it('acts only once on repeated taps', () => {
    const h = harness();
    const screen = createBootScreen();
    const root = mount(screen, h.ctx);

    const start = findButton(root, 'タップしてスタート');
    start.click();
    start.click();

    expect(h.state.unlocks).toBe(1);
    expect(h.go).toHaveLength(1);
    expect(h.state.okSounds).toBe(1);
    screen.unmount();
  });
});

describe('title screen', () => {
  it('starts title music and opens the menu', () => {
    const h = harness();
    const screen = createTitleScreen();
    const root = mount(screen, h.ctx);

    expect(h.bgm).toEqual(['title']);
    const start = findButton(root, 'いざ、まいる！');
    start.click();
    expect(h.go).toEqual([{ id: 'menu', params: undefined }]);
    expect(h.state.okSounds).toBe(1);

    screen.unmount();
    expect(root.childElementCount).toBe(0);
    start.click();
    expect(h.go).toHaveLength(1);
  });
});

describe('menu screen', () => {
  it('shows ruby readings for the Japanese mode names', () => {
    const h = harness();
    const screen = createMenuScreen();
    const root = mount(screen, h.ctx);

    expect(rubyReading(root, '.pr-menu__button--battle')).toBe('いろどりがっせん');
    expect(rubyReading(root, '.pr-menu__button--training')).toBe('しゅぎょうば');
    expect(root.querySelectorAll('ruby')).toHaveLength(2);
    screen.unmount();
  });

  it('navigates to setup, training, settings and credits', () => {
    const h = harness();
    const screen = createMenuScreen();
    const root = mount(screen, h.ctx);

    findButton(root, '色取り合戦').click();
    findButton(root, '修行場').click();
    findButton(root, 'せってい').click();
    findButton(root, 'クレジット').click();

    expect(h.go.map((call) => call.id)).toEqual(['setup', 'loading', 'settings', 'credits']);
    expect(h.go[1]?.params).toEqual({ kind: 'loading', setup: 'training' });
    expect(h.state.okSounds).toBe(4);
    expect(h.bgm).toEqual(['title']);
    screen.unmount();
  });

  it('uses the title track on menu, setup and credits', () => {
    const h = harness();
    for (const screen of [createMenuScreen(), createSetupScreen(), createCreditsScreen()]) {
      screen.mount(document.createElement('div'), h.ctx, { kind: 'none' });
      screen.unmount();
    }
    expect(h.bgm).toEqual(['title', 'title', 'title']);
  });
});

describe('setup screen', () => {
  it('prefills from the saved last choices and shows ruby for stage and weapon names', () => {
    const h = harness();
    const screen = createSetupScreen();
    const root = mount(screen, h.ctx);

    const selected = Array.from(root.querySelectorAll<HTMLButtonElement>('.pr-choice.is-selected')).map(
      (button) => button.dataset.value,
    );
    expect(selected.sort()).toEqual(['120', 'hard', 'karakuri-port', 'oofude']);

    expect(rubyReading(choice(root, 'neon-town'), '')).toBe('じょうかまち');
    expect(rubyReading(choice(root, 'karakuri-port'), '')).toBe('みなと');
    expect(rubyReading(choice(root, 'iro-shuriken'), '')).toBe('いろしゅりけん');
    expect(rubyReading(choice(root, 'oofude'), '')).toBe('おおふで');
    expect(rubyReading(choice(root, 'naga-fukiya'), '')).toBe('ながふきや');
    screen.unmount();
  });

  it('saves the chosen last setup and opens loading with it', () => {
    const h = harness();
    const screen = createSetupScreen();
    const root = mount(screen, h.ctx);

    choice(root, 'neon-town').click();
    choice(root, 'iro-shuriken').click();
    choice(root, 'easy').click();
    choice(root, '60').click();
    expect(h.saved).toHaveLength(0);

    findButton(root, 'はじめる').click();

    const saved = h.saved[0];
    expect(saved).toBeDefined();
    expect(saved?.last).toEqual({
      weaponId: 'iro-shuriken',
      stageId: 'neon-town',
      difficulty: 'easy',
      durationSeconds: 60,
    });
    expect(saved?.records).toEqual(makeSaveData().records);
    expect(saved?.settings).toEqual(makeSaveData().settings);
    expect(h.go).toEqual([
      {
        id: 'loading',
        params: {
          kind: 'loading',
          setup: { weaponId: 'iro-shuriken', stageId: 'neon-town', difficulty: 'easy', durationSeconds: 60 },
        },
      },
    ]);
    expect(h.state.okSounds).toBe(5);
    screen.unmount();
  });

  it('falls back to safe defaults when the saved choices are unknown', () => {
    const data = makeSaveData();
    data.last = { weaponId: 'unknown', stageId: 'moon', difficulty: 'normal', durationSeconds: 90 };
    const h = harness(data);
    const screen = createSetupScreen();
    const root = mount(screen, h.ctx);

    const selected = Array.from(root.querySelectorAll<HTMLButtonElement>('.pr-choice.is-selected')).map(
      (button) => button.dataset.value,
    );
    expect(selected.sort()).toEqual(['60', 'iro-shuriken', 'neon-town', 'normal']);
    screen.unmount();
  });
});

describe('loading screen', () => {
  it('starts the match after 800ms and clears its timer on unmount', () => {
    vi.useFakeTimers();
    const h = harness();
    const screen = createLoadingScreen();
    const root = mount(screen, h.ctx, { kind: 'loading', setup: SETUP });

    expect(find(root, '.pr-loading__drop')).not.toBeNull();
    expect(root.textContent).toContain('もうすぐ はじまるよ！');
    vi.advanceTimersByTime(799);
    expect(h.starts).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.starts).toEqual([SETUP]);

    screen.unmount();
    expect(root.childElementCount).toBe(0);
  });

  it('does not start when unmounted before the delay ends', () => {
    vi.useFakeTimers();
    const h = harness();
    const screen = createLoadingScreen();
    const root = mount(screen, h.ctx, { kind: 'loading', setup: 'training' });

    vi.advanceTimersByTime(400);
    screen.unmount();
    vi.advanceTimersByTime(1000);
    expect(h.starts).toHaveLength(0);
    expect(root.childElementCount).toBe(0);
  });

  it('shows a kana hint for the current device', () => {
    const h = harness();
    const screen = createLoadingScreen();
    const root = mount(screen, h.ctx, { kind: 'loading', setup: SETUP });

    const controls = find(root, '.pr-loading__controls');
    expect(controls.textContent).toContain('あそぶよ');
    expect(controls.textContent).not.toMatch(/[A-Za-z]/);
    screen.unmount();
  });
});

describe('result screen', () => {
  it('shows a win, the local paint and kills, and leaves records to the runner', () => {
    const h = harness();
    const screen = createResultScreen();
    const root = mount(screen, h.ctx, { kind: 'result', result: matchResult(), localId: 1, teams: TEAMS });

    expect(find(root, '.pr-result__verdict').textContent).toBe('かち！');
    expect(find(root, '.pr-result__paint').textContent).toBe('1234');
    expect(find(root, '.pr-result__kills').textContent).toBe('5');
    expect(find(root, '.pr-result__bar').style.getPropertyValue('--pr-ratio-0')).toBe('62.5%');
    expect(find(root, '.pr-result__bar').style.getPropertyValue('--pr-ratio-1')).toBe('37.5%');
    expect(root.querySelector('.pr-confetti')).not.toBeNull();
    expect(h.bgm).toEqual(['win']);
    // Records are written once at match end by the runner (D9).
    expect(h.saved).toHaveLength(0);

    screen.unmount();
    expect(root.childElementCount).toBe(0);
  });

  it('shows a loss without touching the save and plays the lose music', () => {
    const h = harness();
    const screen = createResultScreen();
    const root = mount(screen, h.ctx, {
      kind: 'result',
      result: matchResult({ winner: 1 }),
      localId: 1,
      teams: TEAMS,
    });

    expect(find(root, '.pr-result__verdict').textContent).toBe('まけ…');
    expect(h.bgm).toEqual(['lose']);
    expect(h.saved).toHaveLength(0);
    expect(root.querySelector('.pr-confetti')).toBeNull();
    screen.unmount();
  });

  it('shows a draw with the calm track instead of the victory jingle', () => {
    const h = harness();
    const screen = createResultScreen();
    const root = mount(screen, h.ctx, {
      kind: 'result',
      result: matchResult({ winner: null }),
      localId: 1,
      teams: TEAMS,
    });

    expect(find(root, '.pr-result__verdict').textContent).toBe('ひきわけ');
    expect(h.bgm).toEqual(['title']);
    expect(h.saved).toHaveLength(0);
    screen.unmount();
  });

  it('navigates to setup and menu from the action buttons', () => {
    const h = harness();
    const screen = createResultScreen();
    const root = mount(screen, h.ctx, { kind: 'result', result: matchResult(), localId: 1, teams: TEAMS });

    findButton(root, 'もういっかい').click();
    findButton(root, 'メニューへ').click();

    expect(h.go.map((call) => call.id)).toEqual(['setup', 'menu']);
    expect(h.state.okSounds).toBe(2);
    screen.unmount();
  });

  it('shows the teams chosen for the match with ruby and their own colours', () => {
    const h = harness();
    const screen = createResultScreen();
    const root = mount(screen, h.ctx, { kind: 'result', result: matchResult(), localId: 1, teams: TEAMS });

    const left = find(root, '.pr-result__team--0');
    const right = find(root, '.pr-result__team--1');

    expect(left.querySelector('.pr-ruby__base')?.textContent).toBe('朱雀');
    expect(rubyReading(left, '')).toBe('すざく');
    expect(right.querySelector('.pr-ruby__base')?.textContent).toBe('青龍');
    expect(rubyReading(right, '')).toBe('せいりゅう');
    expect(left.textContent).toContain('62.5%');
    expect(right.textContent).toContain('37.5%');

    expect(left.style.getPropertyValue('color')).toBe('#ff8a1f');
    expect(right.style.getPropertyValue('color')).toBe('#2e7bff');
    expect(left.style.getPropertyValue('--pr-team-color')).toBe('#ff8a1f');
    expect(right.style.getPropertyValue('--pr-team-color')).toBe('#2e7bff');

    expect(find(root, '.pr-result__fill--0').style.getPropertyValue('background')).toContain('#ff8a1f');
    expect(find(root, '.pr-result__fill--1').style.getPropertyValue('background')).toContain('#2e7bff');
    expect(find(root, '.pr-result__bar').getAttribute('aria-label')).toBe('朱雀 62.5%、青龍 37.5%');

    // The old fixed names must not survive alongside the real teams.
    expect(root.textContent).not.toContain('ピンク');
    expect(root.textContent).not.toContain('みずいろ');
    screen.unmount();
  });

  it('keeps team labels and colours safe when the payload is hostile', () => {
    const h = harness();
    const screen = createResultScreen();
    const hostile: readonly [TeamLabel, TeamLabel] = [
      { name: '  ', reading: '', color: Number.NaN },
      { name: '青龍', reading: 'せいりゅう', color: 0x1ffffff },
    ];
    const root = mount(screen, h.ctx, { kind: 'result', result: matchResult(), localId: 1, teams: hostile });

    const left = find(root, '.pr-result__team--0');
    const right = find(root, '.pr-result__team--1');

    expect(left.querySelector('.pr-ruby__base')?.textContent).toBe('みかた');
    expect(rubyReading(left, '')).toBe('みかた');
    expect(left.style.getPropertyValue('color')).toBe('#ff2e88');
    expect(right.style.getPropertyValue('color')).toBe('#ffffff');
    expect(find(root, '.pr-result__fill--1').style.getPropertyValue('background')).not.toContain('NaN');
    screen.unmount();
  });

  it('keeps non-finite result numbers finite', () => {
    const h = harness();
    const screen = createResultScreen();
    const result = matchResult({
      ratio: [Number.NaN, Number.POSITIVE_INFINITY],
      players: [{ id: 1, team: 0, paintCells: Number.NaN, kills: Number.NEGATIVE_INFINITY, deaths: 0 }],
    });
    const root = mount(screen, h.ctx, { kind: 'result', result, localId: 1, teams: TEAMS });

    expect(find(root, '.pr-result__paint').textContent).toBe('0');
    expect(find(root, '.pr-result__kills').textContent).toBe('0');
    expect(find(root, '.pr-result__bar').style.getPropertyValue('--pr-ratio-0')).toBe('0%');
    expect(find(root, '.pr-result__bar').style.getPropertyValue('--pr-ratio-1')).toBe('0%');
    expect(h.saved).toHaveLength(0);
    screen.unmount();
  });
});

describe('credits screen', () => {
  it('lists the game, Apache-2.0, Three.js and zod licences, then returns to the menu', () => {
    const h = harness();
    const screen = createCreditsScreen();
    const root = mount(screen, h.ctx);

    const text = root.textContent ?? '';
    expect(text).toContain('ペイントラッシュ！');
    expect(text).toContain('Apache-2.0');
    expect(text).toContain('Three.js');
    expect(text).toContain('MIT');
    expect(text).toContain('zod');
    expect(text).toContain('すべてオリジナルのそざいです。');

    findButton(root, 'メニューへ').click();
    expect(h.go).toEqual([{ id: 'menu', params: undefined }]);
    expect(h.state.okSounds).toBe(1);
    screen.unmount();
    expect(root.childElementCount).toBe(0);
  });
});
