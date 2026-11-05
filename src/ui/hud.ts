import './ui.css';
import type { PlayerStateName, PlayerView } from '../core/snapshot';
import type { TeamId } from '../core/types';

const TEAM_COLORS: readonly [string, string] = ['#ff2e88', '#19e6d0'];

function createDiv(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
}

function percentText(value: number, total: number): string {
  return `${(Math.round(percent(value, total) * 10) / 10).toFixed(1)}%`;
}

function statText(value: number): string {
  return `${Math.round(clamp(Number.isFinite(value) ? value : 0, 0, 100) * 10) / 10}%`;
}

function formLabel(state: PlayerStateName): string {
  switch (state) {
    case 'dive':
      return '染遁';
    case 'down':
    case 'respawn':
      return 'やられ';
    case 'stance':
    case 'air':
      return '構え';
    default:
      return '構え';
  }
}

function teamColor(team: TeamId): string {
  return team === 1 ? TEAM_COLORS[1] : TEAM_COLORS[0];
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
  const hpFill = createDiv('pr-hp__fill');
  hp.setAttribute('role', 'progressbar');
  hp.setAttribute('aria-label', '体力');
  hp.append(hpFill);

  const gourd = createDiv('pr-gourd');
  const gourdBody = createDiv('pr-gourd__body');
  const gourdFill = createDiv('pr-gourd__fill');
  const gourdCap = createDiv('pr-gourd__cap');
  gourdBody.setAttribute('role', 'progressbar');
  gourdBody.setAttribute('aria-label', 'インク残量');
  gourdBody.append(gourdFill);
  gourd.append(gourdBody, gourdCap);

  const form = createDiv('pr-form');
  form.textContent = '構え';

  const score = createDiv('pr-score');
  const teamZero = createDiv('pr-score__team pr-score__team--0');
  const teamZeroName = document.createElement('span');
  teamZeroName.className = 'pr-score__name';
  teamZeroName.textContent = '紅蓮';
  const teamZeroPct = document.createElement('span');
  teamZeroPct.className = 'pr-score__pct';
  teamZeroPct.textContent = '0.0%';
  teamZero.append(teamZeroName, teamZeroPct);

  const teamOne = createDiv('pr-score__team pr-score__team--1');
  const teamOneName = document.createElement('span');
  teamOneName.className = 'pr-score__name';
  teamOneName.textContent = '蒼雷';
  const teamOnePct = document.createElement('span');
  teamOnePct.className = 'pr-score__pct';
  teamOnePct.textContent = '0.0%';
  teamOne.append(teamOneName, teamOnePct);

  score.append(teamZero, teamOne);

  const crosshair = createDiv('pr-crosshair');
  crosshair.setAttribute('aria-hidden', 'true');

  hud.append(hp, gourd, form, score, crosshair);

  const startOverlay = createDiv('pr-overlay pr-start');
  const startTitle = document.createElement('h1');
  startTitle.className = 'pr-start__title';
  startTitle.textContent = 'ペイントラッシュ！';
  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'pr-start__button';
  startButton.textContent = 'タップしてスタート';
  startOverlay.append(startTitle, startButton);
  startOverlay.hidden = true;

  const pausedOverlay = createDiv('pr-overlay pr-paused');
  const pausedTitle = document.createElement('p');
  pausedTitle.className = 'pr-paused__title';
  pausedTitle.textContent = 'ポーズ中';
  const pausedHint = document.createElement('p');
  pausedHint.className = 'pr-paused__hint';
  pausedHint.textContent = 'クリックで再開';
  pausedOverlay.append(pausedTitle, pausedHint);
  pausedOverlay.hidden = true;

  const orientation = createDiv('pr-orientation');
  const orientationText = document.createElement('span');
  orientationText.textContent = '横向きにしてください';
  orientation.append(orientationText);

  ui.append(hud, startOverlay, pausedOverlay, orientation);

  setVar(hpFill, '--pr-hp', '0%');
  setVar(gourdFill, '--pr-ink', '0%');

  let startCallback: (() => void) | null = null;
  const onStartClick = (): void => {
    if (startCallback !== null) startCallback();
  };
  startButton.addEventListener('click', onStartClick);

  root.append(ui);

  let disposed = false;

  return {
    update(view: PlayerView, counts: [number, number], totalCells: number): void {
      if (disposed) return;

      setVar(hpFill, '--pr-hp', statText(view.hp));
      setVar(gourdFill, '--pr-ink', statText(view.ink));
      setVar(ui, '--pr-team-color', teamColor(view.team));
      setText(form, formLabel(view.state));
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
