import './ui.css';
import type { PlayerStateName, PlayerView } from '../core/snapshot';
import type { TeamId } from '../core/types';

const TEAM_COLORS: readonly [string, string] = ['#ff2e88', '#19e6d0'];
const HEART_COUNT = 3;

interface FormLabel {
  base: string;
  reading: string | null;
}

interface HeartView {
  heart: HTMLDivElement;
  fill: HTMLDivElement;
  state: 'full' | 'partial' | 'empty';
}

function createDiv(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function createRuby(base: string, reading: string): HTMLElement {
  const ruby = document.createElement('ruby');
  ruby.className = 'pr-ruby';

  const baseText = document.createElement('span');
  baseText.className = 'pr-ruby__base';
  baseText.textContent = base;

  const rt = document.createElement('rt');
  rt.className = 'pr-ruby__rt';
  rt.textContent = reading;

  ruby.append(baseText, rt);
  return ruby;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteIn(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? clamp(value, min, max) : 0;
}

function percent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
}

function percentText(value: number, total: number): string {
  return `${(Math.round(percent(value, total) * 10) / 10).toFixed(1)}%`;
}

function statText(value: number): string {
  return `${Math.round(finiteIn(value, 0, 100) * 10) / 10}%`;
}

function formLabel(state: PlayerStateName): FormLabel {
  switch (state) {
    case 'dive':
      return { base: '染遁', reading: 'せんとん' };
    case 'down':
    case 'respawn':
      return { base: 'やられ', reading: null };
    case 'stance':
    case 'air':
    default:
      return { base: '構え', reading: 'かまえ' };
  }
}

function formKey(label: FormLabel): string {
  return `${label.base}\u0000${label.reading ?? ''}`;
}

function renderFormLabel(container: HTMLElement, label: FormLabel): void {
  if (label.reading === null) {
    container.replaceChildren(document.createTextNode(label.base));
    return;
  }
  container.replaceChildren(createRuby(label.base, label.reading));
}

function teamColor(team: TeamId): string {
  return team === 1 ? TEAM_COLORS[1] : TEAM_COLORS[0];
}

/**
 * One heart covers one third of the 0..100 hp range. A heart whose third is
 * partly used is shown as a partial heart, so 34 hp is one full heart plus a
 * just-started second heart (two hearts, the second partial).
 */
function heartAmount(hp: number, index: number): number {
  const span = 100 / HEART_COUNT;
  return clamp((hp - index * span) / span, 0, 1);
}

function heartState(amount: number): HeartView['state'] {
  if (amount >= 1 - 1e-6) return 'full';
  if (amount <= 1e-6) return 'empty';
  return 'partial';
}

function heartFill(amount: number): string {
  if (amount >= 1 - 1e-6) return '100%';
  if (amount <= 1e-6) return '0%';
  return `${Math.max(1, Math.round(amount * 100))}%`;
}

export interface Hud {
  /** Updates every displayed value. Only changed values touch the DOM. */
  update(view: PlayerView, counts: [number, number], totalCells: number): void;
  showStart(onStart: () => void): void;
  hideStart(): void;
  showPaused(visible: boolean): void;
  dispose(): void;
}

export function createHud(root: HTMLElement): Hud {
  const ui = createDiv('pr-ui');
  const hud = createDiv('pr-hud');

  const hp = createDiv('pr-hp');
  hp.setAttribute('role', 'progressbar');
  hp.setAttribute('aria-label', '体力');
  hp.setAttribute('aria-valuemin', '0');
  hp.setAttribute('aria-valuemax', '100');
  hp.setAttribute('aria-valuenow', '100');

  const hearts: HeartView[] = [];
  for (let index = 0; index < HEART_COUNT; index += 1) {
    const heart = createDiv('pr-hp__heart is-full');
    const fill = createDiv('pr-hp__heart-fill');
    setVar(fill, '--pr-heart-fill', '100%');
    heart.append(fill);
    hp.append(heart);
    hearts.push({ heart, fill, state: 'full' });
  }

  const gourd = createDiv('pr-gourd');
  const gourdBody = createDiv('pr-gourd__body');
  const gourdFill = createDiv('pr-gourd__fill');
  const gourdCap = createDiv('pr-gourd__cap');
  gourdBody.setAttribute('role', 'progressbar');
  gourdBody.setAttribute('aria-label', 'インク残量');
  gourdBody.setAttribute('aria-valuemin', '0');
  gourdBody.setAttribute('aria-valuemax', '100');
  gourdBody.setAttribute('aria-valuenow', '100');
  gourdBody.append(gourdFill);
  gourd.append(gourdBody, gourdCap);

  const form = createDiv('pr-form');
  const initialForm = formLabel('stance');
  renderFormLabel(form, initialForm);

  const score = createDiv('pr-score');
  const teamZero = createDiv('pr-score__team pr-score__team--0');
  const teamZeroName = document.createElement('span');
  teamZeroName.className = 'pr-score__name';
  teamZeroName.append(createRuby('紅蓮', 'ぐれん'));
  const teamZeroPct = document.createElement('span');
  teamZeroPct.className = 'pr-score__pct';
  teamZeroPct.textContent = '0.0%';
  teamZero.append(teamZeroName, teamZeroPct);

  const teamOne = createDiv('pr-score__team pr-score__team--1');
  const teamOneName = document.createElement('span');
  teamOneName.className = 'pr-score__name';
  teamOneName.append(createRuby('蒼雷', 'そうらい'));
  const teamOnePct = document.createElement('span');
  teamOnePct.className = 'pr-score__pct';
  teamOnePct.textContent = '0.0%';
  teamOne.append(teamOneName, teamOnePct);

  score.append(teamZero, teamOne);

  const crosshair = createDiv('pr-crosshair');
  crosshair.setAttribute('aria-hidden', 'true');

  hud.append(hp, gourd, form, score, crosshair);

  const startOverlay = createDiv('pr-overlay pr-start');
  const startLogo = createDiv('pr-start__logo');
  const startTitle = document.createElement('h1');
  startTitle.className = 'pr-start__title';
  startTitle.textContent = 'ペイントラッシュ！';
  startLogo.append(startTitle);
  for (let index = 1; index <= 3; index += 1) {
    const drip = createDiv(`pr-start__drip pr-start__drip--${index}`);
    drip.setAttribute('aria-hidden', 'true');
    startLogo.append(drip);
  }
  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'pr-start__button';
  startButton.textContent = 'タップしてスタート';
  startOverlay.append(startLogo, startButton);
  startOverlay.hidden = true;

  const pausedOverlay = createDiv('pr-overlay pr-paused');
  const pausedTitle = document.createElement('p');
  pausedTitle.className = 'pr-paused__title';
  pausedTitle.textContent = 'ポーズちゅう';
  const pausedHint = document.createElement('p');
  pausedHint.className = 'pr-paused__hint';
  pausedHint.textContent = 'クリックでさいかい';
  pausedOverlay.append(pausedTitle, pausedHint);
  pausedOverlay.hidden = true;

  const orientation = createDiv('pr-orientation');
  const orientationText = document.createElement('span');
  orientationText.textContent = 'よこむきにしてね';
  orientation.append(orientationText);

  ui.append(hud, startOverlay, pausedOverlay, orientation);

  setVar(gourdFill, '--pr-ink', '0%');

  let startCallback: (() => void) | null = null;
  const onStartClick = (): void => {
    if (startCallback !== null) startCallback();
  };
  startButton.addEventListener('click', onStartClick);

  root.append(ui);

  let disposed = false;
  let lastHp = 100;
  let lastInk = 100;
  let lastAriaHp = '100';
  let lastAriaInk = '100';
  let lastForm = formKey(initialForm);
  let lastTeam = '';

  function updateHearts(hpValue: number): void {
    for (let index = 0; index < hearts.length; index += 1) {
      const view = hearts[index];
      if (view === undefined) continue;
      const amount = heartAmount(hpValue, index);
      const state = heartState(amount);
      if (view.state !== state) {
        view.state = state;
        view.heart.classList.toggle('is-full', state === 'full');
        view.heart.classList.toggle('is-partial', state === 'partial');
        view.heart.classList.toggle('is-empty', state === 'empty');
      }
      setVar(view.fill, '--pr-heart-fill', heartFill(amount));
    }
  }

  return {
    update(view: PlayerView, counts: [number, number], totalCells: number): void {
      if (disposed) return;

      const hpValue = Math.round(finiteIn(view.hp, 0, 100) * 10) / 10;
      if (hpValue !== lastHp) {
        lastHp = hpValue;
        updateHearts(hpValue);
      }

      const hpNow = String(Math.round(hpValue));
      if (hpNow !== lastAriaHp) {
        lastAriaHp = hpNow;
        setAttr(hp, 'aria-valuenow', hpNow);
      }

      const inkValue = Math.round(finiteIn(view.ink, 0, 100) * 10) / 10;
      if (inkValue !== lastInk) {
        lastInk = inkValue;
        setVar(gourdFill, '--pr-ink', statText(inkValue));
      }

      const inkNow = String(Math.round(inkValue));
      if (inkNow !== lastAriaInk) {
        lastAriaInk = inkNow;
        setAttr(gourdBody, 'aria-valuenow', inkNow);
      }

      const color = teamColor(view.team);
      if (color !== lastTeam) {
        lastTeam = color;
        setVar(ui, '--pr-team-color', color);
      }

      const label = formLabel(view.state);
      const key = formKey(label);
      if (key !== lastForm) {
        lastForm = key;
        renderFormLabel(form, label);
      }

      setText(teamZeroPct, percentText(counts[0], totalCells));
      setText(teamOnePct, percentText(counts[1], totalCells));
    },

    showStart(onStart: () => void): void {
      if (disposed) return;
      startCallback = onStart;
      if (startOverlay.hidden) startOverlay.hidden = false;
    },

    hideStart(): void {
      if (disposed) return;
      startCallback = null;
      if (!startOverlay.hidden) startOverlay.hidden = true;
    },

    showPaused(visible: boolean): void {
      if (disposed) return;
      if (pausedOverlay.hidden !== !visible) pausedOverlay.hidden = !visible;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      startCallback = null;
      startButton.removeEventListener('click', onStartClick);
      ui.remove();
    },
  };
}
