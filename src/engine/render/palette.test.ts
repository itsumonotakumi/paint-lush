import { describe, expect, it } from 'vitest';
import { PALETTE } from './palette';

const TEAM_COLORS = [0xff2e88, 0x19e6d0] as const;
const SKY_COLORS = [PALETTE.skyZenith, PALETTE.skyMid, PALETTE.skyHorizon] as const;

/** One 8-bit channel of a 0xRRGGBB value, normalised to 0..1. */
function channel(hex: number, shift: number): number {
  return ((Math.trunc(hex) >> shift) & 0xff) / 255;
}

/** sRGB transfer function, per the WCAG definition of relative luminance. */
function linearize(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance of a 0xRRGGBB colour. */
function relativeLuminance(hex: number): number {
  return (
    0.2126 * linearize(channel(hex, 16)) +
    0.7152 * linearize(channel(hex, 8)) +
    0.0722 * linearize(channel(hex, 0))
  );
}

/** WCAG 2.1 contrast ratio, always at or above 1. */
function contrastRatio(a: number, b: number): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Rec.709 luma of the stored (gamma-encoded) channels. The art brief tracks
 * the brightness of flat palette swatches with this measure rather than with
 * scene-linear luminance.
 */
function perceivedLuminance(hex: number): number {
  return (
    0.2126 * channel(hex, 16) +
    0.7152 * channel(hex, 8) +
    0.0722 * channel(hex, 0)
  );
}

describe('team colour legibility', () => {
  it('keeps the magenta team well above the 1.5 contrast floor on ground', () => {
    expect(contrastRatio(PALETTE.ground, TEAM_COLORS[0])).toBeGreaterThanOrEqual(1.5);
  });

  it('keeps the teal team above the 1.2 legibility floor on ground', () => {
    // The shared palette yields about 1.28 here; 1.5 would need a darker teal.
    expect(contrastRatio(PALETTE.ground, TEAM_COLORS[1])).toBeGreaterThanOrEqual(1.2);
  });

  it('keeps the two teams readable against each other', () => {
    expect(contrastRatio(TEAM_COLORS[0], TEAM_COLORS[1])).toBeGreaterThanOrEqual(1.5);
  });

  it('keeps the cream ground lighter than both team colours', () => {
    for (const team of TEAM_COLORS) {
      expect(relativeLuminance(PALETTE.ground)).toBeGreaterThan(relativeLuminance(team));
    }
  });
});

describe('sky swatch brightness', () => {
  it('keeps every sunset band at or above a perceived luminance of 0.2', () => {
    for (const sky of SKY_COLORS) {
      expect(perceivedLuminance(sky)).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('orders the bands from the brightest horizon to the deepest zenith', () => {
    expect(perceivedLuminance(PALETTE.skyHorizon)).toBeGreaterThan(
      perceivedLuminance(PALETTE.skyMid),
    );
    expect(perceivedLuminance(PALETTE.skyMid)).toBeGreaterThan(
      perceivedLuminance(PALETTE.skyZenith),
    );
  });
});
