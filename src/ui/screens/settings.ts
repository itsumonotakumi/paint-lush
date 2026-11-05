import './settings.css';
import type { IScreen, ScreenContext } from '../../engine/ports';
import { keyBindingsSchema, type KeyBindings, type SaveData } from '../../game/data/schemas';

type KeyAction = keyof KeyBindings;
type Quality = SaveData['settings']['quality'];

const KEY_ACTIONS: readonly KeyAction[] = [
  'forward',
  'back',
  'left',
  'right',
  'fire',
  'jump',
  'dive',
  'sub',
  'special',
  'pause',
];

const KEY_LABELS: Readonly<Record<KeyAction, string>> = {
  forward: 'まえへ',
  back: 'うしろへ',
  left: 'ひだりへ',
  right: 'みぎへ',
  fire: 'うつ',
  jump: 'ジャンプ',
  dive: 'もぐる',
  sub: 'サブ',
  special: 'ひっさつ',
  pause: 'ポーズ',
};

const QUALITY_OPTIONS: readonly { value: Quality; label: string }[] = [
  { value: 'auto', label: 'じどう' },
  { value: 'low', label: 'ひくい' },
  { value: 'mid', label: 'ふつう' },
  { value: 'high', label: 'たかい' },
];

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function keyLabel(code: string): string {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  switch (code) {
    case 'Space':
      return 'スペース';
    case 'ShiftLeft':
      return 'ひだりシフト';
    case 'ShiftRight':
      return 'みぎシフト';
    case 'ControlLeft':
      return 'ひだりCtrl';
    case 'ControlRight':
      return 'みぎCtrl';
    case 'AltLeft':
      return 'ひだりAlt';
    case 'AltRight':
      return 'みぎAlt';
    case 'ArrowUp':
      return 'うえ';
    case 'ArrowDown':
      return 'した';
    case 'ArrowLeft':
      return 'ひだり';
    case 'ArrowRight':
      return 'みぎ';
    case 'Tab':
      return 'タブ';
    case 'Enter':
      return 'エンター';
    case 'Escape':
      return 'エスケープ';
    case 'Mouse0':
      return 'マウスひだり';
    case 'Mouse1':
      return 'マウスまんなか';
    case 'Mouse2':
      return 'マウスみぎ';
    default:
      return code;
  }
}

function isQuality(value: string): value is Quality {
  return value === 'auto' || value === 'low' || value === 'mid' || value === 'high';
}

interface SliderOptions {
  setting: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function createSlider(options: SliderOptions): HTMLElement {
  const row = createEl('div', 'pr-settings__row');
  const label = createEl('label', 'pr-settings__label');
  const text = createEl('span', 'pr-settings__label-text', options.label);
  const initial = clampFinite(options.value, options.min, options.max, options.min);
  const valueText = createEl('span', 'pr-settings__value', options.format(initial));
  const input = createEl('input', 'pr-slider');
  input.type = 'range';
  input.id = `settings-${options.setting}`;
  input.name = options.setting;
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(initial);
  input.setAttribute('data-setting', options.setting);
  input.setAttribute('aria-label', options.label);
  label.htmlFor = input.id;

  let lastValue = initial;
  input.addEventListener('input', () => {
    const raw = input.value.trim();
    const parsed = raw === '' ? Number.NaN : Number(raw);
    const next = clampFinite(parsed, options.min, options.max, lastValue);
    lastValue = next;
    if (input.value !== String(next)) input.value = String(next);
    valueText.textContent = options.format(next);
    options.onChange(next);
  });

  label.append(text, valueText, input);
  row.append(label);
  return row;
}

interface ToggleOptions {
  setting: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function createToggle(options: ToggleOptions): HTMLElement {
  const row = createEl('div', 'pr-settings__row pr-settings__row--toggle');
  const label = createEl('label', 'pr-settings__toggle-label');
  const text = createEl('span', 'pr-settings__label-text', options.label);
  const input = createEl('input', 'pr-toggle');
  input.type = 'checkbox';
  input.id = `settings-${options.setting}`;
  input.name = options.setting;
  input.checked = options.checked;
  input.setAttribute('data-setting', options.setting);
  input.setAttribute('aria-label', options.label);
  label.htmlFor = input.id;

  input.addEventListener('change', () => options.onChange(input.checked));

  label.append(text, input);
  row.append(label);
  return row;
}

function createGroup(title: string): { group: HTMLElement; body: HTMLElement } {
  const group = createEl('section', 'pr-settings__group');
  const heading = createEl('h2', 'pr-settings__group-title', title);
  const body = createEl('div', 'pr-settings__group-body');
  group.append(heading, body);
  return { group, body };
}

export function createSettingsScreen(): IScreen {
  let cleanup: (() => void) | null = null;

  return {
    mount(root: HTMLElement, ctx: ScreenContext): void {
      if (cleanup !== null) {
        const previous = cleanup;
        cleanup = null;
        previous();
      }

      ctx.audio.setBgm('title');

      const current = ctx.save.load();
      const keyButtons = new Map<KeyAction, HTMLButtonElement>();
      let listening: KeyAction | null = null;

      const screen = createEl('div', 'pr-screen pr-settings');
      screen.setAttribute('data-screen', 'settings');
      const panel = createEl('div', 'pr-settings__panel');
      const title = createEl('h1', 'pr-settings__title', 'せってい');
      const status = createEl('p', 'pr-settings__status');
      status.setAttribute('aria-live', 'polite');

      const setStatus = (text: string, warn = false): void => {
        status.textContent = text;
        status.classList.toggle('is-warn', warn);
      };

      const persist = (): boolean => {
        const saved = ctx.save.save(current);
        if (!saved) {
          setStatus('ほぞんできなかったよ', true);
        } else if (status.classList.contains('is-warn')) {
          setStatus('');
        }
        return saved;
      };

      const endListening = (): void => {
        if (listening === null) return;
        const action = listening;
        listening = null;
        window.removeEventListener('keydown', onKeyDown, true);
        const button = keyButtons.get(action);
        if (button !== undefined) {
          button.classList.remove('is-listening');
          button.textContent = keyLabel(current.settings.keys[action]);
          button.setAttribute('data-code', current.settings.keys[action]);
        }
      };

      const isDuplicate = (action: KeyAction, code: string): boolean => {
        for (const other of KEY_ACTIONS) {
          if (other !== action && current.settings.keys[other] === code) return true;
        }
        return false;
      };

      const isAllowedCode = (action: KeyAction, code: string): boolean => {
        const candidate: KeyBindings = { ...current.settings.keys };
        candidate[action] = code;
        return keyBindingsSchema.safeParse(candidate).success;
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        if (listening === null) return;
        event.preventDefault();
        event.stopPropagation();
        const action = listening;
        const code = typeof event.code === 'string' ? event.code : '';
        if (code === '') {
          endListening();
          setStatus('そのキーは つかえないよ', true);
          return;
        }
        if (isDuplicate(action, code)) {
          endListening();
          setStatus('そのキーは もう つかっているよ', true);
          return;
        }
        if (!isAllowedCode(action, code)) {
          endListening();
          setStatus('そのキーは つかえないよ', true);
          return;
        }
        current.settings.keys[action] = code;
        const saved = persist();
        endListening();
        setStatus(saved ? 'キーを かえたよ' : 'ほぞんできなかったよ', !saved);
      };

      const startListening = (action: KeyAction): void => {
        if (listening !== null) endListening();
        listening = action;
        const button = keyButtons.get(action);
        if (button !== undefined) {
          button.classList.add('is-listening');
          button.textContent = 'キーを おしてね';
          button.focus();
        }
        setStatus('つぎに おしたい キーを おしてね');
        window.addEventListener('keydown', onKeyDown, true);
      };

      const createKeyRow = (action: KeyAction): HTMLElement => {
        const row = createEl('div', 'pr-settings__row pr-settings__row--key');
        const label = createEl('span', 'pr-settings__label-text', KEY_LABELS[action]);
        const button = createEl('button', 'pr-button pr-key-button');
        const code = current.settings.keys[action];
        button.type = 'button';
        button.setAttribute('data-action', action);
        button.setAttribute('data-code', code);
        button.setAttribute('aria-label', `${KEY_LABELS[action]}のキー`);
        button.textContent = keyLabel(code);
        button.addEventListener('click', () => startListening(action));
        keyButtons.set(action, button);
        row.append(label, button);
        return row;
      };

      const sound = createGroup('おと');
      sound.body.append(
        createSlider({
          setting: 'bgm',
          label: 'おんがく',
          min: 0,
          max: 1,
          step: 0.01,
          value: current.settings.volume.bgm,
          format: (value) => `${Math.round(value * 100)}%`,
          onChange: (value) => {
            current.settings.volume.bgm = value;
            ctx.audio.setVolumes({ ...current.settings.volume });
            persist();
          },
        }),
        createSlider({
          setting: 'se',
          label: 'こうかおん',
          min: 0,
          max: 1,
          step: 0.01,
          value: current.settings.volume.se,
          format: (value) => `${Math.round(value * 100)}%`,
          onChange: (value) => {
            current.settings.volume.se = value;
            ctx.audio.setVolumes({ ...current.settings.volume });
            persist();
          },
        }),
        createSlider({
          setting: 'voice',
          label: 'こえ',
          min: 0,
          max: 1,
          step: 0.01,
          value: current.settings.volume.voice,
          format: (value) => `${Math.round(value * 100)}%`,
          onChange: (value) => {
            current.settings.volume.voice = value;
            ctx.audio.setVolumes({ ...current.settings.volume });
            persist();
          },
        }),
      );

      const aim = createGroup('さしどの');
      aim.body.append(
        createSlider({
          setting: 'mouseSensitivity',
          label: 'マウスのかんど',
          min: 0.0001,
          max: 0.05,
          step: 0.000005,
          value: current.settings.mouseSensitivity,
          format: (value) => value.toFixed(4),
          onChange: (value) => {
            current.settings.mouseSensitivity = value;
            persist();
          },
        }),
        createSlider({
          setting: 'stickSensitivity',
          label: 'スティックのかんど',
          min: 0.5,
          max: 15,
          step: 0.002,
          value: current.settings.stickSensitivity,
          format: (value) => value.toFixed(1),
          onChange: (value) => {
            current.settings.stickSensitivity = value;
            persist();
          },
        }),
        createToggle({
          setting: 'invertY',
          label: 'うえしたを はんてん',
          checked: current.settings.invertY,
          onChange: (checked) => {
            current.settings.invertY = checked;
            persist();
          },
        }),
      );

      const look = createGroup('いろと がしつ');
      const qualityRow = createEl('div', 'pr-settings__row');
      const qualityLabel = createEl('label', 'pr-settings__label');
      const qualityText = createEl('span', 'pr-settings__label-text', 'がしつ');
      const quality = createEl('select', 'pr-select');
      quality.id = 'settings-quality';
      quality.name = 'quality';
      quality.setAttribute('data-setting', 'quality');
      quality.setAttribute('aria-label', 'がしつ');
      for (const option of QUALITY_OPTIONS) {
        const optionEl = createEl('option', 'pr-select__option', option.label);
        optionEl.value = option.value;
        quality.append(optionEl);
      }
      quality.value = current.settings.quality;
      quality.addEventListener('change', () => {
        if (!isQuality(quality.value)) return;
        current.settings.quality = quality.value;
        persist();
      });
      qualityLabel.append(qualityText, quality);
      qualityLabel.htmlFor = quality.id;
      qualityRow.append(qualityLabel);

      look.body.append(
        createToggle({
          setting: 'colorblind',
          label: 'いろのサポート',
          checked: current.settings.colorblind,
          onChange: (checked) => {
            current.settings.colorblind = checked;
            persist();
          },
        }),
        qualityRow,
      );

      const touch = createGroup('タッチボタン');
      touch.body.append(
        createSlider({
          setting: 'touchScale',
          label: 'ボタンの おおきさ',
          min: 0.7,
          max: 1.5,
          step: 0.05,
          value: current.settings.touchLayout.scale,
          format: (value) => `${Math.round(value * 100)}%`,
          onChange: (value) => {
            current.settings.touchLayout.scale = value;
            persist();
          },
        }),
      );

      const keyGroup = createGroup('キーを かえる');
      const hint = createEl('p', 'pr-settings__hint', 'かえたい ところを おして、つぎに キーを おしてね');
      keyGroup.body.append(hint);
      for (const action of KEY_ACTIONS) {
        keyGroup.body.append(createKeyRow(action));
      }

      const back = createEl('button', 'pr-button pr-settings__back', 'もどる');
      back.type = 'button';
      back.addEventListener('click', () => {
        endListening();
        ctx.back();
      });

      panel.append(title, sound.group, aim.group, look.group, touch.group, keyGroup.group, status, back);
      screen.append(panel);
      root.append(screen);

      cleanup = (): void => {
        window.removeEventListener('keydown', onKeyDown, true);
        screen.remove();
      };
    },

    unmount(): void {
      if (cleanup === null) return;
      const run = cleanup;
      cleanup = null;
      run();
    },
  };
}
