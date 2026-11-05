import './ui.css';

export interface DebugParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
}

interface Row {
  param: DebugParam;
  input: HTMLInputElement;
  value: HTMLElement;
  min: number;
  max: number;
}

function createDiv(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

function rangeOf(param: DebugParam): { min: number; max: number; step: number } {
  const min = safeNumber(param.min, 0);
  const max = Math.max(min, safeNumber(param.max, min + 100));
  const step = Number.isFinite(param.step) && param.step > 0 ? param.step : 1;
  return { min, max, step };
}

export interface DebugPanel {
  dispose(): void;
}

type Cleanup = () => void;

function listen(el: HTMLElement, type: string, handler: (event: Event) => void, cleanups: Cleanup[]): void {
  el.addEventListener(type, handler);
  cleanups.push(() => el.removeEventListener(type, handler));
}

export function createDebugPanel(root: HTMLElement, params: readonly DebugParam[]): DebugPanel {
  const panel = createDiv('pr-debug');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pr-debug__toggle';
  toggle.textContent = 'デバッグ';
  toggle.setAttribute('aria-expanded', 'false');

  const body = createDiv('pr-debug__body');
  body.hidden = true;

  const rows: Row[] = [];

  for (const param of params) {
    const range = rangeOf(param);
    const row = createDiv('pr-debug__row');
    const label = document.createElement('span');
    label.className = 'pr-debug__label';
    label.textContent = param.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'pr-debug__input';
    input.name = param.key;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.setAttribute('aria-label', param.label);

    const value = document.createElement('span');
    value.className = 'pr-debug__value';

    const current = param.get();
    input.value = String(clamp(safeNumber(current, range.min), range.min, range.max));
    value.textContent = formatValue(current);

    row.append(label, input, value);
    body.append(row);
    rows.push({ param, input, value, min: range.min, max: range.max });
  }

  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'pr-debug__export';
  exportButton.textContent = '値を書き出す';

  const output = document.createElement('textarea');
  output.className = 'pr-debug__output';
  output.name = 'output';
  output.readOnly = true;
  output.setAttribute('aria-label', '書き出した値');
  output.rows = 5;
  output.spellcheck = false;

  body.append(exportButton, output);
  panel.append(toggle, body);
  root.append(panel);

  const cleanups: Cleanup[] = [];
  let disposed = false;

  listen(
    toggle,
    'click',
    () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    },
    cleanups,
  );

  for (const row of rows) {
    listen(
      row.input,
      'input',
      () => {
        const raw = Number(row.input.value);
        if (!Number.isFinite(raw)) return;
        row.param.set(raw);
        const current = row.param.get();
        const shown = Number.isFinite(current) ? current : raw;
        setText(row.value, formatValue(shown));
        const nextInput = String(clamp(shown, row.min, row.max));
        if (row.input.value !== nextInput) row.input.value = nextInput;
      },
      cleanups,
    );
  }

  listen(
    exportButton,
    'click',
    () => {
      const data: Record<string, number> = {};
      for (const row of rows) {
        const current = row.param.get();
        data[row.param.key] = Number.isFinite(current) ? current : 0;
      }
      output.value = JSON.stringify(data, null, 2);
    },
    cleanups,
  );

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      panel.remove();
    },
  };
}
