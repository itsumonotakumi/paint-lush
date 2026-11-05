import { describe, expect, it } from 'vitest';
import {
  AUTO_MAX_PIXELS,
  AUTO_PIXEL_RATIO,
  DEFAULT_MAX_PIXELS,
  QUALITY_PIXEL_RATIOS,
  resolveQuality,
} from './quality';

describe('resolveQuality', () => {
  it('maps the fixed quality levels to their pixel ratios', () => {
    expect(resolveQuality('low', false)).toEqual({
      lowDetail: true,
      pixelRatio: 1,
      maxPixels: DEFAULT_MAX_PIXELS,
    });
    expect(resolveQuality('low', true)).toEqual({
      lowDetail: true,
      pixelRatio: 1,
      maxPixels: DEFAULT_MAX_PIXELS,
    });
    expect(resolveQuality('mid', false)).toEqual({
      lowDetail: false,
      pixelRatio: 1.5,
      maxPixels: DEFAULT_MAX_PIXELS,
    });
    expect(resolveQuality('high', false)).toEqual({
      lowDetail: false,
      pixelRatio: 2,
      maxPixels: DEFAULT_MAX_PIXELS,
    });
  });

  it('honours the touch rule only when quality is auto', () => {
    expect(resolveQuality('auto', true)).toEqual({
      lowDetail: true,
      pixelRatio: 1,
      maxPixels: DEFAULT_MAX_PIXELS,
    });
  });

  it('caps non-touch auto at ratio 1.5 and 3.5 megapixels', () => {
    expect(resolveQuality('auto', false)).toEqual({
      lowDetail: false,
      pixelRatio: AUTO_PIXEL_RATIO,
      maxPixels: AUTO_MAX_PIXELS,
    });
    expect(AUTO_PIXEL_RATIO).toBe(1.5);
    expect(AUTO_MAX_PIXELS).toBe(3_500_000);
  });

  it('keeps high at ratio 2 even though auto is lower', () => {
    expect(resolveQuality('high', false).pixelRatio).toBe(2);
    expect(resolveQuality('auto', false).pixelRatio).toBeLessThan(
      resolveQuality('high', false).pixelRatio,
    );
  });

  it('falls back to auto for unknown settings', () => {
    expect(resolveQuality('ultra', true)).toEqual(resolveQuality('auto', true));
    expect(resolveQuality('', false)).toEqual(resolveQuality('auto', false));
  });

  it('keeps every ratio and budget finite and positive', () => {
    for (const value of Object.values(QUALITY_PIXEL_RATIOS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(Number.isFinite(AUTO_PIXEL_RATIO)).toBe(true);
    expect(AUTO_PIXEL_RATIO).toBeGreaterThan(0);
    expect(Number.isFinite(AUTO_MAX_PIXELS)).toBe(true);
    expect(AUTO_MAX_PIXELS).toBeGreaterThan(0);
  });
});
