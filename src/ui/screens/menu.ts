import type { IScreen, ScreenContext } from '../../engine/ports';

function createEl(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function createRuby(base: string, reading: string): HTMLElement {
  const ruby = document.createElement('ruby');
  ruby.className = 'pr-ruby';
  const baseText = document.createElement('span');
  baseText.className = 'pr-ruby__base';
  baseText.textContent = base;
  const rt = document.createElement('rt');
  rt.className = 'pr-ruby__rt';
  rt.textContent = reading;
  ruby.append(baseText, rt);
  return ruby;
}

/** Two stacked lines plus the optional "first time?" badge. No ruby needed. */
function createTutorialLabel(highlight: boolean): HTMLElement {
  const label = document.createElement('span');
  label.className = 'pr-menu__label';

  const name = document.createElement('span');
  name.className = 'pr-menu__label-name';
  name.textContent = 'あそびかた';

  const sub = document.createElement('span');
  sub.className = 'pr-menu__label-sub';
  sub.textContent = 'はじめての ひとは ここから！';

  label.append(name, sub);

  if (highlight) {
    const badge = document.createElement('span');
    badge.className = 'pr-menu__badge';
    badge.textContent = 'はじめて？';
    badge.setAttribute('aria-hidden', 'true');
    label.append(badge);
  }

  return label;
}

/** Main menu: tutorial, battle, training, settings and credits. */
export function createMenuScreen(): IScreen {
  let host: HTMLElement | null = null;
  let cleanup: (() => void) | null = null;
  let mounted = false;

  return {
    mount(root: HTMLElement, ctx: ScreenContext): void {
      if (mounted) return;
      mounted = true;
      // Menus share the title track so quitting a match never leaves it silent.
      ctx.audio.setBgm('title');

      const screen = createEl('pr-screens pr-screens--menu');
      const panel = createEl('pr-screen pr-menu');

      const title = document.createElement('h1');
      title.className = 'pr-menu__title';
      title.textContent = 'メニュー';

      const list = createEl('div pr-menu__list');
      const removeListeners: Array<() => void> = [];

      const addButton = (
        className: string,
        label: HTMLElement | string,
        ariaLabel: string,
        action: () => void,
      ): void => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `pr-btn pr-menu__button ${className}`;
        button.setAttribute('aria-label', ariaLabel);
        if (typeof label === 'string') button.textContent = label;
        else button.append(label);
        const onClick = (): void => {
          if (!mounted) return;
          ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
          action();
        };
        button.addEventListener('click', onClick);
        removeListeners.push(() => button.removeEventListener('click', onClick));
        list.append(button);
      };

      const tutorialDone = ctx.save.load().records.tutorialDone === true;
      const tutorialClass = tutorialDone
        ? 'pr-menu__button--tutorial'
        : 'pr-menu__button--tutorial is-highlight';

      addButton(
        tutorialClass,
        createTutorialLabel(!tutorialDone),
        'あそびかた',
        () => ctx.go('loading', { kind: 'loading', setup: 'tutorial' }),
      );
      addButton(
        'pr-menu__button--battle',
        createRuby('色取り合戦', 'いろどりがっせん'),
        '色取り合戦',
        () => ctx.go('setup'),
      );
      addButton(
        'pr-menu__button--training',
        createRuby('修行場', 'しゅぎょうば'),
        '修行場',
        () => ctx.go('loading', { kind: 'loading', setup: 'training' }),
      );
      addButton('pr-menu__button--settings', 'せってい', 'せってい', () => ctx.go('settings'));
      addButton('pr-menu__button--credits', 'クレジット', 'クレジット', () => ctx.go('credits'));

      const hint = document.createElement('p');
      hint.className = 'pr-menu__hint';
      hint.textContent = 'したの ボタンを えらんでね';

      panel.append(title, list, hint);
      screen.append(panel);
      root.append(screen);
      host = screen;

      cleanup = () => {
        for (const remove of removeListeners) remove();
      };
    },

    unmount(): void {
      mounted = false;
      cleanup?.();
      cleanup = null;
      host?.remove();
      host = null;
    },
  };
}
