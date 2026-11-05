import type { IScreen, MatchSetup, ScreenContext } from '../../engine/ports';
import type { Difficulty, SaveData } from '../../game/data/schemas';

interface LabelPart {
  text: string;
  reading?: string;
}

interface ChoiceOption {
  id: string;
  content: HTMLElement;
  aria: string;
}

const DEFAULT_STAGE = 'neon-town';
const DEFAULT_WEAPON = 'iro-shuriken';
const DEFAULT_DURATION = 180;

const STAGES: ReadonlyArray<{ id: string; parts: readonly LabelPart[]; aria: string }> = [
  { id: 'neon-town', parts: [{ text: 'ネオン' }, { text: '城下町', reading: 'じょうかまち' }], aria: 'ネオン城下町' },
  { id: 'karakuri-port', parts: [{ text: 'からくり' }, { text: '港', reading: 'みなと' }], aria: 'からくり港' },
];

const WEAPONS: ReadonlyArray<{ id: string; parts: readonly LabelPart[]; aria: string; desc: string }> = [
  {
    id: 'iro-shuriken',
    parts: [{ text: '彩手裏剣', reading: 'いろしゅりけん' }],
    aria: '彩手裏剣',
    desc: 'はやく うてて、はじめての ひとに おすすめ！',
  },
  {
    id: 'oofude',
    parts: [{ text: '大筆', reading: 'おおふで' }],
    aria: '大筆',
    desc: 'ころがして、ひろく ぬれる ちからもち！',
  },
  {
    id: 'naga-fukiya',
    parts: [{ text: '長吹き矢', reading: 'ながふきや' }],
    aria: '長吹き矢',
    desc: 'ためて うつと、とおくまで とどくよ！',
  },
];

const DIFFICULTIES: ReadonlyArray<{ id: Difficulty; label: string }> = [
  { id: 'easy', label: 'やさしい' },
  { id: 'normal', label: 'ふつう' },
  { id: 'hard', label: 'つよい' },
];

const TIMES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 60, label: '1 ふん' },
  { seconds: 120, label: '2 ふん' },
  { seconds: 180, label: '3 ふん' },
  { seconds: 300, label: '5 ふん' },
];

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

function makeLabel(parts: readonly LabelPart[], className: string): HTMLElement {
  const label = document.createElement('span');
  label.className = className;
  for (const part of parts) {
    if (part.reading === undefined) label.append(document.createTextNode(part.text));
    else label.append(createRuby(part.text, part.reading));
  }
  return label;
}

function nearestDuration(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DURATION;
  let best = DEFAULT_DURATION;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const option of TIMES) {
    const gap = Math.abs(option.seconds - value);
    if (gap < bestGap) {
      bestGap = gap;
      best = option.seconds;
    }
  }
  return best;
}

/** Match setup: stage, weapon, CPU strength and time. */
export function createSetupScreen(): IScreen {
  let host: HTMLElement | null = null;
  let cleanup: (() => void) | null = null;
  let mounted = false;

  return {
    mount(root: HTMLElement, ctx: ScreenContext): void {
      if (mounted) return;
      mounted = true;
      ctx.audio.setBgm('title');

      const saved: SaveData = ctx.save.load();
      const last = saved.last;

      let stageId = STAGES.find((stage) => stage.id === last.stageId)?.id ?? DEFAULT_STAGE;
      let weaponId = WEAPONS.find((weapon) => weapon.id === last.weaponId)?.id ?? DEFAULT_WEAPON;
      let difficulty = DIFFICULTIES.find((item) => item.id === last.difficulty)?.id ?? 'normal';
      let durationSeconds = nearestDuration(last.durationSeconds);

      const screen = createEl('pr-screens pr-screens--setup');
      const panel = createEl('pr-screen pr-setup');

      const title = document.createElement('h1');
      title.className = 'pr-setup__title';
      title.textContent = 'しあいの じゅんび';

      const sub = document.createElement('p');
      sub.className = 'pr-setup__sub';
      sub.textContent = 'すきな ものを えらんでね';

      const groups = createEl('div pr-setup__groups');
      const cleanups: Array<() => void> = [];

      const makeGroup = (
        legend: string,
        options: readonly ChoiceOption[],
        selected: string,
        onSelect: (id: string) => void,
      ): HTMLElement => {
        const group = createEl('div pr-group');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', legend);

        const legendEl = document.createElement('p');
        legendEl.className = 'pr-group__legend';
        legendEl.textContent = legend;

        const row = createEl('div pr-group__row');
        const buttons = new Map<string, HTMLButtonElement>();

        const select = (id: string): void => {
          for (const [key, button] of buttons) {
            const active = key === id;
            button.classList.toggle('is-selected', active);
            button.setAttribute('aria-checked', active ? 'true' : 'false');
          }
        };

        for (const option of options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'pr-choice';
          button.dataset.value = option.id;
          button.setAttribute('role', 'radio');
          button.setAttribute('aria-label', option.aria);
          button.setAttribute('aria-checked', option.id === selected ? 'true' : 'false');
          button.classList.toggle('is-selected', option.id === selected);
          button.append(option.content);

          const onClick = (): void => {
            if (!mounted) return;
            ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
            onSelect(option.id);
            select(option.id);
          };
          button.addEventListener('click', onClick);
          cleanups.push(() => button.removeEventListener('click', onClick));

          buttons.set(option.id, button);
          row.append(button);
        }

        group.append(legendEl, row);
        return group;
      };

      const stageOptions: ChoiceOption[] = STAGES.map((stage) => ({
        id: stage.id,
        aria: stage.aria,
        content: makeLabel(stage.parts, 'pr-choice__name'),
      }));
      groups.append(
        makeGroup('ステージ', stageOptions, stageId, (id) => {
          if (STAGES.some((stage) => stage.id === id)) stageId = id;
        }),
      );

      const weaponOptions: ChoiceOption[] = WEAPONS.map((weapon) => {
        const body = document.createElement('span');
        body.className = 'pr-choice__body';
        const name = makeLabel(weapon.parts, 'pr-choice__name');
        const desc = document.createElement('span');
        desc.className = 'pr-choice__desc';
        desc.textContent = weapon.desc;
        body.append(name, desc);
        return { id: weapon.id, aria: `${weapon.aria}。${weapon.desc}`, content: body };
      });
      groups.append(
        makeGroup('ぶき', weaponOptions, weaponId, (id) => {
          if (WEAPONS.some((weapon) => weapon.id === id)) weaponId = id;
        }),
      );

      const difficultyOptions: ChoiceOption[] = DIFFICULTIES.map((item) => {
        const label = document.createElement('span');
        label.className = 'pr-choice__name';
        label.textContent = item.label;
        return { id: item.id, aria: item.label, content: label };
      });
      groups.append(
        makeGroup('つよさ', difficultyOptions, difficulty, (id) => {
          const found = DIFFICULTIES.find((item) => item.id === id);
          if (found !== undefined) difficulty = found.id;
        }),
      );

      const timeOptions: ChoiceOption[] = TIMES.map((item) => {
        const label = document.createElement('span');
        label.className = 'pr-choice__name';
        label.textContent = item.label;
        return { id: String(item.seconds), aria: item.label, content: label };
      });
      groups.append(
        makeGroup('じかん', timeOptions, String(durationSeconds), (id) => {
          const seconds = Number(id);
          if (TIMES.some((item) => item.seconds === seconds)) durationSeconds = seconds;
        }),
      );

      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'pr-btn pr-btn--primary pr-setup__start';
      start.textContent = 'はじめる';

      const onStart = (): void => {
        if (!mounted) return;
        ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);

        const setup: MatchSetup = {
          weaponId,
          stageId,
          difficulty,
          durationSeconds,
        };
        const current = ctx.save.load();
        ctx.save.save({
          version: 2,
          settings: current.settings,
          records: current.records,
          last: {
            weaponId: setup.weaponId,
            stageId: setup.stageId,
            difficulty: setup.difficulty,
            durationSeconds: setup.durationSeconds,
          },
        });
        ctx.go('loading', { kind: 'loading', setup });
      };
      start.addEventListener('click', onStart);
      cleanups.push(() => start.removeEventListener('click', onStart));

      panel.append(title, sub, groups, start);
      screen.append(panel);
      root.append(screen);
      host = screen;

      cleanup = () => {
        for (const remove of cleanups) remove();
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
