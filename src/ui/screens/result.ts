import type { TeamId } from '../../core/types';
import type { MatchPlayerResult, MatchResult } from '../../game/contracts';
import type { IScreen, ScreenContext, ScreenParams, TeamLabel } from '../../engine/ports';

type Outcome = 'win' | 'lose' | 'draw';

const CONFETTI_COLORS: readonly string[] = ['#ff2e88', '#ffc14d', '#19e6d0', '#8b7cff', '#ff8f3d'];
const FALLBACK_TEAM_COLORS: readonly [number, number] = [0xff2e88, 0x19e6d0];
const MAX_COUNT = 1_000_000_000;
const MAX_TEAM_NAME = 24;
const MAX_TEAM_READING = 32;

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

function sanitizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_COUNT, Math.max(0, Math.round(value)));
}

function sanitizeRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function ratioText(value: number): string {
  return `${value.toFixed(1)}%`;
}

function sanitizeColor(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(0xffffff, Math.max(0, Math.trunc(value)));
}

function hexChannel(color: number, shift: number): number {
  return (color >> shift) & 0xff;
}

/** Lightens a 0xRRGGBB colour towards white by `amount` in 0..1. */
function lighten(color: number, amount: number): number {
  const mix = Math.min(1, Math.max(0, amount));
  const blend = (channel: number): number => Math.round(channel + (255 - channel) * mix);
  return (blend(hexChannel(color, 16)) << 16) | (blend(hexChannel(color, 8)) << 8) | blend(hexChannel(color, 0));
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Keeps hostile team payloads from producing empty labels or bad colours. */
function sanitizeTeam(value: TeamLabel | undefined, index: 0 | 1): TeamLabel {
  const fallbackName = index === 0 ? 'みかた' : 'あいて';
  const rawName = typeof value?.name === 'string' ? value.name.trim() : '';
  const rawReading = typeof value?.reading === 'string' ? value.reading.trim() : '';
  const name = (rawName.length > 0 ? rawName : fallbackName).slice(0, MAX_TEAM_NAME);
  const reading = (rawReading.length > 0 ? rawReading : name).slice(0, MAX_TEAM_READING);
  return { name, reading, color: sanitizeColor(value?.color ?? Number.NaN, FALLBACK_TEAM_COLORS[index]) };
}

function outcomeOf(result: MatchResult, localId: number): { outcome: Outcome; team: TeamId; local: MatchPlayerResult | null } {
  const local = result.players.find((player) => player.id === localId) ?? null;
  const team: TeamId = local?.team ?? 0;
  if (result.winner === null) return { outcome: 'draw', team, local };
  return { outcome: result.winner === team ? 'win' : 'lose', team, local };
}

function verdictText(outcome: Outcome): string {
  if (outcome === 'win') return 'かち！';
  if (outcome === 'lose') return 'まけ…';
  return 'ひきわけ';
}

/** Result: growing paint bar, verdict, personal score and replay actions. */
export function createResultScreen(): IScreen {
  let host: HTMLElement | null = null;
  let cleanup: (() => void) | null = null;
  let mounted = false;

  return {
    mount(root: HTMLElement, ctx: ScreenContext, params: ScreenParams): void {
      if (mounted) return;
      if (params.kind !== 'result') {
        ctx.go('menu');
        return;
      }
      mounted = true;

      const result = params.result;
      const { outcome, local } = outcomeOf(result, params.localId);
      const paint = sanitizeCount(local?.paintCells ?? 0);
      const kills = sanitizeCount(local?.kills ?? 0);
      const ratio0 = sanitizeRatio(result.ratio[0]);
      const ratio1 = sanitizeRatio(result.ratio[1]);
      // Index 0 is always the local player's side; the match runner sends that pair.
      const teamLabels: readonly [TeamLabel, TeamLabel] = [
        sanitizeTeam(params.teams?.[0], 0),
        sanitizeTeam(params.teams?.[1], 1),
      ];

      // Records are written once by the match runner at the end of the match;
      // this screen is read-only (D9).
      // A draw gets the calm menu track, never the victory jingle (D10).
      ctx.audio.setBgm(outcome === 'win' ? 'win' : outcome === 'lose' ? 'lose' : 'title');

      const screen = createEl(`pr-screens pr-screens--result pr-result--${outcome}`);
      const panel = createEl('pr-screen pr-result');

      if (outcome !== 'lose') {
        const confetti = createEl('div pr-confetti');
        confetti.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 18; index += 1) {
          const piece = document.createElement('span');
          piece.className = 'pr-confetti__piece';
          piece.style.setProperty('--x', `${(index * 53) % 100}%`);
          piece.style.setProperty('--delay', `${(index % 6) * 0.09}s`);
          piece.style.setProperty('--dur', `${2.1 + (index % 5) * 0.18}s`);
          piece.style.setProperty('--sway', `${((index % 7) - 3) * 18}px`);
          piece.style.setProperty('--c', CONFETTI_COLORS[index % CONFETTI_COLORS.length] ?? '#ff2e88');
          confetti.append(piece);
        }
        panel.append(confetti);
      }

      const verdict = document.createElement('h1');
      verdict.className = 'pr-result__verdict';
      verdict.textContent = verdictText(outcome);

      const sub = document.createElement('p');
      sub.className = 'pr-result__sub';
      sub.textContent = outcome === 'win' ? 'やったね！' : outcome === 'draw' ? 'いい しあいだったね' : 'つぎは きっと いけるよ';

      const teamRow = createEl('div pr-result__teams');

      const makeTeamLabel = (team: TeamLabel, index: 0 | 1, ratio: number): HTMLElement => {
        const label = document.createElement('span');
        label.className = `pr-result__team pr-result__team--${index}`;
        const value = cssColor(team.color);
        label.style.setProperty('color', value);
        label.style.setProperty('--pr-team-color', value);
        const percent = document.createElement('span');
        percent.className = 'pr-result__team-pct';
        percent.textContent = ratioText(ratio);
        label.append(createRuby(team.name, team.reading), document.createTextNode(' '), percent);
        return label;
      };

      teamRow.append(makeTeamLabel(teamLabels[0], 0, ratio0), makeTeamLabel(teamLabels[1], 1, ratio1));

      const makeFill = (team: TeamLabel, index: 0 | 1): HTMLElement => {
        const fill = createEl(`pr-result__fill pr-result__fill--${index}`);
        const base = cssColor(team.color);
        const edge = cssColor(lighten(team.color, 0.35));
        const angle = index === 0 ? '90deg' : '270deg';
        fill.style.setProperty('background', `linear-gradient(${angle}, ${base} 0%, ${edge} 100%)`);
        return fill;
      };

      const bar = createEl('div pr-result__bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute(
        'aria-label',
        `${teamLabels[0].name} ${ratioText(ratio0)}、${teamLabels[1].name} ${ratioText(ratio1)}`,
      );
      bar.style.setProperty('--pr-ratio-0', `${ratio0}%`);
      bar.style.setProperty('--pr-ratio-1', `${ratio1}%`);
      bar.append(makeFill(teamLabels[0], 0), makeFill(teamLabels[1], 1));

      const stats = createEl('div pr-result__stats');
      const paintStat = createEl('div pr-result__stat');
      const paintLabel = document.createElement('span');
      paintLabel.className = 'pr-result__stat-label';
      paintLabel.textContent = 'ぬった ます';
      const paintValue = document.createElement('span');
      paintValue.className = 'pr-result__stat-value pr-result__paint';
      paintValue.textContent = String(paint);
      paintStat.append(paintLabel, paintValue);

      const killStat = createEl('div pr-result__stat');
      const killLabel = document.createElement('span');
      killLabel.className = 'pr-result__stat-label';
      killLabel.textContent = 'たおした かず';
      const killValue = document.createElement('span');
      killValue.className = 'pr-result__stat-value pr-result__kills';
      killValue.textContent = String(kills);
      killStat.append(killLabel, killValue);

      stats.append(paintStat, killStat);

      const actions = createEl('div pr-result__actions');
      const removeListeners: Array<() => void> = [];

      const addAction = (label: string, className: string, action: () => void): void => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `pr-btn ${className}`;
        button.textContent = label;
        const onClick = (): void => {
          if (!mounted) return;
          ctx.audio.handle({ t: 'ui', kind: 'ok' }, { x: 0, y: 0, z: 0 }, 0);
          action();
        };
        button.addEventListener('click', onClick);
        removeListeners.push(() => button.removeEventListener('click', onClick));
        actions.append(button);
      };

      addAction('もういっかい', 'pr-btn--primary', () => ctx.go('setup'));
      addAction('メニューへ', 'pr-btn--ghost', () => ctx.go('menu'));

      panel.append(verdict, sub, teamRow, bar, stats, actions);
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
