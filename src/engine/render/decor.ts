import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from 'three';
import type { Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { z } from 'zod';
import { createRng } from '../../core/rng';
import type { Vec3 } from '../../core/types';
import type { StageData } from '../../game/data/schemas';
import type { RenderModule, RenderModuleDeps } from './module';
import { PALETTE } from './palette';
import { createToonMaterial } from './toon';

// The site CSP forbids eval, so zod must not probe for or use its JIT compiler.
z.config({ jitless: true });

const finite = z.number().finite();
const positive = finite.positive();
const nonNegative = finite.nonnegative();

const decorSchema = z
  .object({
    theme: z.literal('sunset-castle'),
    seed: z.number().int().nonnegative(),
    lantern: z
      .object({
        spacing: positive,
        lowDetailSpacing: positive,
        height: finite,
        offset: positive,
        radius: positive,
        capRadius: positive,
      })
      .strict(),
    banner: z
      .object({
        offsets: z.array(finite).min(1),
        centerY: finite,
        offset: nonNegative,
        width: positive,
        height: positive,
      })
      .strict(),
    tree: z
      .object({
        count: z.number().int().nonnegative(),
        outsideMin: positive,
        outsideMax: positive,
        trunkRadius: positive,
        trunkHeight: positive,
        leafRadius: positive,
      })
      .strict(),
    mountain: z
      .object({
        count: z.number().int().nonnegative(),
        z: finite,
        radius: positive,
        height: positive,
        spreadMin: finite,
        spreadMax: finite,
      })
      .strict(),
    castle: z
      .object({
        x: finite,
        z: finite,
        width: positive,
        height: positive,
        depth: positive,
        floors: z.number().int().min(1),
      })
      .strict(),
    cloud: z
      .object({
        count: z.number().int().nonnegative(),
        minY: finite,
        maxY: finite,
        speed: nonNegative,
        loopHalfWidth: positive,
        minRadius: positive,
        maxRadius: positive,
      })
      .strict(),
  })
  .strict();

export type DecorData = z.infer<typeof decorSchema>;

/** Validates stage decoration data. Throws with the failing field path. */
export function parseDecor(json: unknown): DecorData {
  const result = decorSchema.safeParse(json);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `.${issue.path.map(String).join('.')}` : '';
  throw new Error(`decor${where}: ${issue ? issue.message : 'invalid data'}`);
}

/* ---------- layout types ---------- */

export type DecorKind =
  | 'eave'
  | 'roof'
  | 'beam'
  | 'lantern'
  | 'lanternCap'
  | 'lanternGlow'
  | 'lanternBracket'
  | 'banner'
  | 'bannerPattern'
  | 'treeTrunk'
  | 'treeLeaf'
  | 'mountain'
  | 'castleBody'
  | 'castleRoof'
  | 'castleTier'
  | 'castleWindow'
  | 'castleOrnament'
  | 'houseWall'
  | 'houseRoof'
  | 'wallSkirt'
  | 'wallRail'
  | 'shopDoor'
  | 'shopWindow'
  | 'cloud';

type DecorLayer = 'matte' | 'lantern' | 'glow' | 'cloud';

export interface DecorAabb {
  min: Vec3;
  max: Vec3;
}

type Shape =
  | { type: 'box'; center: Vec3; size: Vec3 }
  | { type: 'sphere'; center: Vec3; radius: number; scale: Vec3 }
  | { type: 'cylinder'; center: Vec3; radius: number; height: number; axis: 'x' | 'y' | 'z' }
  | {
      type: 'cone';
      center: Vec3;
      radius: number;
      height: number;
      /** Radial face count; 4 makes a square pyramid. */
      segments?: number;
      /** Extra spin around +y, radians. */
      rotationY?: number;
    }
  | { type: 'gable'; center: Vec3; size: Vec3; ridge: 'x' | 'z' }
  | { type: 'cluster'; spheres: { center: Vec3; radius: number }[] };

export interface DecorItem {
  kind: DecorKind;
  layer: DecorLayer;
  color: number;
  /**
   * Optional exact art hue for this piece. `color` stays a shared-palette slot
   * so the palette audit remains meaningful; the renderer tints with this when set.
   */
  renderColor?: number;
  shape: Shape;
  /** World offset for movable pieces (clouds). Static pieces use zero. */
  offset: Vec3;
  aabb: DecorAabb;
}

/* ---------- small numeric helpers ---------- */

function safe(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

function copyVec(v: Vec3): Vec3 {
  return { x: safe(v.x), y: safe(v.y), z: safe(v.z) };
}

function offsetAabb(aabb: DecorAabb, offset: Vec3): DecorAabb {
  return {
    min: {
      x: aabb.min.x + safe(offset.x),
      y: aabb.min.y + safe(offset.y),
      z: aabb.min.z + safe(offset.z),
    },
    max: {
      x: aabb.max.x + safe(offset.x),
      y: aabb.max.y + safe(offset.y),
      z: aabb.max.z + safe(offset.z),
    },
  };
}

function emptyAabb(): DecorAabb {
  return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
}

function shapeAabb(shape: Shape): DecorAabb {
  if (shape.type === 'cluster') {
    let min = emptyAabb();
    let first = true;
    for (const sphere of shape.spheres) {
      const radius = Math.abs(safe(sphere.radius));
      const x = safe(sphere.center.x);
      const y = safe(sphere.center.y);
      const z = safe(sphere.center.z);
      if (first) {
        min = {
          min: { x: x - radius, y: y - radius, z: z - radius },
          max: { x: x + radius, y: y + radius, z: z + radius },
        };
        first = false;
      } else {
        min.min.x = Math.min(min.min.x, x - radius);
        min.min.y = Math.min(min.min.y, y - radius);
        min.min.z = Math.min(min.min.z, z - radius);
        min.max.x = Math.max(min.max.x, x + radius);
        min.max.y = Math.max(min.max.y, y + radius);
        min.max.z = Math.max(min.max.z, z + radius);
      }
    }
    return min;
  }

  const cx = safe(shape.center.x);
  const cy = safe(shape.center.y);
  const cz = safe(shape.center.z);

  if (shape.type === 'box') {
    const hx = Math.abs(safe(shape.size.x)) * 0.5;
    const hy = Math.abs(safe(shape.size.y)) * 0.5;
    const hz = Math.abs(safe(shape.size.z)) * 0.5;
    return {
      min: { x: cx - hx, y: cy - hy, z: cz - hz },
      max: { x: cx + hx, y: cy + hy, z: cz + hz },
    };
  }

  if (shape.type === 'sphere') {
    const rx = Math.abs(safe(shape.radius)) * Math.abs(safe(shape.scale.x));
    const ry = Math.abs(safe(shape.radius)) * Math.abs(safe(shape.scale.y));
    const rz = Math.abs(safe(shape.radius)) * Math.abs(safe(shape.scale.z));
    return {
      min: { x: cx - rx, y: cy - ry, z: cz - rz },
      max: { x: cx + rx, y: cy + ry, z: cz + rz },
    };
  }

  if (shape.type === 'cylinder') {
    const r = Math.abs(safe(shape.radius));
    const half = Math.abs(safe(shape.height)) * 0.5;
    if (shape.axis === 'x') {
      return {
        min: { x: cx - half, y: cy - r, z: cz - r },
        max: { x: cx + half, y: cy + r, z: cz + r },
      };
    }
    if (shape.axis === 'z') {
      return {
        min: { x: cx - r, y: cy - r, z: cz - half },
        max: { x: cx + r, y: cy + r, z: cz + half },
      };
    }
    return {
      min: { x: cx - r, y: cy - half, z: cz - r },
      max: { x: cx + r, y: cy + half, z: cz + r },
    };
  }

  if (shape.type === 'gable') {
    const hx = Math.abs(safe(shape.size.x)) * 0.5;
    const hy = Math.abs(safe(shape.size.y)) * 0.5;
    const hz = Math.abs(safe(shape.size.z)) * 0.5;
    return {
      min: { x: cx - hx, y: cy - hy, z: cz - hz },
      max: { x: cx + hx, y: cy + hy, z: cz + hz },
    };
  }

  const r = Math.abs(safe(shape.radius));
  const half = Math.abs(safe(shape.height)) * 0.5;
  return {
    min: { x: cx - r, y: cy - half, z: cz - r },
    max: { x: cx + r, y: cy + half, z: cz + r },
  };
}

function makeItem(
  kind: DecorKind,
  layer: DecorLayer,
  color: number,
  shape: Shape,
  offset: Vec3 = ZERO,
): DecorItem {
  const moved = copyVec(offset);
  return {
    kind,
    layer,
    color,
    shape,
    offset: moved,
    aabb: offsetAabb(shapeAabb(shape), moved),
  };
}

/** Builds a piece that renders in an exact art hue while keeping a palette slot. */
function makeArtItem(
  kind: DecorKind,
  layer: DecorLayer,
  paletteSlot: number,
  renderColor: number,
  shape: Shape,
): DecorItem {
  const item = makeItem(kind, layer, paletteSlot, shape);
  item.renderColor = renderColor;
  return item;
}

/* ---------- exact art hues ---------- */

const ART = {
  stone: 0xb8a98f,
  houseWalls: [0xffd9a0, 0xf7b5c4, 0xbde3c8, 0xbfd7f2] as const,
  houseWallSlots: [
    PALETTE.skyHorizon,
    PALETTE.skyMid,
    PALETTE.wall,
    PALETTE.roofHighlight,
  ] as const,
  houseRoofAccent: 0xc8553d,
  glass: 0x8fb8e8,
} as const;

/* ---------- stage boxes ---------- */

interface BoxInfo {
  min: Vec3;
  max: Vec3;
  width: number;
  height: number;
  depth: number;
}

function intersects(a: DecorAabb, b: DecorAabb, epsilon = 1e-6): boolean {
  return (
    a.min.x < b.max.x - epsilon &&
    a.max.x > b.min.x + epsilon &&
    a.min.y < b.max.y - epsilon &&
    a.max.y > b.min.y + epsilon &&
    a.min.z < b.max.z - epsilon &&
    a.max.z > b.min.z + epsilon
  );
}

function readBoxes(stage: StageData): BoxInfo[] {
  const boxes: BoxInfo[] = [];
  for (const entry of stage.boxes) {
    const ax = safe(entry.box.min.x);
    const ay = safe(entry.box.min.y);
    const az = safe(entry.box.min.z);
    const bx = safe(entry.box.max.x);
    const by = safe(entry.box.max.y);
    const bz = safe(entry.box.max.z);
    const min = { x: Math.min(ax, bx), y: Math.min(ay, by), z: Math.min(az, bz) };
    const max = { x: Math.max(ax, bx), y: Math.max(ay, by), z: Math.max(az, bz) };
    boxes.push({
      min,
      max,
      width: safe(max.x - min.x),
      height: safe(max.y - min.y),
      depth: safe(max.z - min.z),
    });
  }
  return boxes;
}

function readBounds(stage: StageData): BoxInfo {
  const ax = safe(stage.bounds.min.x);
  const ay = safe(stage.bounds.min.y);
  const az = safe(stage.bounds.min.z);
  const bx = safe(stage.bounds.max.x);
  const by = safe(stage.bounds.max.y);
  const bz = safe(stage.bounds.max.z);
  const min = { x: Math.min(ax, bx), y: Math.min(ay, by), z: Math.min(az, bz) };
  const max = { x: Math.max(ax, bx), y: Math.max(ay, by), z: Math.max(az, bz) };
  return {
    min,
    max,
    width: safe(max.x - min.x),
    height: safe(max.y - min.y),
    depth: safe(max.z - min.z),
  };
}

function isBlocked(aabb: DecorAabb, boxes: readonly BoxInfo[], owner: BoxInfo): boolean {
  for (const box of boxes) {
    if (box === owner) continue;
    if (intersects(aabb, box)) return true;
  }
  return false;
}

function overlapSpan(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax - 1e-6 && aMax > bMin + 1e-6;
}

/**
 * True when a low decoration becomes a shelf for a different collision box:
 * it touches that box and extends more than 0.10 m outward from it.
 */
function lowShelfViolation(aabb: DecorAabb, boxes: readonly BoxInfo[]): boolean {
  if (aabb.min.y >= 2.6) return false;
  const eps = 1e-6;
  const attach = 0.1;

  for (const box of boxes) {
    const yOverlap = overlapSpan(aabb.min.y, aabb.max.y, box.min.y, box.max.y);
    const xOverlap = overlapSpan(aabb.min.x, aabb.max.x, box.min.x, box.max.x);
    const zOverlap = overlapSpan(aabb.min.z, aabb.max.z, box.min.z, box.max.z);

    if (
      yOverlap &&
      zOverlap &&
      aabb.min.x >= box.max.x - eps &&
      aabb.min.x <= box.max.x + attach &&
      aabb.max.x - box.max.x > attach + eps
    ) {
      return true;
    }
    if (
      yOverlap &&
      zOverlap &&
      aabb.max.x <= box.min.x + eps &&
      aabb.max.x >= box.min.x - attach &&
      box.min.x - aabb.min.x > attach + eps
    ) {
      return true;
    }
    if (
      yOverlap &&
      xOverlap &&
      aabb.min.z >= box.max.z - eps &&
      aabb.min.z <= box.max.z + attach &&
      aabb.max.z - box.max.z > attach + eps
    ) {
      return true;
    }
    if (
      yOverlap &&
      xOverlap &&
      aabb.max.z <= box.min.z + eps &&
      aabb.max.z >= box.min.z - attach &&
      box.min.z - aabb.min.z > attach + eps
    ) {
      return true;
    }
  }

  return false;
}

function spacingCount(length: number, margin: number, spacing: number): number {
  const usable = safe(length) - Math.max(0, safe(margin)) * 2;
  if (!(usable > 0) || !(spacing > 0)) return 1;
  return Math.max(1, Math.floor(usable / spacing) + 1);
}

/* ---------- eaves and beams ---------- */

const EAVE_THICKNESS = 0.08;
const EAVE_HEIGHT = 0.12;
const BEAM_THICKNESS = 0.05;
const BEAM_WIDTH = 0.14;
const BEAM_SPACING = 2;
const BEAM_MARGIN = 0.9;

function addEaves(box: BoxInfo, boxes: readonly BoxInfo[], out: DecorItem[]): void {
  const centerY = safe(box.max.y - EAVE_HEIGHT * 0.5);
  const centerX = safe((box.min.x + box.max.x) * 0.5);
  const centerZ = safe((box.min.z + box.max.z) * 0.5);

  const candidates: { center: Vec3; size: Vec3 }[] = [
    {
      center: { x: safe(box.max.x + EAVE_THICKNESS * 0.5), y: centerY, z: centerZ },
      size: { x: EAVE_THICKNESS, y: EAVE_HEIGHT, z: box.depth },
    },
    {
      center: { x: safe(box.min.x - EAVE_THICKNESS * 0.5), y: centerY, z: centerZ },
      size: { x: EAVE_THICKNESS, y: EAVE_HEIGHT, z: box.depth },
    },
    {
      center: { x: centerX, y: centerY, z: safe(box.max.z + EAVE_THICKNESS * 0.5) },
      size: { x: box.width, y: EAVE_HEIGHT, z: EAVE_THICKNESS },
    },
    {
      center: { x: centerX, y: centerY, z: safe(box.min.z - EAVE_THICKNESS * 0.5) },
      size: { x: box.width, y: EAVE_HEIGHT, z: EAVE_THICKNESS },
    },
  ];

  for (const candidate of candidates) {
    const shape: Shape = { type: 'box', center: candidate.center, size: candidate.size };
    const item = makeItem('eave', 'matte', PALETTE.roof, shape);
    if (isBlocked(item.aabb, boxes, box) || lowShelfViolation(item.aabb, boxes)) continue;
    out.push(item);
  }
}

function addBeams(box: BoxInfo, boxes: readonly BoxInfo[], out: DecorItem[]): void {
  const height = Math.max(0.2, safe(box.height - 0.24));
  const centerY = safe((box.min.y + box.max.y) * 0.5);
  const centerX = safe((box.min.x + box.max.x) * 0.5);
  const centerZ = safe((box.min.z + box.max.z) * 0.5);

  const faces: {
    length: number;
    place: (along: number) => { center: Vec3; size: Vec3 };
  }[] = [
    {
      length: box.depth,
      place: (along) => ({
        center: { x: safe(box.max.x + BEAM_THICKNESS * 0.5), y: centerY, z: safe(centerZ + along) },
        size: { x: BEAM_THICKNESS, y: height, z: BEAM_WIDTH },
      }),
    },
    {
      length: box.depth,
      place: (along) => ({
        center: { x: safe(box.min.x - BEAM_THICKNESS * 0.5), y: centerY, z: safe(centerZ + along) },
        size: { x: BEAM_THICKNESS, y: height, z: BEAM_WIDTH },
      }),
    },
    {
      length: box.width,
      place: (along) => ({
        center: { x: safe(centerX + along), y: centerY, z: safe(box.max.z + BEAM_THICKNESS * 0.5) },
        size: { x: BEAM_WIDTH, y: height, z: BEAM_THICKNESS },
      }),
    },
    {
      length: box.width,
      place: (along) => ({
        center: { x: safe(centerX + along), y: centerY, z: safe(box.min.z - BEAM_THICKNESS * 0.5) },
        size: { x: BEAM_WIDTH, y: height, z: BEAM_THICKNESS },
      }),
    },
  ];

  for (const face of faces) {
    if (face.length < 1.5) continue;
    const count = spacingCount(face.length, BEAM_MARGIN, BEAM_SPACING);
    for (let i = 0; i < count; i += 1) {
      const along = (i - (count - 1) * 0.5) * BEAM_SPACING;
      const spot = face.place(along);
      const shape: Shape = { type: 'box', center: spot.center, size: spot.size };
      const item = makeItem('beam', 'matte', PALETTE.timber, shape);
      if (isBlocked(item.aabb, boxes, box) || lowShelfViolation(item.aabb, boxes)) continue;
      out.push(item);
    }
  }
}

const PANEL_THICKNESS = 0.04;

/** Flat door and window panels on the faces of the raised shop platforms. */
function addShopPanels(box: BoxInfo, boxes: readonly BoxInfo[], out: DecorItem[]): void {
  if (box.height < 1 - 1e-9 || box.height > 3) return;
  // The ground slab is not a shop platform.
  if (box.min.y < -0.5) return;

  const doorHeight = Math.min(1, box.height * 0.62);
  const doorY = safe(box.min.y + 0.06 + doorHeight * 0.5);
  const windowHeight = Math.min(0.7, box.height * 0.4);
  const windowY = safe(box.min.y + box.height * 0.55);

  const faces: { length: number; axis: 'x' | 'z'; sign: 1 | -1 }[] = [
    { length: box.depth, axis: 'x', sign: 1 },
    { length: box.depth, axis: 'x', sign: -1 },
    { length: box.width, axis: 'z', sign: 1 },
    { length: box.width, axis: 'z', sign: -1 },
  ];

  for (const face of faces) {
    if (face.length < 1.2) continue;
    const faceCoord =
      face.axis === 'x'
        ? face.sign > 0
          ? box.max.x
          : box.min.x
        : face.sign > 0
          ? box.max.z
          : box.min.z;
    const centerCoord = safe(faceCoord + face.sign * PANEL_THICKNESS * 0.5);
    const alongCenter =
      face.axis === 'x'
        ? safe((box.min.z + box.max.z) * 0.5)
        : safe((box.min.x + box.max.x) * 0.5);

    const place = (
      kind: DecorKind,
      color: number,
      renderColor: number | undefined,
      along: number,
      y: number,
      height: number,
      width: number,
    ): void => {
      const size: Vec3 =
        face.axis === 'x'
          ? { x: PANEL_THICKNESS, y: height, z: width }
          : { x: width, y: height, z: PANEL_THICKNESS };
      const center: Vec3 =
        face.axis === 'x'
          ? { x: centerCoord, y, z: safe(alongCenter + along) }
          : { x: safe(alongCenter + along), y, z: centerCoord };
      const shape: Shape = { type: 'box', center, size };
      const item =
        renderColor === undefined
          ? makeItem(kind, 'matte', color, shape)
          : makeArtItem(kind, 'matte', color, renderColor, shape);
      if (isBlocked(item.aabb, boxes, box)) return;
      out.push(item);
    };

    const doorWidth = Math.min(0.9, face.length * 0.22);
    place('shopDoor', PALETTE.timber, undefined, 0, doorY, doorHeight, doorWidth);

    const windowWidth = Math.min(0.55, face.length * 0.12);
    for (const side of [-1, 1]) {
      place(
        'shopWindow',
        PALETTE.roofHighlight,
        ART.glass,
        side * face.length * 0.28,
        windowY,
        windowHeight,
        windowWidth,
      );
    }
  }
}

/* ---------- perimeter walls ---------- */

interface WallInfo {
  box: BoxInfo;
  /** Thin horizontal axis. */
  axis: 'x' | 'z';
  /** Direction from the wall face into the play area. */
  roomSign: 1 | -1;
  /** Coordinate of the inner face. */
  face: number;
  /** The long axis that runs along the wall. */
  along: 'x' | 'z';
  length: number;
  middle: number;
}

function findWalls(boxes: readonly BoxInfo[], bounds: BoxInfo): WallInfo[] {
  const walls: WallInfo[] = [];
  for (const box of boxes) {
    if (box.height < 5.5) continue;

    const thinAxis: 'x' | 'z' = box.width < box.depth ? 'x' : 'z';
    if (thinAxis === 'x') {
      if (box.width > 2) continue;
      const touchesHigh = box.max.x >= bounds.max.x - 1e-6;
      const touchesLow = box.min.x <= bounds.min.x + 1e-6;
      if (!touchesHigh && !touchesLow) continue;
      walls.push({
        box,
        axis: 'x',
        roomSign: touchesHigh ? -1 : 1,
        face: touchesHigh ? box.min.x : box.max.x,
        along: 'z',
        length: box.depth,
        middle: safe((box.min.z + box.max.z) * 0.5),
      });
    } else {
      if (box.depth > 2) continue;
      const touchesHigh = box.max.z >= bounds.max.z - 1e-6;
      const touchesLow = box.min.z <= bounds.min.z + 1e-6;
      if (!touchesHigh && !touchesLow) continue;
      walls.push({
        box,
        axis: 'z',
        roomSign: touchesHigh ? -1 : 1,
        face: touchesHigh ? box.min.z : box.max.z,
        along: 'x',
        length: box.width,
        middle: safe((box.min.x + box.max.x) * 0.5),
      });
    }
  }
  return walls;
}

function addLargeRoofs(
  walls: readonly WallInfo[],
  bounds: BoxInfo,
  out: DecorItem[],
): void {
  for (const wall of walls) {
    const centerY = safe(wall.box.max.y + 0.25);
    const outside = wall.roomSign < 0 ? bounds.max : bounds.min;
    if (wall.axis === 'x') {
      const center = {
        x: safe(outside.x + wall.roomSign * -0.6),
        y: centerY,
        z: wall.middle,
      };
      const shape: Shape = {
        type: 'box',
        center,
        size: { x: 1.2, y: 0.5, z: wall.length },
      };
      out.push(makeItem('roof', 'matte', PALETTE.roof, shape));
    } else {
      const center = {
        x: wall.middle,
        y: centerY,
        z: safe(outside.z + wall.roomSign * -0.6),
      };
      const shape: Shape = {
        type: 'box',
        center,
        size: { x: wall.length, y: 0.5, z: 1.2 },
      };
      out.push(makeItem('roof', 'matte', PALETTE.roof, shape));
    }
  }
}

const SKIRT_THICKNESS = 0.04;
const SKIRT_BOTTOM = 0.021;
const SKIRT_HEIGHT = 1 - SKIRT_BOTTOM;
const SKIRT_INSET = 0.15;
const RAIL_THICKNESS = 0.05;
const RAIL_HEIGHT = 0.1;

/** Stone plinth band and timber rail along the inner faces of the perimeter walls. */
function addWallSkirts(
  walls: readonly WallInfo[],
  bounds: BoxInfo,
  out: DecorItem[],
): void {
  for (const wall of walls) {
    const roomSpan = wall.along === 'x' ? bounds.width : bounds.depth;
    const fitted = Math.min(safe(wall.length), Math.max(1e-3, safe(roomSpan) - 1));
    const length = Math.max(1e-3, fitted - SKIRT_INSET * 2);
    const skirtCoord = safe(wall.face + wall.roomSign * SKIRT_THICKNESS * 0.5);
    const railCoord = safe(wall.face + wall.roomSign * RAIL_THICKNESS * 0.5);

    const skirtSize: Vec3 =
      wall.axis === 'x'
        ? { x: SKIRT_THICKNESS, y: SKIRT_HEIGHT, z: length }
        : { x: length, y: SKIRT_HEIGHT, z: SKIRT_THICKNESS };
    const skirtCenter: Vec3 =
      wall.axis === 'x'
        ? {
            x: skirtCoord,
            y: safe(SKIRT_BOTTOM + SKIRT_HEIGHT * 0.5),
            z: wall.middle,
          }
        : {
            x: wall.middle,
            y: safe(SKIRT_BOTTOM + SKIRT_HEIGHT * 0.5),
            z: skirtCoord,
          };
    out.push(
      makeArtItem('wallSkirt', 'matte', PALETTE.groundUnderside, ART.stone, {
        type: 'box',
        center: skirtCenter,
        size: skirtSize,
      }),
    );

    const railSize: Vec3 =
      wall.axis === 'x'
        ? { x: RAIL_THICKNESS, y: RAIL_HEIGHT, z: length }
        : { x: length, y: RAIL_HEIGHT, z: RAIL_THICKNESS };
    const railCenter: Vec3 =
      wall.axis === 'x'
        ? { x: railCoord, y: 1, z: wall.middle }
        : { x: wall.middle, y: 1, z: railCoord };
    out.push(
      makeItem('wallRail', 'matte', PALETTE.timber, {
        type: 'box',
        center: railCenter,
        size: railSize,
      }),
    );
  }
}

const BANNER_COLORS: readonly number[] = [
  PALETTE.norenBlue,
  PALETTE.norenRed,
  PALETTE.signYellow,
];

const BANNER_THICKNESS = 0.03;
const BANNER_PATTERN_THICKNESS = 0.02;

function addBanners(
  wall: WallInfo,
  data: DecorData,
  bannerIndex: number,
  out: DecorItem[],
): number {
  let nextIndex = bannerIndex;
  const banner = data.banner;

  for (const alongOffset of banner.offsets) {
    const colorIndex = nextIndex % BANNER_COLORS.length;
    const color = BANNER_COLORS[colorIndex] ?? PALETTE.norenBlue;
    nextIndex += 1;

    const along = safe(wall.middle + alongOffset);
    const bodyDistance = safe(banner.offset + BANNER_THICKNESS * 0.5);
    const patternDistance = safe(
      banner.offset + BANNER_THICKNESS + BANNER_PATTERN_THICKNESS * 0.5,
    );

    if (wall.axis === 'z') {
      const z = safe(wall.face + wall.roomSign * bodyDistance);
      const body: Shape = {
        type: 'box',
        center: { x: along, y: banner.centerY, z },
        size: { x: banner.width, y: banner.height, z: BANNER_THICKNESS },
      };
      out.push(makeItem('banner', 'matte', color, body));

      const patternZ = safe(wall.face + wall.roomSign * patternDistance);
      if (colorIndex === 2) {
        const circle: Shape = {
          type: 'cylinder',
          center: { x: along, y: banner.centerY, z: patternZ },
          radius: Math.min(banner.height * 0.3, 0.22),
          height: BANNER_PATTERN_THICKNESS,
          axis: 'z',
        };
        out.push(makeItem('bannerPattern', 'matte', PALETTE.roof, circle));
      } else {
        for (const stripe of [-0.36, 0.36]) {
          const stripeShape: Shape = {
            type: 'box',
            center: { x: safe(along + stripe), y: banner.centerY, z: patternZ },
            size: {
              x: Math.min(0.14, banner.width * 0.12),
              y: safe(banner.height * 0.62),
              z: BANNER_PATTERN_THICKNESS,
            },
          };
          out.push(makeItem('bannerPattern', 'matte', PALETTE.wall, stripeShape));
        }
      }
    } else {
      const x = safe(wall.face + wall.roomSign * bodyDistance);
      const body: Shape = {
        type: 'box',
        center: { x, y: banner.centerY, z: along },
        size: { x: BANNER_THICKNESS, y: banner.height, z: banner.width },
      };
      out.push(makeItem('banner', 'matte', color, body));

      const patternX = safe(wall.face + wall.roomSign * patternDistance);
      if (colorIndex === 2) {
        const circle: Shape = {
          type: 'cylinder',
          center: { x: patternX, y: banner.centerY, z: along },
          radius: Math.min(banner.height * 0.3, 0.22),
          height: BANNER_PATTERN_THICKNESS,
          axis: 'x',
        };
        out.push(makeItem('bannerPattern', 'matte', PALETTE.roof, circle));
      } else {
        for (const stripe of [-0.36, 0.36]) {
          const stripeShape: Shape = {
            type: 'box',
            center: { x: patternX, y: banner.centerY, z: safe(along + stripe) },
            size: {
              x: BANNER_PATTERN_THICKNESS,
              y: safe(banner.height * 0.62),
              z: Math.min(0.14, banner.width * 0.12),
            },
          };
          out.push(makeItem('bannerPattern', 'matte', PALETTE.wall, stripeShape));
        }
      }
    }
  }

  return nextIndex;
}

function addLanterns(
  wall: WallInfo,
  data: DecorData,
  lowDetail: boolean,
  out: DecorItem[],
): void {
  const spacing = lowDetail ? data.lantern.lowDetailSpacing : data.lantern.spacing;
  const count = spacingCount(wall.length, 0.75, spacing);
  const capHeight = 0.06;

  for (let i = 0; i < count; i += 1) {
    const along = safe(wall.middle + (i - (count - 1) * 0.5) * spacing);
    const centerCoord = safe(wall.face + wall.roomSign * data.lantern.offset);
    const center: Vec3 =
      wall.axis === 'z'
        ? { x: along, y: data.lantern.height, z: centerCoord }
        : { x: centerCoord, y: data.lantern.height, z: along };

    const glowScale: Vec3 = { x: 1, y: 1.25, z: 1 };

    out.push(
      makeItem('lantern', 'lantern', PALETTE.lantern, {
        type: 'sphere',
        center: copyVec(center),
        radius: data.lantern.radius,
        scale: glowScale,
      }),
    );

    out.push(
      makeItem('lanternGlow', 'glow', PALETTE.lanternGlow, {
        type: 'sphere',
        center: copyVec(center),
        radius: data.lantern.radius * 1.15,
        scale: { x: 1, y: 1.25, z: 1 },
      }),
    );

    for (const capSign of [-1, 1]) {
      out.push(
        makeItem('lanternCap', 'matte', PALETTE.outline, {
          type: 'cylinder',
          center: {
            x: center.x,
            y: safe(center.y + capSign * data.lantern.radius * 1.25),
            z: center.z,
          },
          radius: data.lantern.capRadius,
          height: capHeight,
          axis: 'y',
        }),
      );
    }

    const bracketLength = safe(data.lantern.offset);
    out.push(
      makeItem('lanternBracket', 'matte', PALETTE.timber, {
        type: 'box',
        center: {
          x: wall.axis === 'x' ? safe(wall.face + wall.roomSign * bracketLength * 0.5) : along,
          y: safe(center.y + data.lantern.radius * 1.25),
          z: wall.axis === 'z' ? safe(wall.face + wall.roomSign * bracketLength * 0.5) : along,
        },
        size:
          wall.axis === 'x'
            ? { x: bracketLength, y: 0.05, z: 0.05 }
            : { x: 0.05, y: 0.05, z: bracketLength },
      }),
    );
  }
}

/* ---------- trees, town row, mountains, castle, clouds ---------- */

const HOUSE_ROW_GAP = 4.5;
const HOUSE_DEPTH_MIN = 3.6;
const HOUSE_DEPTH_MAX = 4.4;
const HOUSE_WIDTH_MIN = 3;
const HOUSE_WIDTH_MAX = 5;
const HOUSE_HEIGHT_MIN = 7;
const HOUSE_HEIGHT_MAX = 9;
const HOUSE_ROOF_MIN = 1.7;
const HOUSE_ROOF_MAX = 2.3;
const CASTLE_GAP_HALF_WIDTH = 7.5;

interface SideInfo {
  /** Axis the row runs along. */
  along: 'x' | 'z';
  /** Fixed coordinate perpendicular to the row. */
  fixed: number;
}

function townSides(bounds: BoxInfo): SideInfo[] {
  return [
    { along: 'x', fixed: safe(bounds.min.z - HOUSE_ROW_GAP) },
    { along: 'x', fixed: safe(bounds.max.z + HOUSE_ROW_GAP) },
    { along: 'z', fixed: safe(bounds.max.x + HOUSE_ROW_GAP) },
    { along: 'z', fixed: safe(bounds.min.x - HOUSE_ROW_GAP) },
  ];
}

function rowPositions(
  count: number,
  min: number,
  max: number,
  rng: ReturnType<typeof createRng>,
): number[] {
  const positions: number[] = [];
  const step = (max - min) / count;
  const jitter = step * 0.16;
  for (let i = 0; i < count; i += 1) {
    const base = min + (i + 0.5) * step;
    const value = safe(base + rng.range(-jitter, jitter));
    positions.push(Math.min(max - 0.25, Math.max(min + 0.25, value)));
  }
  return positions;
}

/** A row of tall, gabled town houses peeking over each perimeter wall. */
function addTownRows(
  bounds: BoxInfo,
  out: DecorItem[],
  rng: ReturnType<typeof createRng>,
): void {
  const sides = townSides(bounds);
  const span = Math.max(bounds.width, bounds.depth) + 4;
  const half = span * 0.5;

  for (let sideIndex = 0; sideIndex < sides.length; sideIndex += 1) {
    const side = sides[sideIndex];
    if (!side) continue;
    const count = 8 + rng.int(3);
    const positions: number[] = [];

    if (sideIndex === 0) {
      const leftCount = Math.floor(count * 0.5);
      const rightCount = count - leftCount;
      positions.push(...rowPositions(leftCount, -half, -CASTLE_GAP_HALF_WIDTH, rng));
      positions.push(...rowPositions(rightCount, CASTLE_GAP_HALF_WIDTH, half, rng));
    } else {
      positions.push(...rowPositions(count, -half, half, rng));
    }

    for (let i = 0; i < positions.length; i += 1) {
      const along = positions[i] ?? 0;
      const step = span / count;
      const width = Math.min(
        HOUSE_WIDTH_MAX,
        Math.max(HOUSE_WIDTH_MIN, rng.range(HOUSE_WIDTH_MIN, Math.min(HOUSE_WIDTH_MAX, step - 0.35))),
      );
      const depth = rng.range(HOUSE_DEPTH_MIN, HOUSE_DEPTH_MAX);
      const totalHeight = rng.range(HOUSE_HEIGHT_MIN, HOUSE_HEIGHT_MAX);
      const roofHeight = rng.range(HOUSE_ROOF_MIN, HOUSE_ROOF_MAX);
      const bodyHeight = Math.max(0.5, totalHeight - roofHeight);

      const colorIndex = rng.int(ART.houseWalls.length);
      const wallColor = ART.houseWalls[colorIndex] ?? ART.houseWalls[0];
      const wallSlot = ART.houseWallSlots[colorIndex] ?? PALETTE.wall;

      const bodyCenter: Vec3 =
        side.along === 'x'
          ? { x: along, y: bodyHeight * 0.5, z: side.fixed }
          : { x: side.fixed, y: bodyHeight * 0.5, z: along };
      const bodySize: Vec3 =
        side.along === 'x'
          ? { x: width, y: bodyHeight, z: depth }
          : { x: depth, y: bodyHeight, z: width };

      out.push(
        makeArtItem('houseWall', 'matte', wallSlot, wallColor, {
          type: 'box',
          center: bodyCenter,
          size: bodySize,
        }),
      );

      const roofSize: Vec3 =
        side.along === 'x'
          ? { x: width * 1.08, y: roofHeight, z: depth * 1.18 }
          : { x: depth * 1.18, y: roofHeight, z: width * 1.08 };
      const roofCenter: Vec3 =
        side.along === 'x'
          ? { x: along, y: bodyHeight + roofHeight * 0.5, z: side.fixed }
          : { x: side.fixed, y: bodyHeight + roofHeight * 0.5, z: along };
      const roofShape: Shape = {
        type: 'gable',
        center: roofCenter,
        size: roofSize,
        ridge: side.along,
      };

      const accent = (i + sideIndex) % 3 === 0;
      out.push(
        accent
          ? makeArtItem('houseRoof', 'matte', PALETTE.norenRed, ART.houseRoofAccent, roofShape)
          : makeItem('houseRoof', 'matte', PALETTE.roof, roofShape),
      );
    }
  }
}

function addCastleWindows(
  x: number,
  z: number,
  width: number,
  depth: number,
  baseY: number,
  height: number,
  out: DecorItem[],
): void {
  const stripHeight = Math.max(0.2, height * 0.46);
  const stripWidth = Math.min(0.16, width * 0.06);
  const centerY = safe(baseY + height * 0.55);
  const inset = 0.03;

  const faces: { length: number; axis: 'x' | 'z'; sign: 1 | -1 }[] = [
    { length: depth, axis: 'x', sign: 1 },
    { length: depth, axis: 'x', sign: -1 },
    { length: width, axis: 'z', sign: 1 },
    { length: width, axis: 'z', sign: -1 },
  ];

  for (const face of faces) {
    const faceCoord =
      face.axis === 'x'
        ? face.sign > 0
          ? safe(x + width * 0.5 + inset)
          : safe(x - width * 0.5 - inset)
        : face.sign > 0
          ? safe(z + depth * 0.5 + inset)
          : safe(z - depth * 0.5 - inset);
    const alongCenter = face.axis === 'x' ? z : x;
    const offset = face.length * 0.22;

    for (const side of [-1, 1]) {
      const along = safe(alongCenter + side * offset);
      const center: Vec3 =
        face.axis === 'x'
          ? { x: faceCoord, y: centerY, z: along }
          : { x: along, y: centerY, z: faceCoord };
      const size: Vec3 =
        face.axis === 'x'
          ? { x: 0.06, y: stripHeight, z: stripWidth }
          : { x: stripWidth, y: stripHeight, z: 0.06 };
      out.push(
        makeItem('castleWindow', 'matte', PALETTE.timber, {
          type: 'box',
          center,
          size,
        }),
      );
    }
  }
}

function addTrees(data: DecorData, out: DecorItem[], rng: ReturnType<typeof createRng>): void {
  const perSide = Math.max(1, Math.ceil(data.tree.count / 4));
  let placed = 0;

  for (let side = 0; side < 4 && placed < data.tree.count; side += 1) {
    for (let i = 0; i < perSide && placed < data.tree.count; i += 1) {
      const along = (i - (perSide - 1) * 0.5) * 13 + rng.range(-1.5, 1.5);
      const outside = rng.range(data.tree.outsideMin, data.tree.outsideMax);
      const x = side < 2 ? along : side === 2 ? outside : -outside;
      const z = side === 0 ? outside : side === 1 ? -outside : along;

      const trunkHeight = data.tree.trunkHeight;
      const trunk: Shape = {
        type: 'cylinder',
        center: { x, y: trunkHeight * 0.5, z },
        radius: data.tree.trunkRadius,
        height: trunkHeight,
        axis: 'y',
      };
      out.push(makeItem('treeTrunk', 'matte', PALETTE.trunk, trunk));

      const leafRadius = data.tree.leafRadius;
      const leafCenters: { center: Vec3; color: number }[] = [
        { center: { x, y: trunkHeight + 0.9, z }, color: PALETTE.leaf },
        {
          center: { x: safe(x + 1), y: trunkHeight + 0.45, z: safe(z - 0.6) },
          color: PALETTE.leafDark,
        },
        {
          center: { x: safe(x - 1), y: trunkHeight + 0.5, z: safe(z + 0.6) },
          color: PALETTE.leaf,
        },
      ];
      for (const leaf of leafCenters) {
        out.push(
          makeItem('treeLeaf', 'matte', leaf.color, {
            type: 'sphere',
            center: leaf.center,
            radius: leafRadius,
            scale: { x: 1, y: 1, z: 1 },
          }),
        );
      }
      placed += 1;
    }
  }
}

function addMountains(data: DecorData, out: DecorItem[]): void {
  const count = data.mountain.count;
  for (let i = 0; i < count; i += 1) {
    const t = count <= 1 ? 0.5 : i / (count - 1);
    const x = data.mountain.spreadMin + (data.mountain.spreadMax - data.mountain.spreadMin) * t;
    out.push(
      makeItem('mountain', 'matte', PALETTE.mountain, {
        type: 'cone',
        center: { x: safe(x), y: data.mountain.height * 0.5, z: data.mountain.z },
        radius: data.mountain.radius,
        height: data.mountain.height,
      }),
    );
  }
}

const CASTLE_PLINTH = { width: 10.2, height: 0.6, depth: 10.2 } as const;
const CASTLE_BASE = { width: 9, height: 2.5, depth: 9 } as const;
const CASTLE_TIERS = [
  { width: 7, height: 3, depth: 7 },
  { width: 5, height: 2.6, depth: 5 },
  { width: 3.4, height: 2.4, depth: 3.4 },
] as const;
const CASTLE_ROOF_HEIGHT = 1.1;

/** A tiered keep with flared pyre roofs, timber windows and a gold finial. */
function addCastle(data: DecorData, out: DecorItem[]): void {
  const x = data.castle.x;
  const z = data.castle.z;
  let y = 0;

  out.push(
    makeArtItem('castleBody', 'matte', PALETTE.groundUnderside, ART.stone, {
      type: 'box',
      center: { x, y: safe(y + CASTLE_PLINTH.height * 0.5), z },
      size: {
        x: CASTLE_PLINTH.width,
        y: CASTLE_PLINTH.height,
        z: CASTLE_PLINTH.depth,
      },
    }),
  );
  y += CASTLE_PLINTH.height;

  out.push(
    makeArtItem('castleBody', 'matte', PALETTE.groundUnderside, ART.stone, {
      type: 'box',
      center: { x, y: safe(y + CASTLE_BASE.height * 0.5), z },
      size: { x: CASTLE_BASE.width, y: CASTLE_BASE.height, z: CASTLE_BASE.depth },
    }),
  );
  y += CASTLE_BASE.height;

  for (let i = 0; i < CASTLE_TIERS.length; i += 1) {
    const tier = CASTLE_TIERS[i];
    if (!tier) continue;
    out.push(
      makeItem('castleTier', 'matte', PALETTE.wall, {
        type: 'box',
        center: { x, y: safe(y + tier.height * 0.5), z },
        size: { x: tier.width, y: tier.height, z: tier.depth },
      }),
    );
    addCastleWindows(x, z, tier.width, tier.depth, y, tier.height, out);
    y += tier.height;

    if (i < CASTLE_TIERS.length - 1) {
      const radius = safe((tier.width * 1.5) / Math.SQRT2);
      out.push(
        makeItem('castleRoof', 'matte', PALETTE.roof, {
          type: 'cone',
          center: { x, y, z },
          radius,
          height: CASTLE_ROOF_HEIGHT,
          segments: 4,
          rotationY: Math.PI * 0.25,
        }),
      );
    }
  }

  out.push(
    makeItem('castleOrnament', 'matte', PALETTE.signYellow, {
      type: 'cylinder',
      center: { x, y: safe(y + 0.2), z },
      radius: 0.18,
      height: 0.4,
      axis: 'y',
    }),
  );
  out.push(
    makeItem('castleOrnament', 'matte', PALETTE.signYellow, {
      type: 'sphere',
      center: { x, y: safe(y + 0.4 + 0.42), z },
      radius: 0.42,
      scale: { x: 1, y: 1, z: 1 },
    }),
  );
}

function addClouds(
  data: DecorData,
  out: DecorItem[],
  rng: ReturnType<typeof createRng>,
): void {
  const cloud = data.cloud;
  for (let i = 0; i < cloud.count; i += 1) {
    const sphereCount = 3 + rng.int(3);
    const spheres: { center: Vec3; radius: number }[] = [];
    const baseRadius = rng.range(cloud.minRadius, cloud.maxRadius);
    spheres.push({ center: { x: 0, y: 0, z: 0 }, radius: baseRadius });

    for (let s = 1; s < sphereCount; s += 1) {
      spheres.push({
        center: {
          x: rng.range(-3.4, 3.4),
          y: rng.range(-0.9, 0.9),
          z: rng.range(-1.4, 1.4),
        },
        radius: rng.range(cloud.minRadius, cloud.maxRadius),
      });
    }

    const offset: Vec3 = {
      x: rng.range(-50, 50),
      y: rng.range(cloud.minY, cloud.maxY),
      z: rng.range(-55, -20),
    };

    out.push(
      makeItem('cloud', 'cloud', PALETTE.cloud, { type: 'cluster', spheres }, offset),
    );
  }
}

/**
 * Produces every decoration placement plus its world-space bounds.
 * The placement order is deterministic for a given stage and decor file.
 */
export function buildDecorPlan(
  stage: StageData,
  data: DecorData,
  lowDetail: boolean,
): DecorItem[] {
  const boxes = readBoxes(stage);
  const bounds = readBounds(stage);
  const items: DecorItem[] = [];
  const rng = createRng(data.seed);
  const townRng = createRng(data.seed + 0x51ed);

  for (const box of boxes) {
    if (box.height >= 1 - 1e-9) addEaves(box, boxes, items);
    if (box.height >= 1 - 1e-9 && box.max.y > 0.2) addBeams(box, boxes, items);
    addShopPanels(box, boxes, items);
  }

  const walls = findWalls(boxes, bounds);
  addLargeRoofs(walls, bounds, items);
  addWallSkirts(walls, bounds, items);

  let bannerIndex = 0;
  for (const wall of walls) {
    bannerIndex = addBanners(wall, data, bannerIndex, items);
    addLanterns(wall, data, lowDetail, items);
  }

  addTrees(data, items, rng);
  addTownRows(bounds, items, townRng);
  addMountains(data, items);
  addCastle(data, items);
  addClouds(data, items, rng);

  return items;
}

/* ---------- geometry ---------- */

const SPHERE_WIDTH_SEGMENTS = 10;
const SPHERE_HEIGHT_SEGMENTS = 8;

/** Triangular prism used for gabled roofs. Ridge runs along x before an optional yaw. */
function buildGableGeometry(shape: { size: Vec3; ridge: 'x' | 'z' }): BufferGeometry {
  const ridgeLength =
    shape.ridge === 'x' ? Math.abs(safe(shape.size.x)) : Math.abs(safe(shape.size.z));
  const span = shape.ridge === 'x' ? Math.abs(safe(shape.size.z)) : Math.abs(safe(shape.size.x));
  const height = Math.abs(safe(shape.size.y));
  const halfRidge = Math.max(1e-3, ridgeLength * 0.5);
  const halfSpan = Math.max(1e-3, span * 0.5);
  const halfHeight = Math.max(1e-3, height * 0.5);

  const corners = [
    [-halfRidge, -halfHeight, -halfSpan],
    [-halfRidge, -halfHeight, halfSpan],
    [-halfRidge, halfHeight, 0],
    [halfRidge, -halfHeight, -halfSpan],
    [halfRidge, -halfHeight, halfSpan],
    [halfRidge, halfHeight, 0],
  ] as const;
  // Duplicate vertices per face so the prism keeps crisp flat-shaded ridges.
  const triangles = [0, 1, 2, 3, 5, 4, 1, 4, 5, 1, 5, 2, 0, 2, 5, 0, 5, 3, 0, 4, 1, 0, 3, 4];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const cornerIndex of triangles) {
    const corner = corners[cornerIndex];
    if (!corner) continue;
    positions.push(corner[0], corner[1], corner[2]);
    indices.push(indices.length);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  if (shape.ridge === 'z') geometry.rotateY(Math.PI * 0.5);
  return geometry;
}

function geometryForShape(shape: Shape): BufferGeometry {
  if (shape.type === 'box') {
    const width = Math.max(1e-3, Math.abs(safe(shape.size.x)));
    const height = Math.max(1e-3, Math.abs(safe(shape.size.y)));
    const depth = Math.max(1e-3, Math.abs(safe(shape.size.z)));
    const geometry = new BoxGeometry(width, height, depth);
    geometry.translate(safe(shape.center.x), safe(shape.center.y), safe(shape.center.z));
    return geometry;
  }

  if (shape.type === 'sphere') {
    const radius = Math.max(1e-3, Math.abs(safe(shape.radius)));
    const geometry = new SphereGeometry(
      radius,
      SPHERE_WIDTH_SEGMENTS,
      SPHERE_HEIGHT_SEGMENTS,
    );
    geometry.scale(
      Math.max(1e-3, Math.abs(safe(shape.scale.x))),
      Math.max(1e-3, Math.abs(safe(shape.scale.y))),
      Math.max(1e-3, Math.abs(safe(shape.scale.z))),
    );
    geometry.translate(safe(shape.center.x), safe(shape.center.y), safe(shape.center.z));
    return geometry;
  }

  if (shape.type === 'cylinder') {
    const radius = Math.max(1e-3, Math.abs(safe(shape.radius)));
    const height = Math.max(1e-3, Math.abs(safe(shape.height)));
    const geometry = new CylinderGeometry(radius, radius, height, 10, 1, false);
    if (shape.axis === 'x') geometry.rotateZ(Math.PI * 0.5);
    if (shape.axis === 'z') geometry.rotateX(Math.PI * 0.5);
    geometry.translate(safe(shape.center.x), safe(shape.center.y), safe(shape.center.z));
    return geometry;
  }

  if (shape.type === 'cone') {
    const radius = Math.max(1e-3, Math.abs(safe(shape.radius)));
    const height = Math.max(1e-3, Math.abs(safe(shape.height)));
    const segments = Math.max(3, Math.floor(safe(shape.segments ?? 20)));
    const geometry = new ConeGeometry(radius, height, segments, 1, false);
    if (shape.rotationY !== undefined) geometry.rotateY(safe(shape.rotationY));
    geometry.translate(safe(shape.center.x), safe(shape.center.y), safe(shape.center.z));
    return geometry;
  }

  if (shape.type === 'gable') {
    const geometry = buildGableGeometry(shape);
    geometry.translate(safe(shape.center.x), safe(shape.center.y), safe(shape.center.z));
    return geometry;
  }

  const sources: BufferGeometry[] = [];
  for (const sphere of shape.spheres) {
    const radius = Math.max(1e-3, Math.abs(safe(sphere.radius)));
    const geometry = new SphereGeometry(
      radius,
      SPHERE_WIDTH_SEGMENTS,
      SPHERE_HEIGHT_SEGMENTS - 2,
    );
    geometry.translate(safe(sphere.center.x), safe(sphere.center.y), safe(sphere.center.z));
    sources.push(geometry);
  }

  if (sources.length === 0) return new BoxGeometry(1e-3, 1e-3, 1e-3);

  const merged = mergeGeometries(sources, false);
  for (const source of sources) source.dispose();
  return merged;
}

function applyVertexColor(geometry: BufferGeometry, hex: number): void {
  const position = geometry.getAttribute('position');
  const count = position.count;
  const colors = new Float32Array(count * 3);
  const color = new Color(hex);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
}

function mergeItems(items: readonly DecorItem[], vertexColors: boolean): BufferGeometry | null {
  if (items.length === 0) return null;
  const sources: BufferGeometry[] = [];
  for (const item of items) {
    const geometry = geometryForShape(item.shape);
    if (vertexColors) applyVertexColor(geometry, item.renderColor ?? item.color);
    sources.push(geometry);
  }
  const merged = mergeGeometries(sources, false);
  for (const source of sources) source.dispose();
  return merged;
}

/* ---------- module ---------- */

export function createDecor(
  deps: RenderModuleDeps & { stage: StageData; decor: unknown },
): RenderModule {
  const data = parseDecor(deps.decor);
  const plan = buildDecorPlan(deps.stage, data, deps.lowDetail);

  const matteItems: DecorItem[] = [];
  const lanternItems: DecorItem[] = [];
  const glowItems: DecorItem[] = [];
  const cloudItems: DecorItem[] = [];

  for (const item of plan) {
    if (item.layer === 'matte') matteItems.push(item);
    else if (item.layer === 'lantern') lanternItems.push(item);
    else if (item.layer === 'glow') glowItems.push(item);
    else cloudItems.push(item);
  }

  const matteMaterial = createToonMaterial(0xffffff, deps.gradient);
  matteMaterial.vertexColors = true;

  const lanternMaterial = new MeshBasicMaterial({
    color: PALETTE.lantern,
    toneMapped: false,
  });

  const glowMaterial = new MeshBasicMaterial({
    color: PALETTE.lanternGlow,
    toneMapped: false,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  const cloudMaterial = createToonMaterial(PALETTE.cloud, deps.gradient);

  const materials: Material[] = [matteMaterial, lanternMaterial, glowMaterial, cloudMaterial];
  const geometries: BufferGeometry[] = [];
  const meshes: Mesh[] = [];
  const cloudMeshes: Mesh[] = [];

  const addMerged = (items: readonly DecorItem[], material: Material, vertexColors: boolean): void => {
    const geometry = mergeItems(items, vertexColors);
    if (!geometry) return;
    geometries.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.userData.decorStatic = true;
    meshes.push(mesh);
    deps.scene.add(mesh);
  };

  addMerged(matteItems, matteMaterial, true);
  addMerged(lanternItems, lanternMaterial, false);
  addMerged(glowItems, glowMaterial, false);

  for (const item of cloudItems) {
    const geometry = geometryForShape(item.shape);
    geometries.push(geometry);
    const mesh = new Mesh(geometry, cloudMaterial);
    mesh.position.set(item.offset.x, item.offset.y, item.offset.z);
    mesh.userData.decorStatic = false;
    cloudMeshes.push(mesh);
    meshes.push(mesh);
    deps.scene.add(mesh);
  }

  let disposed = false;

  function update(dtSec: number): void {
    if (deps.lowDetail || cloudMeshes.length === 0) return;
    const raw = safe(dtSec);
    const dt = Math.max(raw, 0);
    if (dt <= 0) return;
    const step = data.cloud.speed * dt;
    const loop = data.cloud.loopHalfWidth;
    for (const mesh of cloudMeshes) {
      let x = mesh.position.x + step;
      if (!Number.isFinite(x)) x = 0;
      if (x > loop) x -= loop * 2;
      else if (x < -loop) x += loop * 2;
      mesh.position.x = x;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const mesh of meshes) deps.scene.remove(mesh);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    meshes.length = 0;
    cloudMeshes.length = 0;
  }

  return { update, dispose };
}
