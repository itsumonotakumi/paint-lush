import { emptyActions } from '../../../core/actions';
import type { InputActions } from '../../../core/actions';
import type { ITouchControls } from '../../ports';
import './touch.css';

export interface TouchLayout {
  /** Multiplies every on-screen size. 1 is the design size. */
  scale: number;
  /** Horizontal shift of the button cluster, as a fraction of the viewport width. */
  offsetX: number;
  /** Vertical shift of the button cluster, as a fraction of the viewport height. */
  offsetY: number;
}

export interface TouchControlsOptions {
  layout: TouchLayout;
  /** Radians of view rotation per pixel dragged on the right half. */
  lookSensitivity: number;
  /** Injectable time source for the double-tap guard. Defaults to performance.now. */
  now?: () => number;
}

type ButtonAction = 'fire' | 'jump' | 'dive' | 'sub' | 'special' | 'pause';

interface ButtonSpec {
  action: ButtonAction;
  label: string;
  aria: string;
  className: string;
}

interface ButtonState {
  action: ButtonAction;
  el: HTMLButtonElement;
  pointers: Set<number>;
}

/** Stick travel in CSS pixels at scale 1. */
const STICK_RADIUS = 60;
/** Radial fraction of the stick that reads as zero. */
const STICK_DEADZONE = 0.1;
/** Two touchends closer than this are treated as a double-tap zoom gesture. */
const DOUBLE_TAP_MS = 350;

const BUTTONS: readonly ButtonSpec[] = [
  { action: 'fire', label: 'うつ', aria: 'うつ', className: 'pr-touch__button--fire' },
  { action: 'jump', label: 'ジャンプ', aria: 'ジャンプ', className: 'pr-touch__button--jump' },
  { action: 'dive', label: 'もぐる', aria: 'もぐる', className: 'pr-touch__button--dive' },
  { action: 'sub', label: 'ボム', aria: 'ボム', className: 'pr-touch__button--sub' },
  { action: 'special', label: 'おうぎ', aria: 'おうぎ', className: 'pr-touch__button--special' },
];

function createDiv(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function sanitizeScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0.5) return 0.5;
  if (value > 2) return 2;
  return value;
}

function sanitizeOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

function sanitizeSensitivity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** Adds without ever producing NaN or Infinity. */
function addFinite(current: number, delta: number): number {
  if (!Number.isFinite(delta)) return current;
  const next = current + delta;
  return Number.isFinite(next) ? next : current;
}

function setVar(el: HTMLElement, name: string, value: string): void {
  el.style.setProperty(name, value);
}

/** Pointer capture is a best-effort enhancement: losing it must not break input. */
function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* Some environments refuse capture; plain bubbling still works. */
  }
}

function releasePointer(el: Element, pointerId: number): void {
  try {
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
  } catch {
    /* The pointer may already be gone. */
  }
}

function isFinitePoint(event: PointerEvent): boolean {
  return Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
}

/** Synthetic events sent straight to the overlay still pick the correct half. */
function halfThreshold(): number {
  const width = window.innerWidth;
  if (Number.isFinite(width) && width > 0) return width / 2;
  return 0;
}

/**
 * Builds the floating stick, look area and thumb buttons. All geometry lives
 * in CSS variables so the same markup works at every screen size.
 */
export function createTouchControls(options: TouchControlsOptions): ITouchControls {
  const scale = sanitizeScale(options.layout.scale);
  const offsetX = sanitizeOffset(options.layout.offsetX);
  const offsetY = sanitizeOffset(options.layout.offsetY);
  const lookSensitivity = sanitizeSensitivity(options.lookSensitivity);
  const stickRadius = STICK_RADIUS * scale;
  const now = options.now ?? (() => performance.now());

  const root = createDiv('pr-touch');
  setVar(root, '--pr-touch-scale', String(scale));
  setVar(root, '--pr-touch-offset-x', String(offsetX));
  setVar(root, '--pr-touch-offset-y', String(offsetY));

  const stickZone = createDiv('pr-touch__zone pr-touch__stick-zone');
  const lookZone = createDiv('pr-touch__zone pr-touch__look-zone');

  const stick = createDiv('pr-touch__stick');
  const knob = createDiv('pr-touch__stick-knob');
  stick.append(knob);
  stick.setAttribute('aria-hidden', 'true');

  const buttonLayer = createDiv('pr-touch__buttons');
  const buttonStates: ButtonState[] = [];
  let specialButton: HTMLButtonElement | null = null;

  for (const spec of BUTTONS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `pr-touch__button ${spec.className}`;
    el.textContent = spec.label;
    el.setAttribute('aria-label', spec.aria);
    el.dataset['action'] = spec.action;
    if (spec.action === 'special') specialButton = el;
    buttonLayer.append(el);
    buttonStates.push({ action: spec.action, el, pointers: new Set<number>() });
  }

  const pauseEl = document.createElement('button');
  pauseEl.type = 'button';
  pauseEl.className = 'pr-touch__button pr-touch__button--pause';
  pauseEl.textContent = 'ポーズ';
  pauseEl.setAttribute('aria-label', 'ポーズ');
  pauseEl.dataset['action'] = 'pause';
  const pauseState: ButtonState = { action: 'pause', el: pauseEl, pointers: new Set<number>() };
  buttonStates.push(pauseState);

  root.append(stickZone, lookZone, stick, buttonLayer, pauseEl);

  let mounted = false;
  let visible = true;
  let disposed = false;
  let guardsAttached = false;
  let lastTouchEndAt = Number.NEGATIVE_INFINITY;
  let appliedGauge = Number.NaN;

  // Safari fires these proprietary events when two fingers move together.
  const onGesture = (event: Event): void => {
    if (disposed || !guardsAttached) return;
    event.preventDefault();
  };

  const onTouchMove = (event: Event): void => {
    if (disposed || !visible || !guardsAttached) return;
    if (event.cancelable) event.preventDefault();
  };

  const onTouchEnd = (event: Event): void => {
    if (disposed || !visible || !guardsAttached) return;
    const stamp = now();
    if (!Number.isFinite(stamp)) {
      lastTouchEndAt = Number.NEGATIVE_INFINITY;
      return;
    }
    const delta = stamp - lastTouchEndAt;
    if (delta >= 0 && delta <= DOUBLE_TAP_MS) {
      event.preventDefault();
    }
    lastTouchEndAt = stamp;
  };

  const onDoubleClick = (event: Event): void => {
    if (disposed || !visible || !guardsAttached) return;
    event.preventDefault();
  };

  const documentTarget: EventTarget = document;
  const guardOptions: AddEventListenerOptions = { passive: false };
  const attachGuards = (): void => {
    if (guardsAttached) return;
    guardsAttached = true;
    documentTarget.addEventListener('gesturestart', onGesture, guardOptions);
    documentTarget.addEventListener('gesturechange', onGesture, guardOptions);
    documentTarget.addEventListener('gestureend', onGesture, guardOptions);
    documentTarget.addEventListener('touchmove', onTouchMove, guardOptions);
    documentTarget.addEventListener('touchend', onTouchEnd, guardOptions);
    documentTarget.addEventListener('dblclick', onDoubleClick, guardOptions);
  };
  const detachGuards = (): void => {
    if (!guardsAttached) return;
    guardsAttached = false;
    documentTarget.removeEventListener('gesturestart', onGesture, guardOptions);
    documentTarget.removeEventListener('gesturechange', onGesture, guardOptions);
    documentTarget.removeEventListener('gestureend', onGesture, guardOptions);
    documentTarget.removeEventListener('touchmove', onTouchMove, guardOptions);
    documentTarget.removeEventListener('touchend', onTouchEnd, guardOptions);
    documentTarget.removeEventListener('dblclick', onDoubleClick, guardOptions);
  };

  let stickPointerId = -1;
  let stickStartX = 0;
  let stickStartY = 0;
  let moveX = 0;
  let moveY = 0;

  let lookPointerId = -1;
  let lookLastX = 0;
  let lookLastY = 0;
  let lookX = 0;
  let lookY = 0;

  const clearStick = (): void => {
    stickPointerId = -1;
    moveX = 0;
    moveY = 0;
    stick.classList.remove('pr-touch__stick--active');
    setVar(knob, '--pr-touch-knob-x', '0px');
    setVar(knob, '--pr-touch-knob-y', '0px');
  };

  const clearLook = (): void => {
    lookPointerId = -1;
    lookX = 0;
    lookY = 0;
  };

  const onStickDown = (event: PointerEvent): void => {
    if (disposed || !visible) return;
    if (stickPointerId !== -1) return;
    if (!isFinitePoint(event)) return;
    stickPointerId = event.pointerId;
    stickStartX = event.clientX;
    stickStartY = event.clientY;
    moveX = 0;
    moveY = 0;
    setVar(stick, '--pr-touch-stick-x', `${event.clientX}px`);
    setVar(stick, '--pr-touch-stick-y', `${event.clientY}px`);
    setVar(knob, '--pr-touch-knob-x', '0px');
    setVar(knob, '--pr-touch-knob-y', '0px');
    stick.classList.add('pr-touch__stick--active');
    capturePointer(stickZone, event.pointerId);
    event.preventDefault();
  };

  const onStickMove = (event: PointerEvent): void => {
    if (disposed || !visible) return;
    if (event.pointerId !== stickPointerId) return;
    if (!isFinitePoint(event)) return;

    const dx = event.clientX - stickStartX;
    const dy = event.clientY - stickStartY;
    const distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance)) return;

    const raw = distance / stickRadius;
    const magnitude = raw > 1 ? 1 : raw;
    const eased = magnitude <= STICK_DEADZONE ? 0 : (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);

    if (distance > 0 && eased > 0) {
      const unitX = dx / distance;
      const unitY = dy / distance;
      // Adding zero folds -0 into +0 so callers see clean numbers.
      moveX = finiteOr(unitX * eased, 0) + 0;
      // Screen down is +y; forward is +y in InputActions.
      moveY = finiteOr(-unitY * eased, 0) + 0;
    } else {
      moveX = 0;
      moveY = 0;
    }

    const shown = distance > stickRadius ? stickRadius : distance;
    const knobX = distance > 0 ? (dx / distance) * shown : 0;
    const knobY = distance > 0 ? (dy / distance) * shown : 0;
    setVar(knob, '--pr-touch-knob-x', `${finiteOr(knobX, 0)}px`);
    setVar(knob, '--pr-touch-knob-y', `${finiteOr(knobY, 0)}px`);
  };

  const onStickEnd = (event: PointerEvent): void => {
    if (event.pointerId !== stickPointerId) return;
    // Clear first: releasing capture may synchronously fire lostpointercapture.
    clearStick();
    releasePointer(stickZone, event.pointerId);
  };

  const onLookDown = (event: PointerEvent): void => {
    if (disposed || !visible) return;
    if (lookPointerId !== -1) return;
    if (!isFinitePoint(event)) return;
    lookPointerId = event.pointerId;
    lookLastX = event.clientX;
    lookLastY = event.clientY;
    capturePointer(lookZone, event.pointerId);
    event.preventDefault();
  };

  const onLookMove = (event: PointerEvent): void => {
    if (disposed || !visible) return;
    if (event.pointerId !== lookPointerId) return;
    if (!isFinitePoint(event)) return;

    const dx = event.clientX - lookLastX;
    const dy = event.clientY - lookLastY;
    lookLastX = event.clientX;
    lookLastY = event.clientY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

    lookX = addFinite(lookX, dx * lookSensitivity);
    // Drag up looks up because look.y is +up.
    lookY = addFinite(lookY, -dy * lookSensitivity);
  };

  const onLookEnd = (event: PointerEvent): void => {
    if (event.pointerId !== lookPointerId) return;
    // Keep pending deltas; only the finger tracking ends here.
    lookPointerId = -1;
    releasePointer(lookZone, event.pointerId);
  };

  const onLookCancel = (event: PointerEvent): void => {
    if (event.pointerId !== lookPointerId) return;
    clearLook();
    releasePointer(lookZone, event.pointerId);
  };

  const makeButtonHandlers = (
    state: ButtonState,
  ): {
    down: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } => {
    const down = (event: PointerEvent): void => {
      if (disposed || !visible) return;
      if (state.pointers.has(event.pointerId)) return;
      state.pointers.add(event.pointerId);
      state.el.classList.add('pr-touch__button--down');
      capturePointer(state.el, event.pointerId);
      event.preventDefault();
    };
    const end = (event: PointerEvent): void => {
      if (!state.pointers.delete(event.pointerId)) return;
      releasePointer(state.el, event.pointerId);
      if (state.pointers.size === 0) state.el.classList.remove('pr-touch__button--down');
    };
    return { down, end };
  };

  const buttonHandlers = buttonStates.map((state) => makeButtonHandlers(state));

  // Real touches land on the half-zone elements. Synthetic events dispatched
  // straight at the overlay are routed here by x position.
  const onRootDown = (event: PointerEvent): void => {
    if (event.target !== root) return;
    if (event.clientX < halfThreshold()) onStickDown(event);
    else onLookDown(event);
  };

  const onRootMove = (event: PointerEvent): void => {
    if (event.target !== root) return;
    if (event.pointerId === stickPointerId) onStickMove(event);
    else if (event.pointerId === lookPointerId) onLookMove(event);
  };

  const onRootEnd = (event: PointerEvent): void => {
    if (event.target !== root) return;
    if (event.pointerId === stickPointerId) onStickEnd(event);
    else if (event.pointerId === lookPointerId) onLookEnd(event);
  };

  const onRootCancel = (event: PointerEvent): void => {
    if (event.target !== root) return;
    if (event.pointerId === stickPointerId) onStickEnd(event);
    else if (event.pointerId === lookPointerId) onLookCancel(event);
  };

  // Listeners are kept in one list so dispose can remove every one of them.
  const removals: (() => void)[] = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ): void => {
    const listener = handler as EventListener;
    el.addEventListener(type, listener);
    removals.push(() => el.removeEventListener(type, listener));
  };

  listen(stickZone, 'pointerdown', onStickDown);
  listen(stickZone, 'pointermove', onStickMove);
  listen(stickZone, 'pointerup', onStickEnd);
  listen(stickZone, 'pointercancel', onStickEnd);
  listen(stickZone, 'lostpointercapture', onStickEnd);

  listen(lookZone, 'pointerdown', onLookDown);
  listen(lookZone, 'pointermove', onLookMove);
  listen(lookZone, 'pointerup', onLookEnd);
  listen(lookZone, 'pointercancel', onLookCancel);
  listen(lookZone, 'lostpointercapture', onLookCancel);

  listen(root, 'pointerdown', onRootDown);
  listen(root, 'pointermove', onRootMove);
  listen(root, 'pointerup', onRootEnd);
  listen(root, 'pointercancel', onRootCancel);
  listen(root, 'lostpointercapture', onRootCancel);

  for (let i = 0; i < buttonStates.length; i += 1) {
    const state = buttonStates[i];
    const handlers = buttonHandlers[i];
    if (state === undefined || handlers === undefined) continue;
    listen(state.el, 'pointerdown', handlers.down);
    listen(state.el, 'pointerup', handlers.end);
    listen(state.el, 'pointercancel', handlers.end);
    listen(state.el, 'lostpointercapture', handlers.end);
  }

  const mount = (host: HTMLElement): void => {
    if (disposed || mounted) return;
    host.appendChild(root);
    mounted = true;
    attachGuards();
  };

  const read = (): InputActions => {
    const actions = emptyActions();
    if (disposed || !mounted) return actions;

    actions.move = [moveX, moveY];
    actions.look = [lookX, lookY];
    for (const state of buttonStates) {
      if (!state.pointers.size) continue;
      actions[state.action] = true;
    }
    // Deltas belong to exactly one poll, like mouse movement.
    lookX = 0;
    lookY = 0;
    return actions;
  };

  /** Drops every held finger and pending look, matching IInputSource.reset. */
  const reset = (): void => {
    if (disposed) return;
    clearStick();
    clearLook();
    for (const state of buttonStates) {
      state.pointers.clear();
      state.el.classList.remove('pr-touch__button--down');
    }
  };

  const setVisible = (next: boolean): void => {
    if (disposed) return;
    visible = next;
    root.classList.toggle('pr-touch--hidden', !next);
    root.hidden = !next;
    if (!next) {
      lastTouchEndAt = Number.NEGATIVE_INFINITY;
      reset();
    }
  };

  /** Clamps to 0..1, maps non-finite input to 0, and avoids redundant style writes. */
  const setSpecialGauge = (value: number): void => {
    if (disposed) return;
    const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    if (clamped === appliedGauge) return;
    appliedGauge = clamped;
    if (specialButton === null) return;
    setVar(specialButton, '--pr-special-fill', `${(clamped * 100).toFixed(1)}%`);
    specialButton.classList.toggle('pr-touch__button--ready', clamped >= 0.999);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    visible = false;
    detachGuards();
    for (const remove of removals) remove();
    removals.length = 0;
    clearStick();
    clearLook();
    for (const state of buttonStates) {
      state.pointers.clear();
      state.el.classList.remove('pr-touch__button--down');
    }
    root.remove();
    mounted = false;
  };

  return { mount, read, reset, setVisible, setSpecialGauge, dispose };
}
