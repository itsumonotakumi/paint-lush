import type { IScreen, ScreenContext, ScreenParams } from '../../engine/ports';

const START_DELAY_MS = 800;

function createEl(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/** Pick a kana hint for the device the player is most likely holding. */
function controlHint(): string {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      const pads = navigator.getGamepads();
      if (pads !== null) {
        for (const pad of pads) {
          if (pad !== null && pad.connected) return 'コントローラーで あそぶよ';
        }
      }
    }
  } catch {
    // Gamepad access can be blocked; fall through to the pointer hint.
  }
  let coarse = false;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      coarse = window.matchMedia('(pointer: coarse)').matches === true;
    }
  } catch {
    coarse = false;
  }
  return coarse ? 'ゆびで さわって あそぶよ' : 'マウスと キーボードで あそぶよ';
}

/** Short cosmetic pause between setup and the match. */
export function createLoadingScreen(): IScreen {
  let host: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let mounted = false;
  let started = false;

  return {
    mount(root: HTMLElement, ctx: ScreenContext, params: ScreenParams): void {
      if (mounted) return;
      mounted = true;
      started = false;

      const setup = params.kind === 'loading' ? params.setup : null;

      const screen = createEl('pr-screens pr-screens--loading');
      const panel = createEl('pr-screen pr-loading');

      const hint = document.createElement('p');
      hint.className = 'pr-loading__hint';
      hint.textContent = 'もうすぐ はじまるよ！';

      const controls = document.createElement('p');
      controls.className = 'pr-loading__controls';
      controls.textContent = controlHint();

      const drop = createEl('div pr-loading__drop');
      drop.setAttribute('aria-hidden', 'true');
      const shine = createEl('span pr-loading__shine');
      drop.append(shine);

      const puddle = createEl('div pr-loading__puddle');
      puddle.setAttribute('aria-hidden', 'true');

      const small = document.createElement('p');
      small.className = 'pr-loading__small';
      small.textContent = 'ペンキの じゅんびを しているよ';

      panel.append(hint, controls, drop, puddle, small);
      screen.append(panel);
      root.append(screen);
      host = screen;

      if (setup !== null) {
        timer = setTimeout(() => {
          timer = null;
          if (!mounted || started) return;
          started = true;
          ctx.start(setup);
        }, START_DELAY_MS);
      }
    },

    unmount(): void {
      mounted = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      host?.remove();
      host = null;
    },
  };
}
