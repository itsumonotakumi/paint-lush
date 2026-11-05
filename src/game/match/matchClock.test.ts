import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../core/events';
import type { IMatchClock } from '../contracts';
import type { MatchConfig } from '../data/schemas';
import { createMatchClock } from './matchClock';

const TPS = 60;
const BASE: MatchConfig = {
  durationSeconds: 180,
  preSeconds: 3,
  lastMinuteAt: 60,
  countdownAt: 10,
  settleSeconds: 0.5,
  teamSize: 4,
};

function advance(clock: IMatchClock, steps: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < steps; i += 1) events.push(...clock.step());
  return events;
}

function countdownSequence(from: number, to: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let n = from; n >= to; n -= 1) out.push({ t: 'countdown', n });
  return out;
}

const PRE_STEPS = 3 * TPS;
const LAST_MINUTE_STEP = PRE_STEPS + (180 - 60) * TPS;
const COUNTDOWN_STEP = PRE_STEPS + (180 - 10) * TPS;
const FINISH_STEP = PRE_STEPS + 180 * TPS;

describe('createMatchClock', () => {
  it('starts in pre with inputs locked and the full duration showing', () => {
    const clock = createMatchClock(BASE);
    expect(clock.phase()).toBe('pre');
    expect(clock.timeLeft()).toBe(180);
    expect(clock.inputsEnabled()).toBe(false);
    expect(clock.settled()).toBe(false);
  });

  it('enters play on the exact tick preSeconds ends', () => {
    const clock = createMatchClock(BASE);
    expect(advance(clock, PRE_STEPS - 1)).toEqual([]);
    expect(clock.phase()).toBe('pre');

    const events = clock.step();
    expect(events).toEqual([
      { t: 'phase', phase: 'play' },
      { t: 'voice', line: 'start' },
    ]);
    expect(clock.phase()).toBe('play');
    expect(clock.timeLeft()).toBe(180);
    expect(clock.inputsEnabled()).toBe(true);
  });

  it('enters lastMinute on the exact tick 60 s remain, without repeating it', () => {
    const clock = createMatchClock(BASE);
    advance(clock, PRE_STEPS);
    expect(advance(clock, LAST_MINUTE_STEP - PRE_STEPS - 1)).toEqual([]);
    expect(clock.phase()).toBe('play');
    expect(clock.timeLeft()).toBeCloseTo(60 + 1 / TPS, 10);

    expect(clock.step()).toEqual([
      { t: 'phase', phase: 'lastMinute' },
      { t: 'voice', line: 'lastMinute' },
    ]);
    expect(clock.phase()).toBe('lastMinute');
    expect(clock.timeLeft()).toBe(60);

    expect(clock.step()).toEqual([]);
    expect(clock.phase()).toBe('lastMinute');
  });

  it('enters countdown at exactly 10 s and counts one number per second', () => {
    const clock = createMatchClock(BASE);
    advance(clock, COUNTDOWN_STEP - 1);
    expect(clock.phase()).toBe('lastMinute');

    expect(clock.step()).toEqual([
      { t: 'phase', phase: 'countdown' },
      { t: 'countdown', n: 10 },
    ]);
    expect(clock.timeLeft()).toBe(10);
    expect(clock.inputsEnabled()).toBe(true);

    for (let n = 9; n >= 1; n -= 1) {
      expect(advance(clock, TPS - 1)).toEqual([]);
      expect(clock.step()).toEqual([{ t: 'countdown', n }]);
      expect(clock.timeLeft()).toBe(n);
    }
  });

  it('finishes exactly at zero and locks input', () => {
    const clock = createMatchClock(BASE);
    advance(clock, FINISH_STEP - 1);
    expect(clock.phase()).toBe('countdown');
    expect(clock.timeLeft()).toBeCloseTo(1 / TPS, 10);

    expect(clock.step()).toEqual([{ t: 'phase', phase: 'finished' }]);
    expect(clock.phase()).toBe('finished');
    expect(clock.timeLeft()).toBe(0);
    expect(clock.inputsEnabled()).toBe(false);
    expect(clock.settled()).toBe(false);
  });

  it('settles settleSeconds after the final tick', () => {
    const clock = createMatchClock(BASE);
    advance(clock, FINISH_STEP);
    expect(clock.settled()).toBe(false);

    advance(clock, Math.round(0.5 * TPS) - 1);
    expect(clock.settled()).toBe(false);

    clock.step();
    expect(clock.settled()).toBe(true);
    // Settled stays true and no more events fire.
    expect(advance(clock, 10)).toEqual([]);
    expect(clock.phase()).toBe('finished');
  });

  it('produces the full event sequence for a 180 s match', () => {
    const clock = createMatchClock(BASE);
    expect(advance(clock, FINISH_STEP)).toEqual([
      { t: 'phase', phase: 'play' },
      { t: 'voice', line: 'start' },
      { t: 'phase', phase: 'lastMinute' },
      { t: 'voice', line: 'lastMinute' },
      { t: 'phase', phase: 'countdown' },
      ...countdownSequence(10, 1),
      { t: 'phase', phase: 'finished' },
    ]);
  });

  it('starts a 60 s match in lastMinute without a duplicate phase event', () => {
    const cfg: MatchConfig = { ...BASE, durationSeconds: 60 };
    const clock = createMatchClock(cfg);

    const startEvents = advance(clock, PRE_STEPS);
    expect(startEvents).toEqual([
      { t: 'phase', phase: 'lastMinute' },
      { t: 'voice', line: 'start' },
    ]);
    expect(startEvents.filter((event) => event.t === 'phase')).toHaveLength(1);
    expect(clock.phase()).toBe('lastMinute');
    expect(clock.timeLeft()).toBe(60);

    expect(advance(clock, 60 * TPS)).toEqual([
      { t: 'phase', phase: 'countdown' },
      ...countdownSequence(10, 1),
      { t: 'phase', phase: 'finished' },
    ]);
    expect(clock.phase()).toBe('finished');
  });

  it('honours the short-match rule even when lastMinuteAt is smaller', () => {
    const cfg: MatchConfig = { ...BASE, durationSeconds: 60, lastMinuteAt: 30 };
    const clock = createMatchClock(cfg);
    const startEvents = advance(clock, PRE_STEPS);
    expect(startEvents).toEqual([
      { t: 'phase', phase: 'lastMinute' },
      { t: 'voice', line: 'start' },
    ]);
    expect(clock.phase()).toBe('lastMinute');
    // Crossing 30 s left is not a new phase and must not announce again.
    expect(advance(clock, (60 - 30) * TPS)).toEqual([]);
    expect(clock.phase()).toBe('lastMinute');
  });

  it('keeps time finite and exact over a full match', () => {
    const clock = createMatchClock(BASE);
    advance(clock, PRE_STEPS);
    for (let second = 1; second <= 5; second += 1) {
      advance(clock, TPS);
      expect(clock.timeLeft()).toBe(180 - second);
      expect(Number.isFinite(clock.timeLeft())).toBe(true);
    }
  });

  it('treats a sub-tick pre delay and settle delay as zero', () => {
    const cfg: MatchConfig = { ...BASE, preSeconds: 0.001, settleSeconds: 0.001 };
    const clock = createMatchClock(cfg);
    expect(clock.step()).toEqual([
      { t: 'phase', phase: 'play' },
      { t: 'voice', line: 'start' },
    ]);
    advance(clock, 180 * TPS);
    expect(clock.phase()).toBe('finished');
    expect(clock.settled()).toBe(true);
  });
});
