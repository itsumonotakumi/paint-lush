import type { IScreen, ScreenContext } from '../../engine/ports';

function createEl(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

interface CreditEntry {
  name: string;
  license: string;
}

const ENTRIES: readonly CreditEntry[] = [
  { name: 'ペイントラッシュ！', license: 'Apache-2.0' },
  { name: 'Three.js', license: 'MIT' },
  { name: 'zod', license: 'MIT' },
];

/** Credits and licence notes. */
export function createCreditsScreen(): IScreen {
  let host: HTMLElement | null = null;
  let cleanup: (() => void) | null = null;
  let mounted = false;

  return {
    mount(root: HTMLElement, ctx: ScreenContext): void {
      if (mounted) return;
      mounted = true;
      ctx.audio.setBgm('title');

      const screen = createEl('pr-screens pr-screens--credits');
      const panel = createEl('pr-screen pr-credits');

      const title = document.createElement('h1');
      title.className = 'pr-credits__title';
      title.textContent = 'クレジット';

      const card = createEl('div pr-credits__card');

      const game = document.createElement('p');
      game.className = 'pr-credits__lead';
      game.textContent = 'ペンキで いろを ぬりあう、にんじゃの たいせんゲーム。';

      const list = document.createElement('ul');
      list.className = 'pr-credits__list';
      for (const entry of ENTRIES) {
        const item = document.createElement('li');
        item.className = 'pr-credits__item';
        const name = document.createElement('span');
        name.className = 'pr-credits__name';
        name.textContent = entry.name;
        const license = document.createElement('span');
        license.className = 'pr-credits__license';
        license.textContent = entry.license;
        item.append(name, license);
        list.append(item);
      }

      const note = document.createElement('p');
      note.className = 'pr-credits__note';
      note.textContent = 'すべてオリジナルのそざいです。';

      card.append(game, list, note);

      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'pr-btn pr-btn--ghost pr-credits__back';
      back.textContent = 'メニューへ';

      const onBack = (): void => {
        if (!mounted) return;
        ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
        ctx.go('menu');
      };
      back.addEventListener('click', onBack);

      panel.append(title, card, back);
      screen.append(panel);
      root.append(screen);
      host = screen;

      cleanup = () => {
        back.removeEventListener('click', onBack);
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
