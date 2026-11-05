import type { ZodError } from 'zod';
import type { Box, Face, Vec3 } from '../../core/types';
import {
  aiSchema,
  matchConfigSchema,
  playerConfigSchema,
  specialSchema,
  stageSchema,
  subSchema,
  weaponsSchema,
  type AiProfiles,
  type MatchConfig,
  type PlayerConfig,
  type SpecialWeapon,
  type StageData,
  type SubWeapon,
  type Weapon,
} from './schemas';

export type {
  AiProfiles,
  MatchConfig,
  PlayerConfig,
  SpecialWeapon,
  StageData,
  SubWeapon,
  Weapon,
} from './schemas';

const AXES: readonly (keyof Vec3)[] = ['x', 'y', 'z'];

/** Renders a zod issue path so every rejection can name the offending field. */
function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.map((segment) => String(segment)).join('.');
}

function failFromZod(label: string, error: ZodError): never {
  const issue = error.issues[0];
  if (!issue) throw new Error(`${label}: invalid data`);
  const where = formatPath(issue.path);
  const location = where === '(root)' ? label : `${label}.${where}`;
  throw new Error(`${location}: ${issue.message}`);
}

function assertOrderedBox(where: string, box: Box): void {
  for (const axis of AXES) {
    if (!(box.min[axis] < box.max[axis])) {
      throw new Error(`${where}.min.${axis}: must be less than ${where}.max.${axis}`);
    }
  }
}

/** A box has only six faces, so its paintable list must not repeat or exceed them. */
function assertPaintableFaces(where: string, faces: readonly Face[]): void {
  const unique = new Set<Face>();
  for (const face of faces) {
    if (unique.has(face)) {
      throw new Error(`${where}: duplicate face ${face}`);
    }
    unique.add(face);
  }
  if (unique.size > 6) {
    throw new Error(`${where}: at most 6 unique faces`);
  }
}

function insideBounds(point: Vec3, bounds: Box): boolean {
  return (
    point.x >= bounds.min.x &&
    point.x <= bounds.max.x &&
    point.y >= bounds.min.y &&
    point.y <= bounds.max.y &&
    point.z >= bounds.min.z &&
    point.z <= bounds.max.z
  );
}

function validateStage(stage: StageData): void {
  if (!(stage.cellSize > 0) || !Number.isFinite(stage.cellSize)) {
    throw new Error('cellSize: must be positive');
  }
  assertOrderedBox('bounds', stage.bounds);

  for (const [index, entry] of stage.boxes.entries()) {
    assertOrderedBox(`boxes.${index}.box`, entry.box);
    assertPaintableFaces(`boxes.${index}.paintable`, entry.paintable);
  }

  for (const [teamIndex, team] of stage.spawns.entries()) {
    for (const [spawnIndex, spawn] of team.entries()) {
      if (!insideBounds(spawn, stage.bounds)) {
        throw new Error(`spawns.${teamIndex}.${spawnIndex}: outside bounds`);
      }
    }
  }

  const byId = new Map<number, StageData['waypoints'][number]>();
  for (const [index, waypoint] of stage.waypoints.entries()) {
    if (byId.has(waypoint.id)) {
      throw new Error(`waypoints.${index}.id: duplicate id ${waypoint.id}`);
    }
    byId.set(waypoint.id, waypoint);
  }

  for (const [index, waypoint] of stage.waypoints.entries()) {
    for (const [linkIndex, link] of waypoint.links.entries()) {
      const target = byId.get(link);
      if (!target) {
        throw new Error(`waypoints.${index}.links.${linkIndex}: unknown waypoint id ${link}`);
      }
      if (!target.links.includes(waypoint.id)) {
        throw new Error(`waypoints.${index}.links.${linkIndex}: one-way link to ${link}`);
      }
    }
  }
}

/** Parses and validates a stage definition. Throws with the failing field path. */
export function parseStage(json: unknown): StageData {
  const result = stageSchema.safeParse(json);
  if (!result.success) failFromZod('stage', result.error);
  const stage = result.data;
  validateStage(stage);
  return stage;
}

/** Parses and validates the weapon catalogue. Throws with the failing field path. */
export function parseWeapons(json: unknown): Weapon[] {
  const result = weaponsSchema.safeParse(json);
  if (!result.success) failFromZod('weapons', result.error);
  return result.data;
}

/** Parses and validates the player tuning constants. Throws with the failing field path. */
export function parsePlayerConfig(json: unknown): PlayerConfig {
  const result = playerConfigSchema.safeParse(json);
  if (!result.success) failFromZod('player', result.error);
  return result.data;
}

/** Parses and validates the single sub weapon definition. Throws with the failing field path. */
export function parseSub(json: unknown): SubWeapon {
  const result = subSchema.safeParse(json);
  if (!result.success) failFromZod('sub', result.error);
  return result.data;
}

/** Parses and validates the single special weapon definition. Throws with the failing field path. */
export function parseSpecial(json: unknown): SpecialWeapon {
  const result = specialSchema.safeParse(json);
  if (!result.success) failFromZod('special', result.error);
  return result.data;
}

/** Parses and validates the per-difficulty AI profiles. Throws with the failing field path. */
export function parseAi(json: unknown): AiProfiles {
  const result = aiSchema.safeParse(json);
  if (!result.success) failFromZod('ai', result.error);
  return result.data;
}

/** Parses and validates the match clock configuration. Throws with the failing field path. */
export function parseMatchConfig(json: unknown): MatchConfig {
  const result = matchConfigSchema.safeParse(json);
  if (!result.success) failFromZod('match', result.error);
  return result.data;
}
