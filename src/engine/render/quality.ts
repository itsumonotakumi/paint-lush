/** Requested visual quality from save settings. */
export type RenderQuality = 'auto' | 'low' | 'mid' | 'high';

/** Resolved render profile: detail level, pixel-ratio ceiling and buffer budget. */
export interface QualityProfile {
  lowDetail: boolean;
  pixelRatio: number;
  /** Largest allowed drawing-buffer area in device pixels. */
  maxPixels: number;
}

/** Pixel-ratio ceilings per fixed quality setting. */
export const QUALITY_PIXEL_RATIOS: Readonly<Record<Exclude<RenderQuality, 'auto'>, number>> = {
  low: 1,
  mid: 1.5,
  high: 2,
};

/** Pixel-ratio ceiling for non-touch auto quality. `high` deliberately keeps 2. */
export const AUTO_PIXEL_RATIO = 1.5;
/** Drawing-buffer budget for non-touch auto quality, in device pixels. */
export const AUTO_MAX_PIXELS = 3_500_000;
/** Fallback budget for the explicit quality levels. */
export const DEFAULT_MAX_PIXELS = 16_000_000;

/**
 * Resolves the quality setting into a detail flag, a pixel-ratio ceiling and a
 * drawing-buffer pixel budget.
 *
 * `auto` keeps the existing touch-device rule: small touch screens with four
 * or fewer logical cores use the low profile. Non-touch auto caps the ratio at
 * 1.5 and the buffer at 3.5 megapixels so a large desktop display does not pay
 * for nine million extra fragments. The explicit `high` setting still keeps a
 * ratio ceiling of 2. Unknown quality strings fall back to `auto` rather than
 * throwing at runtime.
 */
export function resolveQuality(quality: string, touchLowDetail: boolean): QualityProfile {
  const level: RenderQuality =
    quality === 'low' || quality === 'mid' || quality === 'high' ? quality : 'auto';
  const lowDetail = level === 'low' || (level === 'auto' && touchLowDetail === true);
  if (level === 'low') {
    return {
      lowDetail: true,
      pixelRatio: QUALITY_PIXEL_RATIOS.low,
      maxPixels: DEFAULT_MAX_PIXELS,
    };
  }
  if (level === 'mid') {
    return {
      lowDetail: false,
      pixelRatio: QUALITY_PIXEL_RATIOS.mid,
      maxPixels: DEFAULT_MAX_PIXELS,
    };
  }
  if (level === 'high') {
    return {
      lowDetail: false,
      pixelRatio: QUALITY_PIXEL_RATIOS.high,
      maxPixels: DEFAULT_MAX_PIXELS,
    };
  }
  if (lowDetail) {
    return {
      lowDetail: true,
      pixelRatio: QUALITY_PIXEL_RATIOS.low,
      maxPixels: DEFAULT_MAX_PIXELS,
    };
  }
  return {
    lowDetail: false,
    pixelRatio: AUTO_PIXEL_RATIO,
    maxPixels: AUTO_MAX_PIXELS,
  };
}
