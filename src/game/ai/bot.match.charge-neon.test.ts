import { beforeAll, describe, expect, it } from 'vitest';
import { DIFFICULTIES, readMetrics, runStage } from './bot.match.helpers';
import type { RunMetrics } from './bot.match.helpers';
import type { Difficulty } from '../data/schemas';

const STAGE = 'neon';

let charge: ReadonlyMap<Difficulty, RunMetrics> = new Map();

describe('90 second headless charge mirror matches on neon town', () => {
  beforeAll(() => {
    charge = runStage(STAGE, 'charge');
  }, 90_000);

  it('has charge bots firing repeatedly in every mirror match', () => {
    for (const difficulty of DIFFICULTIES) {
      const metrics = readMetrics(charge, difficulty);
      expect(metrics.shots, `${STAGE}/${difficulty} charge shots`).toBeGreaterThanOrEqual(10);
    }
  });

  it('keeps every measured value finite', () => {
    for (const metrics of charge.values()) {
      expect(Number.isFinite(metrics.paint)).toBe(true);
      expect(Number.isFinite(metrics.kills)).toBe(true);
      expect(Number.isFinite(metrics.shots)).toBe(true);
      expect(Number.isFinite(metrics.subs)).toBe(true);
      expect(Number.isFinite(metrics.dryShare)).toBe(true);
      expect(metrics.dryShare).toBeGreaterThanOrEqual(0);
      expect(metrics.dryShare).toBeLessThanOrEqual(1);
    }
  });
});
