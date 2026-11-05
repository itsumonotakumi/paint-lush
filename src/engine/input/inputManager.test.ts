import { describe, expect, it } from 'vitest';
import type { InputDevice } from '../../core/actions';
import { FIXED_DT } from '../../core/types';
import type { KeyBindings } from '../../game/data/schemas';
import { createInputManager } from './inputManager';
import type { GamepadLike, InputDeps } from './inputManager';

const bindings: KeyBindings = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  fire: 'Mouse0',
  jump: 'Space',
  dive: 'ShiftLeft',
  sub: 'KeyF',
  special: 'KeyE',
  pause: 'Escape',
};

const defaultSensitivity = { mouse: 0.01, stick: 2, invertY: false };

interface HarnessOptions {
  locked?: boolean;
  pads?: readonly (GamepadLike | null)[];
  bindings?: KeyBindings;
  sensitivity?: { mouse: number; stick: number; invertY: boolean };
}

function harness(options: HarnessOptions = {}) {
  const keyboardTarget = new EventTarget();
  const pointerTarget = new EventTarget();
  let locked = options.locked ?? false;
  let pads = options.pads ?? [];
  const deps: InputDeps = {
    keyboardTarget,
    pointerTarget,
    getGamepads: () => pads,
    isPointerLocked: () => locked,
    bindings: options.bindings ?? bindings,
    sensitivity: options.sensitivity ?? defaultSensitivity,
  };
  const input = createInputManager(deps);
  return {
    input,
    keyboardTarget,
    pointerTarget,
    setLocked(value: boolean) {
      locked = value;
    },
    setPads(value: readonly (GamepadLike | null)[]) {
      pads = value;
    },
  };
}

function keyEvent(type: 'keydown' | 'keyup', code: string, repeat = false): Event {
  return Object.assign(new Event(type, { cancelable: true }), { code, repeat });
}

function mouseEvent(
  type: 'mousedown' | 'mouseup' | 'mousemove',
  props: Record<string, number> = {},
): Event {
  return Object.assign(new Event(type, { cancelable: true }), props);
}

function neutralButtons(): { pressed: boolean; value: number }[] {
  return Array.from({ length: 12 }, () => ({ pressed: false, value: 0 }));
}

function makePad(
  axes: readonly number[],
  buttons: readonly { pressed: boolean; value: number }[] = neutralButtons(),
  connected = true,
): GamepadLike {
  return { axes, buttons, connected };
}

describe('createInputManager', () => {
  it('maps bound keyboard keys to movement and normalises diagonals', () => {
    const h = harness();
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyW'));
    expect(h.input.poll().move).toEqual([0, 1]);

    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyD'));
    const diagonal = h.input.poll().move;
    expect(diagonal[0]).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal[1]).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(diagonal[0], diagonal[1])).toBeCloseTo(1);

    h.keyboardTarget.dispatchEvent(keyEvent('keyup', 'KeyW'));
    expect(h.input.poll().move[0]).toBeCloseTo(1);

    h.keyboardTarget.dispatchEvent(keyEvent('keyup', 'KeyD'));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyW'));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyS'));
    expect(h.input.poll().move).toEqual([0, 0]);
  });

  it('ignores unbound keys and repeat keydown events', () => {
    const h = harness();
    const unbound = keyEvent('keydown', 'KeyZ');
    h.keyboardTarget.dispatchEvent(unbound);
    expect(unbound.defaultPrevented).toBe(false);
    expect(h.input.poll().move).toEqual([0, 0]);

    const repeated = keyEvent('keydown', 'KeyW', true);
    h.keyboardTarget.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(false);
    expect(h.input.poll().move).toEqual([0, 0]);
  });

  it('prevents default only for bound keyboard and mouse codes', () => {
    const h = harness();
    const boundKey = keyEvent('keydown', 'KeyW');
    h.keyboardTarget.dispatchEvent(boundKey);
    expect(boundKey.defaultPrevented).toBe(true);

    const boundUp = keyEvent('keyup', 'Space');
    h.keyboardTarget.dispatchEvent(boundUp);
    expect(boundUp.defaultPrevented).toBe(true);

    const boundMouse = mouseEvent('mousedown', { button: 0 });
    h.pointerTarget.dispatchEvent(boundMouse);
    expect(boundMouse.defaultPrevented).toBe(true);

    const unboundMouse = mouseEvent('mousedown', { button: 4 });
    h.pointerTarget.dispatchEvent(unboundMouse);
    expect(unboundMouse.defaultPrevented).toBe(false);
  });

  it('tracks mouse buttons as Mouse0..Mouse4 codes', () => {
    const h = harness();
    h.pointerTarget.dispatchEvent(mouseEvent('mousedown', { button: 0 }));
    expect(h.input.poll().fire).toBe(true);
    h.pointerTarget.dispatchEvent(mouseEvent('mouseup', { button: 0 }));
    expect(h.input.poll().fire).toBe(false);

    h.pointerTarget.dispatchEvent(mouseEvent('mousedown', { button: 9 }));
    expect(h.input.poll().fire).toBe(false);
  });

  it('clears held keys on blur', () => {
    const h = harness();
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyW'));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyE'));
    h.keyboardTarget.dispatchEvent(new Event('blur'));
    const actions = h.input.poll();
    expect(actions.move).toEqual([0, 0]);
    expect(actions.special).toBe(false);
  });

  it('maps action bindings and ORs keyboard with mouse buttons', () => {
    const h = harness();
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'Space'));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'ShiftLeft'));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyF'));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyE'));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'Escape'));
    const actions = h.input.poll();
    expect(actions.jump).toBe(true);
    expect(actions.dive).toBe(true);
    expect(actions.sub).toBe(true);
    expect(actions.special).toBe(true);
    expect(actions.pause).toBe(true);
    expect(actions.fire).toBe(false);

    h.pointerTarget.dispatchEvent(mouseEvent('mousedown', { button: 0 }));
    expect(h.input.poll().fire).toBe(true);
  });

  it('accumulates mouse look only while pointer-locked and resets after poll', () => {
    const h = harness({ locked: false, sensitivity: { mouse: 0.01, stick: 2, invertY: false } });
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 10, movementY: 20 }));
    expect(h.input.poll().look).toEqual([0, 0]);

    h.setLocked(true);
    // The first event after locking is discarded; the second applies.
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 5, movementY: 10 }));
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 5, movementY: 10 }));
    const look = h.input.poll().look;
    expect(look[0]).toBeCloseTo(0.05);
    expect(look[1]).toBeCloseTo(-0.1);

    const next = h.input.poll();
    expect(next.look).toEqual([0, 0]);
  });

  it('ignores only the first mousemove after pointer lock is acquired', () => {
    const h = harness({ locked: false, sensitivity: { mouse: 0.01, stick: 2, invertY: false } });
    h.input.poll();

    h.setLocked(true);
    // Simulate the large snapshot delta some browsers emit on lock.
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 5000, movementY: -4000 }));
    expect(h.input.poll().look).toEqual([0, 0]);

    // A normal second event applies, unaffected by the discarded one.
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 12, movementY: 8 }));
    const look = h.input.poll().look;
    expect(look[0]).toBeCloseTo(0.12);
    expect(look[1]).toBeCloseTo(-0.08);

    // Unlocking and locking again arms the discard once more.
    h.setLocked(false);
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 30, movementY: 30 }));
    expect(h.input.poll().look).toEqual([0, 0]);
    h.setLocked(true);
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 999, movementY: 999 }));
    expect(h.input.poll().look).toEqual([0, 0]);
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 2, movementY: 0 }));
    expect(h.input.poll().look[0]).toBeCloseTo(0.02);
  });

  it('tracks the lock transition during poll as well as mousemove', () => {
    const h = harness({ locked: false, sensitivity: { mouse: 0.01, stick: 2, invertY: false } });
    h.input.poll();

    h.setLocked(true);
    // Poll observes the transition, so the next move is still discarded.
    h.input.poll();
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 1000, movementY: 0 }));
    expect(h.input.poll().look).toEqual([0, 0]);

    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 10, movementY: 0 }));
    expect(h.input.poll().look[0]).toBeCloseTo(0.1);
  });

  it('clamps each mouse delta to +/-300 pixels before sensitivity', () => {
    const h = harness({ locked: true, sensitivity: { mouse: 0.01, stick: 2, invertY: false } });

    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 5000, movementY: -5000 }));
    const clamped = h.input.poll().look;
    expect(clamped[0]).toBeCloseTo(3);
    expect(clamped[1]).toBeCloseTo(3);
    expect(Number.isFinite(clamped[0])).toBe(true);
    expect(Number.isFinite(clamped[1])).toBe(true);

    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: -5000, movementY: 5000 }));
    const negated = h.input.poll().look;
    expect(negated[0]).toBeCloseTo(-3);
    expect(negated[1]).toBeCloseTo(-3);

    // Values inside the bound are applied unchanged.
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 300, movementY: -300 }));
    const boundary = h.input.poll().look;
    expect(boundary[0]).toBeCloseTo(3);
    expect(boundary[1]).toBeCloseTo(3);

    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 42, movementY: -7 }));
    const normal = h.input.poll().look;
    expect(normal[0]).toBeCloseTo(0.42);
    expect(normal[1]).toBeCloseTo(0.07);
  });

  it('applies invertY and rejects non-finite mouse deltas', () => {
    const h = harness({
      locked: true,
      sensitivity: { mouse: 0.02, stick: 2, invertY: true },
    });
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 0, movementY: 5 }));
    expect(h.input.poll().look[1]).toBeCloseTo(0.1);

    h.pointerTarget.dispatchEvent(
      mouseEvent('mousemove', { movementX: Number.NaN, movementY: 5 }),
    );
    expect(h.input.poll().look).toEqual([0, 0]);

    h.pointerTarget.dispatchEvent(
      mouseEvent('mousemove', { movementX: 5, movementY: Number.POSITIVE_INFINITY }),
    );
    expect(h.input.poll().look).toEqual([0, 0]);
  });

  it('guards invalid sensitivity values', () => {
    const h = harness({
      locked: true,
      sensitivity: { mouse: Number.NaN, stick: -1, invertY: false },
    });
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 10, movementY: 10 }));
    expect(h.input.poll().look).toEqual([0, 0]);

    h.setPads([makePad([0, 0, 1, 1])]);
    expect(h.input.poll().look).toEqual([0, 0]);
  });

  it('reads the first connected gamepad and ignores disconnected pads', () => {
    const h = harness({
      pads: [makePad([0, 0, 0, 0], neutralButtons(), false), null, makePad([0, -1, 0, 0])],
    });
    const actions = h.input.poll();
    expect(actions.move[1]).toBeCloseTo(1);
  });

  it('applies a radial deadzone and rescales stick movement', () => {
    const h = harness();
    h.setPads([makePad([0.1, -0.1, 0, 0])]);
    expect(h.input.poll().move).toEqual([0, 0]);

    h.setPads([makePad([0.5, -0.5, 0, 0])]);
    const move = h.input.poll().move;
    const raw = Math.hypot(0.5, 0.5);
    const expectedAxis = 0.5 * ((raw - 0.15) / 0.85) / raw;
    expect(move[0]).toBeCloseTo(expectedAxis);
    expect(move[1]).toBeCloseTo(expectedAxis);

    h.setPads([makePad([1, -1, 0, 0])]);
    const full = h.input.poll().move;
    expect(Math.hypot(full[0], full[1])).toBeCloseTo(1);
  });

  it('maps gamepad look axes with sensitivity, FIXED_DT and invertY', () => {
    const h = harness();
    h.setPads([makePad([0, 0, 1, 1])]);
    const look = h.input.poll().look;
    // The 45-degree stick is clamped to the unit circle, so each axis is 1/sqrt(2).
    const axisScale = Math.SQRT1_2 * 2 * FIXED_DT;
    expect(look[0]).toBeCloseTo(axisScale);
    expect(look[1]).toBeCloseTo(-axisScale);

    const inverted = harness({ sensitivity: { mouse: 0.01, stick: 2, invertY: true } });
    inverted.setPads([makePad([0, 0, 1, 1])]);
    expect(inverted.input.poll().look[1]).toBeCloseTo(axisScale);
  });

  it('sums mouse look and gamepad look within one poll', () => {
    const h = harness({ locked: true });
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 10, movementY: 0 }));
    h.setPads([makePad([0, 0, 1, 0])]);
    const look = h.input.poll().look;
    expect(look[0]).toBeCloseTo(0.1 + 2 * FIXED_DT);
    expect(look[1]).toBeCloseTo(0);
  });

  it('maps gamepad buttons with the analog threshold', () => {
    const h = harness();
    const buttons = neutralButtons();
    buttons[7] = { pressed: true, value: 0.31 };
    buttons[6] = { pressed: false, value: 0.31 };
    buttons[0] = { pressed: true, value: 1 };
    buttons[5] = { pressed: true, value: 1 };
    buttons[3] = { pressed: true, value: 1 };
    buttons[9] = { pressed: true, value: 1 };
    h.setPads([makePad([0, 0, 0, 0], buttons)]);
    const actions = h.input.poll();
    expect(actions.fire).toBe(true);
    expect(actions.dive).toBe(true);
    expect(actions.jump).toBe(true);
    expect(actions.sub).toBe(true);
    expect(actions.special).toBe(true);
    expect(actions.pause).toBe(true);

    buttons[7] = { pressed: true, value: 0.3 };
    buttons[6] = { pressed: true, value: 0.3 };
    const below = h.input.poll();
    expect(below.fire).toBe(false);
    expect(below.dive).toBe(false);
  });

  it('guards non-finite gamepad axes and button values', () => {
    const h = harness();
    const buttons = neutralButtons();
    buttons[7] = { pressed: true, value: Number.NaN };
    h.setPads([
      makePad([Number.NaN, Number.NEGATIVE_INFINITY, Number.NaN, 0], buttons),
    ]);
    const actions = h.input.poll();
    expect(actions.move).toEqual([0, 0]);
    expect(Number.isFinite(actions.look[0])).toBe(true);
    expect(actions.look[1]).toBe(0);
    expect(actions.fire).toBe(false);
  });

  it('combines keyboard and stick movement, clamping magnitude to one', () => {
    const h = harness();
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyW'));
    h.setPads([makePad([0, -1, 0, 0])]);
    expect(h.input.poll().move).toEqual([0, 1]);

    h.setPads([makePad([1, 0, 0, 0])]);
    const combined = h.input.poll().move;
    expect(combined[0]).toBeCloseTo(Math.SQRT1_2);
    expect(combined[1]).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(combined[0], combined[1])).toBeCloseTo(1);
  });

  it('reports the last active device', () => {
    const h = harness();
    expect(h.input.lastDevice()).toBe('keyboard');

    h.setPads([makePad([0.1, -0.1, 0, 0])]);
    h.input.poll();
    expect(h.input.lastDevice()).toBe('keyboard');

    h.setPads([makePad([0.5, 0, 0, 0])]);
    h.input.poll();
    expect(h.input.lastDevice()).toBe('gamepad');

    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyW'));
    expect(h.input.lastDevice()).toBe('keyboard');

    const buttons = neutralButtons();
    buttons[11] = { pressed: true, value: 1 };
    h.setPads([makePad([0, 0, 0, 0], buttons)]);
    h.input.poll();
    expect(h.input.lastDevice()).toBe('gamepad');

    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 1 }));
    expect(h.input.lastDevice()).toBe('keyboard');
  });

  it('returns a fresh actions object on every poll', () => {
    const h = harness();
    const first = h.input.poll();
    first.move[0] = 99;
    first.fire = true;
    const second = h.input.poll();
    expect(second).not.toBe(first);
    expect(second.move).toEqual([0, 0]);
    expect(second.fire).toBe(false);
  });

  it('stops responding to all events after dispose', () => {
    const h = harness();
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyW'));
    h.setPads([makePad([0, -1, 1, 1])]);
    const before = h.input.poll();
    expect(before.move).toEqual([0, 1]);
    expect(before.look[0]).toBeGreaterThan(0);

    h.input.dispose();

    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyE'));
    h.keyboardTarget.dispatchEvent(keyEvent('keyup', 'KeyW'));
    h.pointerTarget.dispatchEvent(mouseEvent('mousedown', { button: 0 }));
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 100, movementY: 100 }));
    h.keyboardTarget.dispatchEvent(new Event('blur'));
    const after = h.input.poll();
    expect(after.move).toEqual([0, 0]);
    expect(after.look).toEqual([0, 0]);
    expect(after.fire).toBe(false);
    expect(after.special).toBe(false);

    const device: InputDevice = h.input.lastDevice();
    expect(device).toBe('gamepad');
  });
});
