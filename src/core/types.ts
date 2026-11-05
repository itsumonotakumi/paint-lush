/** World units are metres. +Y is up. All positions of actors are AABB centres. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type TeamId = 0 | 1;
/** Value of an unpainted cell in a paint grid. */
export const NO_TEAM = 255;
export type CellValue = TeamId | typeof NO_TEAM;

export type EntityId = number;
export type Tick = number;
export type SurfaceId = number;

export interface Box {
  min: Vec3;
  max: Vec3;
}

export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/** A point on a face of a stage box. Produced by collision, consumed by paint. */
export interface SurfaceHit {
  pos: Vec3;
  /** Unit outward normal of `face`. */
  normal: Vec3;
  /** Index into StageData.boxes. */
  boxIndex: number;
  face: Face;
}

/** Simulation fixed step in seconds. */
export const FIXED_DT = 1 / 60;
