/** Geometry of the five action buttons, shared by the CSS numbers and layout tests. */
export type ActionButtonId = 'fire' | 'jump' | 'dive' | 'sub' | 'special';

export interface ActionButtonLayout {
  readonly id: ActionButtonId;
  /** Distance from the viewport's right edge in px; not multiplied by scale. */
  readonly rightPx: number;
  /** Distance from the viewport's bottom edge in px; not multiplied by scale. */
  readonly bottomPx: number;
  /** Extra bottom distance that grows with the user's scale, used for stacking. */
  readonly bottomScalePx: number;
  /** Button diameter at scale 1 in px. */
  readonly sizePx: number;
  /** Diameter as a percentage of viewport width, capping the scaled size on narrow screens. */
  readonly sizeVw: number;
}

/** Keep these numbers in sync with touch.css. */
export const ACTION_BUTTON_LAYOUT: readonly ActionButtonLayout[] = [
  { id: 'fire', rightPx: 6, bottomPx: 118, bottomScalePx: 0, sizePx: 74, sizeVw: 18 },
  { id: 'jump', rightPx: 20, bottomPx: 26, bottomScalePx: 0, sizePx: 64, sizeVw: 16 },
  { id: 'dive', rightPx: 112, bottomPx: 26, bottomScalePx: 0, sizePx: 64, sizeVw: 16 },
  { id: 'sub', rightPx: 112, bottomPx: 132, bottomScalePx: 0, sizePx: 64, sizeVw: 16 },
  { id: 'special', rightPx: 96, bottomPx: 130, bottomScalePx: 74, sizePx: 74, sizeVw: 18 },
];

export interface TouchRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function finitePositive(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** Diameter used by a button at this viewport width and scale. */
export function actionButtonSize(
  spec: ActionButtonLayout,
  viewportWidth: number,
  scale: number,
): number {
  const width = finitePositive(viewportWidth);
  const factor = finitePositive(scale);
  const scaled = spec.sizePx * factor;
  const capped = (width * spec.sizeVw) / 100;
  const size = Math.min(scaled, capped);
  return Number.isFinite(size) ? size : 0;
}

/** Axis-aligned rectangle of a button measured from the viewport's top-left. */
export function actionButtonRect(
  spec: ActionButtonLayout,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
): TouchRect {
  const size = actionButtonSize(spec, viewportWidth, scale);
  const width = finitePositive(viewportWidth);
  const height = finitePositive(viewportHeight);
  const bottom =
    height - (spec.bottomPx + spec.bottomScalePx * finitePositive(scale));
  return {
    left: width - spec.rightPx - size,
    top: bottom - size,
    right: width - spec.rightPx,
    bottom,
    width: size,
    height: size,
  };
}
