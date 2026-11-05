// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerStateName, PlayerView, WorldSnapshot } from '../core/snapshot';
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
    weaponId: 'brush',
    gauge: 0,
    specialActive: false,
    charge: 0,
    kills: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    tick: 0,
    players: [],
    projectiles: [],
    bombs: [],
    phase: 'play',
    timeLeft: 120,
    counts: [0, 0],
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

function dots(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.pr-roster__dot'));
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots) root.remove();
  roots.length = 0;
  vi.restoreAllMocks();
});

describe('createHud', () => {
  it('renders hearts, ink, ruby form, gauge and both paint percentages in training', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player({ team: 1, state: 'dive', hp: 64.2, ink: 37.5, gauge: 0.42 }), snapshot({
      phase: 'pre',
      timeLeft: 0,
      counts: [250, 100],
    }), 1000);

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
    expect(find(root, '.pr-gauge__ring').style.getPropertyValue('--pr-gauge-fill')).toBe('42%');
    expect(find(root, '.pr-gauge__label').textContent).toBe('おうぎ');
    expect(find(root, '.pr-crosshair')).not.toBeNull();
  });

  it('keeps the portrait notice out of the match HUD', () => {
    const root = makeRoot();
    createHud(root);
    expect(root.querySelector('.pr-orientation')).toBeNull();
  });

  it('shows a start gate that reports when it is pressed', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const gate = find(root, '.pr-start-gate');
    expect(gate.hidden).toBe(true);

    const onStart = vi.fn();
    hud.onStart(onStart);

    hud.showStartGate(true);
    expect(gate.hidden).toBe(false);
    const button = find(root, '.pr-start-gate__button') as HTMLButtonElement;
    expect(button.textContent).toBe('たたかう!');

    button.click();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(gate.hidden).toBe(true);

    hud.showStartGate(false);
    expect(gate.hidden).toBe(true);
  });

  it('stops calling the start handler after dispose', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const onStart = vi.fn();
    hud.onStart(onStart);
    const button = find(root, '.pr-start-gate__button') as HTMLButtonElement;

    hud.dispose();
    button.click();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('does not build the old start overlay anymore', () => {
    const root = makeRoot();
    createHud(root);
    expect(root.querySelector('.pr-start')).toBeNull();
    expect(root.querySelector('.pr-start__title')).toBeNull();
  });

  it('uses the renderer colours: team 0 pink and team 1 teal', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const ui = find(root, '.pr-ui');

    hud.update(player({ team: 0 }), snapshot(), 100);
    expect(ui.style.getPropertyValue('--pr-team-color')).toBe('#ff2e88');

    hud.update(player({ team: 1 }), snapshot(), 100);
    expect(ui.style.getPropertyValue('--pr-team-color')).toBe('#19e6d0');
  });

  it('shows every team name with furigana built from ruby and rt elements', () => {
    const root = makeRoot();
    createHud(root);

    expect(ruby(root, '.pr-score__team--0 .pr-score__name')).toEqual({ base: '紅蓮', rt: 'ぐれん' });
    expect(ruby(root, '.pr-score__team--1 .pr-score__name')).toEqual({ base: '蒼雷', rt: 'そうらい' });
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
      hud.update(player({ state }), snapshot(), 100);
      expect(ruby(root, '.pr-form')).toEqual({ base, rt });
    }
  });

  it('shows 34 hp as two hearts, the second one partial', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player({ hp: 34 }), snapshot(), 100);

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

  it('exposes progressbar values for hp, ink and the special gauge', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const hp = find(root, '.pr-hp');
    const gourd = find(root, '.pr-gourd__body');
    const gauge = find(root, '.pr-gauge__ring');

    expect(hp.getAttribute('role')).toBe('progressbar');
    expect(hp.getAttribute('aria-valuemin')).toBe('0');
    expect(hp.getAttribute('aria-valuemax')).toBe('100');
    expect(hp.getAttribute('aria-valuenow')).toBe('100');
    expect(gourd.getAttribute('role')).toBe('progressbar');
    expect(gourd.getAttribute('aria-valuenow')).toBe('100');
    expect(gauge.getAttribute('role')).toBe('progressbar');
    expect(gauge.getAttribute('aria-label')).toBe('おうぎゲージ');
    expect(gauge.getAttribute('aria-valuenow')).toBe('0');

    hud.update(player({ hp: 34, ink: 12.5, gauge: 0.375 }), snapshot(), 100);
    expect(hp.getAttribute('aria-valuenow')).toBe('34');
    expect(gourd.getAttribute('aria-valuenow')).toBe('13');
    expect(gauge.getAttribute('aria-valuenow')).toBe('38');
  });

  it('shows a full gourd from the start and writes the ink level on the fill itself', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const fill = find(root, '.pr-gourd__fill');
    const body = find(root, '.pr-gourd__body');

    // The bar must not read empty while aria-valuenow already says 100.
    expect(fill.style.getPropertyValue('--pr-ink')).toBe('100%');
    expect(body.getAttribute('aria-valuenow')).toBe('100');
    // The custom property belongs to the fill, not to an ancestor.
    expect(body.style.getPropertyValue('--pr-ink')).toBe('');
    expect(find(root, '.pr-ui').style.getPropertyValue('--pr-ink')).toBe('');

    hud.update(player({ ink: 100 }), snapshot(), 100);
    expect(fill.style.getPropertyValue('--pr-ink')).toBe('100%');
    expect(body.getAttribute('aria-valuenow')).toBe('100');

    hud.update(player({ ink: 100 }), snapshot(), 100);
    expect(fill.style.getPropertyValue('--pr-ink')).toBe('100%');

    hud.update(player({ ink: 0 }), snapshot(), 100);
    expect(fill.style.getPropertyValue('--pr-ink')).toBe('0%');
    expect(body.getAttribute('aria-valuenow')).toBe('0');
  });

  it('recovers the fill when the first update is below a full tank', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const fill = find(root, '.pr-gourd__fill');

    hud.update(player({ ink: 5 }), snapshot(), 100);
    expect(fill.style.getPropertyValue('--pr-ink')).toBe('5%');
    expect(find(root, '.pr-gourd__body').getAttribute('aria-valuenow')).toBe('5');
  });

  it('does not rewrite unchanged values', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const view = player({ hp: 34, ink: 45, gauge: 0.5, charge: 0.5 });
    const world = snapshot({ phase: 'finished', timeLeft: 65, counts: [120, 80], players: [view] });
    hud.update(view, world, 1000);

    const inkFill = find(root, '.pr-gourd__fill');
    const ui = find(root, '.pr-ui');
    const hpBar = find(root, '.pr-hp');
    const heartFillEl = find(root, '.pr-hp__heart.is-partial .pr-hp__heart-fill');
    const gaugeRing = find(root, '.pr-gauge__ring');
    const charge = find(root, '.pr-charge');
    const inkWrite = vi.spyOn(inkFill.style, 'setProperty');
    const uiWrite = vi.spyOn(ui.style, 'setProperty');
    const heartWrite = vi.spyOn(heartFillEl.style, 'setProperty');
    const gaugeWrite = vi.spyOn(gaugeRing.style, 'setProperty');
    const chargeWrite = vi.spyOn(charge.style, 'setProperty');
    const attrWrite = vi.spyOn(Element.prototype, 'setAttribute');
    const textWrite = vi.spyOn(Element.prototype, 'textContent', 'set');
    const gaugeClassWrite = vi.spyOn(find(root, '.pr-gauge').classList, 'toggle');
    const dotClassWrite = vi.spyOn(dots(root)[0]?.classList ?? find(root, '.pr-roster').classList, 'toggle');

    hud.update(view, world, 1000);

    expect(inkWrite).not.toHaveBeenCalled();
    expect(uiWrite).not.toHaveBeenCalled();
    expect(heartWrite).not.toHaveBeenCalled();
    expect(gaugeWrite).not.toHaveBeenCalled();
    expect(chargeWrite).not.toHaveBeenCalled();
    expect(attrWrite).not.toHaveBeenCalled();
    expect(textWrite).not.toHaveBeenCalled();
    expect(gaugeClassWrite).not.toHaveBeenCalled();
    expect(dotClassWrite).not.toHaveBeenCalled();
    expect(hpBar.getAttribute('aria-valuenow')).toBe('34');

    hud.update(player({ state: 'down', hp: 34, ink: 45, gauge: 0.5, charge: 0.5 }), world, 1000);
    expect(inkWrite).not.toHaveBeenCalled();
    expect(heartWrite).not.toHaveBeenCalled();
    expect(find(root, '.pr-form').textContent).toBe('やられ');
  });

  it('reports a zero or invalid paint total as 0.0%', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player(), snapshot({ phase: 'pre', counts: [5, 3] }), 0);
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('0.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('0.0%');

    hud.update(player(), snapshot({
      phase: 'pre',
      counts: [Number.NaN, Number.POSITIVE_INFINITY],
    }), Number.NaN);
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('0.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('0.0%');
  });

  it('keeps every displayed stat finite and clamped', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.update(player({
      hp: Number.NaN,
      ink: Number.NEGATIVE_INFINITY,
      gauge: Number.NaN,
      charge: Number.POSITIVE_INFINITY,
    }), snapshot({ phase: 'pre', counts: [999, -1], timeLeft: Number.NaN }), 10);
    expect(hearts(root).every((heart) => heart.classList.contains('is-empty'))).toBe(true);
    expect(find(root, '.pr-gourd__fill').style.getPropertyValue('--pr-ink')).toBe('0%');
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('100.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('0.0%');
    expect(find(root, '.pr-hp').getAttribute('aria-valuenow')).toBe('0');
    expect(find(root, '.pr-gauge__ring').getAttribute('aria-valuenow')).toBe('0');
    expect(find(root, '.pr-charge').hidden).toBe(true);

    hud.update(player({ hp: 130, ink: -20, gauge: 5, charge: 2 }), snapshot({ phase: 'pre', counts: [0, 0] }), 10);
    expect(hearts(root).every((heart) => heart.classList.contains('is-full'))).toBe(true);
    expect(find(root, '.pr-gourd__fill').style.getPropertyValue('--pr-ink')).toBe('0%');
    expect(find(root, '.pr-hp').getAttribute('aria-valuenow')).toBe('100');
    expect(find(root, '.pr-gauge__ring').getAttribute('aria-valuenow')).toBe('100');
    expect(find(root, '.pr-gauge').classList.contains('is-full')).toBe(true);
    expect(find(root, '.pr-charge').style.getPropertyValue('--pr-charge-fill')).toBe('100%');
  });

  it('shows the clock as M:SS and hides it when time is over', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const time = find(root, '.pr-time');

    expect(time.hidden).toBe(true);

    hud.update(player(), snapshot({ phase: 'play', timeLeft: 125 }), 100);
    expect(time.hidden).toBe(false);
    expect(time.textContent).toBe('2:05');

    hud.update(player(), snapshot({ phase: 'lastMinute', timeLeft: 59.2 }), 100);
    expect(time.textContent).toBe('1:00');

    hud.update(player(), snapshot({ phase: 'countdown', timeLeft: 0.2 }), 100);
    expect(time.textContent).toBe('0:01');

    hud.update(player(), snapshot({ phase: 'finished', timeLeft: 0 }), 100);
    expect(time.hidden).toBe(true);

    hud.update(player(), snapshot({ phase: 'finished', timeLeft: Number.NaN }), 100);
    expect(time.hidden).toBe(true);
  });

  it('hides paint percentages before and during a match but keeps them in training and finished', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const score = find(root, '.pr-score');

    const hiddenPhases: WorldSnapshot['phase'][] = ['pre', 'play', 'lastMinute', 'countdown'];
    for (const phase of hiddenPhases) {
      hud.update(player(), snapshot({ phase, timeLeft: 120, counts: [250, 100] }), 1000);
      expect(score.hidden, phase).toBe(true);
    }

    hud.update(player(), snapshot({ phase: 'finished', counts: [250, 100] }), 1000);
    expect(score.hidden).toBe(false);
    expect(find(root, '.pr-score__team--0 .pr-score__pct').textContent).toBe('25.0%');
    expect(find(root, '.pr-score__team--1 .pr-score__pct').textContent).toBe('10.0%');

    // Training has no clock, including while the simulation counts down.
    for (const phase of ['pre', 'play'] as const) {
      hud.update(player(), snapshot({ phase, timeLeft: 0, counts: [250, 100] }), 1000);
      expect(score.hidden, phase).toBe(false);
      expect(find(root, '.pr-time').hidden, phase).toBe(true);
    }
  });

  it('never shows the score pills and the match clock together', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const score = find(root, '.pr-score');
    const time = find(root, '.pr-time');
    const phases: WorldSnapshot['phase'][] = ['pre', 'play', 'lastMinute', 'countdown', 'finished'];

    for (const phase of phases) {
      for (const timeLeft of [0, 0.5, 120, Number.NaN]) {
        hud.update(player(), snapshot({ phase, timeLeft, counts: [250, 100] }), 1000);
        expect(score.hidden && time.hidden, `${phase} ${timeLeft}`).toBe(false);
        expect(!score.hidden && !time.hidden, `${phase} ${timeLeft}`).toBe(false);
      }
    }
  });

  it('fills the おうぎ ring and makes it glow when full', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const gauge = find(root, '.pr-gauge');
    const ring = find(root, '.pr-gauge__ring');

    hud.update(player({ gauge: 0 }), snapshot(), 100);
    expect(ring.style.getPropertyValue('--pr-gauge-fill')).toBe('0%');
    expect(gauge.classList.contains('is-full')).toBe(false);

    hud.update(player({ gauge: 0.625 }), snapshot(), 100);
    expect(ring.style.getPropertyValue('--pr-gauge-fill')).toBe('62.5%');
    expect(gauge.classList.contains('is-full')).toBe(false);

    hud.update(player({ gauge: 1 }), snapshot(), 100);
    expect(ring.style.getPropertyValue('--pr-gauge-fill')).toBe('100%');
    expect(gauge.classList.contains('is-full')).toBe(true);
  });

  it('shows a charge meter around the crosshair only while charging', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const charge = find(root, '.pr-charge');

    expect(find(root, '.pr-crosshair').contains(charge)).toBe(true);
    expect(charge.hidden).toBe(true);

    hud.update(player({ charge: 0.25 }), snapshot(), 100);
    expect(charge.hidden).toBe(false);
    expect(charge.style.getPropertyValue('--pr-charge-fill')).toBe('25%');

    hud.update(player({ charge: 0 }), snapshot(), 100);
    expect(charge.hidden).toBe(true);
  });

  it('draws eight roster dots that turn grey when a player is down', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const roster = [
      player({ id: 1, team: 0, state: 'stance' }),
      player({ id: 2, team: 0, state: 'down' }),
      player({ id: 3, team: 1, state: 'stance' }),
      player({ id: 4, team: 1, state: 'respawn' }),
    ];

    hud.update(player({ team: 0 }), snapshot({ players: roster }), 100);

    const rosterDots = dots(root);
    expect(rosterDots).toHaveLength(8);
    expect(rosterDots[0]?.hidden).toBe(false);
    expect(rosterDots[0]?.classList.contains('is-ally')).toBe(true);
    expect(rosterDots[0]?.classList.contains('is-down')).toBe(false);
    expect(rosterDots[0]?.style.getPropertyValue('--pr-dot-color')).toBe('#ff2e88');

    expect(rosterDots[1]?.classList.contains('is-down')).toBe(true);
    expect(rosterDots[1]?.style.getPropertyValue('--pr-dot-color')).toBe('#b9b4ac');

    expect(rosterDots[2]?.classList.contains('is-enemy')).toBe(true);
    expect(rosterDots[2]?.style.getPropertyValue('--pr-dot-color')).toBe('#19e6d0');

    expect(rosterDots[3]?.classList.contains('is-down')).toBe(true);
    expect(rosterDots[4]?.hidden).toBe(true);
  });

  it('keeps only the last three kill log lines and fades them after four seconds', () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const hud = createHud(root);

    hud.log('あかが やった');
    vi.advanceTimersByTime(1000);
    hud.log('あおが やった');
    vi.advanceTimersByTime(1000);
    hud.log('あかが やった');
    vi.advanceTimersByTime(2000);

    let lines = Array.from(root.querySelectorAll<HTMLElement>('.pr-killlog__line'));
    expect(lines).toHaveLength(3);
    expect(lines[0]?.textContent).toBe('あかが やった');
    expect(lines[0]?.classList.contains('is-faded')).toBe(false);
    expect(lines[2]?.textContent).toBe('あかが やった');
    expect(lines[2]?.classList.contains('is-faded')).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(lines[1]?.classList.contains('is-faded')).toBe(true);

    hud.log('さいごの いちげき');
    lines = Array.from(root.querySelectorAll<HTMLElement>('.pr-killlog__line'));
    expect(lines).toHaveLength(3);
    expect(lines[0]?.textContent).toBe('さいごの いちげき');
    expect(lines[2]?.textContent).toBe('あおが やった');
  });

  it('ignores empty kill log text', () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const hud = createHud(root);

    hud.log('   ');
    expect(root.querySelectorAll('.pr-killlog__line')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a call-out banner and hides it again on its own', () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const hud = createHud(root);
    const banner = find(root, '.pr-banner');

    expect(banner.hidden).toBe(true);

    hud.banner('スタート！');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe('スタート！');
    expect(banner.classList.contains('is-visible')).toBe(true);

    vi.advanceTimersByTime(2399);
    expect(banner.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(banner.hidden).toBe(true);
    expect(banner.classList.contains('is-visible')).toBe(false);

    hud.banner('あと 1ぷん！');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe('あと 1ぷん！');
  });

  it('shows the countdown numeral at ten seconds or less', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const countdown = find(root, '.pr-countdown');

    hud.update(player(), snapshot({ phase: 'play', timeLeft: 25 }), 100);
    expect(countdown.hidden).toBe(true);

    hud.update(player(), snapshot({ phase: 'countdown', timeLeft: 10 }), 100);
    expect(countdown.hidden).toBe(false);
    expect(countdown.textContent).toBe('10');

    hud.update(player(), snapshot({ phase: 'countdown', timeLeft: 9.2 }), 100);
    expect(countdown.textContent).toBe('10');

    hud.update(player(), snapshot({ phase: 'countdown', timeLeft: 1.2 }), 100);
    expect(countdown.textContent).toBe('2');

    hud.update(player(), snapshot({ phase: 'finished', timeLeft: 0 }), 100);
    expect(countdown.hidden).toBe(true);
  });

  it('hides and shows the whole HUD with setVisible', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const ui = find(root, '.pr-ui');

    expect(ui.hidden).toBe(false);
    hud.setVisible(false);
    expect(ui.hidden).toBe(true);
    hud.setVisible(false);
    expect(ui.hidden).toBe(true);
    hud.setVisible(true);
    expect(ui.hidden).toBe(false);
  });

  it('shows and hides the pause overlay with a つづける button and no click hint', () => {
    const root = makeRoot();
    const hud = createHud(root);

    const overlay = find(root, '.pr-paused');
    expect(overlay.hidden).toBe(true);
    expect(find(root, '.pr-paused__title').textContent).toBe('ポーズちゅう');
    const button = find(root, '.pr-paused__button') as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.textContent).toBe('つづける');
    expect(button.classList.contains('pr-start__button')).toBe(true);
    expect(find(root, '.pr-paused__reason').textContent).toBe('');
    expect(root.querySelector('.pr-paused__hint')).toBeNull();

    hud.showPaused(true);
    expect(overlay.hidden).toBe(false);
    hud.showPaused(true);
    expect(overlay.hidden).toBe(false);
    hud.showPaused(false);
    expect(overlay.hidden).toBe(true);
  });

  it('calls the resume callback from the つづける button', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const onResume = vi.fn();
    hud.onResume(onResume);
    hud.showPaused(true);

    const button = find(root, '.pr-paused__button') as HTMLButtonElement;
    button.click();

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('calls the quit callback from the やめる button', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const onQuit = vi.fn();
    const onResume = vi.fn();
    hud.onResume(onResume);
    hud.onQuit(onQuit);
    hud.showPaused(true);

    const quit = find(root, '.pr-paused__quit') as HTMLButtonElement;
    expect(quit.tagName).toBe('BUTTON');
    expect(quit.textContent).toBe('やめる');
    quit.click();

    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('applies team names, readings and colours with setTeams', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.setTeams([
      { name: '朱雀', reading: 'すざく', color: 0xff8a1f },
      { name: '青龍', reading: 'せいりゅう', color: 0x2e7bff },
    ]);

    expect(ruby(root, '.pr-score__team--0 .pr-score__name')).toEqual({ base: '朱雀', rt: 'すざく' });
    expect(ruby(root, '.pr-score__team--1 .pr-score__name')).toEqual({ base: '青龍', rt: 'せいりゅう' });
    expect(find(root, '.pr-score__team--0').style.getPropertyValue('--pr-team-color')).toBe('#ff8a1f');
    expect(find(root, '.pr-score__team--1').style.getPropertyValue('--pr-team-color')).toBe('#2e7bff');

    hud.update(player({ team: 0 }), snapshot({ players: [player({ id: 1, team: 0 })] }), 100);
    expect(find(root, '.pr-ui').style.getPropertyValue('--pr-team-color')).toBe('#ff8a1f');
    expect(dots(root)[0]?.style.getPropertyValue('--pr-dot-color')).toBe('#ff8a1f');

    hud.update(player({ team: 1 }), snapshot({ players: [player({ id: 1, team: 1 })] }), 100);
    expect(find(root, '.pr-ui').style.getPropertyValue('--pr-team-color')).toBe('#2e7bff');
    expect(dots(root)[0]?.style.getPropertyValue('--pr-dot-color')).toBe('#2e7bff');

    // CSS hex strings are accepted too, and invalid values fall back.
    hud.setTeams([
      { name: '紫電', reading: 'しでん', color: '#B44CFF' },
      { name: '若葉', reading: 'わかば', color: 'not-a-colour' },
    ]);
    expect(find(root, '.pr-score__team--0').style.getPropertyValue('--pr-team-color')).toBe('#b44cff');
    expect(find(root, '.pr-score__team--1').style.getPropertyValue('--pr-team-color')).toBe('#ff2e88');
  });

  it('falls back to the default team when setTeams gets empty or hostile values', () => {
    const root = makeRoot();
    const hud = createHud(root);

    hud.setTeams([
      { name: '山吹', reading: 'やまぶき', color: 0xe69f00 },
      { name: '群青', reading: 'ぐんじょう', color: 0x0072b2 },
    ]);
    hud.setTeams([
      { name: '   ', reading: '', color: Number.NaN },
      { name: '', reading: '  ', color: Number.POSITIVE_INFINITY },
    ]);

    expect(ruby(root, '.pr-score__team--0 .pr-score__name')).toEqual({ base: '紅蓮', rt: 'ぐれん' });
    expect(ruby(root, '.pr-score__team--1 .pr-score__name')).toEqual({ base: '蒼雷', rt: 'そうらい' });
    expect(find(root, '.pr-score__team--0').style.getPropertyValue('--pr-team-color')).toBe('#ff2e88');
    expect(find(root, '.pr-score__team--1').style.getPropertyValue('--pr-team-color')).toBe('#19e6d0');
  });

  it('renders the pause reason as text and clears it when absent', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const reason = find(root, '.pr-paused__reason');

    hud.showPaused(true, 'コントローラーがきれました');
    expect(reason.textContent).toBe('コントローラーがきれました');

    hud.showPaused(false);
    hud.showPaused(true);
    expect(reason.textContent).toBe('');
  });

  it('moves focus to the resume button when the pause overlay appears', () => {
    const root = makeRoot();
    const hud = createHud(root);
    const button = find(root, '.pr-paused__button') as HTMLButtonElement;

    hud.showPaused(true);

    expect(document.activeElement).toBe(button);
  });

  it('removes listeners and timers on dispose', () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const hud = createHud(root);
    const baseline = vi.getTimerCount();
    const onResume = vi.fn();
    hud.onResume(onResume);
    hud.showPaused(true);
    hud.log('やった');
    hud.banner('スタート！');
    const button = find(root, '.pr-paused__button') as HTMLButtonElement;

    expect(vi.getTimerCount()).toBe(baseline + 2);

    hud.dispose();
    expect(root.querySelector('.pr-ui')).toBeNull();
    expect(vi.getTimerCount()).toBe(baseline);

    button.click();
    expect(onResume).not.toHaveBeenCalled();

    expect(() => hud.update(player(), snapshot(), 10)).not.toThrow();
    expect(() => hud.log('まだ')).not.toThrow();
    expect(() => hud.banner('まだ')).not.toThrow();
    expect(() => hud.setVisible(true)).not.toThrow();
  });
});
