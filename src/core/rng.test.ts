import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRng } from './rng';

function sequence(seed: number, count: number): number[] {
  const rng = createRng(seed);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(rng.next());
  return out;
}

describe('createRng', () => {
  it('matches a fixed mulberry32 sequence for known seeds', () => {
    const rng = createRng(1);
    expect(rng.next()).toBe(0.6270739405881613);
    expect(rng.next()).toBe(0.002735721180215478);
    expect(rng.next()).toBe(0.5274470399599522);
  });

  it('reproduces the same sequence for the same seed', () => {
    expect(sequence(12345, 64)).toEqual(sequence(12345, 64));
  });

  it('produces a different stream for a different seed', () => {
    expect(sequence(1, 32)).not.toEqual(sequence(2, 32));
  });

  it('keeps next() inside [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rng = createRng(seed);
        for (let i = 0; i < 50; i += 1) {
          const value = rng.next();
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('returns ints across every slot and never reaches n', () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const value = rng.int(5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
      seen.add(value);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('guards invalid int sizes', () => {
    const rng = createRng(9);
    expect(rng.int(0)).toBe(0);
    expect(rng.int(-4)).toBe(0);
    expect(rng.int(Number.NaN)).toBe(0);
    expect(rng.int(Number.POSITIVE_INFINITY)).toBe(0);
    expect(rng.int(1)).toBe(0);
  });

  it('keeps range() between its endpoints regardless of order', () => {
    const rng = createRng(42);
    for (let i = 0; i < 500; i += 1) {
      const forward = rng.range(-3, 8);
      const backward = rng.range(8, -3);
      expect(forward).toBeGreaterThanOrEqual(-3);
      expect(forward).toBeLessThan(8);
      expect(backward).toBeGreaterThanOrEqual(-3);
      expect(backward).toBeLessThan(8);
    }
    expect(rng.range(4, 4)).toBe(4);
  });

  it('guards non-finite range bounds', () => {
    const rng = createRng(3);
    expect(rng.range(Number.NaN, 5)).toBe(0);
    expect(rng.range(0, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
