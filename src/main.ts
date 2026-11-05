import type { AudioContextLike } from './engine/audio/audio';
import { createAudio } from './engine/audio/audio';
import { createBgmPlayer } from './engine/audio/bgm/player';
import type { BgmAudioContext } from './engine/audio/bgm/synth';
import type { BgmSource } from './engine/ports';
import { createSaveStore } from './engine/save/saveStore';
import { registerServiceWorker } from './sw/register';
import { createMatchRunner } from './app/matchRunner';
import { createRouter, type Router } from './app/router';
import { createScreens } from './ui/screens';
import { createSettingsScreen } from './ui/screens/settings';

const SILENT_BGM: BgmSource = {
  start: () => undefined,
  stop: () => undefined,
};

/**
 * A real AudioContext always has a biquad filter, but createAudio exposes only
 * the smaller structural view. This narrows without casting.
 */
function isBgmContext(context: AudioContextLike): context is BgmAudioContext {
  return typeof Reflect.get(context, 'createBiquadFilter') === 'function';
}

/**
 * Wraps window.setInterval as the BGM scheduler's injected timer. The player
 * asks for a new timer on every tick, so a single shared interval is kept and
 * simply handed the newest callback; this avoids stacking intervals forever.
 * The returned handle exposes cancel() so the player can clear the interval
 * once every track has faded out.
 */
function createBgmTimer(): (callback: () => void, delayMs: number) => { cancel(): void } {
  let intervalId: number | null = null;
  let pending: (() => void) | null = null;
  const cancel = (): void => {
    pending = null;
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };
  return (callback, delayMs) => {
    pending = callback;
    if (intervalId === null) {
      const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 50;
      intervalId = window.setInterval(() => {
        const run = pending;
        if (run !== null) run();
      }, delay);
    }
    return { cancel };
  };
}

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

/** GitHub Pages cannot send frame-ancestors, so refuse to run inside a frame. */
function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/** CSS decides when this shows (portrait on a touch device); the DOM is always present. */
function addOrientationNotice(root: HTMLElement): void {
  const notice = document.createElement('div');
  notice.className = 'pr-orientation';
  const text = document.createElement('span');
  text.className = 'pr-orientation__text';
  text.textContent = 'よこむきにしてね';
  notice.append(text);
  root.append(notice);
}

function boot(): void {
  const canvas = requireElement('#game', HTMLCanvasElement);
  const uiRoot = requireElement('#ui', HTMLDivElement);
  addOrientationNotice(uiRoot);

  const saveStore = createSaveStore(safeStorage());
  const save = saveStore.load();
  const audio = createAudio({
    // One context for the whole session; createBgmPlayer hangs off the BGM bus.
    createContext: () => new AudioContext(),
    createBgm: (context, output) =>
      isBgmContext(context)
        ? createBgmPlayer(context, output, { setTimer: createBgmTimer() })
        : SILENT_BGM,
  });
  audio.setVolumes(save.settings.volume);

  const screens = { ...createScreens(), settings: createSettingsScreen() };

  let router: Router | null = null;

  const runner = createMatchRunner({
    canvas,
    root: uiRoot,
    save: saveStore,
    audio,
    go: (id, params) => {
      router?.go(id, params);
    },
  });

  router = createRouter(uiRoot, screens, (nav) => ({
    save: saveStore,
    audio,
    start: (setup) => {
      router?.clear();
      runner.start(setup);
    },
    go: nav.go,
    back: nav.back,
  }));

  window.addEventListener('beforeunload', () => runner.dispose());
  router.go('boot');

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void registerServiceWorker(navigator, import.meta.env.BASE_URL + 'sw.js');
  }
}

if (!isFramed()) boot();
