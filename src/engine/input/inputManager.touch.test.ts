// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { emptyActions } from '../../core/actions';
import type { InputActions } from '../../core/actions';
import type { KeyBindings } from '../../game/data/schemas';
import type { ITouchControls } from '../ports';
import { createInputManager } from './inputManager';
import type { InputDeps } from './inputManager';
import { createTouchControls } from './touch/touchControls';

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

const sensitivity = { mouse: 0.01, stick: 2, invertY: false };

class FakeTouch implements ITouchControls {
  actions: InputActions = emptyActions();
  visible = true;
  mounted = false;
  disposed = false;
  resets = 0;

  mount(): void {
    this.mounted = true;
  }

  read(): InputActions {
    const out = this.actions;
    this.actions = emptyActions();
    return out;
  }

  reset(): void {
    this.resets += 1;
    this.actions = emptyActions();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  setSpecialGauge(): void {
    /* Not used by the input manager. */
  }

  dispose(): void {
    this.disposed = true;
  }
}

interface Harness {
  input: ReturnType<typeof createInputManager>;
  keyboardTarget: EventTarget;
  pointerTarget: EventTarget;
  touch: FakeTouch;
  setLocked(value: boolean): void;
}

function harness(withTouch = true): Harness {
  const keyboardTarget = new EventTarget();
  const pointerTarget = new EventTarget();
  const touch = new FakeTouch();
  let locked = false;
  const base: InputDeps = {
    keyboardTarget,
    pointerTarget,
    getGamepads: () => [],
    isPointerLocked: () => locked,
    bindings,
    sensitivity,
  };
  const deps: InputDeps = withTouch ? { ...base, touch } : base;
  const input = createInputManager(deps);
  return {
    input,
    keyboardTarget,
    pointerTarget,
    touch,
    setLocked(value: boolean) {
      locked = value;
    },
  };
}

function keyEvent(type: 'keydown' | 'keyup', code: string): Event {
  return Object.assign(new Event(type, { cancelable: true }), { code, repeat: false });
}

function mouseEvent(type: string, props: Record<string, number>): Event {
  return Object.assign(new Event(type, { cancelable: true }), props);
}

function pointer(type: string, id: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    bubbles: true,
    cancelable: true,
  });
}

describe('createInputManager with touch', () => {
  it('uses whichever movement has the larger magnitude', () => {
    const h = harness();

    h.touch.actions.move = [0.9, 0];
    expect(h.input.poll().move).toEqual([0.9, 0]);

    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyW'));
    h.touch.actions.move = [0.2, 0];
    expect(h.input.poll().move).toEqual([0, 1]);

    // Equal magnitudes keep the keyboard vector.
    h.keyboardTarget.dispatchEvent(keyEvent('keyup', 'KeyW'));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyD'));
    h.touch.actions.move = [0.5, 0];
    expect(h.input.poll().move).toEqual([1, 0]);
  });

  it('adds touch look to mouse look and ORs all buttons', () => {
    const h = harness();
    h.setLocked(true);
    // The first move after locking is discarded by the manager.
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 999, movementY: 0 }));
    h.pointerTarget.dispatchEvent(mouseEvent('mousemove', { movementX: 10, movementY: 0 }));
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'Space'));

    h.touch.actions.look = [0.2, 0.1];
    h.touch.actions.fire = true;
    h.touch.actions.dive = true;
    h.touch.actions.sub = true;
    h.touch.actions.special = true;
    h.touch.actions.pause = true;

    const actions = h.input.poll();
    expect(actions.look[0]).toBeCloseTo(0.3);
    expect(actions.look[1]).toBeCloseTo(0.1);
    expect(actions.fire).toBe(true);
    expect(actions.jump).toBe(true);
    expect(actions.dive).toBe(true);
    expect(actions.sub).toBe(true);
    expect(actions.special).toBe(true);
    expect(actions.pause).toBe(true);
  });

  it('marks the last device as touch only while touch activity exists', () => {
    const h = harness();
    expect(h.input.lastDevice()).toBe('keyboard');

    h.touch.actions.move = [0.5, 0];
    h.input.poll();
    expect(h.input.lastDevice()).toBe('touch');

    h.input.poll();
    expect(h.input.lastDevice()).toBe('touch');

    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyW'));
    expect(h.input.lastDevice()).toBe('keyboard');

    h.keyboardTarget.dispatchEvent(keyEvent('keyup', 'KeyW'));
    h.touch.actions.fire = true;
    h.input.poll();
    expect(h.input.lastDevice()).toBe('touch');
  });

  it('resets the touch source together with keyboard and look state', () => {
    const h = harness();
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyD'));
    h.touch.actions.fire = true;
    expect(h.input.poll().move).toEqual([1, 0]);

    h.touch.actions.fire = true;
    h.input.reset();

    expect(h.touch.resets).toBe(1);
    const actions = h.input.poll();
    expect(actions.move).toEqual([0, 0]);
    expect(actions.fire).toBe(false);
  });

  it('works without a touch source', () => {
    const h = harness(false);
    h.keyboardTarget.dispatchEvent(keyEvent('keydown', 'KeyD'));
    const actions = h.input.poll();
    expect(actions.move).toEqual([1, 0]);
    expect(h.input.lastDevice()).toBe('keyboard');
  });

  it('merges real pointer-sequence touch controls into a poll', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const touch = createTouchControls({
      layout: { scale: 1, offsetX: 0, offsetY: 0 },
      lookSensitivity: 0.01,
    });
    touch.mount(host);

    const keyboardTarget = new EventTarget();
    const pointerTarget = new EventTarget();
    const input = createInputManager({
      keyboardTarget,
      pointerTarget,
      getGamepads: () => [],
      isPointerLocked: () => false,
      bindings,
      sensitivity,
      touch,
    });

    const root = host.querySelector('.pr-touch');
    const stickZone = root?.querySelector('.pr-touch__stick-zone');
    const lookZone = root?.querySelector('.pr-touch__look-zone');
    if (!(stickZone instanceof HTMLElement) || !(lookZone instanceof HTMLElement)) {
      throw new Error('touch controls did not mount');
    }

    stickZone.dispatchEvent(pointer('pointerdown', 1, 100, 300));
    stickZone.dispatchEvent(pointer('pointermove', 1, 160, 300));
    lookZone.dispatchEvent(pointer('pointerdown', 2, 400, 200));
    lookZone.dispatchEvent(pointer('pointermove', 2, 420, 200));

    const actions = input.poll();
    expect(actions.move).toEqual([1, 0]);
    expect(actions.look[0]).toBeCloseTo(0.2);
    expect(input.lastDevice()).toBe('touch');

    input.dispose();
    touch.dispose();
    host.remove();
  });
});
