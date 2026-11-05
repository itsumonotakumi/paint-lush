// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebugPanel } from './debugPanel';
import type { DebugParam } from './debugPanel';

const roots: HTMLElement[] = [];

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  return root;
}

function find(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector(selector);
  expect(el).not.toBeNull();
  if (el === null) throw new Error(`missing ${selector}`);
  return el as HTMLElement;
}

function slider(root: HTMLElement, index: number): HTMLInputElement {
  const inputs = root.querySelectorAll('.pr-debug__input');
  const input = inputs.item(index);
  expect(input).not.toBeNull();
  if (!(input instanceof HTMLInputElement)) throw new Error('missing slider');
  return input;
}

function param(key: string, label: string, initial: number, min = 0, max = 100, step = 1): DebugParam {
  let current = initial;
  return {
    key,
    label,
    min,
    max,
    step,
    get: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

afterEach(() => {
  for (const root of roots) root.remove();
  roots.length = 0;
  vi.restoreAllMocks();
});

describe('createDebugPanel', () => {
  it('is collapsed by default and toggles open and closed', () => {
    const root = makeRoot();
    createDebugPanel(root, [param('speed', '歩行速度', 5)]);

    const body = find(root, '.pr-debug__body');
    const toggle = find(root, '.pr-debug__toggle') as HTMLButtonElement;
    expect(body.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(body.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    expect(body.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders one labelled range per parameter with the current value', () => {
    const root = makeRoot();
    const speed = param('speed', '歩行速度', 4.5, 1, 12, 0.5);
    const gravity = param('gravity', '重力', 22, 0, 60, 1);
    createDebugPanel(root, [speed, gravity]);

    expect(root.querySelectorAll('.pr-debug__input')).toHaveLength(2);
    expect(root.querySelectorAll('.pr-debug__label')).toHaveLength(2);

    const first = slider(root, 0);
    expect(first.type).toBe('range');
    expect(first.min).toBe('1');
    expect(first.max).toBe('12');
    expect(first.step).toBe('0.5');
    expect(first.value).toBe('4.5');
    expect(first.name).toBe('speed');
    expect(first.getAttribute('aria-label')).toBe('歩行速度');
    expect(slider(root, 1).name).toBe('gravity');
    expect(find(root, '.pr-debug__value').textContent).toBe('4.5');
    expect(find(root, '.pr-debug__label').textContent).toBe('歩行速度');
  });

  it('sets the parameter and updates the readout from a slider input', () => {
    const root = makeRoot();
    let current = 4;
    const set = vi.fn((value: number) => {
      current = value;
    });
    const speed: DebugParam = {
      key: 'speed',
      label: '歩行速度',
      min: 0,
      max: 100,
      step: 1,
      get: () => current,
      set,
    };
    createDebugPanel(root, [speed]);

    const input = slider(root, 0);
    input.value = '72';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(72);
    expect(find(root, '.pr-debug__value').textContent).toBe('72');
  });

  it('ignores non-finite slider input', () => {
    const root = makeRoot();
    const set = vi.fn();
    const speed: DebugParam = {
      key: 'speed',
      label: '歩行速度',
      min: 0,
      max: 100,
      step: 1,
      get: () => 4,
      set,
    };
    createDebugPanel(root, [speed]);

    const input = slider(root, 0);
    Object.defineProperty(input, 'value', { configurable: true, get: () => 'NaN' });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(set).not.toHaveBeenCalled();
    expect(find(root, '.pr-debug__value').textContent).toBe('4');

    Object.defineProperty(input, 'value', { configurable: true, get: () => 'Infinity' });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(set).not.toHaveBeenCalled();
    expect(find(root, '.pr-debug__value').textContent).toBe('4');
  });

  it('exports every current value as JSON in a read-only textarea', () => {
    const root = makeRoot();
    const speed = param('speed', '歩行速度', 4.5);
    const gravity = param('gravity', '重力', 22);
    createDebugPanel(root, [speed, gravity]);

    const output = find(root, '.pr-debug__output') as HTMLTextAreaElement;
    expect(output.readOnly).toBe(true);
    expect(output.name).toBe('output');
    expect(output.value).toBe('');

    (find(root, '.pr-debug__export') as HTMLButtonElement).click();
    expect(JSON.parse(output.value)).toEqual({ speed: 4.5, gravity: 22 });

    const input = slider(root, 0);
    input.value = '9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (find(root, '.pr-debug__export') as HTMLButtonElement).click();
    expect(JSON.parse(output.value)).toEqual({ speed: 9, gravity: 22 });
  });

  it('renders markup-like labels as text without creating elements', () => {
    const root = makeRoot();
    createDebugPanel(root, [param('speed', '<img src=x>', 1)]);

    expect(find(root, '.pr-debug__label').textContent).toBe('<img src=x>');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelectorAll('*')).not.toHaveLength(0);
  });

  it('removes all listeners and elements on dispose', () => {
    const root = makeRoot();
    const set = vi.fn();
    const speed: DebugParam = {
      key: 'speed',
      label: '歩行速度',
      min: 0,
      max: 100,
      step: 1,
      get: () => 4,
      set,
    };
    const panel = createDebugPanel(root, [speed]);
    const toggle = find(root, '.pr-debug__toggle') as HTMLButtonElement;
    const input = slider(root, 0);

    panel.dispose();
    expect(root.querySelector('.pr-debug')).toBeNull();

    toggle.click();
    input.value = '50';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(set).not.toHaveBeenCalled();
  });
});
