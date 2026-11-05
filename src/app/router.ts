import type {
  IScreen,
  ScreenContext,
  ScreenId,
  ScreenParams,
} from '../engine/ports';

/** Navigation handles given to the context factory. */
export interface RouterNav {
  go(id: ScreenId, params?: ScreenParams): void;
  /** Returns to the single previous screen, if there is one. */
  back(): void;
}

/**
 * Everything a screen needs except navigation, which the router owns. The app
 * supplies save, audio and start here.
 */
export type RouterContextFactory = (nav: RouterNav) => Omit<ScreenContext, 'go' | 'back'>;

export interface Router extends RouterNav {
  /** The screen currently mounted, or null before the first go. */
  current(): ScreenId | null;
  /** Unmounts the current screen and forgets the history, e.g. when a match starts. */
  clear(): void;
}

interface Entry {
  id: ScreenId;
  params: ScreenParams;
}

const NONE: ScreenParams = { kind: 'none' };

/**
 * Mounts one screen at a time under `root`. Only the immediately previous
 * screen is remembered, so back() always steps exactly one navigation back.
 * Screens are unmounted before the next one mounts, which keeps their DOM and
 * listeners from overlapping.
 */
export function createRouter(
  root: HTMLElement,
  screens: Record<ScreenId, IScreen>,
  ctxFactory: RouterContextFactory,
): Router {
  let current: Entry | null = null;
  let previous: Entry | null = null;

  const unmountEntry = (entry: Entry): void => {
    const screen = screens[entry.id];
    if (screen === undefined) return;
    screen.unmount();
  };

  const mountEntry = (entry: Entry): void => {
    const screen = screens[entry.id];
    if (screen === undefined) return;
    const leaving = current;
    if (leaving !== null) {
      previous = { id: leaving.id, params: leaving.params };
      unmountEntry(leaving);
    }
    current = entry;
    // A screen may navigate while mounting (for example a bad result payload).
    // The nested navigation unmounts `entry` through mountEntry/back, so no
    // extra cleanup is needed here.
    screen.mount(root, context, entry.params);
  };

  const go = (id: ScreenId, params: ScreenParams = NONE): void => {
    if (screens[id] === undefined) return;
    mountEntry({ id, params });
  };

  const back = (): void => {
    if (previous === null) return;
    const target = previous;
    const leaving = current;
    previous = null;
    if (leaving !== null) unmountEntry(leaving);
    current = target;
    const screen = screens[target.id];
    if (screen === undefined) {
      current = null;
      return;
    }
    screen.mount(root, context, target.params);
  };

  const clear = (): void => {
    if (current !== null) unmountEntry(current);
    current = null;
    previous = null;
  };

  const nav: RouterNav = { go, back };
  const context: ScreenContext = { ...ctxFactory(nav), go, back };

  return {
    go,
    back,
    current: () => current?.id ?? null,
    clear,
  };
}
