import type { Box, Face } from '../../core/types';

/**
 * Per-surface base colours for the bright sunset castle town. Everything here
 * is a pure function of the stage geometry so the renderer can stay thin and
 * the colour rules can be tested without WebGL.
 */
export const FLOOR_COLOR = 0xe9cfa0;
export const PLASTER_COLOR = 0xfff4e0;
export const PERIMETER_WALL_COLOR = 0xffefd5;

/** Raised-block top colours, cycled so neighbouring rooftops read apart. */
export const TOP_COLORS = [0xf4a65e, 0x7cc6a4, 0xf08fa0, 0x8fb8e8, 0xf2d16b] as const;

/**
 * The top-face footprint of a stage box. `x` and `z` are the box centre while
 * `y` is the highest point, which is enough to tell the floor plate, raised
 * blocks and tall perimeter walls apart.
 */
export interface BoxTop {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  /** Horizontal extent along X, in metres. */
  readonly width: number;
  /** Horizontal extent along Z, in metres. */
  readonly depth: number;
}

function safe(n: number, fallback: number): number {
  return Number.isFinite(n) ? n + 0 : fallback;
}

function positiveExtent(n: number): number {
  const value = safe(n, 0);
  return value > 0 ? value : 0;
}

/** Builds the top-face summary of a box, tolerating inverted or broken bounds. */
export function boxTop(box: Box): BoxTop {
  const minX = safe(box.min.x, 0);
  const minY = safe(box.min.y, 0);
  const minZ = safe(box.min.z, 0);
  const maxX = safe(box.max.x, 0);
  const maxY = safe(box.max.y, 0);
  const maxZ = safe(box.max.z, 0);

  return {
    x: (minX + maxX) * 0.5,
    z: (minZ + maxZ) * 0.5,
    y: Math.max(minY, maxY),
    width: Math.abs(maxX - minX),
    depth: Math.abs(maxZ - minZ),
  };
}

/**
 * Chooses the base colour for one box face.
 *
 * Floor plate tops (y = 0) are warm stone. Raised tops cycle through the town
 * palette keyed on `|centre.x| + |centre.z|` so a mirrored pair of blocks gets
 * the same colour. Sides are plaster, except for the long, tall perimeter
 * walls which use a slightly deeper cream.
 */
export function surfaceBase(boxIndex: number, face: Face, top: BoxTop): number {
  // The cycle deliberately ignores boxIndex so mirrored blocks match.
  const topY = safe(top.y, 0);
  const centreX = safe(top.x, 0);
  const centreZ = safe(top.z, 0);
  const width = positiveExtent(top.width);
  const depth = positiveExtent(top.depth);

  if (face === '+y') {
    if (topY <= 0) return FLOOR_COLOR;
    const key = Math.round(Math.abs(centreX) + Math.abs(centreZ));
    const cycle = TOP_COLORS.length;
    const index = ((key % cycle) + cycle) % cycle;
    return TOP_COLORS[index] ?? TOP_COLORS[0];
  }

  if (face === '-y') return FLOOR_COLOR;

  const longSide = Math.max(width, depth);
  const shortSide = Math.min(width, depth);
  const isPerimeterWall = topY >= 2 && longSide >= shortSide * 4;
  return isPerimeterWall ? PERIMETER_WALL_COLOR : PLASTER_COLOR;
}
