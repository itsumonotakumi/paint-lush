import { describe, expect, it } from 'vitest';
import {
  ACTION_BUTTON_LAYOUT,
  actionButtonRect,
  actionButtonSize,
} from './layout';
import type { TouchRect } from './layout';

const VIEWPORTS: readonly [number, number][] = [
  [844, 390],
  [1180, 820],
  [1366, 1024],
  [390, 844],
];
const SCALES = [1, 1.4];

function overlaps(a: TouchRect, b: TouchRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe('touch action button layout', () => {
  it('defines five action buttons in the right-hand cluster', () => {
    expect(ACTION_BUTTON_LAYOUT.map((spec) => spec.id)).toEqual([
      'fire',
      'jump',
      'dive',
      'sub',
      'special',
    ]);
    // The special ring must read as important, matching fire.
    const fire = ACTION_BUTTON_LAYOUT.find((spec) => spec.id === 'fire');
    const special = ACTION_BUTTON_LAYOUT.find((spec) => spec.id === 'special');
    expect(fire?.sizePx).toBe(special?.sizePx);
    expect(fire?.sizeVw).toBe(special?.sizeVw);
  });

  it('never overlaps two action buttons at any tested viewport and scale', () => {
    for (const [width, height] of VIEWPORTS) {
      for (const scale of SCALES) {
        const rects = ACTION_BUTTON_LAYOUT.map((spec) => ({
          id: spec.id,
          rect: actionButtonRect(spec, width, height, scale),
        }));
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) {
            const a = rects[i];
            const b = rects[j];
            if (a === undefined || b === undefined) continue;
            expect(
              overlaps(a.rect, b.rect),
              `${a.id} overlaps ${b.id} at ${width}x${height} scale ${scale}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('keeps every button inside the right 55% of the viewport', () => {
    for (const [width, height] of VIEWPORTS) {
      for (const scale of SCALES) {
        for (const spec of ACTION_BUTTON_LAYOUT) {
          const rect = actionButtonRect(spec, width, height, scale);
          const where = `${spec.id} at ${width}x${height} scale ${scale}`;
          expect(rect.left, where).toBeGreaterThanOrEqual(width * 0.55);
          expect(rect.right, where).toBeLessThanOrEqual(width);
          expect(rect.top, where).toBeGreaterThanOrEqual(0);
          expect(rect.bottom, where).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  it('never produces a non-finite rectangle for hostile numbers', () => {
    const spec = ACTION_BUTTON_LAYOUT[0];
    if (spec === undefined) throw new Error('missing layout');
    for (const [width, height, scale] of [
      [Number.NaN, 390, 1],
      [844, Number.POSITIVE_INFINITY, 1],
      [844, 390, Number.NaN],
      [-10, -10, -2],
    ] as const) {
      const rect = actionButtonRect(spec, width, height, scale);
      for (const value of [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(actionButtonSize(spec, width, scale)).toBeGreaterThanOrEqual(0);
    }
  });
});
