// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TutorialOverlay, TutorialView } from '../../app/tutorial/types';
import { createTutorialOverlay } from './overlay';

const roots: HTMLElement[] = [];
const overlays: TutorialOverlay[] = [];

function view(overrides: Partial<TutorialView> = {}): TutorialView {
  return {
    stepId: 'move',
    index: 0,
    total: 8,
    title: 'あるいてみよう',
    hint: 'ひだりの スティックを うごかそう',
    progress: 0,
    celebrating: false,
    finished: false,
    ...overrides,
  };
}

function setup(): { root: HTMLElement; overlay: TutorialOverlay } {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const overlay = createTutorialOverlay();
  overlay.mount(root);
  overlays.push(overlay);
  return { root, overlay };
}

function find(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el;
}

function fillVar(root: HTMLElement): string {
  return find(root, '.pr-tut__bar-fill').style.getPropertyValue('--pr-tut-fill');
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function watchTextWrites(el: Node): () => number {
  let writes = 0;
  let proto: object | null = Object.getPrototypeOf(el) as object | null;
  let descriptor: PropertyDescriptor | undefined;
  while (proto !== null) {
    descriptor = Object.getOwnPropertyDescriptor(proto, 'textContent');
    if (descriptor !== undefined) break;
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  if (descriptor === undefined || descriptor.get === undefined || descriptor.set === undefined) {
    throw new Error('textContent accessor is missing');
  }
  const getter = descriptor.get;
  const setter = descriptor.set;
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    enumerable: true,
    get(this: Node): string {
      return getter.call(this) as string;
    },
    set(this: Node, value: string): void {
      writes += 1;
      setter.call(this, value);
    },
  });
  return () => writes;
}

afterEach(() => {
  for (const overlay of overlays) overlay.dispose();
  overlays.length = 0;
  for (const root of roots) root.remove();
  roots.length = 0;
  vi.restoreAllMocks();
});

describe('tutorial overlay content', () => {
  it('renders the title, hint and step progress', () => {
    const { root, overlay } = setup();
    overlay.show(view({ index: 2, total: 8, progress: 0.375 }));

    expect(find(root, '.pr-tut').hidden).toBe(false);
    expect(find(root, '.pr-tut__title').textContent).toBe('あるいてみよう');
    expect(find(root, '.pr-tut__hint').textContent).toBe('ひだりの スティックを うごかそう');
    expect(find(root, '.pr-tut__count').textContent).toBe('3 / 8');
    expect(fillVar(root)).toBe('37.5%');
    expect(find(root, '.pr-tut__bar').getAttribute('aria-valuenow')).toBe('38');
  });

  it('announces the title region politely', () => {
    const { root } = setup();
    expect(find(root, '.pr-tut__body').getAttribute('aria-live')).toBe('polite');
    expect(find(root, '.pr-tut__skip').getAttribute('aria-label')).toBe('この ステップを とばす');
    expect(find(root, '.pr-tut__quit').getAttribute('aria-label')).toBe('チュートリアルを おわる');
  });

  it('draws one dot per step with done and current marks', () => {
    const { root, overlay } = setup();
    overlay.show(view({ index: 2, total: 8 }));

    const dots = root.querySelectorAll<HTMLElement>('.pr-tut__dot');
    expect(dots).toHaveLength(8);
    expect(root.querySelectorAll('.pr-tut__dot.is-done')).toHaveLength(2);
    expect(root.querySelectorAll('.pr-tut__dot.is-current')).toHaveLength(1);
    expect(root.querySelectorAll('.pr-tut__dot.is-todo')).toHaveLength(0);
    expect(find(root, '.pr-tut__dots').getAttribute('aria-hidden')).toBe('true');
  });

  it('caps the dot row when a hostile total is huge', () => {
    const { root, overlay } = setup();
    overlay.show(view({ index: 1, total: 5000 }));
    expect(root.querySelectorAll('.pr-tut__dot')).toHaveLength(24);
    expect(find(root, '.pr-tut__count').textContent).toBe('2 / 99');
  });

  it('keeps results finite when the view carries bad numbers', () => {
    const { root, overlay } = setup();
    overlay.show(
      view({
        index: Number.NaN,
        total: Number.POSITIVE_INFINITY,
        progress: Number.NaN,
      }),
    );

    expect(fillVar(root)).toBe('0%');
    expect(find(root, '.pr-tut__bar').getAttribute('aria-valuenow')).toBe('0');
    expect(find(root, '.pr-tut').textContent ?? '').not.toContain('NaN');
    // A non-finite total collapses to zero instead of leaking garbage.
    expect(find(root, '.pr-tut__count').textContent).toBe('0 / 0');
    expect(root.querySelectorAll('.pr-tut__dot')).toHaveLength(0);
    expect(fillVar(root)).not.toContain('Infinity');
    expect(root.textContent ?? '').not.toContain('NaN');
  });
});

describe('tutorial overlay change tracking', () => {
  it('mutates nothing when the same view is shown again', async () => {
    const { root, overlay } = setup();
    const current = view({ index: 1, total: 8, progress: 0.25 });
    overlay.show(current);
    await flush();

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });

    overlay.show(current);
    await flush();
    expect(mutations).toBe(0);

    // A progress change too small to move the rounded bar is still no change.
    overlay.show(view({ index: 1, total: 8, progress: 0.2501 }));
    await flush();
    expect(mutations).toBe(0);

    overlay.show(view({ index: 1, total: 8, progress: 0.5 }));
    await flush();
    expect(mutations).toBeGreaterThan(0);

    observer.disconnect();
  });

  it('writes the title once per real title change', () => {
    const { root, overlay } = setup();
    const titleEl = find(root, '.pr-tut__title');
    const writes = watchTextWrites(titleEl);

    overlay.show(view({ index: 0, title: 'あるいてみよう' }));
    expect(writes()).toBe(1);

    overlay.show(view({ index: 0, title: 'あるいてみよう' }));
    expect(writes()).toBe(1);

    overlay.show(view({ index: 0, title: 'あるいてみよう' }));
    overlay.show(view({ index: 1, title: 'まわりを みよう' }));
    expect(writes()).toBe(2);
    expect(titleEl.textContent).toBe('まわりを みよう');
  });

  it('replaces the dot row only when the step total changes', () => {
    const { root, overlay } = setup();
    overlay.show(view({ index: 1, total: 8 }));
    const firstDot = root.querySelector('.pr-tut__dot');

    overlay.show(view({ index: 3, total: 8 }));
    expect(root.querySelector('.pr-tut__dot')).toBe(firstDot);
    expect(root.querySelectorAll('.pr-tut__dot.is-done')).toHaveLength(3);

    overlay.show(view({ index: 3, total: 5 }));
    expect(root.querySelectorAll('.pr-tut__dot')).toHaveLength(5);
    expect(root.querySelectorAll('.pr-tut__dot.is-current')).toHaveLength(1);
  });
});

describe('tutorial overlay celebration and finish', () => {
  it('celebrates with a CSS-only star burst', () => {
    const { root, overlay } = setup();
    overlay.show(view({ index: 2, celebrating: true }));

    expect(find(root, '.pr-tut__card').classList.contains('is-celebrating')).toBe(true);
    expect(root.querySelectorAll('.pr-tut__star')).toHaveLength(8);

    overlay.show(view({ index: 2, celebrating: false }));
    expect(find(root, '.pr-tut__card').classList.contains('is-celebrating')).toBe(false);
  });

  it('grows into a centred panel with おわる as the primary button when finished', () => {
    const { root, overlay } = setup();
    overlay.show(view({ index: 7, total: 8, celebrating: false }));
    overlay.show(view({ index: 8, stepId: 'done', total: 8, progress: 1, finished: true }));

    const tutorial = find(root, '.pr-tut');
    expect(tutorial.classList.contains('is-finished')).toBe(true);
    expect(find(root, '.pr-tut__skip').hidden).toBe(true);
    expect(find(root, '.pr-tut__quit').classList.contains('is-primary')).toBe(true);
    expect(find(root, '.pr-tut__count').textContent).toBe('8 / 8');
    expect(root.querySelectorAll('.pr-tut__dot.is-done')).toHaveLength(8);
    expect(root.querySelectorAll('.pr-tut__dot.is-current')).toHaveLength(0);
  });
});

describe('tutorial overlay handlers', () => {
  it('fires the skip and quit handlers from the buttons', () => {
    const { root, overlay } = setup();
    const skip = vi.fn();
    const quit = vi.fn();
    overlay.onSkip(skip);
    overlay.onQuit(quit);
    overlay.show(view({ index: 1, total: 8 }));

    find(root, '.pr-tut__skip').click();
    expect(skip).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    find(root, '.pr-tut__quit').click();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('does not throw when handlers are not registered', () => {
    const { root, overlay } = setup();
    overlay.show(view());
    expect(() => find(root, '.pr-tut__quit').click()).not.toThrow();
  });
});

describe('tutorial overlay lifecycle', () => {
  it('mounts once and moves instead of duplicating', () => {
    const { root, overlay } = setup();
    overlay.mount(root);
    expect(root.querySelectorAll('.pr-tut')).toHaveLength(1);

    const other = document.createElement('div');
    document.body.append(other);
    roots.push(other);
    overlay.mount(other);
    expect(root.querySelectorAll('.pr-tut')).toHaveLength(0);
    expect(other.querySelectorAll('.pr-tut')).toHaveLength(1);
  });

  it('removes the element and its listeners on dispose', () => {
    const { root, overlay } = setup();
    const skip = vi.fn();
    const quit = vi.fn();
    overlay.onSkip(skip);
    overlay.onQuit(quit);
    overlay.show(view({ index: 1, total: 8 }));

    const skipButton = find(root, '.pr-tut__skip');
    const quitButton = find(root, '.pr-tut__quit');

    overlay.dispose();

    expect(root.children).toHaveLength(0);
    skipButton.click();
    quitButton.click();
    expect(skip).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    overlay.onSkip(skip);
    overlay.show(view({ index: 2, title: 'ちがう' }));
    expect(root.children).toHaveLength(0);
  });

  it('ignores a second dispose', () => {
    const { overlay } = setup();
    overlay.dispose();
    expect(() => overlay.dispose()).not.toThrow();
  });
});

describe('tutorial overlay source and stylesheet', () => {
  const source = readFileSync(join(process.cwd(), 'src/ui/tutorial/overlay.ts'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src/ui/tutorial/tutorial.css'), 'utf8');

  it('never writes markup strings', () => {
    expect(source).not.toMatch(/\binnerHTML\b/);
    expect(source).not.toMatch(/\bouterHTML\b/);
    expect(source).not.toMatch(/setAttribute\(\s*['"]style['"]/);
    expect(source).not.toMatch(/\beval\(/);
    expect(source).not.toMatch(/new Function\(/);
    expect(source).not.toMatch(/\bas unknown as\b/);
  });

  it('places the card under the timer and keeps pointer events on the buttons', () => {
    expect(css).toMatch(/\.pr-tut\s*\{[^}]*pointer-events:\s*none;/);
    expect(css).toMatch(/\.pr-tut__card\s*\{[^}]*top:\s*max\(92px,[^}]*max-width:\s*min\(560px, 92vw\);/);
    expect(css).toMatch(/\.pr-tut__button\s*\{[^}]*pointer-events:\s*auto;/);
    expect(css).toMatch(/\.pr-tut__bar-fill\s*\{[^}]*width:\s*var\(--pr-tut-fill, 0%\);/);
  });

  it('draws the celebration with clip paths and respects reduced motion', () => {
    expect(css).toMatch(/\.pr-tut__star\s*\{[^}]*clip-path:\s*polygon\(/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/\.pr-tut\.is-finished \.pr-tut__card\s*\{[^}]*transform:\s*translate\(-50%, -50%\);/);
  });

  it('switches to a compact one-line card on short landscape phones', () => {
    expect(css).toMatch(/@media \(max-height: 480px\)/);
    expect(css).toMatch(/\.pr-tut:not\(\.is-finished\) \.pr-tut__card\s*\{[^}]*flex-direction:\s*row;/);
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/@import/);
  });

  it('hides and shows the card without disposing it', () => {
    const host = document.createElement('div');
    const overlay = createTutorialOverlay();
    overlay.mount(host);
    const card = host.querySelector('.pr-tut');
    expect(card).not.toBeNull();
    overlay.setVisible(false);
    expect((card as HTMLElement).hidden).toBe(true);
    overlay.setVisible(true);
    expect((card as HTMLElement).hidden).toBe(false);
    overlay.dispose();
    overlay.setVisible(false);
    expect(host.querySelector('.pr-tut')).toBeNull();
  });
});
