import type { GameEvent, MatchPhase } from '../../core/events';
import { FIXED_DT } from '../../core/types';
import type { IMatchClock } from '../contracts';
import type { MatchConfig } from '../data/schemas';

/** Ticks in one second. Derived so the clock and the rest of the game share one rate. */
const TICKS_PER_SECOND = Math.round(1 / FIXED_DT);
/** A 60 s match is already inside its last minute when the whistle blows. */
const SHORT_MATCH_SECONDS = 60;
/** Upper bound on tick counts and countdown names, so hostile configs cannot loop forever. */
const MAX_TICKS = 1_000_000;
const MAX_COUNTDOWN_SECONDS = 3_600;

/** Finite, non-negative seconds to whole ticks, rounded to the nearest tick. */
function secondsToTicks(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const ticks = Math.round(seconds * TICKS_PER_SECOND);
  if (!Number.isFinite(ticks) || ticks <= 0) return 0;
  return ticks > MAX_TICKS ? MAX_TICKS : ticks;
}

/**
 * Match timer driven purely by whole ticks, so long matches cannot drift.
 *
 * Timeline at 180 s with the shipped config:
 * pre 0..179 -> play at tick 180 -> lastMinute with 60 s left -> countdown
 * with 10 s left (one `countdown` event per second) -> finished at 0.
 */
export function createMatchClock(cfg: MatchConfig): IMatchClock {
  const durationTicks = secondsToTicks(cfg.durationSeconds);
  const preTicks = secondsToTicks(cfg.preSeconds);
  const lastMinuteTicks = secondsToTicks(cfg.lastMinuteAt);
  const countdownTicks = secondsToTicks(cfg.countdownAt);
  const settleTicks = secondsToTicks(cfg.settleSeconds);
  const shortMatchTicks = SHORT_MATCH_SECONDS * TICKS_PER_SECOND;

  const countdownSeconds = Number.isFinite(cfg.countdownAt)
    ? Math.max(0, Math.floor(cfg.countdownAt))
    : 0;
  const durationSeconds = Math.floor(durationTicks / TICKS_PER_SECOND);
  // Never announce a count above the match length; that could never happen.
  let nextCountdown = Math.min(countdownSeconds, durationSeconds, MAX_COUNTDOWN_SECONDS);

  let phase: MatchPhase = 'pre';
  let preElapsed = 0;
  /** Phases only move forward; a short match that starts in lastMinute must not fall back to play. */
  const phaseRank: Record<MatchPhase, number> = {
    pre: 0,
    play: 1,
    lastMinute: 2,
    countdown: 3,
    finished: 4,
  };
  /** Ticks of gameplay elapsed. Stays 0 during 'pre'. */
  let gameTicks = 0;
  /** Ticks elapsed since the final whistle. */
  let finishElapsed = 0;

  function phaseAt(remainingTicks: number, atStart: boolean): MatchPhase {
    if (remainingTicks <= 0) return 'finished';
    if (remainingTicks <= countdownTicks) return 'countdown';
    if (remainingTicks <= lastMinuteTicks) return 'lastMinute';
    if (atStart && durationTicks <= shortMatchTicks) return 'lastMinute';
    return 'play';
  }

  function pushCountdowns(events: GameEvent[], remainingTicks: number): void {
    while (nextCountdown >= 1 && remainingTicks <= nextCountdown * TICKS_PER_SECOND) {
      events.push({ t: 'countdown', n: nextCountdown });
      nextCountdown -= 1;
    }
  }

  function beginPlay(events: GameEvent[]): void {
    const start = phaseAt(durationTicks, true);
    phase = start;
    // Exactly one phase change, even when the match opens inside its last minute.
    events.push({ t: 'phase', phase: start });
    events.push({ t: 'voice', line: 'start' });
    if (start === 'finished') {
      finishElapsed = 0;
      return;
    }
    if (start === 'countdown') pushCountdowns(events, durationTicks);
    // 'lastMinute' at the very start is covered by the start call, so it is not
    // announced twice; only a later play -> lastMinute change gets its own voice.
  }

  function step(): GameEvent[] {
    const events: GameEvent[] = [];

    if (phase === 'pre') {
      preElapsed += 1;
      if (preElapsed >= preTicks) beginPlay(events);
      return events;
    }

    if (phase === 'finished') {
      finishElapsed += 1;
      return events;
    }

    gameTicks += 1;
    const remainingTicks = durationTicks - gameTicks;

    const next = phaseAt(remainingTicks, false);
    if (next !== phase && phaseRank[next] > phaseRank[phase]) {
      phase = next;
      events.push({ t: 'phase', phase: next });
      if (next === 'lastMinute') events.push({ t: 'voice', line: 'lastMinute' });
      if (next === 'finished') finishElapsed = 0;
    }
    // Includes the tick that enters 'countdown', so n = countdownAt lands exactly
    // on the transition tick and each later n lands one second after the previous.
    if (phase === 'countdown') pushCountdowns(events, remainingTicks);

    return events;
  }

  function timeLeft(): number {
    if (phase === 'pre') return durationTicks / TICKS_PER_SECOND;
    const remainingTicks = durationTicks - gameTicks;
    if (!Number.isFinite(remainingTicks) || remainingTicks <= 0) return 0;
    return remainingTicks / TICKS_PER_SECOND;
  }

  function inputsEnabled(): boolean {
    return phase !== 'pre' && phase !== 'finished';
  }

  function settled(): boolean {
    return phase === 'finished' && finishElapsed >= settleTicks;
  }

  return {
    step,
    phase(): MatchPhase {
      return phase;
    },
    timeLeft,
    inputsEnabled,
    settled,
  };
}
