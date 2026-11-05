import './ui.css';
import type { MatchPhase } from '../core/events';
import type { PlayerStateName, PlayerView, WorldSnapshot } from '../core/snapshot';
import type { TeamId } from '../core/types';

const TEAM_COLORS: readonly [string, string] = ['#ff2e88', '#19e6d0'];
const TEAM_NAMES: readonly [HudTeam, HudTeam] = [
  { name: '紅蓮', reading: 'ぐれん', color: 0xff2e88 },
  { name: '蒼雷', reading: 'そうらい', color: 0x19e6d0 },
];
const DOWN_COLOR = '#b9b4ac';
const HEART_COUNT = 3;
const ROSTER_COUNT = 8;
const GAUGE_FULL_EPSILON = 1e-6;
const KILL_FADE_MS = 4000;
const BANNER_VISIBLE_MS = 2400;
const MAX_TIME_SECONDS = 359999;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface FormLabel {
  base: string;
  reading: string | null;
}

/** Name, furigana and ink colour for one team. Colours may be 0xRRGGBB or CSS hex. */
export interface HudTeam {
  name: string;
  reading: string;
  color: number | string;
}

interface HeartView {
  heart: HTMLDivElement;
  fill: HTMLDivElement;
  state: 'full' | 'partial' | 'empty';
}

interface KillEntry {
  line: HTMLParagraphElement;
  timer: TimerHandle;
}

function createDiv(className: string): HTMLDivElement {
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

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

function setClass(el: HTMLElement, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteIn(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? clamp(value, min, max) : 0;
}

function percent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
}

function percentText(value: number, total: number): string {
  return `${(Math.round(percent(value, total) * 10) / 10).toFixed(1)}%`;
}

function statText(value: number): string {
  return `${Math.round(finiteIn(value, 0, 100) * 10) / 10}%`;
}

function formatClockSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function hidesPaint(phase: MatchPhase): boolean {
  switch (phase) {
    case 'pre':
    case 'play':
    case 'lastMinute':
    case 'countdown':
      return true;
    case 'finished':
    default:
      return false;
  }
}

function formLabel(state: PlayerStateName): FormLabel {
  switch (state) {
    case 'dive':
      return { base: '染遁', reading: 'せんとん' };
    case 'down':
    case 'respawn':
      return { base: 'やられ', reading: null };
    case 'stance':
    case 'air':
    default:
      return { base: '構え', reading: 'かまえ' };
  }
}

function formKey(label: FormLabel): string {
  return `${label.base}\u0000${label.reading ?? ''}`;
}

function renderFormLabel(container: HTMLElement, label: FormLabel): void {
  if (label.reading === null) {
    container.replaceChildren(document.createTextNode(label.base));
    return;
  }
  container.replaceChildren(createRuby(label.base, label.reading));
}

function sanitizeTeam(value: HudTeam, fallback: HudTeam): HudTeam {
  const name = typeof value.name === 'string' && value.name.trim().length > 0 ? value.name : fallback.name;
  const reading =
    typeof value.reading === 'string' && value.reading.trim().length > 0 ? value.reading : fallback.reading;
  const color =
    (typeof value.color === 'number' && Number.isFinite(value.color)) ||
    (typeof value.color === 'string' && value.color.trim().length > 0)
      ? value.color
      : fallback.color;
  return { name, reading, color };
}

function renderTeamName(container: HTMLElement, team: HudTeam): void {
  container.replaceChildren(createRuby(team.name, team.reading));
}

/** Converts a finite 0xRRGGBB value or CSS hex colour, clamping hostile input. */
export function teamCssColor(value: number | string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return TEAM_COLORS[0];
    const clamped = Math.min(0xffffff, Math.max(0, Math.trunc(value)));
    return `#${clamped.toString(16).padStart(6, '0')}`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^#[0-9a-f]{3}$/i.test(trimmed) || /^#[0-9a-f]{6}$/i.test(trimmed)) {
      return trimmed.toLowerCase();
    }
  }
  return TEAM_COLORS[0];
}

function teamColor(colors: readonly [string, string], team: TeamId): string {
  return team === 1 ? colors[1] : colors[0];
}

function rosterLabel(ally: boolean, down: boolean): string {
  const side = ally ? 'みかた' : 'あいて';
  return down ? `${side} たおれ` : `${side} げんき`;
}

/**
 * One heart covers one third of the 0..100 hp range. A heart whose third is
 * partly used is shown as a partial heart, so 34 hp is one full heart plus a
 * just-started second heart (two hearts, the second partial).
 */
function heartAmount(hp: number, index: number): number {
  const span = 100 / HEART_COUNT;
  return clamp((hp - index * span) / span, 0, 1);
}

function heartState(amount: number): HeartView['state'] {
  if (amount >= 1 - 1e-6) return 'full';
  if (amount <= 1e-6) return 'empty';
  return 'partial';
}

function heartFill(amount: number): string {
  if (amount >= 1 - 1e-6) return '100%';
  if (amount <= 1e-6) return '0%';
  return `${Math.max(1, Math.round(amount * 100))}%`;
}

export interface Hud {
  /** Updates every displayed value. Only changed values touch the DOM. */
  update(view: PlayerView, snapshot: WorldSnapshot, totalCells: number): void;
  /** Adds a line to the last-three kill log. Fades after four seconds. */
  log(text: string): void;
  /** Announces a call-out banner such as a start or one-minute warning. */
  banner(text: string): void;
  /** Hides or shows the whole HUD without destroying it. */
  setVisible(visible: boolean): void;
  showPaused(visible: boolean, reason?: string): void;
  /** Shows the "たたかう!" gate used to request pointer lock from a real gesture. */
  showStartGate(visible: boolean): void;
  /** Registers the action run when the player presses たたかう!. */
  onStart(callback: () => void): void;
  /** Registers the action run when the player presses つづける. */
  onResume(callback: () => void): void;
  /** Registers the action run when the player presses やめる. */
  onQuit(callback: () => void): void;
  /** Applies team names, furigana and ink colours for the current match. */
  setTeams(teams: readonly HudTeam[]): void;
  dispose(): void;
}

export function createHud(root: HTMLElement): Hud {
  const ui = createDiv('pr-ui');
  const hud = createDiv('pr-hud');

  const hp = createDiv('pr-hp');
  hp.setAttribute('role', 'progressbar');
  hp.setAttribute('aria-label', '体力');
  hp.setAttribute('aria-valuemin', '0');
  hp.setAttribute('aria-valuemax', '100');
  hp.setAttribute('aria-valuenow', '100');

  const hearts: HeartView[] = [];
  for (let index = 0; index < HEART_COUNT; index += 1) {
    const heart = createDiv('pr-hp__heart is-full');
    const fill = createDiv('pr-hp__heart-fill');
    setVar(fill, '--pr-heart-fill', '100%');
    heart.append(fill);
    hp.append(heart);
    hearts.push({ heart, fill, state: 'full' });
  }

  const gourd = createDiv('pr-gourd');
  const gourdBody = createDiv('pr-gourd__body');
  const gourdFill = createDiv('pr-gourd__fill');
  const gourdCap = createDiv('pr-gourd__cap');
  gourdBody.setAttribute('role', 'progressbar');
  gourdBody.setAttribute('aria-label', 'インク残量');
  gourdBody.setAttribute('aria-valuemin', '0');
  gourdBody.setAttribute('aria-valuemax', '100');
  gourdBody.setAttribute('aria-valuenow', '100');
  gourdBody.append(gourdFill);
  gourd.append(gourdBody, gourdCap);

  const form = createDiv('pr-form');
  const initialForm = formLabel('stance');
  renderFormLabel(form, initialForm);

  const score = createDiv('pr-score');
  const teamZero = createDiv('pr-score__team pr-score__team--0');
  const teamZeroName = document.createElement('span');
  teamZeroName.className = 'pr-score__name';
  teamZeroName.append(createRuby(TEAM_NAMES[0].name, TEAM_NAMES[0].reading));
  const teamZeroPct = document.createElement('span');
  teamZeroPct.className = 'pr-score__pct';
  teamZeroPct.textContent = '0.0%';
  teamZero.append(teamZeroName, teamZeroPct);

  const teamOne = createDiv('pr-score__team pr-score__team--1');
  const teamOneName = document.createElement('span');
  teamOneName.className = 'pr-score__name';
  teamOneName.append(createRuby(TEAM_NAMES[1].name, TEAM_NAMES[1].reading));
  const teamOnePct = document.createElement('span');
  teamOnePct.className = 'pr-score__pct';
  teamOnePct.textContent = '0.0%';
  teamOne.append(teamOneName, teamOnePct);

  score.append(teamZero, teamOne);

  const time = createDiv('pr-time');
  time.textContent = '0:00';
  time.hidden = true;
  time.setAttribute('role', 'timer');
  time.setAttribute('aria-label', 'のこりじかん');

  const countdown = createDiv('pr-countdown');
  countdown.hidden = true;
  countdown.setAttribute('aria-hidden', 'true');

  const banner = createDiv('pr-banner');
  const bannerText = document.createElement('span');
  bannerText.className = 'pr-banner__text';
  banner.append(bannerText);
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const roster = createDiv('pr-roster');
  roster.setAttribute('role', 'group');
  roster.setAttribute('aria-label', 'なかまと あいての ようす');
  const rosterDots: HTMLDivElement[] = [];
  const rosterKeys: string[] = [];
  for (let index = 0; index < ROSTER_COUNT; index += 1) {
    const dot = createDiv('pr-roster__dot');
    dot.setAttribute('role', 'img');
    dot.hidden = true;
    roster.append(dot);
    rosterDots.push(dot);
    rosterKeys.push('empty');
  }

  const killLog = createDiv('pr-killlog');
  killLog.setAttribute('aria-live', 'polite');
  killLog.setAttribute('aria-label', 'きろく');

  const gauge = createDiv('pr-gauge');
  const gaugeRing = createDiv('pr-gauge__ring');
  const gaugeLabel = document.createElement('span');
  gaugeLabel.className = 'pr-gauge__label';
  gaugeLabel.textContent = 'おうぎ';
  gaugeRing.setAttribute('role', 'progressbar');
  gaugeRing.setAttribute('aria-label', 'おうぎゲージ');
  gaugeRing.setAttribute('aria-valuemin', '0');
  gaugeRing.setAttribute('aria-valuemax', '100');
  gaugeRing.setAttribute('aria-valuenow', '0');
  setVar(gaugeRing, '--pr-gauge-fill', '0%');
  gauge.append(gaugeRing, gaugeLabel);

  const crosshair = createDiv('pr-crosshair');
  crosshair.setAttribute('aria-hidden', 'true');
  const charge = createDiv('pr-charge');
  charge.hidden = true;
  charge.setAttribute('aria-hidden', 'true');
  setVar(charge, '--pr-charge-fill', '0%');
  crosshair.append(charge);

  hud.append(hp, gourd, form, score, time, countdown, banner, roster, killLog, gauge, crosshair);

  const pausedOverlay = createDiv('pr-overlay pr-paused');
  const pausedTitle = document.createElement('p');
  pausedTitle.className = 'pr-paused__title';
  pausedTitle.textContent = 'ポーズちゅう';
  const pausedButton = document.createElement('button');
  pausedButton.type = 'button';
  pausedButton.className = 'pr-start__button pr-paused__button';
  pausedButton.textContent = 'つづける';
  const quitButton = document.createElement('button');
  quitButton.type = 'button';
  quitButton.className = 'pr-paused__button pr-paused__quit';
  quitButton.textContent = 'やめる';
  const pausedReason = document.createElement('p');
  pausedReason.className = 'pr-paused__reason';
  pausedReason.textContent = '';
  pausedOverlay.append(pausedTitle, pausedButton, quitButton, pausedReason);
  pausedOverlay.hidden = true;

  const startGate = createDiv('pr-start-gate');
  const startGateButton = document.createElement('button');
  startGateButton.type = 'button';
  startGateButton.className = 'pr-start__button pr-start-gate__button';
  startGateButton.textContent = 'たたかう!';
  startGateButton.setAttribute('aria-label', 'たたかう');
  startGate.append(startGateButton);
  startGate.hidden = true;

  ui.append(hud, pausedOverlay, startGate);

  // The DOM starts full so it agrees with aria-valuenow and lastInk below.
  setVar(gourdFill, '--pr-ink', '100%');

  let disposed = false;
  let resumeCallback: (() => void) | null = null;
  let quitCallback: (() => void) | null = null;
  let startCallback: (() => void) | null = null;
  const onResumeClick = (): void => {
    if (disposed) return;
    if (resumeCallback !== null) resumeCallback();
  };
  const onQuitClick = (): void => {
    if (disposed) return;
    if (quitCallback !== null) quitCallback();
  };
  const onStartClick = (): void => {
    if (disposed) return;
    setStartGateVisible(false);
    if (startCallback !== null) startCallback();
  };
  pausedButton.addEventListener('click', onResumeClick);
  quitButton.addEventListener('click', onQuitClick);
  startGateButton.addEventListener('click', onStartClick);

  root.append(ui);

  const teamColors: [string, string] = [TEAM_COLORS[0], TEAM_COLORS[1]];
  let lastHp = 100;
  // -1 cannot be a clamped ink value, so the first update always reconciles the
  // fill even if the initial inline value and this cache ever drift apart.
  let lastInk = -1;
  let lastAriaHp = '100';
  let lastAriaInk = '100';
  let lastForm = formKey(initialForm);
  let lastTeam = '';
  let lastGaugePercent = 0;
  let lastGaugeNow = '0';
  let lastChargePercent = 0;
  let lastClockSeconds = -1;
  let lastCountdown = '';
  let lastShowTime = false;
  let lastShowCountdown = false;
  let lastPaintsHidden: boolean | null = null;
  let lastScoreZero = '0.0%';
  let lastScoreOne = '0.0%';
  const killEntries: KillEntry[] = [];
  let bannerTimer: TimerHandle | null = null;

  function updateHearts(hpValue: number): void {
    for (let index = 0; index < hearts.length; index += 1) {
      const view = hearts[index];
      if (view === undefined) continue;
      const amount = heartAmount(hpValue, index);
      const state = heartState(amount);
      if (view.state !== state) {
        view.state = state;
        view.heart.classList.toggle('is-full', state === 'full');
        view.heart.classList.toggle('is-partial', state === 'partial');
        view.heart.classList.toggle('is-empty', state === 'empty');
      }
      setVar(view.fill, '--pr-heart-fill', heartFill(amount));
    }
  }

  function updateRoster(team: TeamId, players: readonly PlayerView[]): void {
    for (let index = 0; index < ROSTER_COUNT; index += 1) {
      const dot = rosterDots[index];
      if (dot === undefined) continue;
      const player = players[index];
      if (player === undefined) {
        if (rosterKeys[index] !== 'empty') {
          rosterKeys[index] = 'empty';
          setHidden(dot, true);
          setClass(dot, 'is-ally', false);
          setClass(dot, 'is-enemy', false);
          setClass(dot, 'is-down', false);
          setAttr(dot, 'aria-label', '');
        }
        continue;
      }

      const down = player.state === 'down' || player.state === 'respawn';
      const ally = player.team === team;
      const key = `${ally ? 'a' : 'e'}:${down ? 'd' : 'u'}:${player.team}`;
      if (rosterKeys[index] !== key) {
        rosterKeys[index] = key;
        setClass(dot, 'is-ally', ally);
        setClass(dot, 'is-enemy', !ally);
        setClass(dot, 'is-down', down);
        setVar(dot, '--pr-dot-color', down ? DOWN_COLOR : teamColor(teamColors, player.team));
        setAttr(dot, 'aria-label', rosterLabel(ally, down));
        setHidden(dot, false);
      }
    }
  }

  function hideBanner(): void {
    if (bannerTimer !== null) {
      globalThis.clearTimeout(bannerTimer);
      bannerTimer = null;
    }
    setClass(banner, 'is-visible', false);
    setHidden(banner, true);
  }

  function setStartGateVisible(visible: boolean): void {
    if (disposed) return;
    setHidden(startGate, !visible);
  }

  return {
    update(view: PlayerView, snapshot: WorldSnapshot, totalCells: number): void {
      if (disposed) return;

      const hpValue = Math.round(finiteIn(view.hp, 0, 100) * 10) / 10;
      if (hpValue !== lastHp) {
        lastHp = hpValue;
        updateHearts(hpValue);
      }

      const hpNow = String(Math.round(hpValue));
      if (hpNow !== lastAriaHp) {
        lastAriaHp = hpNow;
        setAttr(hp, 'aria-valuenow', hpNow);
      }

      const inkValue = Math.round(finiteIn(view.ink, 0, 100) * 10) / 10;
      if (inkValue !== lastInk) {
        lastInk = inkValue;
        setVar(gourdFill, '--pr-ink', statText(inkValue));
      }

      const inkNow = String(Math.round(inkValue));
      if (inkNow !== lastAriaInk) {
        lastAriaInk = inkNow;
        setAttr(gourdBody, 'aria-valuenow', inkNow);
      }

      const color = teamColor(teamColors, view.team);
      if (color !== lastTeam) {
        lastTeam = color;
        setVar(ui, '--pr-team-color', color);
      }

      const label = formLabel(view.state);
      const key = formKey(label);
      if (key !== lastForm) {
        lastForm = key;
        renderFormLabel(form, label);
      }

      const safeTime = Number.isFinite(snapshot.timeLeft) ? clamp(snapshot.timeLeft, 0, MAX_TIME_SECONDS) : 0;
      // The score pills sit where the clock sits, so the two never share a phase.
      const showTime = safeTime > 0 && snapshot.phase !== 'finished';
      if (showTime !== lastShowTime) {
        lastShowTime = showTime;
        setHidden(time, !showTime);
      }
      if (showTime) {
        const clockSeconds = Math.ceil(safeTime);
        if (clockSeconds !== lastClockSeconds) {
          lastClockSeconds = clockSeconds;
          setText(time, formatClockSeconds(clockSeconds));
        }
      }

      const countdownValue = showTime && safeTime <= 10 ? String(Math.ceil(safeTime)) : '';
      const showCountdown = countdownValue !== '';
      if (showCountdown !== lastShowCountdown) {
        lastShowCountdown = showCountdown;
        setHidden(countdown, !showCountdown);
      }
      if (showCountdown && countdownValue !== lastCountdown) {
        lastCountdown = countdownValue;
        setText(countdown, countdownValue);
      }

      // Training has no match clock, so its zero time marks it even while the
      // simulation keeps the friendly 'play' phase.
      const training = safeTime <= 0 && snapshot.phase !== 'finished';
      const paintsHidden = !training && hidesPaint(snapshot.phase);
      if (paintsHidden !== lastPaintsHidden) {
        lastPaintsHidden = paintsHidden;
        setHidden(score, paintsHidden);
      }
      if (!paintsHidden) {
        const zero = percentText(snapshot.counts[0], totalCells);
        if (zero !== lastScoreZero) {
          lastScoreZero = zero;
          setText(teamZeroPct, zero);
        }
        const one = percentText(snapshot.counts[1], totalCells);
        if (one !== lastScoreOne) {
          lastScoreOne = one;
          setText(teamOnePct, one);
        }
      }

      const gaugeValue = finiteIn(view.gauge, 0, 1);
      const gaugePercent = Math.round(gaugeValue * 1000) / 10;
      if (gaugePercent !== lastGaugePercent) {
        lastGaugePercent = gaugePercent;
        setVar(gaugeRing, '--pr-gauge-fill', `${gaugePercent}%`);
      }
      const gaugeNow = String(Math.round(gaugeValue * 100));
      if (gaugeNow !== lastGaugeNow) {
        lastGaugeNow = gaugeNow;
        setAttr(gaugeRing, 'aria-valuenow', gaugeNow);
      }
      setClass(gauge, 'is-full', gaugeValue >= 1 - GAUGE_FULL_EPSILON);

      const chargeValue = finiteIn(view.charge, 0, 1);
      const charging = chargeValue > 0;
      setHidden(charge, !charging);
      if (charging) {
        const chargePercent = Math.round(chargeValue * 1000) / 10;
        if (chargePercent !== lastChargePercent) {
          lastChargePercent = chargePercent;
          setVar(charge, '--pr-charge-fill', `${chargePercent}%`);
        }
      }

      updateRoster(view.team, snapshot.players);
    },

    log(text: string): void {
      if (disposed) return;
      const message = text.trim();
      if (message.length === 0) return;

      const line = document.createElement('p');
      line.className = 'pr-killlog__line';
      line.textContent = message;

      const timer = globalThis.setTimeout(() => {
        line.classList.add('is-faded');
      }, KILL_FADE_MS);

      killEntries.unshift({ line, timer });
      killLog.prepend(line);

      while (killEntries.length > 3) {
        const oldest = killEntries.pop();
        if (oldest !== undefined) {
          globalThis.clearTimeout(oldest.timer);
          oldest.line.remove();
        }
      }
    },

    banner(text: string): void {
      if (disposed) return;
      const message = text.trim();
      if (message.length === 0) {
        hideBanner();
        return;
      }

      if (bannerTimer !== null) {
        globalThis.clearTimeout(bannerTimer);
        bannerTimer = null;
      }

      setText(bannerText, message);
      setHidden(banner, false);
      setClass(banner, 'is-visible', true);

      bannerTimer = globalThis.setTimeout(() => {
        bannerTimer = null;
        if (disposed) return;
        setClass(banner, 'is-visible', false);
        setHidden(banner, true);
      }, BANNER_VISIBLE_MS);
    },

    setVisible(visible: boolean): void {
      if (disposed) return;
      setHidden(ui, visible !== true);
    },

    showPaused(visible: boolean, reason?: string): void {
      if (disposed) return;
      setText(pausedReason, reason ?? '');
      const shouldShow = visible === true;
      if (pausedOverlay.hidden === !shouldShow) return;
      pausedOverlay.hidden = !shouldShow;
      // Move focus onto the button so it can be reached without a mouse.
      if (shouldShow) pausedButton.focus();
    },

    showStartGate(visible: boolean): void {
      setStartGateVisible(visible === true);
      if (visible === true) startGateButton.focus();
    },

    onStart(callback: () => void): void {
      if (disposed) return;
      startCallback = callback;
    },

    onResume(callback: () => void): void {
      if (disposed) return;
      resumeCallback = callback;
    },

    onQuit(callback: () => void): void {
      if (disposed) return;
      quitCallback = callback;
    },

    setTeams(teams: readonly HudTeam[]): void {
      if (disposed) return;
      const zero = sanitizeTeam(teams[0] ?? TEAM_NAMES[0], TEAM_NAMES[0]);
      const one = sanitizeTeam(teams[1] ?? TEAM_NAMES[1], TEAM_NAMES[1]);
      teamColors[0] = teamCssColor(zero.color);
      teamColors[1] = teamCssColor(one.color);
      renderTeamName(teamZeroName, zero);
      renderTeamName(teamOneName, one);
      setVar(teamZero, '--pr-team-color', teamColors[0]);
      setVar(teamOne, '--pr-team-color', teamColors[1]);
      // Force the next update to apply the new local team colour.
      lastTeam = '';
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      resumeCallback = null;
      quitCallback = null;
      startCallback = null;
      pausedButton.removeEventListener('click', onResumeClick);
      quitButton.removeEventListener('click', onQuitClick);
      startGateButton.removeEventListener('click', onStartClick);

      for (const entry of killEntries) {
        globalThis.clearTimeout(entry.timer);
        entry.line.remove();
      }
      killEntries.length = 0;

      if (bannerTimer !== null) {
        globalThis.clearTimeout(bannerTimer);
        bannerTimer = null;
      }

      ui.remove();
    },
  };
}
