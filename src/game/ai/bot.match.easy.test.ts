import { beforeAll, describe, expect, it } from 'vitest';
import { STAGE_NAMES, readStage, runMatch } from './bot.match.helpers';
import type { RunMetrics, StageName } from './bot.match.helpers';

const easy = new Map<StageName, RunMetrics>();

describe('90 second headless bot matches on easy', () => {
  beforeAll(() => {
    for (const stage of STAGE_NAMES) {
      easy.set(stage, runMatch(stage, 'easy', 'mixed'));
    }
  }, 90_000);

  it('keeps easy bots out of a dry tank for most of their alive time', () => {
    for (const stage of STAGE_NAMES) {
      const metrics = readStage(easy, stage);
      expect(metrics.dryShare, `${stage}/easy dry share`).toBeLessThan(0.25);
    }
  });

  it('throws a sub at least once on easy in every stage', () => {
    for (const stage of STAGE_NAMES) {
      const metrics = readStage(easy, stage);
      expect(metrics.subs, `${stage}/easy sub throws`).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps every measured value finite', () => {
    for (const metrics of easy.values()) {
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
