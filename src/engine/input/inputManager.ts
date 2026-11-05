import { emptyActions } from '../../core/actions';
import type { InputActions, InputDevice } from '../../core/actions';
import { FIXED_DT } from '../../core/types';
import type { KeyBindings } from '../../game/data/schemas';
import type { IInputSource } from '../ports';

/** Minimum subset of the browser Gamepad shape (standard mapping). */
export interface GamepadLike {
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
  connected: boolean;
}

export interface InputDeps {
  keyboardTarget: EventTarget;
  pointerTarget: EventTarget;
  getGamepads: () => readonly (GamepadLike | null)[];
  isPointerLocked: () => boolean;
  bindings: KeyBindings;
  sensitivity: { mouse: number; stick: number; invertY: boolean };
}

/** Radial stick deadzone. Values inside it read as zero and are rescaled outside. */
const STICK_DEADZONE = 0.15;
/** Analog trigger threshold for the fire/dive buttons. */
const TRIGGER_THRESHOLD = 0.3;

const MOUSE_CODE_LIMIT = 4;
/**
 * Upper bound for a single mouse delta. Some browsers report an enormous
 * movement when pointer lock is acquired; clamping keeps the view stable.
 */
const MAX_MOUSE_DELTA = 300;

function clampMouseDelta(value: number): number {
  if (value > MAX_MOUSE_DELTA) return MAX_MOUSE_DELTA;
  if (value < -MAX_MOUSE_DELTA) return -MAX_MOUSE_DELTA;
  return value;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Reads a possibly-missing axis without trusting the array length. */
function readAxis(axes: readonly number[], index: number): number {
  const value = axes[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buttonPressed(
  buttons: readonly { pressed: boolean; value: number }[],
  index: number,
): boolean {
  const button = buttons[index];
  return button !== undefined && button.pressed === true;
}

function buttonValue(
  buttons: readonly { pressed: boolean; value: number }[],
  index: number,
): number {
  const button = buttons[index];
  if (button === undefined) return 0;
  return Number.isFinite(button.value) ? button.value : 0;
}

/**
 * Applies a radial deadzone and writes the result into `out` so polling does
 * not allocate per tick. Output magnitude never exceeds 1.
 */
function radialDeadzone(x: number, y: number, out: { x: number; y: number }): void {
  const vx = finiteOr(x, 0);
  const vy = finiteOr(y, 0);
  const magnitude = Math.hypot(vx, vy);
  if (!(magnitude > STICK_DEADZONE)) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const clamped = magnitude > 1 ? 1 : magnitude;
  const scale = ((clamped - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / magnitude;
  out.x = vx * scale;
  out.y = vy * scale;
}

/**
 * Collects keyboard, mouse and gamepad state into the device-independent
 * InputActions consumed once per fixed simulation tick.
 */
export function createInputManager(deps: InputDeps): IInputSource {
  const { keyboardTarget, pointerTarget, getGamepads, isPointerLocked, bindings, sensitivity } = deps;

  const heldCodes = new Set<string>();
  const boundCodes = new Set<string>(Object.values(bindings));

  const moveStick = { x: 0, y: 0 };
  const lookStick = { x: 0, y: 0 };

  let lookX = 0;
  let lookY = 0;
  let device: InputDevice = 'keyboard';
  let disposed = false;

  // Initialise from the current lock so entering the manager while already
  // locked is not mistaken for a fresh transition.
  let wasPointerLocked = isPointerLocked() === true;
  let skipNextMouseMove = false;

  /**
   * Records the current pointer-lock state. A false -> true transition marks
   * the next mousemove to be discarded, since browsers often emit one large
   * delta at the moment the lock is acquired.
   */
  const syncPointerLock = (): boolean => {
    const locked = isPointerLocked() === true;
    if (locked) {
      if (!wasPointerLocked) skipNextMouseMove = true;
    } else {
      skipNextMouseMove = false;
    }
    wasPointerLocked = locked;
    return locked;
  };

  const isBound = (code: string): boolean => boundCodes.has(code);

  const onKeyDown = (event: Event): void => {
    if (disposed) return;
    const key = event as KeyboardEvent;
    if (key.repeat === true) return;
    const code = typeof key.code === 'string' ? key.code : '';
    if (code === '') return;
    device = 'keyboard';
    heldCodes.add(code);
    if (isBound(code)) event.preventDefault();
  };

  const onKeyUp = (event: Event): void => {
    if (disposed) return;
    const key = event as KeyboardEvent;
    const code = typeof key.code === 'string' ? key.code : '';
    if (code === '') return;
    device = 'keyboard';
    heldCodes.delete(code);
    if (isBound(code)) event.preventDefault();
  };

  const onBlur = (): void => {
    if (disposed) return;
    heldCodes.clear();
  };

  const onMouseDown = (event: Event): void => {
    if (disposed) return;
    const mouse = event as MouseEvent;
    device = 'keyboard';
    const button = mouse.button;
    if (!Number.isInteger(button) || button < 0 || button > MOUSE_CODE_LIMIT) return;
    const code = `Mouse${button}`;
    heldCodes.add(code);
    if (isBound(code)) event.preventDefault();
  };

  const onMouseUp = (event: Event): void => {
    if (disposed) return;
    const mouse = event as MouseEvent;
    device = 'keyboard';
    const button = mouse.button;
    if (!Number.isInteger(button) || button < 0 || button > MOUSE_CODE_LIMIT) return;
    const code = `Mouse${button}`;
    heldCodes.delete(code);
    if (isBound(code)) event.preventDefault();
  };

  const onMouseMove = (event: Event): void => {
    if (disposed) return;
    device = 'keyboard';
    if (!syncPointerLock()) return;
    // The first move after locking is discarded to avoid a snapshot jump.
    if (skipNextMouseMove) {
      skipNextMouseMove = false;
      return;
    }
    const mouse = event as MouseEvent;
    // A malformed delta invalidates the whole move rather than injecting garbage.
    if (!Number.isFinite(mouse.movementX) || !Number.isFinite(mouse.movementY)) return;
    const movementX = clampMouseDelta(mouse.movementX);
    const movementY = clampMouseDelta(mouse.movementY);
    const mouseSensitivity = nonNegativeFinite(sensitivity.mouse);
    // Screen-down movement looks down; invertY flips the pitch direction.
    const pitchSign = sensitivity.invertY === true ? 1 : -1;
    const deltaYaw = movementX * mouseSensitivity;
    const deltaPitch = movementY * mouseSensitivity * pitchSign;
    if (Number.isFinite(deltaYaw) && Number.isFinite(deltaPitch)) {
      lookX = finiteOr(lookX + deltaYaw, 0);
      lookY = finiteOr(lookY + deltaPitch, 0);
    }
  };

  keyboardTarget.addEventListener('keydown', onKeyDown);
  keyboardTarget.addEventListener('keyup', onKeyUp);
  keyboardTarget.addEventListener('blur', onBlur);
  pointerTarget.addEventListener('mousedown', onMouseDown);
  pointerTarget.addEventListener('mouseup', onMouseUp);
  pointerTarget.addEventListener('mousemove', onMouseMove);

  const readPads = (): readonly (GamepadLike | null)[] => {
    try {
      const pads = getGamepads();
      return Array.isArray(pads) ? pads : [];
    } catch {
      return [];
    }
  };

  const firstConnectedPad = (): GamepadLike | null => {
    const pads = readPads();
    for (let i = 0; i < pads.length; i += 1) {
      const pad = pads[i];
      if (pad !== null && pad !== undefined && pad.connected === true) return pad;
    }
    return null;
  };

  const poll = (): InputActions => {
    const actions = emptyActions();
    if (disposed) {
      lookX = 0;
      lookY = 0;
      return actions;
    }

    syncPointerLock();

    const keyboardX =
      (heldCodes.has(bindings.right) ? 1 : 0) - (heldCodes.has(bindings.left) ? 1 : 0);
    const keyboardY =
      (heldCodes.has(bindings.forward) ? 1 : 0) - (heldCodes.has(bindings.back) ? 1 : 0);
    let moveX = keyboardX;
    let moveY = keyboardY;
    const keyboardMagnitude = Math.hypot(moveX, moveY);
    if (keyboardMagnitude > 1) {
      moveX /= keyboardMagnitude;
      moveY /= keyboardMagnitude;
    }

    let stickX = 0;
    let stickY = 0;
    let gameLookX = 0;
    let gameLookY = 0;
    let fire = false;
    let jump = false;
    let dive = false;
    let sub = false;
    let special = false;
    let pause = false;

    const pad = firstConnectedPad();
    if (pad !== null) {
      const axes = pad.axes;
      const buttons = pad.buttons;

      radialDeadzone(readAxis(axes, 0), readAxis(axes, 1), moveStick);
      stickX = moveStick.x;
      // Standard mapping: pushing the left stick up gives axis 1 = -1, which is forward.
      stickY = -moveStick.y;

      radialDeadzone(readAxis(axes, 2), readAxis(axes, 3), lookStick);
      const stickSensitivity = nonNegativeFinite(sensitivity.stick);
      const stickPitchSign = sensitivity.invertY === true ? 1 : -1;
      gameLookX = lookStick.x * stickSensitivity * FIXED_DT;
      gameLookY = lookStick.y * stickSensitivity * stickPitchSign * FIXED_DT;

      fire = buttonValue(buttons, 7) > TRIGGER_THRESHOLD;
      dive = buttonValue(buttons, 6) > TRIGGER_THRESHOLD;
      jump = buttonPressed(buttons, 0);
      sub = buttonPressed(buttons, 5);
      special = buttonPressed(buttons, 3);
      pause = buttonPressed(buttons, 9);

      let padActive = stickX !== 0 || stickY !== 0 || lookStick.x !== 0 || lookStick.y !== 0;
      if (!padActive) {
        for (let i = 0; i < buttons.length; i += 1) {
          const button = buttons[i];
          if (button !== undefined && button.pressed === true) {
            padActive = true;
            break;
          }
        }
      }
      if (padActive) device = 'gamepad';
    }

    moveX += stickX;
    moveY += stickY;
    const magnitude = Math.hypot(moveX, moveY);
    if (magnitude > 1) {
      moveX /= magnitude;
      moveY /= magnitude;
    }

    actions.move = [finiteOr(moveX, 0), finiteOr(moveY, 0)];
    actions.look = [finiteOr(lookX + gameLookX, 0), finiteOr(lookY + gameLookY, 0)];
    actions.fire = fire || heldCodes.has(bindings.fire);
    actions.jump = jump || heldCodes.has(bindings.jump);
    actions.dive = dive || heldCodes.has(bindings.dive);
    actions.sub = sub || heldCodes.has(bindings.sub);
    actions.special = special || heldCodes.has(bindings.special);
    actions.pause = pause || heldCodes.has(bindings.pause);

    // Look deltas are consumed by this poll; the next tick starts fresh.
    lookX = 0;
    lookY = 0;

    return actions;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    heldCodes.clear();
    lookX = 0;
    lookY = 0;
    keyboardTarget.removeEventListener('keydown', onKeyDown);
    keyboardTarget.removeEventListener('keyup', onKeyUp);
    keyboardTarget.removeEventListener('blur', onBlur);
    pointerTarget.removeEventListener('mousedown', onMouseDown);
    pointerTarget.removeEventListener('mouseup', onMouseUp);
    pointerTarget.removeEventListener('mousemove', onMouseMove);
  };

  const lastDevice = (): InputDevice => device;

  return { poll, lastDevice, dispose };
}
