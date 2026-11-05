import type { Box, Face } from '../../core/types';

/**
 * Per-surface base colours for the bright stage art. Everything here is a pure
 * function of the stage geometry so the renderer can stay thin and the colour
 * rules can be tested without WebGL.
 */
export const FLOOR_COLOR = 0xe9cfa0;
export const PLASTER_COLOR = 0xfff4e0;
export const PERIMETER_WALL_COLOR = 0xffefd5;

/** Raised-block top colours for the sunset castle town. */
export const TOP_COLORS = [0xf4a65e, 0x7cc6a4, 0xf08fa0, 0x8fb8e8, 0xf2d16b] as const;

/** Container hues for the harbour stage, cycled for point symmetry. */
export const CONTAINER_COLORS = [0xe8743b, 0x3f8fc4, 0x4fa36b, 0xf2c14e] as const;

/** Warm concrete floor of the harbour stage. */
export const CONCRETE_FLOOR_COLOR = 0xcfc7b8;

/** Stage id that switches to the container palette. */
export const HARBOR_STAGE_ID = 'karakuri-port';

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
 * The harbour stage uses concrete floors and a container palette for the tops
 * and sides of raised blocks; other stages keep the warm castle-town palette.
 * Both cycles are keyed on `|centre.x| + |centre.z|`, so point-symmetric boxes
 * share a colour. Castle-town sides are plaster, except for the long, tall
 * perimeter walls which use a slightly deeper cream.
 */
export function surfaceBase(
  boxIndex: number,
  face: Face,
  top: BoxTop,
  stageId: string,
): number {
  const harbor = stageId === HARBOR_STAGE_ID;
  // The cycle deliberately ignores boxIndex so mirrored blocks match.
  const topY = safe(top.y, 0);
  const centreX = safe(top.x, 0);
  const centreZ = safe(top.z, 0);
  const width = positiveExtent(top.width);
  const depth = positiveExtent(top.depth);

  if (face === '+y') {
    if (topY <= 0) return harbor ? CONCRETE_FLOOR_COLOR : FLOOR_COLOR;
    const palette = harbor ? CONTAINER_COLORS : TOP_COLORS;
    return cycleColor(palette, centreX, centreZ);
  }

  if (face === '-y') return harbor ? CONCRETE_FLOOR_COLOR : FLOOR_COLOR;
  if (harbor && topY <= 0) return CONCRETE_FLOOR_COLOR;

  const longSide = Math.max(width, depth);
  const shortSide = Math.min(width, depth);
  const isPerimeterWall = topY >= 2 && longSide >= shortSide * 4;
  if (isPerimeterWall) return PERIMETER_WALL_COLOR;
  if (harbor) return cycleColor(CONTAINER_COLORS, centreX, centreZ);
  return PLASTER_COLOR;
}

/** Stable point-symmetric colour choice: mirrored boxes land on the same swatch. */
function cycleColor(palette: readonly number[], centreX: number, centreZ: number): number {
  const key = Math.round(Math.abs(centreX) + Math.abs(centreZ));
  const cycle = palette.length;
  const index = ((key % cycle) + cycle) % cycle;
  return palette[index] ?? palette[0] ?? FLOOR_COLOR;
}
