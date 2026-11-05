import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PlayerStateName } from '../../core/snapshot';
import { RUN_FREQUENCY, createNinjaPose, pose } from './ninjaPose';

const STATES: readonly PlayerStateName[] = ['stance', 'dive', 'air', 'down', 'respawn'];
const PERIOD = (Math.PI * 2) / RUN_FREQUENCY;

function expectFinite(p: { legSwing: number; armSwing: number; lean: number; bounce: number; tailSwing: number }): void {
  expect(Number.isFinite(p.legSwing)).toBe(true);
  expect(Number.isFinite(p.armSwing)).toBe(true);
  expect(Number.isFinite(p.lean)).toBe(true);
  expect(Number.isFinite(p.bounce)).toBe(true);
  expect(Number.isFinite(p.tailSwing)).toBe(true);
}

describe('ninja pose', () => {
  it('stays finite for every state, time and speed', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10000, max: 10000, noNaN: true }),
        fc.double({ min: -10, max: 30, noNaN: true }),
        fc.constantFrom(...STATES),
        (t, speed, state) => {
          expectFinite(pose(t, speed, state));
        },
      ),
    );
    for (const state of STATES) {
      expectFinite(pose(Number.NaN, Number.POSITIVE_INFINITY, state));
      expectFinite(pose(Number.NEGATIVE_INFINITY, Number.NaN, state));
    }
  });

  it('never swings a leg beyond 1.2 radians', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10000, max: 10000, noNaN: true }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        fc.constantFrom(...STATES),
        (t, speed, state) => {
          expect(Math.abs(pose(t, speed, state).legSwing)).toBeLessThanOrEqual(1.2);
        },
      ),
    );
  });

  it('repeats every run period at t = 0 and t = 2*PI/14', () => {
    for (const state of STATES) {
      for (const speed of [0, 0.5, 0.51, 3, 12]) {
        const first = pose(0, speed, state);
        const later = pose(PERIOD, speed, state);
        expect(later.legSwing).toBeCloseTo(first.legSwing, 10);
        expect(later.armSwing).toBeCloseTo(first.armSwing, 10);
        expect(later.lean).toBeCloseTo(first.lean, 10);
        expect(later.bounce).toBeCloseTo(first.bounce, 10);
        expect(later.tailSwing).toBeCloseTo(first.tailSwing, 10);
      }
    }
  });

  it('runs with opposite arm and leg swings and a forward lean', () => {
    const p = pose(0.1, 2, 'stance');
    expect(Math.abs(p.legSwing)).toBeGreaterThan(0.5);
    expect(p.armSwing).toBeCloseTo(-p.legSwing, 12);
    expect(p.lean).toBeCloseTo(0.15, 12);
    expect(p.bounce).toBeGreaterThan(0);
    expect(p.bounce).toBeLessThanOrEqual(0.04);
    expect(p.tailSwing).not.toBe(0);
  });

  it('breathes gently while idle and does not run at the threshold', () => {
    const idle = pose(0.33, 0.5, 'stance');
    expect(idle.legSwing).toBe(0);
    expect(idle.lean).toBe(0);
    expect(idle.bounce).toBeGreaterThanOrEqual(0);
    expect(idle.bounce).toBeLessThanOrEqual(0.02);

    const justRunning = pose(0.33, 0.5001, 'stance');
    expect(justRunning.lean).toBeCloseTo(0.15, 12);
  });

  it('tucks legs and raises arms in the air with straight tails', () => {
    const p = pose(2.4, 3, 'air');
    expect(p.legSwing).toBeCloseTo(-0.9, 12);
    expect(p.armSwing).toBeLessThan(-1);
    expect(p.tailSwing).toBe(0);
  });

  it('is neutral on the floor, in a dive, and while respawning', () => {
    for (const state of ['dive', 'down', 'respawn'] as const) {
      const p = pose(1.7, 4, state);
      expect(p.legSwing).toBe(0);
      expect(p.armSwing).toBe(0);
      expect(p.lean).toBe(0);
      expect(p.bounce).toBe(0);
      expect(p.tailSwing).toBe(0);
    }
  });

  it('writes into a supplied buffer instead of allocating', () => {
    const out = createNinjaPose();
    const returned = pose(0.5, 2, 'stance', out);
    expect(returned).toBe(out);
    expect(out.lean).toBeCloseTo(0.15, 12);
  });
});
