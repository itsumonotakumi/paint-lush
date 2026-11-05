import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  add,
  clamp,
  cross,
  dot,
  length,
  lerp,
  lerpAngle,
  normalize,
  scale,
  sub,
  vec3,
} from './vec3';
import type { Vec3 } from '../types';

function frozen(x: number, y: number, z: number): Vec3 {
  return Object.freeze({ x, y, z });
}

/** Signed difference between two angles, wrapped into (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let delta = (a - b) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}

describe('vec3 helpers', () => {
  it('builds vectors and collapses non-finite components to zero', () => {
    expect(vec3(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
    expect(vec3(Number.NaN, Number.POSITIVE_INFINITY, 2)).toEqual({ x: 0, y: 0, z: 2 });
  });

  it('adds and subtracts without mutating inputs', () => {
    const a = frozen(1, 2, 3);
    const b = frozen(-4, 5, 0.5);
    expect(add(a, b)).toEqual({ x: -3, y: 7, z: 3.5 });
    expect(sub(a, b)).toEqual({ x: 5, y: -3, z: 2.5 });
    expect(a).toEqual({ x: 1, y: 2, z: 3 });
    expect(b).toEqual({ x: -4, y: 5, z: 0.5 });
  });

  it('scales without mutating the input', () => {
    const a = frozen(2, -3, 0.5);
    expect(scale(a, 4)).toEqual({ x: 8, y: -12, z: 2 });
    expect(scale(a, 0)).toEqual({ x: 0, y: 0, z: 0 });
    expect(a).toEqual({ x: 2, y: -3, z: 0.5 });
  });

  it('computes dot and cross products', () => {
    expect(dot(vec3(1, 2, 3), vec3(4, -5, 6))).toBe(12);
    expect(cross(vec3(1, 0, 0), vec3(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
    expect(cross(vec3(0, 1, 0), vec3(1, 0, 0))).toEqual({ x: 0, y: 0, z: -1 });
    const a = vec3(2, 3, 4);
    const b = vec3(-1, 5, 2);
    const c = cross(a, b);
    expect(dot(c, a)).toBeCloseTo(0, 12);
    expect(dot(c, b)).toBeCloseTo(0, 12);
  });

  it('measures length', () => {
    expect(length(vec3(3, 4, 0))).toBe(5);
    expect(length(vec3(0, 0, 0))).toBe(0);
    expect(length(vec3(-2, -3, 6))).toBe(7);
  });

  it('normalizes to unit length and leaves zero vectors alone', () => {
    expect(normalize(vec3(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 });
    expect(normalize(vec3(0, 3, 4))).toEqual({ x: 0, y: 0.6, z: 0.8 });
    expect(length(normalize(vec3(-7, 2, 11)))).toBeCloseTo(1, 12);
  });

  it('normalizes subnormal vectors without losing direction', () => {
    const unit = normalize(vec3(0, 5e-324, 5e-324));
    expect(unit.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(unit.z).toBeCloseTo(Math.SQRT1_2, 12);
    expect(length(unit)).toBeCloseTo(1, 12);
    expect(length(vec3(0, 5e-324, 5e-324))).toBeGreaterThan(0);
  });

  it('interpolates vectors at both ends and the midpoint', () => {
    const a = frozen(0, 0, 0);
    const b = frozen(10, -4, 2);
    expect(lerp(a, b, 0)).toEqual({ x: 0, y: 0, z: 0 });
    expect(lerp(a, b, 1)).toEqual({ x: 10, y: -4, z: 2 });
    expect(lerp(a, b, 0.5)).toEqual({ x: 5, y: -2, z: 1 });
    expect(a).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('clamps values and handles reversed bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-2, 0, 10)).toBe(0);
    expect(clamp(12, 0, 10)).toBe(10);
    expect(clamp(7, 10, 0)).toBe(7);
    expect(clamp(-3, 10, 0)).toBe(0);
    expect(clamp(Number.NaN, 2, 4)).toBe(2);
  });

  it('lerps angles along the shortest arc', () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 12);
    // 3PI/2 backwards is the short way round from 0.
    expect(lerpAngle(0, (3 * Math.PI) / 2, 0.5)).toBeCloseTo(-Math.PI / 4, 12);
    // Crossing the -PI/PI seam.
    expect(lerpAngle(Math.PI * 1.75, Math.PI * 0.25, 0.5)).toBeCloseTo(Math.PI * 2, 12);
    expect(lerpAngle(0.3, 1.1, 0)).toBeCloseTo(0.3, 12);
    expect(lerpAngle(0.3, 1.1, 1)).toBeCloseTo(1.1, 12);
  });

  it('always takes an arc no longer than PI', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b, t) => {
          const result = lerpAngle(a, b, t);
          expect(Number.isFinite(result)).toBe(true);
          const expected = angleDelta(b, a) * t;
          const actual = angleDelta(result, a);
          expect(Math.abs(angleDelta(actual, expected))).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('normalizes arbitrary non-zero vectors', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e3, max: 1e3, noNaN: true }),
        fc.double({ min: -1e3, max: 1e3, noNaN: true }),
        fc.double({ min: -1e3, max: 1e3, noNaN: true }),
        (x, y, z) => {
          const v = vec3(x, y, z);
          const unit = normalize(v);
          const len = length(v);
          expect(Number.isFinite(unit.x) && Number.isFinite(unit.y) && Number.isFinite(unit.z)).toBe(true);
          if (len > 0) expect(length(unit)).toBeCloseTo(1, 9);
          else expect(unit).toEqual({ x: 0, y: 0, z: 0 });
        },
      ),
      { numRuns: 100 },
    );
  });
});
