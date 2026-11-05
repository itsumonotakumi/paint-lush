// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IAudio,
  ISaveStore,
  IScreen,
  ScreenContext,
  ScreenId,
  ScreenParams,
} from '../engine/ports';
import { defaultSave } from '../engine/save/saveStore';
import { createRouter } from './router';

const audio: IAudio = {
  unlock: async () => undefined,
  handle: () => undefined,
  setBgm: () => undefined,
  setVolumes: () => undefined,
};

const save: ISaveStore = {
  load: () => defaultSave(),
  save: () => true,
};

function noopScreen(): IScreen {
  return {
    mount: () => undefined,
    unmount: () => undefined,
  };
}

function allScreens(overrides: Partial<Record<ScreenId, IScreen>>): Record<ScreenId, IScreen> {
  return {
    boot: noopScreen(),
    title: noopScreen(),
    menu: noopScreen(),
    setup: noopScreen(),
    loading: noopScreen(),
    result: noopScreen(),
    settings: noopScreen(),
    credits: noopScreen(),
    ...overrides,
  };
}

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('createRouter', () => {
  it('mounts the first screen with none params and exposes it as current', () => {
    const root = makeRoot();
    const mount = vi.fn();
    const ctxStart = vi.fn();
    const router = createRouter(
      root,
      allScreens({ boot: { mount, unmount: () => undefined } }),
      (nav) => ({ save, audio, start: ctxStart, ...nav }),
    );

    router.go('boot');

    expect(router.current()).toBe('boot');
    expect(mount).toHaveBeenCalledTimes(1);
    const [host, ctx, params] = mount.mock.calls[0] ?? [];
    expect(host).toBe(root);
    expect(params).toEqual({ kind: 'none' });
    expect(typeof ctx.go).toBe('function');
    expect(typeof ctx.back).toBe('function');
    expect(ctx.save).toBe(save);
  });

  it('unmounts the previous screen before mounting the next one', () => {
    const root = makeRoot();
    const order: string[] = [];

    const router = createRouter(
      root,
      allScreens({
        boot: {
          mount: () => order.push('mount:boot'),
          unmount: () => order.push('unmount:boot'),
        },
        title: {
          mount: () => order.push('mount:title'),
          unmount: () => order.push('unmount:title'),
        },
      }),
      (nav) => ({ save, audio, start: () => undefined, ...nav }),
    );

    router.go('boot');
    router.go('title');

    expect(order).toEqual(['mount:boot', 'unmount:boot', 'mount:title']);
    expect(router.current()).toBe('title');
  });

  it('remembers exactly one previous screen for back()', () => {
    const root = makeRoot();
    const order: string[] = [];
    const screen = (name: string): IScreen => ({
      mount: () => order.push(`mount:${name}`),
      unmount: () => order.push(`unmount:${name}`),
    });

    const router = createRouter(
      root,
      allScreens({ boot: screen('boot'), title: screen('title'), menu: screen('menu') }),
      (nav) => ({ save, audio, start: () => undefined, ...nav }),
    );

    router.go('boot');
    router.go('title');
    router.go('menu');
    order.length = 0;

    router.back();
    expect(router.current()).toBe('title');
    expect(order).toEqual(['unmount:menu', 'mount:title']);

    // Only one entry is kept, so a second back has nowhere to go.
    order.length = 0;
    router.back();
    expect(router.current()).toBe('title');
    expect(order).toEqual([]);
  });

  it('passes params through and lets a screen forward them with go()', () => {
    const root = makeRoot();
    const seen: ScreenParams[] = [];
    const contexts: ScreenContext[] = [];

    const router = createRouter(
      root,
      allScreens({
        loading: {
          mount: (_host, _ctx, params) => {
            seen.push(params);
          },
          unmount: () => undefined,
        },
        menu: {
          mount: (_host, ctx) => {
            contexts.push(ctx);
          },
          unmount: () => undefined,
        },
      }),
      (nav) => ({ save, audio, start: () => undefined, ...nav }),
    );

    router.go('loading', { kind: 'loading', setup: 'training' });
    router.go('menu');
    expect(seen[0]).toEqual({ kind: 'loading', setup: 'training' });

    contexts[0]?.go('loading', { kind: 'loading', setup: 'training' });
    expect(router.current()).toBe('loading');
    expect(seen[1]).toEqual({ kind: 'loading', setup: 'training' });
  });

  it('clear() removes the current screen and forgets history', () => {
    const root = makeRoot();
    const unmount = vi.fn();
    const router = createRouter(
      root,
      allScreens({
        boot: { mount: () => undefined, unmount },
        title: { mount: () => undefined, unmount: () => undefined },
      }),
      (nav) => ({ save, audio, start: () => undefined, ...nav }),
    );

    router.go('boot');
    router.go('title');
    router.clear();

    expect(unmount).toHaveBeenCalledTimes(1);
    expect(router.current()).toBeNull();
    router.back();
    expect(router.current()).toBeNull();
  });

  it('handles a screen that navigates while mounting', () => {
    const root = makeRoot();
    const order: string[] = [];
    const router = createRouter(
      root,
      allScreens({
        result: {
          mount: (_host, ctx) => {
            order.push('mount:result');
            ctx.go('menu');
          },
          unmount: () => order.push('unmount:result'),
        },
        menu: {
          mount: () => order.push('mount:menu'),
          unmount: () => order.push('unmount:menu'),
        },
      }),
      (nav) => ({ save, audio, start: () => undefined, ...nav }),
    );

    router.go('result');

    expect(order).toEqual(['mount:result', 'unmount:result', 'mount:menu']);
    expect(router.current()).toBe('menu');
  });

  it('ignores an unknown screen id at runtime', () => {
    const root = makeRoot();
    const router = createRouter(
      root,
      allScreens({}),
      (nav) => ({ save, audio, start: () => undefined, ...nav }),
    );

    // Casting is avoided by passing a deliberately unknown literal.
    router.go('not-a-screen' as ScreenId);
    expect(router.current()).toBeNull();
  });
});
