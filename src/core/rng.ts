/**
 * Small deterministic PRNG (mulberry32).
 *
 * Every method returns a finite number for any input, including NaN/Infinity.
 * The same seed always produces the same sequence.
 */
export interface Rng {
  /** Uniform value in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). Returns 0 when n is not a positive finite number. */
  int(n: number): number;
  /** Uniform value between a and b (order-independent). */
  range(a: number, b: number): number;
}

const TWO_POW_32 = 4294967296;

/**
 * Creates a seeded generator. The seed is coerced to an unsigned 32-bit
 * integer, so non-finite and fractional seeds are accepted.
 */
export function createRng(seed: number): Rng {
  let state = Number.isFinite(seed) ? seed >>> 0 : 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
  };

  const int = (n: number): number => {
    if (!Number.isFinite(n) || n <= 0) return 0;
    const value = Math.floor(next() * n);
    // next() < 1, so value < n; the guard only protects against rounding edge cases.
    return value >= n ? 0 : value;
  };

  const range = (a: number, b: number): number => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const value = lo + next() * (hi - lo);
    return Number.isFinite(value) ? value : lo;
  };

  return { next, int, range };
}
