import type { IScreen, MatchSetup, ScreenContext } from '../../engine/ports';
import { getCharacter } from '../../engine/render/characters/defs';
import {
  CHARACTER_IDS,
  DEFAULT_CHARACTER_ID,
  isCharacterId,
} from '../../engine/render/characters/roster';
import type { CharacterDef } from '../../engine/render/characters/types';
import type { Difficulty, SaveData } from '../../game/data/schemas';
import { createCharacterPreview } from './characterPreview';

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

/** Roster order, resolved through the defs module so a missing entry still falls back safely. */
const CHARACTER_OPTIONS: readonly CharacterDef[] = CHARACTER_IDS.map((id) => getCharacter(id));

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const DATA_PNG_PREFIX = 'data:image/png;base64,';
/** CSS pixels; the icon renderer multiplies by the capped device pixel ratio. */
const ICON_SIZE = 104;

function safeColor(value: string, fallback: string): string {
  return COLOR_PATTERN.test(value) ? value : fallback;
}

/** Only baked PNG data URLs may reach an <img src>; CSP allows nothing else. */
function isPngDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(DATA_PNG_PREFIX) &&
    value.length > DATA_PNG_PREFIX.length
  );
}

function pickRandomCharacterId(): string {
  const count = CHARACTER_IDS.length;
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    cryptoApi.getRandomValues(buffer);
    const value = buffer[0];
    if (value !== undefined && Number.isFinite(value)) {
      return CHARACTER_IDS[value % count] ?? DEFAULT_CHARACTER_ID;
    }
  }
  const index = Math.floor(Math.random() * count);
  return CHARACTER_IDS[index] ?? DEFAULT_CHARACTER_ID;
}

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
      let characterId: string = isCharacterId(last.characterId) ? last.characterId : DEFAULT_CHARACTER_ID;

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

      /* ---------- character picker ---------- */

      const previewColumn = createEl('div pr-character-preview');
      const canvas = document.createElement('canvas');
      canvas.className = 'pr-character-preview__canvas';
      canvas.width = 320;
      canvas.height = 320;
      canvas.setAttribute('aria-hidden', 'true');

      const previewName = document.createElement('p');
      previewName.className = 'pr-character-preview__name';
      const previewTagline = document.createElement('p');
      previewTagline.className = 'pr-character-preview__tagline';
      const previewBubble = document.createElement('p');
      previewBubble.className = 'pr-character-preview__bubble';

      const backToggle = document.createElement('button');
      backToggle.type = 'button';
      backToggle.className = 'pr-btn pr-btn--ghost pr-character-preview__back';
      backToggle.textContent = 'うしろ';
      backToggle.setAttribute('aria-pressed', 'false');

      previewColumn.append(canvas, previewName, previewTagline, previewBubble, backToggle);

      const preview = createCharacterPreview(canvas);
      cleanups.push(() => preview.dispose());

      let backFacing = false;
      const onBackToggle = (): void => {
        if (!mounted) return;
        ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
        backFacing = !backFacing;
        backToggle.setAttribute('aria-pressed', backFacing ? 'true' : 'false');
        backToggle.classList.toggle('is-on', backFacing);
        preview.setBack(backFacing);
      };
      backToggle.addEventListener('click', onBackToggle);
      cleanups.push(() => backToggle.removeEventListener('click', onBackToggle));

      const grid = createEl('div pr-character-grid');
      const cards = new Map<string, HTMLButtonElement>();

      const showCharacter = (id: string): void => {
        const def = getCharacter(id);
        previewName.textContent = def.name;
        previewTagline.textContent = def.tagline;
        previewBubble.textContent = def.catchphrase;
        preview.show(def.id);
      };

      const selectCharacter = (id: string): void => {
        if (!isCharacterId(id)) return;
        characterId = id;
        for (const [key, card] of cards) {
          const active = key === id;
          card.classList.toggle('is-selected', active);
          card.setAttribute('aria-checked', active ? 'true' : 'false');
          card.tabIndex = active ? 0 : -1;
        }
        showCharacter(id);
      };

      for (const def of CHARACTER_OPTIONS) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'pr-choice pr-character-card';
        card.dataset.value = def.id;
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-label', def.name);
        card.setAttribute('aria-checked', def.id === characterId ? 'true' : 'false');
        card.classList.toggle('is-selected', def.id === characterId);
        card.tabIndex = def.id === characterId ? 0 : -1;

        const band = createEl('span pr-character-card__band');
        band.setAttribute('aria-hidden', 'true');
        band.style.setProperty('--pr-char-garb', safeColor(def.colors.garb, '#2b2f5c'));
        band.style.setProperty('--pr-char-accent', safeColor(def.colors.accent, '#1b1a33'));

        const name = document.createElement('span');
        name.className = 'pr-character-card__name';
        name.textContent = def.name;

        card.append(band, name);
        const onClick = (): void => {
          if (!mounted) return;
          ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
          selectCharacter(def.id);
        };
        card.addEventListener('click', onClick);
        cleanups.push(() => card.removeEventListener('click', onClick));
        cards.set(def.id, card);
        grid.append(card);
      }

      const onGridKeyDown = (event: KeyboardEvent): void => {
        if (!mounted) return;
        const currentIndex = CHARACTER_IDS.findIndex((id) => id === characterId);
        let nextIndex = currentIndex < 0 ? 0 : currentIndex;
        switch (event.key) {
          case 'ArrowRight':
          case 'ArrowDown':
            nextIndex = (nextIndex + 1) % CHARACTER_IDS.length;
            break;
          case 'ArrowLeft':
          case 'ArrowUp':
            nextIndex = (nextIndex - 1 + CHARACTER_IDS.length) % CHARACTER_IDS.length;
            break;
          case 'Home':
            nextIndex = 0;
            break;
          case 'End':
            nextIndex = CHARACTER_IDS.length - 1;
            break;
          default:
            return;
        }
        event.preventDefault();
        const nextId = CHARACTER_IDS[nextIndex];
        if (nextId === undefined) return;
        ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
        selectCharacter(nextId);
        cards.get(nextId)?.focus();
      };
      grid.addEventListener('keydown', onGridKeyDown);
      cleanups.push(() => grid.removeEventListener('keydown', onGridKeyDown));

      /* Thumbnails are progressively enhanced: only a valid PNG data URL is
       * ever written to an <img>, and a missing icon leaves the name alone. */
      const applyIcons = (icons: ReadonlyMap<string, string>): void => {
        if (!mounted) return;
        for (const [id, url] of icons) {
          if (!isPngDataUrl(url)) continue;
          const card = cards.get(id);
          if (card === undefined) continue;
          if (card.querySelector('.pr-character-card__icon') !== null) continue;
          const icon = document.createElement('img');
          icon.className = 'pr-character-card__icon';
          icon.alt = card.getAttribute('aria-label') ?? '';
          icon.draggable = false;
          icon.decoding = 'async';
          icon.src = url;
          card.prepend(icon);
        }
      };

      const characterGroup = createEl('div pr-group pr-group--character');
      characterGroup.setAttribute('role', 'radiogroup');
      characterGroup.setAttribute('aria-label', 'キャラ');

      const characterLegend = document.createElement('p');
      characterLegend.className = 'pr-group__legend';
      characterLegend.textContent = 'キャラ';

      const characterLayout = createEl('div pr-character-layout');
      characterLayout.append(previewColumn, grid);

      const characterFooter = createEl('div pr-character__footer');
      const characterNote = document.createElement('p');
      characterNote.className = 'pr-character__note';
      characterNote.textContent = 'みための ちがい だけ だよ';

      const randomButton = document.createElement('button');
      randomButton.type = 'button';
      randomButton.className = 'pr-btn pr-btn--ghost pr-character__random';
      randomButton.textContent = 'おまかせ';
      const onRandom = (): void => {
        if (!mounted) return;
        ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
        const id = pickRandomCharacterId();
        selectCharacter(id);
        cards.get(id)?.focus();
      };
      randomButton.addEventListener('click', onRandom);
      cleanups.push(() => randomButton.removeEventListener('click', onRandom));

      characterFooter.append(characterNote, randomButton);
      characterGroup.append(characterLegend, characterLayout, characterFooter);
      selectCharacter(characterId);
      groups.append(characterGroup);

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
          characterId,
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
            characterId,
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

      let iconFrame: number | null = null;
      const requestIcons = (): void => {
        iconFrame = null;
        if (!mounted) return;
        try {
          applyIcons(preview.renderIcons(CHARACTER_IDS, ICON_SIZE));
        } catch {
          // Thumbnails are optional; the cards still show their names.
        }
      };
      if (typeof globalThis.requestAnimationFrame === 'function') {
        iconFrame = globalThis.requestAnimationFrame(requestIcons);
      } else {
        requestIcons();
      }

      cleanup = () => {
        if (iconFrame !== null) {
          if (typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(iconFrame);
          }
          iconFrame = null;
        }
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
