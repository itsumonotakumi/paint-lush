// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAudio, ISaveStore, ScreenContext } from '../../engine/ports';
import { defaultSave } from '../../engine/save/saveStore';
import type { SaveData } from '../../game/data/schemas';
import { createSettingsScreen } from './settings';

const roots: HTMLElement[] = [];
const screens: ReturnType<typeof createSettingsScreen>[] = [];

interface FakeSave {
  store: ISaveStore;
  data: () => SaveData;
  saves: SaveData[];
}

function createFakeSave(initial: SaveData = defaultSave(), failSave = false): FakeSave {
  let current = initial;
  const saves: SaveData[] = [];
  return {
    store: {
      load: () => current,
      save: (data: SaveData): boolean => {
        saves.push(data);
        if (failSave) return false;
        current = data;
        return true;
      },
    },
    data: () => current,
    saves,
  };
}

interface Setup {
  root: HTMLElement;
  screen: ReturnType<typeof createSettingsScreen>;
  fake: FakeSave;
  setVolumes: ReturnType<typeof vi.fn>;
  setBgm: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
}

function setup(options: { initial?: SaveData; failSave?: boolean } = {}): Setup {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);

  const fake = createFakeSave(options.initial ?? defaultSave(), options.failSave ?? false);
  const setVolumes = vi.fn((volumes: { bgm: number; se: number; voice: number }) => {
    void volumes;
  });
  const back = vi.fn();
  const setBgm = vi.fn();
  const audio: IAudio = {
    unlock: vi.fn(async () => undefined),
    handle: vi.fn(),
    setBgm,
    setVolumes,
  };
  const ctx: ScreenContext = {
    save: fake.store,
    audio,
    go: vi.fn(),
    start: vi.fn(),
    back,
  };

  const screen = createSettingsScreen();
  screen.mount(root, ctx, { kind: 'none' });
  screens.push(screen);
  return { root, screen, fake, setVolumes, setBgm, back };
}

function input(root: HTMLElement, setting: string): HTMLInputElement {
  const found = root.querySelector<HTMLInputElement>(`[data-setting="${setting}"]`);
  if (found === null) throw new Error(`missing input ${setting}`);
  return found;
}

function select(root: HTMLElement, setting: string): HTMLSelectElement {
  const found = root.querySelector<HTMLSelectElement>(`[data-setting="${setting}"]`);
  if (found === null) throw new Error(`missing select ${setting}`);
  return found;
}

function keyButton(root: HTMLElement, action: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (found === null) throw new Error(`missing key button ${action}`);
  return found;
}

function setSlider(root: HTMLElement, setting: string, value: number): void {
  const slider = input(root, setting);
  slider.value = String(value);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

function setCheckbox(root: HTMLElement, setting: string, checked: boolean): void {
  const checkbox = input(root, setting);
  checkbox.checked = checked;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}

function pressKey(code: string): boolean {
  const event = new KeyboardEvent('keydown', {
    code,
    key: code,
    bubbles: true,
    cancelable: true,
  });
  return document.dispatchEvent(event);
}

afterEach(() => {
  for (const screen of screens) screen.unmount();
  screens.length = 0;
  for (const root of roots) root.remove();
  roots.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createSettingsScreen layout', () => {
  it('plays the title track so leaving settings never leaves the menu silent', () => {
    const { setBgm } = setup();
    expect(setBgm).toHaveBeenCalledWith('title');
  });

  it('renders a bright pr-screen with every control and the pr-button class', () => {
    const { root } = setup();

    const screen = root.querySelector<HTMLElement>('.pr-screen.pr-settings');
    expect(screen).not.toBeNull();
    expect(root.querySelector('.pr-settings__title')?.textContent).toBe('せってい');

    for (const setting of ['bgm', 'se', 'voice', 'mouseSensitivity', 'stickSensitivity', 'touchScale']) {
      expect(input(root, setting).type, setting).toBe('range');
    }
    for (const setting of ['invertY', 'colorblind']) {
      expect(input(root, setting).type, setting).toBe('checkbox');
    }

    const quality = select(root, 'quality');
    expect(Array.from(quality.options).map((option) => option.value)).toEqual(['auto', 'low', 'mid', 'high']);
    expect(Array.from(quality.options).map((option) => option.textContent)).toEqual([
      'じどう',
      'ひくい',
      'ふつう',
      'たかい',
    ]);

    const back = root.querySelector<HTMLButtonElement>('.pr-settings__back');
    expect(back).not.toBeNull();
    expect(back?.classList.contains('pr-button')).toBe(true);
    expect(back?.textContent).toBe('もどる');
  });

  it('shows all ten actions with their current key codes', () => {
    const { root } = setup();
    const expected: Array<[string, string]> = [
      ['forward', 'KeyW'],
      ['back', 'KeyS'],
      ['left', 'KeyA'],
      ['right', 'KeyD'],
      ['fire', 'Mouse0'],
      ['jump', 'Space'],
      ['dive', 'ShiftLeft'],
      ['sub', 'KeyE'],
      ['special', 'KeyQ'],
      ['pause', 'Escape'],
    ];

    for (const [action, code] of expected) {
      const button = keyButton(root, action);
      expect(button.classList.contains('pr-button')).toBe(true);
      expect(button.getAttribute('data-code'), action).toBe(code);
      expect(button.textContent?.length, action).toBeGreaterThan(0);
    }
  });
});

describe('volumes', () => {
  it('saves each volume and updates the audio system live', () => {
    const { root, fake, setVolumes } = setup();

    setSlider(root, 'bgm', 0.5);
    expect(fake.data().settings.volume.bgm).toBe(0.5);
    expect(setVolumes).toHaveBeenLastCalledWith({ bgm: 0.5, se: 0.8, voice: 0.8 });
    expect(fake.saves).toHaveLength(1);

    setSlider(root, 'se', 0.25);
    expect(setVolumes).toHaveBeenLastCalledWith({ bgm: 0.5, se: 0.25, voice: 0.8 });
    expect(fake.saves).toHaveLength(2);

    setSlider(root, 'voice', 0);
    expect(setVolumes).toHaveBeenLastCalledWith({ bgm: 0.5, se: 0.25, voice: 0 });
    expect(fake.saves).toHaveLength(3);
  });
});

describe('aim and touch settings', () => {
  it('saves mouse and stick sensitivity', () => {
    const { root, fake } = setup();

    setSlider(root, 'mouseSensitivity', 0.01);
    expect(fake.data().settings.mouseSensitivity).toBe(0.01);
    setSlider(root, 'stickSensitivity', 4.5);
    expect(fake.data().settings.stickSensitivity).toBe(4.5);
    expect(fake.saves).toHaveLength(2);
  });

  it('saves invert Y and colour support toggles', () => {
    const { root, fake } = setup();

    setCheckbox(root, 'invertY', true);
    expect(fake.data().settings.invertY).toBe(true);
    setCheckbox(root, 'colorblind', true);
    expect(fake.data().settings.colorblind).toBe(true);
    expect(fake.saves).toHaveLength(2);
  });

  it('saves the quality choice and ignores an unknown select value', () => {
    const { root, fake } = setup();

    const quality = select(root, 'quality');
    quality.value = 'high';
    quality.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fake.data().settings.quality).toBe('high');
    expect(fake.saves).toHaveLength(1);

    quality.value = 'ultra';
    quality.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fake.data().settings.quality).toBe('high');
    expect(fake.saves).toHaveLength(1);
  });

  it('saves the touch button size and keeps the offsets untouched', () => {
    const { root, fake } = setup();

    setSlider(root, 'touchScale', 1.3);
    expect(fake.data().settings.touchLayout).toEqual({ scale: 1.3, offsetX: 0, offsetY: 0 });
    expect(fake.saves).toHaveLength(1);
  });
});

describe('key rebinding', () => {
  it('listens for the next key and saves the KeyboardEvent.code', () => {
    const { root, fake } = setup();
    const button = keyButton(root, 'fire');

    button.click();
    expect(button.classList.contains('is-listening')).toBe(true);
    expect(button.textContent).toBe('キーを おしてね');

    const notCancelled = pressKey('KeyR');

    expect(notCancelled).toBe(false);
    expect(fake.data().settings.keys.fire).toBe('KeyR');
    expect(button.getAttribute('data-code')).toBe('KeyR');
    expect(button.textContent).toBe('R');
    expect(button.classList.contains('is-listening')).toBe(false);
    expect(fake.saves).toHaveLength(1);
    expect(root.querySelector('.pr-settings__status')?.textContent).toBe('キーを かえたよ');
  });

  it('rejects a code that the bindings schema does not allow', () => {
    const { root, fake } = setup();
    const button = keyButton(root, 'fire');

    button.click();
    pressKey('F13');

    expect(fake.data().settings.keys.fire).toBe('Mouse0');
    expect(button.getAttribute('data-code')).toBe('Mouse0');
    expect(button.classList.contains('is-listening')).toBe(false);
    expect(fake.saves).toHaveLength(0);
    expect(root.querySelector('.pr-settings__status')?.textContent).toBe('そのキーは つかえないよ');
  });

  it('rejects a key already bound to another action', () => {
    const { root, fake } = setup();
    const button = keyButton(root, 'fire');

    button.click();
    pressKey('KeyW');

    expect(fake.data().settings.keys.fire).toBe('Mouse0');
    expect(fake.data().settings.keys.forward).toBe('KeyW');
    expect(button.getAttribute('data-code')).toBe('Mouse0');
    expect(button.classList.contains('is-listening')).toBe(false);
    expect(fake.saves).toHaveLength(0);
    expect(root.querySelector('.pr-settings__status')?.textContent).toBe('そのキーは もう つかっているよ');
  });

  it('allows keeping the same key on the same action', () => {
    const { root, fake } = setup();
    const button = keyButton(root, 'forward');

    button.click();
    pressKey('KeyW');

    expect(fake.data().settings.keys.forward).toBe('KeyW');
    expect(fake.saves).toHaveLength(1);
    expect(root.querySelector('.pr-settings__status')?.textContent).toBe('キーを かえたよ');
  });

  it('can switch the listening target before pressing a key', () => {
    const { root, fake } = setup();
    const fire = keyButton(root, 'fire');
    const jump = keyButton(root, 'jump');

    fire.click();
    jump.click();
    expect(fire.classList.contains('is-listening')).toBe(false);
    expect(jump.classList.contains('is-listening')).toBe(true);

    pressKey('KeyZ');
    expect(fake.data().settings.keys.fire).toBe('Mouse0');
    expect(fake.data().settings.keys.jump).toBe('KeyZ');
  });
});

describe('no gyro control', () => {
  it('renders no gyro toggle or label', () => {
    const { root } = setup();

    expect(root.querySelector('[data-setting="gyro"]')).toBeNull();
    expect(root.querySelector('[name="gyro"]')).toBeNull();
    expect(root.textContent).not.toContain('ジャイロ');
  });

  it('never calls DeviceOrientationEvent.requestPermission while using the screen', () => {
    const requestPermission = vi.fn(() => Promise.resolve('granted'));
    class FakeDeviceOrientationEvent {
      static requestPermission = requestPermission;
    }
    vi.stubGlobal('DeviceOrientationEvent', FakeDeviceOrientationEvent);

    const { root } = setup();

    for (const setting of ['invertY', 'colorblind']) {
      setCheckbox(root, setting, true);
      setCheckbox(root, setting, false);
    }
    for (const setting of ['bgm', 'se', 'voice', 'mouseSensitivity', 'stickSensitivity', 'touchScale']) {
      setSlider(root, setting, 0.5);
    }
    const quality = select(root, 'quality');
    quality.value = 'high';
    quality.dispatchEvent(new Event('change', { bubbles: true }));

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('keeps the saved gyro field untouched when another setting changes', () => {
    const initial = defaultSave();
    initial.settings.gyro = true;
    const { root, fake } = setup({ initial });

    setSlider(root, 'bgm', 0.5);

    expect(fake.data().settings.gyro).toBe(true);
    expect(fake.saves).toHaveLength(1);
    expect(fake.saves[0]?.settings.gyro).toBe(true);
  });

  it('does not touch gyro when it is saved as false', () => {
    const { root, fake } = setup();

    setCheckbox(root, 'invertY', true);

    expect(fake.data().settings.gyro).toBe(false);
  });
});

describe('navigation, failure and cleanup', () => {
  it('calls back when もどる is pressed', () => {
    const { root, back } = setup();
    const button = root.querySelector<HTMLButtonElement>('.pr-settings__back');
    if (button === null) throw new Error('missing back button');

    button.click();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('shows a warning when storage refuses the write', () => {
    const { root, fake } = setup({ failSave: true });

    setSlider(root, 'bgm', 0.5);

    expect(fake.data().settings.volume.bgm).toBe(0.5);
    expect(root.querySelector('.pr-settings__status')?.textContent).toBe('ほぞんできなかったよ');
    expect(root.querySelector('.pr-settings__status')?.classList.contains('is-warn')).toBe(true);
  });

  it('removes the screen and the document key listener on unmount', () => {
    const { root, screen, fake } = setup();
    const button = keyButton(root, 'fire');
    button.click();

    screen.unmount();
    expect(root.querySelector('.pr-screen')).toBeNull();

    pressKey('KeyR');
    expect(fake.data().settings.keys.fire).toBe('Mouse0');
    expect(fake.saves).toHaveLength(0);

    expect(() => screen.unmount()).not.toThrow();
  });

  it('replaces an earlier mount instead of stacking two screens', () => {
    const { root, screen } = setup();
    const fake = createFakeSave();
    const ctx: ScreenContext = {
      save: fake.store,
      audio: {
        unlock: vi.fn(async () => undefined),
        handle: vi.fn(),
        setBgm: vi.fn(),
        setVolumes: vi.fn(),
      },
      go: vi.fn(),
      start: vi.fn(),
      back: vi.fn(),
    };

    screen.mount(root, ctx, { kind: 'none' });
    expect(root.querySelectorAll('.pr-screen')).toHaveLength(1);
  });
});
