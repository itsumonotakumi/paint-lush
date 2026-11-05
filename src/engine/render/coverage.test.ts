import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { coverageByteLength, updateCoverage } from './coverage';

function coverFor(values: readonly number[]): Uint8Array {
  const data = Uint8Array.from(values);
  const cover = new Uint8Array(coverageByteLength(values.length));
  updateCoverage(data, cover);
  return cover;
}

describe('coverageByteLength', () => {
  it('uses two bytes per cell and rejects nonsense sizes', () => {
    expect(coverageByteLength(0)).toBe(0);
    expect(coverageByteLength(9)).toBe(18);
    expect(coverageByteLength(6.9)).toBe(12);
    expect(coverageByteLength(-4)).toBe(0);
    expect(coverageByteLength(Number.NaN)).toBe(0);
    expect(coverageByteLength(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('updateCoverage', () => {
  it('writes R for team 0 and G for team 1', () => {
    const cover = coverFor([0, 1, 0, 1]);

    expect(Array.from(cover)).toEqual([
      255, 0,
      0, 255,
      255, 0,
      0, 255,
    ]);
  });

  it('maps 255 to zero in both channels', () => {
    const cover = coverFor([255]);

    expect(cover[0]).toBe(0);
    expect(cover[1]).toBe(0);
  });

  it('treats every other byte value as unpainted', () => {
    for (let value = 2; value <= 255; value += 1) {
      const cover = coverFor([value]);
      expect(cover[0]).toBe(0);
      expect(cover[1]).toBe(0);
    }
  });

  it('produces exactly one hot channel for every possible paint byte', () => {
    const data = new Uint8Array(256);
    for (let value = 0; value < 256; value += 1) data[value] = value;

    const cover = new Uint8Array(coverageByteLength(data.length));
    updateCoverage(data, cover);

    for (let value = 0; value < 256; value += 1) {
      const red = cover[value * 2] ?? 0;
      const green = cover[value * 2 + 1] ?? 0;
      if (value === 0) {
        expect([red, green]).toEqual([255, 0]);
      } else if (value === 1) {
        expect([red, green]).toEqual([0, 255]);
      } else {
        expect([red, green]).toEqual([0, 0]);
      }
    }
  });

  it('rebuilds into the same buffer without touching anything outside it', () => {
    const data = new Uint8Array([0, 1, 255]);
    const cover = new Uint8Array(coverageByteLength(data.length) + 4).fill(7);

    updateCoverage(data, cover);
    data[0] = 1;
    data[1] = 255;
    data[2] = 0;
    updateCoverage(data, cover);

    const bytes = Array.from(cover);
    expect(bytes.slice(0, 6)).toEqual([0, 255, 0, 0, 255, 0]);
    expect(bytes.slice(6)).toEqual([7, 7, 7, 7]);
  });

  it('handles an empty surface', () => {
    const cover = new Uint8Array([1, 2]);
    updateCoverage(new Uint8Array(0), cover);
    expect(Array.from(cover)).toEqual([1, 2]);
  });

  it('is a pure mapping for arbitrary cell runs', () => {
    const cells = fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 400 });

    fc.assert(
      fc.property(cells, (values) => {
        const cover = coverFor(values);
        expect(cover).toHaveLength(values.length * 2);

        for (let i = 0; i < values.length; i += 1) {
          const value = values[i];
          const red = cover[i * 2];
          const green = cover[i * 2 + 1];
          const expected =
            value === 0 ? [255, 0] : value === 1 ? [0, 255] : [0, 0];
          expect([red, green]).toEqual(expected);
        }
      }),
    );
  });

  it('never writes a value other than 0 or 255', () => {
    const cover = coverFor([0, 1, 255, 42]);
    for (const byte of cover) {
      expect(byte === 0 || byte === 255).toBe(true);
    }
  });
});
