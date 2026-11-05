import type { IScreen, ScreenContext } from '../../engine/ports';

function createEl(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/** Logo screen. Sets the title music as soon as it appears. */
export function createTitleScreen(): IScreen {
  let host: HTMLElement | null = null;
  let cleanup: (() => void) | null = null;
  let mounted = false;

  return {
    mount(root: HTMLElement, ctx: ScreenContext): void {
      if (mounted) return;
      mounted = true;
      ctx.audio.setBgm('title');

      const screen = createEl('pr-screens pr-screens--title');
      const panel = createEl('pr-screen pr-title');

      const logo = createEl('div pr-logo');
      const word = document.createElement('h1');
      word.className = 'pr-logo__word';
      word.textContent = 'PAINT RUSH!';
      const jp = document.createElement('p');
      jp.className = 'pr-logo__jp';
      jp.textContent = 'ペイントラッシュ！';
      logo.append(word, jp);
      for (let index = 1; index <= 3; index += 1) {
        const drip = createEl(`pr-logo__drip pr-logo__drip--${index}`);
        drip.setAttribute('aria-hidden', 'true');
        logo.append(drip);
      }

      const tagline = document.createElement('p');
      tagline.className = 'pr-title__tagline';
      tagline.textContent = 'いろを ぬって、じぶんの いろを ひろげよう！';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pr-btn pr-btn--primary pr-title__button';
      button.textContent = 'いざ、まいる！';

      const onStart = (): void => {
        if (!mounted) return;
        ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
        ctx.go('menu');
      };
      button.addEventListener('click', onStart);

      panel.append(logo, tagline, button);
      screen.append(panel);
      root.append(screen);
      host = screen;

      cleanup = () => {
        button.removeEventListener('click', onStart);
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
