import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SpecialState } from '../contracts';
import type { SpecialWeapon, Weapon } from '../data/schemas';
import { gainGauge, modifiers, stepSpecial, tryActivate } from './special';

const WEAPON: Weapon = {
  id: 'paint-brush',
  name: 'Paint Brush',
  kind: 'projectile',
  specialGainPerCell: 0.5,
  intervalSeconds: 0.1,
  inkCost: 0,
  damage: 1,
  muzzleSpeed: 1,
  projectileGravity: 0,
  spreadRadians: 0,
  paintRadius: 1,
  trailSpacing: 1,
  trailRadius: 1,
  lifetimeSeconds: 1,
};

const SPECIAL: SpecialWeapon = {
  id: 'bloom',
  name: 'Bloom',
  kind: 'hyakka',
  gaugeMax: 100,
  durationSeconds: 5,
  fireRateMultiplier: 2,
  paintRadiusMultiplier: 1.5,
  inkCostMultiplier: 0.5,
  bgmId: 'bgm-bloom',
};

function state(overrides: Partial<SpecialState> = {}): SpecialState {
  return { gauge: 0, activeLeft: 0, prevButton: false, ...overrides };
}

describe('gainGauge', () => {
  it('adds cells times the weapon gain rate', () => {
    const s = state();
    const events = gainGauge(s, 20, WEAPON, SPECIAL, 7);

    expect(s.gauge).toBeCloseTo(10);
    expect(events).toEqual([]);
  });

  it('emits ready once when the gauge first reaches its maximum', () => {
    const s = state({ gauge: 90 });

    expect(gainGauge(s, 20, WEAPON, SPECIAL, 3)).toEqual([
      { t: 'special', id: 3, phase: 'ready' },
    ]);
    expect(s.gauge).toBe(100);

    // More paint while already full must not repeat the ready event.
    expect(gainGauge(s, 20, WEAPON, SPECIAL, 3)).toEqual([]);
    expect(s.gauge).toBe(100);
  });

  it('clamps an overdrawn gain to the gauge maximum', () => {
    const s = state({ gauge: 1 });
    gainGauge(s, 1_000_000, WEAPON, SPECIAL, 1);
    expect(s.gauge).toBe(100);
  });

  it('does not gain while the special is active', () => {
    const s = state({ gauge: 40, activeLeft: 1 });

    expect(gainGauge(s, 100, WEAPON, SPECIAL, 1)).toEqual([]);
    expect(s.gauge).toBe(40);
    expect(s.activeLeft).toBe(1);
  });

  it('ignores negative, non-finite and zero-cell gains', () => {
    const s = state({ gauge: 5 });

    gainGauge(s, -10, WEAPON, SPECIAL, 1);
    gainGauge(s, Number.NaN, WEAPON, SPECIAL, 1);
    gainGauge(s, Number.POSITIVE_INFINITY, WEAPON, SPECIAL, 1);
    gainGauge(s, 10, { ...WEAPON, specialGainPerCell: Number.NaN }, SPECIAL, 1);
    expect(s.gauge).toBe(5);
  });

  it('repairs an out-of-range stored gauge without emitting ready', () => {
    const low = state({ gauge: -50 });
    gainGauge(low, 0, WEAPON, SPECIAL, 1);
    expect(low.gauge).toBe(0);

    const high = state({ gauge: Number.NaN });
    const events = gainGauge(high, 10, WEAPON, SPECIAL, 1);
    expect(high.gauge).toBe(5);
    expect(events).toEqual([]);
  });
});

describe('tryActivate', () => {
  it('starts on a rising edge with a full gauge', () => {
    const s = state({ gauge: 100 });

    const events = tryActivate(s, true, SPECIAL, 9);

    expect(events).toEqual([{ t: 'special', id: 9, phase: 'start' }]);
    expect(s.gauge).toBe(0);
    expect(s.activeLeft).toBe(5);
    expect(s.prevButton).toBe(true);
  });

  it('ignores a held button and only fires again after a release', () => {
    const s = state({ gauge: 100 });

    expect(tryActivate(s, true, SPECIAL, 1)).toHaveLength(1);
    expect(tryActivate(s, true, SPECIAL, 1)).toEqual([]);

    // Once the special has ended the gauge can fill and fire again.
    s.activeLeft = 0;
    s.gauge = 100;
    expect(tryActivate(s, false, SPECIAL, 1)).toEqual([]);
    expect(s.prevButton).toBe(false);
    expect(tryActivate(s, true, SPECIAL, 1)).toEqual([
      { t: 'special', id: 1, phase: 'start' },
    ]);
  });

  it('refuses a partial gauge but still records the button state', () => {
    const s = state({ gauge: 99 });

    expect(tryActivate(s, true, SPECIAL, 1)).toEqual([]);
    expect(s.prevButton).toBe(true);
    expect(s.activeLeft).toBe(0);
    expect(s.gauge).toBe(99);

    // Holding after the refusal must not activate when the gauge fills.
    s.gauge = 100;
    expect(tryActivate(s, true, SPECIAL, 1)).toEqual([]);
  });

  it('does not restart an already active special', () => {
    const s = state({ gauge: 100, activeLeft: 2 });

    expect(tryActivate(s, true, SPECIAL, 1)).toEqual([]);
    expect(s.activeLeft).toBe(2);
    expect(s.gauge).toBe(100);
  });
});

describe('stepSpecial', () => {
  it('ticks down and emits exactly one end event', () => {
    const s = state({ activeLeft: 0.1 });

    expect(stepSpecial(s, 0.04, 4)).toEqual([]);
    expect(s.activeLeft).toBeCloseTo(0.06);
    expect(stepSpecial(s, 0.04, 4)).toEqual([]);
    expect(s.activeLeft).toBeCloseTo(0.02);

    expect(stepSpecial(s, 0.04, 4)).toEqual([{ t: 'special', id: 4, phase: 'end' }]);
    expect(s.activeLeft).toBe(0);
    expect(stepSpecial(s, 0.04, 4)).toEqual([]);
  });

  it('does nothing when inactive or when dt is not a positive finite number', () => {
    const idle = state();
    expect(stepSpecial(idle, 1 / 60, 1)).toEqual([]);
    expect(idle.activeLeft).toBe(0);

    const active = state({ activeLeft: 1 });
    expect(stepSpecial(active, 0, 1)).toEqual([]);
    expect(stepSpecial(active, -1, 1)).toEqual([]);
    expect(stepSpecial(active, Number.NaN, 1)).toEqual([]);
    expect(stepSpecial(active, Number.POSITIVE_INFINITY, 1)).toEqual([]);
    expect(active.activeLeft).toBe(1);
  });
});

describe('modifiers', () => {
  it('returns neutral multipliers when inactive', () => {
    expect(modifiers(state(), SPECIAL)).toEqual({
      fireRateMul: 1,
      paintMul: 1,
      inkCostMul: 1,
    });
  });

  it('returns the configured multipliers while active', () => {
    expect(modifiers(state({ activeLeft: 0.5 }), SPECIAL)).toEqual({
      fireRateMul: 2,
      paintMul: 1.5,
      inkCostMul: 0.5,
    });
  });

  it('keeps every multiplier finite for malformed data', () => {
    const broken: SpecialWeapon = {
      ...SPECIAL,
      fireRateMultiplier: Number.NaN,
      paintRadiusMultiplier: Number.POSITIVE_INFINITY,
      inkCostMultiplier: Number.NaN,
    };
    const mods = modifiers(state({ activeLeft: 1 }), broken);

    expect(Number.isFinite(mods.fireRateMul)).toBe(true);
    expect(Number.isFinite(mods.paintMul)).toBe(true);
    expect(Number.isFinite(mods.inkCostMul)).toBe(true);
    expect(mods.inkCostMul).toBe(0);
  });
});

describe('special lifecycle event order', () => {
  it('emits ready, then start, then end in that order', () => {
    const s = state({ gauge: 80 });
    const events = [
      ...gainGauge(s, 40, WEAPON, SPECIAL, 12),
      ...tryActivate(s, true, SPECIAL, 12),
      ...stepSpecial(s, 2, 12),
      ...stepSpecial(s, 3, 12),
    ];

    expect(events).toEqual([
      { t: 'special', id: 12, phase: 'ready' },
      { t: 'special', id: 12, phase: 'start' },
      { t: 'special', id: 12, phase: 'end' },
    ]);
  });
});

describe('gainGauge invariants', () => {
  it('keeps the gauge finite and inside [0, gaugeMax] for arbitrary inputs', () => {
    const cellArb = fc.oneof(
      fc.double({ min: -1e6, max: 1e6 }),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
    );

    fc.assert(
      fc.property(cellArb, cellArb, (cells, gauge) => {
        const s = state({ gauge });
        const events = gainGauge(s, cells, WEAPON, SPECIAL, 1);

        expect(Number.isFinite(s.gauge)).toBe(true);
        expect(s.gauge).toBeGreaterThanOrEqual(0);
        expect(s.gauge).toBeLessThanOrEqual(SPECIAL.gaugeMax);
        expect(events.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});
