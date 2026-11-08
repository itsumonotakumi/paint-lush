import { beforeAll, describe, expect, it } from 'vitest';
import { STAGE_NAMES, runMatch } from './bot.match.helpers';
import type { RunMetrics, StageName } from './bot.match.helpers';
import type { Difficulty } from '../data/schemas';

/** Only the difficulties the hard-versus-normal comparisons need. */
const COMPARED: readonly Difficulty[] = ['normal', 'hard'];

const mixed = new Map<string, RunMetrics>();

function key(stage: StageName, difficulty: Difficulty): string {
  return `${stage}:${difficulty}`;
}

function read(stage: StageName, difficulty: Difficulty): RunMetrics {
  const value = mixed.get(key(stage, difficulty));
  if (value === undefined) throw new Error(`missing measurement for ${stage}/${difficulty}`);
  return value;
}

describe('90 second headless bot matches: hard versus normal', () => {
  beforeAll(() => {
    for (const stage of STAGE_NAMES) {
      for (const difficulty of COMPARED) {
        mixed.set(key(stage, difficulty), runMatch(stage, difficulty, 'mixed'));
      }
    }
  }, 90_000);

  it('makes hard more lethal than normal on at least one stage', () => {
    const lethal = STAGE_NAMES.some(
      (stage) => read(stage, 'hard').kills > read(stage, 'normal').kills,
    );
    expect(lethal).toBe(true);
  });

  it('keeps hard paint at least 0.7 times normal paint overall', () => {
    let normalPaint = 0;
    let hardPaint = 0;
    for (const stage of STAGE_NAMES) {
      normalPaint += read(stage, 'normal').paint;
      hardPaint += read(stage, 'hard').paint;
    }
    expect(normalPaint).toBeGreaterThan(0);
    expect(hardPaint).toBeGreaterThanOrEqual(normalPaint * 0.7);
  });

  it('throws a sub at least once on normal and hard in every stage', () => {
    for (const stage of STAGE_NAMES) {
      for (const difficulty of COMPARED) {
        const metrics = read(stage, difficulty);
        expect(metrics.subs, `${stage}/${difficulty} sub throws`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps every measured value finite', () => {
    for (const metrics of mixed.values()) {
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
