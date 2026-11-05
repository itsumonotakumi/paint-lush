// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerStateName, PlayerView } from '../core/snapshot';
import { createHud } from './hud';

const roots: HTMLElement[] = [];

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  return root;
}

function player(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    id: 1,
    team: 0,
    state: 'stance',
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    ink: 100,
    ...overrides,
  };
}

function find(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector(selector);
  expect(el).not.toBeNull();
  if (el === null) throw new Error(`missing ${selector}`);
  return el as HTMLElement;
}

function hearts(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.pr-hp__heart'));
}

function heartFill(root: HTMLElement, index: number): string {
  const heart = hearts(root)[index];
  expect(heart).toBeDefined();
  const fill = heart?.querySelector<HTMLElement>('.pr-hp__heart-fill');
  expect(fill).not.toBeNull();
  return fill?.style.getPropertyValue('--pr-heart-fill') ?? '';
}

function ruby(root: HTMLElement, selector: string): { base: string; rt: string | null } {
  const host = find(root, selector);
  const base = host.querySelector('.pr-ruby__base');
  const rt = host.querySelector('rt');
  if (base === null) return { base: host.textContent ?? '', rt: rt?.textContent ?? null };
  return { base: base.textContent ?? '', rt: rt?.textContent ?? null };
}

afterEach(() => {
  for (const root of roots) root.remove();
  roots.length = 0;
  vi.restoreAllMocks();
});

describe('createHud', () => {
  it('renders hearts, ink, ruby form and both paint percentages', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player({ team: 1, state: 'dive', hp: 64.2, ink: 37.5 }), [250, 100], 1000);

    const heartEls = hearts(root);
    expect(heartEls).toHaveLength(3);
    expect(heartEls[0]?.classList.contains('is-full')).toBe(true);
    expect(heartEls[1]?.classList.contains('is-partial')).toBe(true);
    expect(heartEls[2]?.classList.contains('is-empty')).toBe(true);
    expect(find(root, '.pr-gourd__fill').style.getPropertyValue('--pr-ink')).toBe('37.5%');
    expect(ruby(root, '.pr-form')).toEqual({ base: '染遁', rt: 'せんとん' });
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('25.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('10.0%');
    expect(find(root, '.pr-ui').style.getPropertyValue('--pr-team-color')).toBe('#19e6d0');
    expect(find(root, '.pr-crosshair')).not.toBeNull();
    expect(find(root, '.pr-orientation').textContent).toBe('よこむきにしてね');
  });

  it('uses the renderer colours: team 0 pink and team 1 teal', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const ui = find(root, '.pr-ui');

    hud.update(player({ team: 0 }), [0, 0], 100);
    expect(ui.style.getPropertyValue('--pr-team-color')).toBe('#ff2e88');

    hud.update(player({ team: 1 }), [0, 0], 100);
    expect(ui.style.getPropertyValue('--pr-team-color')).toBe('#19e6d0');
  });

  it('shows every team name with furigana built from ruby and rt elements', () => {
    const root = makeRoot();
    createHud(root);

    expect(ruby(root, '.pr-score__team--0 .pr-score__name')).toEqual({
      base: '紅蓮',
      rt: 'ぐれん',
    });
    expect(ruby(root, '.pr-score__team--1 .pr-score__name')).toEqual({
      base: '蒼雷',
      rt: 'そうらい',
    });
  });

  it('maps every player state to a form label with ruby for its kanji', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const cases: Array<[PlayerStateName, string, string | null]> = [
      ['stance', '構え', 'かまえ'],
      ['air', '構え', 'かまえ'],
      ['dive', '染遁', 'せんとん'],
      ['down', 'やられ', null],
      ['respawn', 'やられ', null],
    ];

    for (const [state, base, rt] of cases) {
      hud.update(player({ state }), [0, 0], 100);
      expect(ruby(root, '.pr-form')).toEqual({ base, rt });
    }
  });

  it('shows 34 hp as two hearts, the second one partial', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player({ hp: 34 }), [0, 0], 100);

    const heartEls = hearts(root);
    expect(heartEls[0]?.classList.contains('is-full')).toBe(true);
    expect(heartEls[1]?.classList.contains('is-partial')).toBe(true);
    expect(heartEls[1]?.classList.contains('is-full')).toBe(false);
    expect(heartEls[2]?.classList.contains('is-empty')).toBe(true);
    // One third is 33.33 hp, so 34 hp leaves 0.67 hp of the second heart.
    expect(heartFill(root, 0)).toBe('100%');
    expect(heartFill(root, 1)).toBe('2%');
    expect(heartFill(root, 2)).toBe('0%');
  });

  it('exposes progressbar values for hp and ink', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const hp = find(root, '.pr-hp');
    const gourd = find(root, '.pr-gourd__body');

    expect(hp.getAttribute('role')).toBe('progressbar');
    expect(hp.getAttribute('aria-valuemin')).toBe('0');
    expect(hp.getAttribute('aria-valuemax')).toBe('100');
    expect(hp.getAttribute('aria-valuenow')).toBe('100');
    expect(gourd.getAttribute('role')).toBe('progressbar');
    expect(gourd.getAttribute('aria-valuenow')).toBe('100');

    hud.update(player({ hp: 34, ink: 12.5 }), [0, 0], 100);
    expect(hp.getAttribute('aria-valuenow')).toBe('34');
    expect(gourd.getAttribute('aria-valuenow')).toBe('13');
  });

  it('does not rewrite unchanged values', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const view = player({ hp: 34, ink: 45 });
    hud.update(view, [120, 80], 1000);

    const inkFill = find(root, '.pr-gourd__fill');
    const ui = find(root, '.pr-ui');
    const hpBar = find(root, '.pr-hp');
    const heartFill = find(root, '.pr-hp__heart.is-partial .pr-hp__heart-fill');
    const inkWrite = vi.spyOn(inkFill.style, 'setProperty');
    const uiWrite = vi.spyOn(ui.style, 'setProperty');
    const heartWrite = vi.spyOn(heartFill.style, 'setProperty');
    const attrWrite = vi.spyOn(Element.prototype, 'setAttribute');
    const textWrite = vi.spyOn(Element.prototype, 'textContent', 'set');

    hud.update(view, [120, 80], 1000);

    expect(inkWrite).not.toHaveBeenCalled();
    expect(uiWrite).not.toHaveBeenCalled();
    expect(heartWrite).not.toHaveBeenCalled();
    expect(attrWrite).not.toHaveBeenCalled();
    expect(textWrite).not.toHaveBeenCalled();
    expect(hpBar.getAttribute('aria-valuenow')).toBe('34');

    hud.update(player({ state: 'down', hp: 34, ink: 45 }), [120, 80], 1000);
    expect(inkWrite).not.toHaveBeenCalled();
    expect(heartWrite).not.toHaveBeenCalled();
    expect(find(root, '.pr-form').textContent).toBe('やられ');
  });

  it('reports a zero or invalid paint total as 0.0%', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player(), [5, 3], 0);
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('0.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('0.0%');

    hud.update(player(), [Number.NaN, Number.POSITIVE_INFINITY], Number.NaN);
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('0.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('0.0%');
  });

  it('keeps every displayed stat finite and clamped', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player({ hp: Number.NaN, ink: Number.NEGATIVE_INFINITY }), [999, -1], 10);
    expect(hearts(root).every((heart) => heart.classList.contains('is-empty'))).toBe(true);
    expect(find(root, '.pr-gourd__fill').style.getPropertyValue('--pr-ink')).toBe('0%');
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('100.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('0.0%');
    expect(find(root, '.pr-hp').getAttribute('aria-valuenow')).toBe('0');

    hud.update(player({ hp: 130, ink: -20 }), [0, 0], 10);
    expect(hearts(root).every((heart) => heart.classList.contains('is-full'))).toBe(true);
    expect(find(root, '.pr-gourd__fill').style.getPropertyValue('--pr-ink')).toBe('0%');
    expect(find(root, '.pr-hp').getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows a sunny start overlay with a logo, drips and a start button', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const onStart = vi.fn();

    hud.showStart(onStart);
    const overlay = find(root, '.pr-start');
    const button = find(root, '.pr-start__button') as HTMLButtonElement;
    expect(overlay.hidden).toBe(false);
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(find(root, '.pr-start__title').textContent).toBe('ペイントラッシュ！');
    expect(root.querySelectorAll('.pr-start__drip')).toHaveLength(3);
    expect(button.textContent).toBe('タップしてスタート');

    button.click();
    expect(onStart).toHaveBeenCalledTimes(1);

    hud.hideStart();
    expect(overlay.hidden).toBe(true);
    button.click();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('shows and hides the pause overlay with kana text', () => {
    const root = makeRoot();
    const hud = createHud(root);

    const overlay = find(root, '.pr-paused');
    expect(overlay.hidden).toBe(true);
    expect(find(root, '.pr-paused__title').textContent).toBe('ポーズちゅう');
    expect(find(root, '.pr-paused__hint').textContent).toBe('クリックでさいかい');

    hud.showPaused(true);
    expect(overlay.hidden).toBe(false);
    hud.showPaused(true);
    expect(overlay.hidden).toBe(false);
    hud.showPaused(false);
    expect(overlay.hidden).toBe(true);
  });

  it('removes the start listener on dispose', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const onStart = vi.fn();
    hud.showStart(onStart);
    const button = find(root, '.pr-start__button') as HTMLButtonElement;

    hud.dispose();
    expect(root.querySelector('.pr-ui')).toBeNull();
    button.click();
    expect(onStart).not.toHaveBeenCalled();

    expect(() => hud.update(player(), [0, 0], 10)).not.toThrow();
  });
});
