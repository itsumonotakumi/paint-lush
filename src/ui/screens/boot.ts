import type { IScreen, ScreenContext } from '../../engine/ports';

function createEl(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/**
 * First tap. Browsers only allow audio after a gesture, so this screen unlocks
 * the audio context before showing the title.
 */
export function createBootScreen(): IScreen {
  let host: HTMLElement | null = null;
  let cleanup: (() => void) | null = null;
  let mounted = false;
  let starting = false;

  return {
    mount(root: HTMLElement, ctx: ScreenContext): void {
      if (mounted) return;
      mounted = true;
      starting = false;

      const screen = createEl('pr-screens pr-screens--boot');
      const panel = createEl('pr-screen pr-boot');

      const paint = createEl('pr-boot__paint');
      paint.setAttribute('aria-hidden', 'true');
      for (let index = 1; index <= 3; index += 1) {
        paint.append(createEl(`pr-boot__blob pr-boot__blob--${index}`));
      }

      const logo = document.createElement('p');
      logo.className = 'pr-boot__logo';
      logo.textContent = 'PAINT RUSH!';

      const jp = document.createElement('p');
      jp.className = 'pr-boot__jp';
      jp.textContent = 'ペイントラッシュ！';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pr-btn pr-btn--primary pr-boot__button';
      button.textContent = 'タップしてスタート';

      const note = document.createElement('p');
      note.className = 'pr-boot__note';
      note.textContent = 'おとが でるよ。こえの おおきさに きをつけてね。';

      const onStart = (): void => {
        if (!mounted || starting) return;
        starting = true;
        button.disabled = true;
        try {
          const unlocking = ctx.audio.unlock();
          // Navigation must not depend on audio success; this also swallows a
          // blocked-context rejection so it never reaches the console.
          void unlocking.catch(() => undefined);
        } catch {
          // A synchronous failure still lets the title open.
        }
        ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
        ctx.go('title');
      };
      button.addEventListener('click', onStart);

      panel.append(paint, logo, jp, button, note);
      screen.append(panel);
      root.append(screen);
      host = screen;

      cleanup = () => {
        button.removeEventListener('click', onStart);
      };
    },

    unmount(): void {
      mounted = false;
      starting = false;
      cleanup?.();
      cleanup = null;
      host?.remove();
      host = null;
    },
  };
}
