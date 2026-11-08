import './tutorial.css';
import type { TutorialOverlay, TutorialView } from '../../app/tutorial/types';

/**
 * Draws the guided tutorial card. The controller owns all state; this module
 * owns the DOM and only writes when a visible value actually changed.
 */

const MAX_DOTS = 24;
const MAX_TOTAL = 99;
const MAX_TEXT = 160;
const STAR_COUNT = 8;
const PROGRESS_STEPS = 1000;

type DotState = 'done' | 'current' | 'todo';

function createDiv(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
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

function setClass(el: HTMLElement, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function finiteIn(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function safeText(value: string): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

function createButton(className: string, label: string, ariaLabel: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  return button;
}

export function createTutorialOverlay(): TutorialOverlay {
  const element = createDiv('pr-tut');
  element.hidden = true;
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', 'チュートリアル');

  const card = createDiv('pr-tut__card');

  const burst = createDiv('pr-tut__burst');
  burst.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < STAR_COUNT; index += 1) {
    burst.append(createDiv(`pr-tut__star pr-tut__star--${index}`));
  }

  const head = createDiv('pr-tut__head');
  const dots = createDiv('pr-tut__dots');
  dots.setAttribute('aria-hidden', 'true');

  const counter = document.createElement('p');
  counter.className = 'pr-tut__count';
  counter.textContent = '';

  head.append(dots, counter);

  const body = createDiv('pr-tut__body');
  body.setAttribute('aria-live', 'polite');
  body.setAttribute('aria-atomic', 'true');

  const title = document.createElement('p');
  title.className = 'pr-tut__title';
  title.textContent = '';

  const hint = document.createElement('p');
  hint.className = 'pr-tut__hint';
  hint.textContent = '';

  body.append(title, hint);

  const bar = createDiv('pr-tut__bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'すすみぐあい');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');

  const barFill = createDiv('pr-tut__bar-fill');
  setVar(barFill, '--pr-tut-fill', '0%');
  bar.append(barFill);

  const actions = createDiv('pr-tut__actions');
  const skipButton = createButton('pr-tut__button pr-tut__skip', 'つぎへ', 'この ステップを とばす');
  const quitButton = createButton('pr-tut__button pr-tut__quit', 'おわる', 'チュートリアルを おわる');
  actions.append(skipButton, quitButton);

  card.append(burst, head, body, bar, actions);
  element.append(card);

  let disposed = false;
  let skipHandler: (() => void) | null = null;
  let quitHandler: (() => void) | null = null;

  const onSkipClick = (): void => {
    if (disposed) return;
    if (skipHandler !== null) skipHandler();
  };
  const onQuitClick = (): void => {
    if (disposed) return;
    if (quitHandler !== null) quitHandler();
  };

  skipButton.addEventListener('click', onSkipClick);
  quitButton.addEventListener('click', onQuitClick);

  const dotEls: HTMLDivElement[] = [];
  const dotStates: DotState[] = [];

  let lastTitle = '';
  let lastHint = '';
  let lastShown = -1;
  let lastTotal = -1;
  let lastIndex = -1;
  let lastPercent = -1;
  let lastAriaPercent = -1;
  let lastCelebrating: boolean | null = null;
  let lastFinished: boolean | null = null;

  function rebuildDots(count: number): void {
    dots.replaceChildren();
    dotEls.length = 0;
    dotStates.length = 0;
    for (let index = 0; index < count; index += 1) {
      const dot = createDiv('pr-tut__dot');
      dots.append(dot);
      dotEls.push(dot);
      dotStates.push('todo');
    }
    // A fresh dot always starts as 'todo', so force the next pass to style it.
    lastIndex = -1;
    lastTotal = -1;
    lastFinished = null;
  }

  function stateFor(index: number, current: number, finished: boolean): DotState {
    if (index < current) return 'done';
    if (index === current && !finished) return 'current';
    return 'todo';
  }

  function updateDots(current: number, total: number, finished: boolean): void {
    const count = Math.min(total, MAX_DOTS);
    if (count !== dotEls.length) rebuildDots(count);
    if (current === lastIndex && total === lastTotal && finished === lastFinished) return;
    for (let index = 0; index < dotEls.length; index += 1) {
      const dot = dotEls[index];
      const state = stateFor(index, current, finished);
      if (dot === undefined || dotStates[index] === state) continue;
      dotStates[index] = state;
      setClass(dot, 'is-done', state === 'done');
      setClass(dot, 'is-current', state === 'current');
    }
  }

  return {
    mount(root: HTMLElement): void {
      if (disposed) return;
      // Re-mounting moves the card instead of duplicating it.
      if (element.parentElement !== root) root.append(element);
    },

    show(view: TutorialView): void {
      if (disposed) return;

      const total = clampInt(view.total, 0, MAX_TOTAL);
      const index = clampInt(view.index, 0, total);
      const finished = view.finished === true;
      const celebrating = view.celebrating === true;
      const progress = finiteIn(view.progress, 0, 1);

      setHidden(element, false);

      const shown = finished ? total : Math.min(total, index + 1);
      if (shown !== lastShown || total !== lastTotal) {
        lastShown = shown;
        setText(counter, `${shown} / ${total}`);
      }

      updateDots(index, total, finished);
      // updateDots may reset lastIndex/lastTotal when it rebuilt the dot row.
      lastIndex = index;
      lastTotal = total;

      const nextTitle = safeText(view.title);
      if (nextTitle !== lastTitle) {
        lastTitle = nextTitle;
        setText(title, nextTitle);
      }

      const nextHint = safeText(view.hint);
      if (nextHint !== lastHint) {
        lastHint = nextHint;
        setText(hint, nextHint);
      }

      const percent = Math.round(progress * PROGRESS_STEPS) / 10;
      if (percent !== lastPercent) {
        lastPercent = percent;
        setVar(barFill, '--pr-tut-fill', `${percent}%`);
      }

      const ariaPercent = Math.round(progress * 100);
      if (ariaPercent !== lastAriaPercent) {
        lastAriaPercent = ariaPercent;
        setAttr(bar, 'aria-valuenow', String(ariaPercent));
      }

      if (celebrating !== lastCelebrating) {
        lastCelebrating = celebrating;
        setClass(card, 'is-celebrating', celebrating);
      }

      if (finished !== lastFinished) {
        lastFinished = finished;
        setClass(element, 'is-finished', finished);
        setClass(quitButton, 'is-primary', finished);
        setHidden(skipButton, finished);
      }
    },

    onSkip(handler: () => void): void {
      if (disposed) return;
      skipHandler = handler;
    },

    onQuit(handler: () => void): void {
      if (disposed) return;
      quitHandler = handler;
    },

    setVisible(visible: boolean): void {
      if (disposed) return;
      setHidden(element, !visible);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      skipHandler = null;
      quitHandler = null;
      skipButton.removeEventListener('click', onSkipClick);
      quitButton.removeEventListener('click', onQuitClick);
      element.remove();
    },
  };
}
