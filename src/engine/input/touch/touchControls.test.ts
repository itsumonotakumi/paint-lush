// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTouchControls } from './touchControls';
import type { TouchControlsOptions } from './touchControls';

const defaultOptions: TouchControlsOptions = {
  layout: { scale: 1, offsetX: 0, offsetY: 0 },
  lookSensitivity: 0.01,
};

const liveControls: ReturnType<typeof createTouchControls>[] = [];

afterEach(() => {
  for (const controls of liveControls.splice(0)) controls.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

interface Setup {
  controls: ReturnType<typeof createTouchControls>;
  host: HTMLElement;
  root: HTMLElement;
  stickZone: HTMLElement;
  lookZone: HTMLElement;
  button: (label: string) => HTMLElement;
}

function query<T extends Element>(parent: ParentNode, selector: string): T {
  const el = parent.querySelector(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el as T;
}

function setup(options: Partial<TouchControlsOptions> = {}): Setup {
  const merged: TouchControlsOptions = {
    layout: { ...defaultOptions.layout, ...options.layout },
    lookSensitivity: options.lookSensitivity ?? defaultOptions.lookSensitivity,
  };
  if (options.now !== undefined) merged.now = options.now;
  const host = document.createElement('div');
  document.body.append(host);
  const controls = createTouchControls(merged);
  liveControls.push(controls);
  controls.mount(host);
  const root = query<HTMLElement>(host, '.pr-touch');
  return {
    controls,
    host,
    root,
    stickZone: query<HTMLElement>(root, '.pr-touch__stick-zone'),
    lookZone: query<HTMLElement>(root, '.pr-touch__look-zone'),
    button(label: string) {
      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.pr-touch__button'));
      const found = buttons.find((el) => el.textContent === label);
      if (found === undefined) throw new Error(`missing button ${label}`);
      return found;
    },
  };
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

describe('createTouchControls', () => {
  it('uses the touch-down point as the stick centre and applies a 0.1 deadzone', () => {
    const s = setup();

    s.stickZone.dispatchEvent(pointer('pointerdown', 1, 40, 300));
    expect(s.controls.read().move).toEqual([0, 0]);

    // Tiny wobble inside the deadzone reads as zero.
    s.stickZone.dispatchEvent(pointer('pointermove', 1, 45, 300));
    expect(s.controls.read().move).toEqual([0, 0]);

    // 30 px of a 60 px radius is half travel, rescaled past the deadzone.
    s.stickZone.dispatchEvent(pointer('pointermove', 1, 70, 300));
    const half = s.controls.read().move;
    expect(half[0]).toBeCloseTo((0.5 - 0.1) / 0.9);
    expect(half[1]).toBeCloseTo(0);

    // The same finger position relative to the centre, not to the screen edge.
    s.stickZone.dispatchEvent(pointer('pointermove', 1, 100, 300));
    expect(s.controls.read().move).toEqual([1, 0]);

    // Pulling past the radius stays clamped to one.
    s.stickZone.dispatchEvent(pointer('pointermove', 1, 220, 300));
    expect(s.controls.read().move).toEqual([1, 0]);
  });

  it('maps screen-up to forward and normalises diagonal stick input', () => {
    const s = setup();
    s.stickZone.dispatchEvent(pointer('pointerdown', 2, 100, 100));
    s.stickZone.dispatchEvent(pointer('pointermove', 2, 160, 40));

    const move = s.controls.read().move;
    expect(move[0]).toBeCloseTo(Math.SQRT1_2);
    expect(move[1]).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(move[0], move[1])).toBeCloseTo(1);
  });

  it('accumulates right-half drag as look and clears it on read', () => {
    const s = setup({ lookSensitivity: 0.02 });
    s.lookZone.dispatchEvent(pointer('pointerdown', 3, 400, 200));
    s.lookZone.dispatchEvent(pointer('pointermove', 3, 410, 200));
    s.lookZone.dispatchEvent(pointer('pointermove', 3, 415, 210));
    // Releasing before the next poll keeps the pending deltas.
    s.lookZone.dispatchEvent(pointer('pointerup', 3, 415, 210));

    const look = s.controls.read().look;
    expect(look[0]).toBeCloseTo(0.3);
    expect(look[1]).toBeCloseTo(-0.2);

    expect(s.controls.read().look).toEqual([0, 0]);
  });

  it('keeps stick, look and button fingers isolated', () => {
    const s = setup({ lookSensitivity: 0.01 });

    s.stickZone.dispatchEvent(pointer('pointerdown', 10, 100, 300));
    s.stickZone.dispatchEvent(pointer('pointermove', 10, 160, 300));
    s.lookZone.dispatchEvent(pointer('pointerdown', 11, 400, 200));
    s.lookZone.dispatchEvent(pointer('pointermove', 11, 430, 200));
    const fire = s.button('うつ');
    fire.dispatchEvent(pointer('pointerdown', 12, 600, 500));

    const actions = s.controls.read();
    expect(actions.move).toEqual([1, 0]);
    expect(actions.look[0]).toBeCloseTo(0.3);
    expect(actions.look[1]).toBeCloseTo(0);
    expect(actions.fire).toBe(true);

    fire.dispatchEvent(pointer('pointerup', 12, 600, 500));
    const second = s.controls.read();
    expect(second.move).toEqual([1, 0]);
    expect(second.fire).toBe(false);
  });

  it('does not move the view when a finger presses and drags a button', () => {
    const s = setup();
    const jump = s.button('ジャンプ');

    jump.dispatchEvent(pointer('pointerdown', 20, 520, 520));
    jump.dispatchEvent(pointer('pointermove', 20, 620, 120));

    const actions = s.controls.read();
    expect(actions.jump).toBe(true);
    expect(actions.fire).toBe(false);
    expect(actions.move).toEqual([0, 0]);
    expect(actions.look).toEqual([0, 0]);
  });

  it('routes pointer events sent straight to the overlay by screen half', () => {
    const s = setup();
    s.root.dispatchEvent(pointer('pointerdown', 80, 100, 300));
    s.root.dispatchEvent(pointer('pointermove', 80, 160, 300));
    expect(s.controls.read().move).toEqual([1, 0]);

    s.root.dispatchEvent(pointer('pointerdown', 81, 700, 200));
    s.root.dispatchEvent(pointer('pointermove', 81, 710, 190));
    const look = s.controls.read().look;
    expect(look[0]).toBeCloseTo(0.1);
    expect(look[1]).toBeCloseTo(0.1);

    s.root.dispatchEvent(pointer('pointerup', 80, 160, 300));
    expect(s.controls.read().move).toEqual([0, 0]);
  });

  it('reports every labelled button, including pause', () => {
    const s = setup();
    const labels = ['うつ', 'ジャンプ', 'もぐる', 'ボム', 'おうぎ', 'ポーズ'];
    for (const label of labels) {
      const button = s.button(label);
      expect(button.textContent).toBe(label);
      button.dispatchEvent(pointer('pointerdown', 30, 600, 500));
    }

    const actions = s.controls.read();
    expect(actions.fire).toBe(true);
    expect(actions.jump).toBe(true);
    expect(actions.dive).toBe(true);
    expect(actions.sub).toBe(true);
    expect(actions.special).toBe(true);
    expect(actions.pause).toBe(true);

    for (const label of labels) {
      s.button(label).dispatchEvent(pointer('pointerup', 30, 600, 500));
    }
    expect(s.controls.read().fire).toBe(false);
  });

  it('clears held state on pointercancel and lostpointercapture', () => {
    const s = setup();

    s.stickZone.dispatchEvent(pointer('pointerdown', 40, 100, 300));
    s.stickZone.dispatchEvent(pointer('pointermove', 40, 160, 300));
    expect(s.controls.read().move).toEqual([1, 0]);
    s.stickZone.dispatchEvent(pointer('pointercancel', 40, 160, 300));
    expect(s.controls.read().move).toEqual([0, 0]);

    const dive = s.button('もぐる');
    dive.dispatchEvent(pointer('pointerdown', 41, 600, 500));
    expect(s.controls.read().dive).toBe(true);
    dive.dispatchEvent(pointer('lostpointercapture', 41, 600, 500));
    expect(s.controls.read().dive).toBe(false);

    s.lookZone.dispatchEvent(pointer('pointerdown', 42, 400, 200));
    s.lookZone.dispatchEvent(pointer('pointermove', 42, 450, 200));
    s.lookZone.dispatchEvent(pointer('pointercancel', 42, 450, 200));
    expect(s.controls.read().look).toEqual([0, 0]);

    // A cancelled pointer no longer controls anything, even if it moves again.
    s.lookZone.dispatchEvent(pointer('pointermove', 42, 900, 900));
    s.stickZone.dispatchEvent(pointer('pointermove', 40, 500, 500));
    const after = s.controls.read();
    expect(after.look).toEqual([0, 0]);
    expect(after.move).toEqual([0, 0]);
  });

  it('drops held stick, look and buttons on reset', () => {
    const s = setup({ lookSensitivity: 0.01 });
    s.stickZone.dispatchEvent(pointer('pointerdown', 55, 100, 300));
    s.stickZone.dispatchEvent(pointer('pointermove', 55, 160, 300));
    s.lookZone.dispatchEvent(pointer('pointerdown', 56, 400, 200));
    s.lookZone.dispatchEvent(pointer('pointermove', 56, 430, 200));
    s.button('うつ').dispatchEvent(pointer('pointerdown', 57, 600, 500));

    const before = s.controls.read();
    expect(before.move).toEqual([1, 0]);
    expect(before.look[0]).toBeCloseTo(0.3);
    expect(before.fire).toBe(true);

    // Queue a look delta without reading it, then reset.
    s.lookZone.dispatchEvent(pointer('pointermove', 56, 450, 200));
    s.stickZone.dispatchEvent(pointer('pointermove', 55, 160, 300));
    s.controls.reset();

    const after = s.controls.read();
    expect(after.move).toEqual([0, 0]);
    expect(after.look).toEqual([0, 0]);
    expect(after.fire).toBe(false);

    // The old fingers stay forgotten until they lift and press again.
    s.stickZone.dispatchEvent(pointer('pointermove', 55, 220, 300));
    expect(s.controls.read().move).toEqual([0, 0]);
  });

  it('hides, clears and restores the overlay with setVisible', () => {
    const s = setup();
    s.stickZone.dispatchEvent(pointer('pointerdown', 50, 100, 300));
    s.stickZone.dispatchEvent(pointer('pointermove', 50, 160, 300));
    s.button('ボム').dispatchEvent(pointer('pointerdown', 51, 600, 500));
    expect(s.controls.read().move).toEqual([1, 0]);

    s.controls.setVisible(false);
    expect(s.root.hidden).toBe(true);
    expect(s.root.classList.contains('pr-touch--hidden')).toBe(true);
    const hidden = s.controls.read();
    expect(hidden.move).toEqual([0, 0]);
    expect(hidden.sub).toBe(false);

    s.controls.setVisible(true);
    expect(s.root.hidden).toBe(false);
    expect(s.root.classList.contains('pr-touch--hidden')).toBe(false);
  });

  it('applies layout scale and offsets as CSS variables', () => {
    const s = setup({ layout: { scale: 1.5, offsetX: 0.1, offsetY: -0.2 } });
    expect(s.root.style.getPropertyValue('--pr-touch-scale')).toBe('1.5');
    expect(s.root.style.getPropertyValue('--pr-touch-offset-x')).toBe('0.1');
    expect(s.root.style.getPropertyValue('--pr-touch-offset-y')).toBe('-0.2');
  });

  it('uses the scaled stick radius', () => {
    const s = setup({ layout: { scale: 2, offsetX: 0, offsetY: 0 } });
    s.stickZone.dispatchEvent(pointer('pointerdown', 60, 100, 300));
    // 60 px is half of a 120 px scaled radius.
    s.stickZone.dispatchEvent(pointer('pointermove', 60, 160, 300));
    const move = s.controls.read().move;
    expect(move[0]).toBeCloseTo((0.5 - 0.1) / 0.9);
  });

  it('removes every listener and the DOM on dispose', () => {
    const s = setup();
    s.stickZone.dispatchEvent(pointer('pointerdown', 70, 100, 300));
    s.stickZone.dispatchEvent(pointer('pointermove', 70, 160, 300));
    expect(s.controls.read().move).toEqual([1, 0]);

    s.controls.dispose();
    expect(s.host.contains(s.root)).toBe(false);

    s.stickZone.dispatchEvent(pointer('pointermove', 70, 200, 300));
    s.button('うつ').dispatchEvent(pointer('pointerdown', 71, 600, 500));
    const after = s.controls.read();
    expect(after.move).toEqual([0, 0]);
    expect(after.fire).toBe(false);

    // Disposing twice is harmless.
    s.controls.dispose();
  });
});

function dispatch(type: string, cancelable = true): Event {
  const event = new Event(type, { cancelable, bubbles: true });
  document.dispatchEvent(event);
  return event;
}

describe('touch zoom guards', () => {
  it('adds passive:false document listeners once on mount and removes them on dispose', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const controls = createTouchControls(defaultOptions);
    const host = document.createElement('div');
    document.body.append(host);

    controls.mount(host);
    controls.mount(host);

    const added = addSpy.mock.calls.map((call) => call[0]);
    expect(added.filter((type) => type === 'gesturestart')).toHaveLength(1);
    expect(added.filter((type) => type === 'gesturechange')).toHaveLength(1);
    expect(added.filter((type) => type === 'gestureend')).toHaveLength(1);
    expect(added.filter((type) => type === 'touchmove')).toHaveLength(1);
    expect(added.filter((type) => type === 'touchend')).toHaveLength(1);
    expect(added.filter((type) => type === 'dblclick')).toHaveLength(1);

    const gestureAdd = addSpy.mock.calls.find((call) => call[0] === 'gesturestart');
    expect(gestureAdd?.[2]).toEqual({ passive: false });

    controls.dispose();
    const removed = removeSpy.mock.calls.map((call) => call[0]);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'touchmove', 'touchend', 'dblclick']) {
      expect(removed).toContain(type);
    }
  });

  it('blocks gestures while mounted, and page movement only while visible', () => {
    const s = setup();

    expect(dispatch('gesturestart').defaultPrevented).toBe(true);
    expect(dispatch('gesturechange').defaultPrevented).toBe(true);
    expect(dispatch('gestureend').defaultPrevented).toBe(true);
    expect(dispatch('touchmove').defaultPrevented).toBe(true);
    expect(dispatch('dblclick').defaultPrevented).toBe(true);

    // A non-cancelable move cannot be blocked and must not throw.
    expect(dispatch('touchmove', false).defaultPrevented).toBe(false);

    s.controls.setVisible(false);
    expect(dispatch('touchmove').defaultPrevented).toBe(false);
    expect(dispatch('dblclick').defaultPrevented).toBe(false);
    // The Safari gesture events stay blocked even under a pause menu.
    expect(dispatch('gesturestart').defaultPrevented).toBe(true);

    s.controls.setVisible(true);
    expect(dispatch('touchmove').defaultPrevented).toBe(true);
  });

  it('prevents the second touchend only when it lands within 350 ms', () => {
    let clock = 0;
    const s = setup({ now: () => clock });

    clock = 1000;
    expect(dispatch('touchend').defaultPrevented).toBe(false);
    clock = 1100;
    expect(dispatch('touchend').defaultPrevented).toBe(true);
    clock = 1500;
    expect(dispatch('touchend').defaultPrevented).toBe(false);
    clock = 1510;
    expect(dispatch('touchend').defaultPrevented).toBe(true);

    // Hiding the controls forgets the previous tap.
    s.controls.setVisible(false);
    s.controls.setVisible(true);
    clock = 1600;
    expect(dispatch('touchend').defaultPrevented).toBe(false);
  });

  it('stops guarding after dispose', () => {
    const s = setup();
    s.controls.dispose();
    expect(dispatch('gesturestart').defaultPrevented).toBe(false);
    expect(dispatch('touchmove').defaultPrevented).toBe(false);
  });
});

describe('setSpecialGauge', () => {
  it('clamps values, writes a percentage and toggles the ready class', () => {
    const s = setup();
    const special = s.button('おうぎ');

    s.controls.setSpecialGauge(0.375);
    expect(special.style.getPropertyValue('--pr-special-fill')).toBe('37.5%');
    expect(special.classList.contains('pr-touch__button--ready')).toBe(false);

    s.controls.setSpecialGauge(0.998);
    expect(special.style.getPropertyValue('--pr-special-fill')).toBe('99.8%');
    expect(special.classList.contains('pr-touch__button--ready')).toBe(false);

    s.controls.setSpecialGauge(0.999);
    expect(special.style.getPropertyValue('--pr-special-fill')).toBe('99.9%');
    expect(special.classList.contains('pr-touch__button--ready')).toBe(true);

    s.controls.setSpecialGauge(5);
    expect(special.style.getPropertyValue('--pr-special-fill')).toBe('100.0%');
    expect(special.classList.contains('pr-touch__button--ready')).toBe(true);

    s.controls.setSpecialGauge(-2);
    expect(special.style.getPropertyValue('--pr-special-fill')).toBe('0.0%');
    expect(special.classList.contains('pr-touch__button--ready')).toBe(false);

    s.controls.setSpecialGauge(Number.NaN);
    expect(special.style.getPropertyValue('--pr-special-fill')).toBe('0.0%');
    s.controls.setSpecialGauge(Number.POSITIVE_INFINITY);
    expect(special.style.getPropertyValue('--pr-special-fill')).toBe('0.0%');
  });

  it('writes the CSS variable only when the clamped value changes', () => {
    const s = setup();
    const special = s.button('おうぎ');
    const spy = vi.spyOn(special.style, 'setProperty');

    s.controls.setSpecialGauge(0.5);
    s.controls.setSpecialGauge(0.5);
    expect(spy).toHaveBeenCalledTimes(1);

    // Different raw values that clamp to the same result do not write again.
    s.controls.setSpecialGauge(4);
    s.controls.setSpecialGauge(9);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('clamps before writing so out-of-range inputs cannot leak', () => {
    const s = setup();
    const special = s.button('おうぎ');
    const spy = vi.spyOn(special.style, 'setProperty');
    s.controls.setSpecialGauge(Number.POSITIVE_INFINITY);
    expect(spy).toHaveBeenCalledWith('--pr-special-fill', '0.0%');
  });
});
