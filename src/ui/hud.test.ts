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

afterEach(() => {
  for (const root of roots) root.remove();
  roots.length = 0;
  vi.restoreAllMocks();
});

describe('createHud', () => {
  it('renders hp, ink, form and both paint percentages', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player({ team: 1, state: 'dive', hp: 64.2, ink: 37.5 }), [250, 100], 1000);

    const hpFill = find(root, '.pr-hp__fill');
    const inkFill = find(root, '.pr-gourd__fill');
    expect(hpFill.style.getPropertyValue('--pr-hp')).toBe('64.2%');
    expect(inkFill.style.getPropertyValue('--pr-ink')).toBe('37.5%');
    expect(find(root, '.pr-form').textContent).toBe('染遁');
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('25.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('10.0%');
    expect(find(root, '.pr-ui').style.getPropertyValue('--pr-team-color')).toBe('#19e6d0');
    expect(find(root, '.pr-crosshair')).not.toBeNull();
    expect(find(root, '.pr-orientation').textContent).toBe('横向きにしてください');
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

  it('maps every player state to a form label', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const cases: Array<[PlayerStateName, string]> = [
      ['stance', '構え'],
      ['air', '構え'],
      ['dive', '染遁'],
      ['down', 'やられ'],
      ['respawn', 'やられ'],
    ];

    for (const [state, label] of cases) {
      hud.update(player({ state }), [0, 0], 100);
      expect(find(root, '.pr-form').textContent).toBe(label);
    }
  });

  it('does not rewrite unchanged values', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const view = player({ hp: 70, ink: 45 });
    hud.update(view, [120, 80], 1000);

    const hpFill = find(root, '.pr-hp__fill');
    const inkFill = find(root, '.pr-gourd__fill');
    const ui = find(root, '.pr-ui');
    const hpWrite = vi.spyOn(hpFill.style, 'setProperty');
    const inkWrite = vi.spyOn(inkFill.style, 'setProperty');
    const uiWrite = vi.spyOn(ui.style, 'setProperty');
    const textWrite = vi.spyOn(Element.prototype, 'textContent', 'set');

    hud.update(view, [120, 80], 1000);

    expect(hpWrite).not.toHaveBeenCalled();
    expect(inkWrite).not.toHaveBeenCalled();
    expect(uiWrite).not.toHaveBeenCalled();
    expect(textWrite).not.toHaveBeenCalled();

    textWrite.mockClear();
    hud.update(player({ state: 'down', hp: 70, ink: 45 }), [120, 80], 1000);
    expect(hpWrite).not.toHaveBeenCalled();
    expect(textWrite).toHaveBeenCalledTimes(1);
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
    expect(find(root, '.pr-hp__fill').style.getPropertyValue('--pr-hp')).toBe('0%');
    expect(find(root, '.pr-gourd__fill').style.getPropertyValue('--pr-ink')).toBe('0%');
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('100.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('0.0%');

    hud.update(player({ hp: 130, ink: -20 }), [0, 0], 10);
    expect(find(root, '.pr-hp__fill').style.getPropertyValue('--pr-hp')).toBe('100%');
    expect(find(root, '.pr-gourd__fill').style.getPropertyValue('--pr-ink')).toBe('0%');
  });

  it('shows a real start button and forwards the callback once per display', () => {
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
    expect(button.textContent).toBe('タップしてスタート');

    button.click();
    expect(onStart).toHaveBeenCalledTimes(1);

    hud.hideStart();
    expect(overlay.hidden).toBe(true);
    button.click();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('shows and hides the pause overlay', () => {
    const root = makeRoot();
    const hud = createHud(root);

    const overlay = find(root, '.pr-paused');
    expect(overlay.hidden).toBe(true);
    expect(find(root, '.pr-paused__title').textContent).toBe('ポーズ中');
    expect(find(root, '.pr-paused__hint').textContent).toBe('クリックで再開');

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
