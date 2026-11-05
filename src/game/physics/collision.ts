import type { Box, Face, SurfaceHit, Vec3 } from '../../core/types';
import type { ICollision, MoveResult } from '../contracts';
import type { StageData } from '../data/schemas';
import { faceNormal, rayBox } from '../../core/math/aabb';

/** A grounded body may rise by at most this many metres in one move. */
export const STEP_HEIGHT = 0.35;

/**
 * Separation kept between a snapped body and the surface it hit. It is far
 * below any gameplay scale but large enough to stop floating-point rounding
 * from leaving a body technically inside a box.
 */
const SNAP_EPS = 1e-9;
/** How far below the feet a surface may be and still count as ground. */
const GROUND_EPS = 1e-3;
/** Ignore raise amounts this small; the feet already rest on the surface. */
const STEP_EPS = 1e-9;
/** Lower bound for a substep, so degenerate half extents cannot loop forever. */
const MIN_SUBSTEP = 1e-6;
/** Upper bound on substeps for one call; keeps runaway velocities cheap. */
const MAX_SUBSTEPS = 2048;

interface MoveState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  ground: SurfaceHit | null;
  wall: SurfaceHit | null;
}

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function cloneVec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function zeroVec(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

function clampTo(min: number, max: number, value: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Copies a stage box, normalising inverted bounds. Returns null for bad data. */
function toSolidBox(box: Box): Box | null {
  if (!isFiniteVec(box.min) || !isFiniteVec(box.max)) return null;
  return {
    min: {
      x: Math.min(box.min.x, box.max.x),
      y: Math.min(box.min.y, box.max.y),
      z: Math.min(box.min.z, box.max.z),
    },
    max: {
      x: Math.max(box.min.x, box.max.x),
      y: Math.max(box.min.y, box.max.y),
      z: Math.max(box.min.z, box.max.z),
    },
  };
}

/** Strict AABB overlap: touching faces, edges and corners are not overlaps. */
function overlapsAt(
  boxes: readonly (Box | null)[],
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): boolean {
  const minX = cx - hx;
  const maxX = cx + hx;
  const minY = cy - hy;
  const maxY = cy + hy;
  const minZ = cz - hz;
  const maxZ = cz + hz;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!box) continue;
    if (
      minX < box.max.x &&
      box.min.x < maxX &&
      minY < box.max.y &&
      box.min.y < maxY &&
      minZ < box.max.z &&
      box.min.z < maxZ
    ) {
      return true;
    }
  }
  return false;
}

/** True when a surface sits within a hair of the body's feet. */
function isStanding(
  boxes: readonly (Box | null)[],
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): boolean {
  const feet = cy - hy;
  const minX = cx - hx;
  const maxX = cx + hx;
  const minZ = cz - hz;
  const maxZ = cz + hz;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!box) continue;
    if (Math.abs(box.max.y - feet) > GROUND_EPS) continue;
    if (minX < box.max.x && box.min.x < maxX && minZ < box.max.z && box.min.z < maxZ) {
      return true;
    }
  }
  return false;
}

function facePoint(box: Box, face: Face, px: number, py: number, pz: number): Vec3 {
  switch (face) {
    case '+x':
      return {
        x: box.max.x,
        y: clampTo(box.min.y, box.max.y, py),
        z: clampTo(box.min.z, box.max.z, pz),
      };
    case '-x':
      return {
        x: box.min.x,
        y: clampTo(box.min.y, box.max.y, py),
        z: clampTo(box.min.z, box.max.z, pz),
      };
    case '+y':
      return {
        x: clampTo(box.min.x, box.max.x, px),
        y: box.max.y,
        z: clampTo(box.min.z, box.max.z, pz),
      };
    case '-y':
      return {
        x: clampTo(box.min.x, box.max.x, px),
        y: box.min.y,
        z: clampTo(box.min.z, box.max.z, pz),
      };
    case '+z':
      return {
        x: clampTo(box.min.x, box.max.x, px),
        y: clampTo(box.min.y, box.max.y, py),
        z: box.max.z,
      };
    case '-z':
      return {
        x: clampTo(box.min.x, box.max.x, px),
        y: clampTo(box.min.y, box.max.y, py),
        z: box.min.z,
      };
  }
}

function makeHit(
  box: Box,
  boxIndex: number,
  face: Face,
  px: number,
  py: number,
  pz: number,
): SurfaceHit {
  return {
    pos: facePoint(box, face, px, py, pz),
    normal: faceNormal(face),
    boxIndex,
    face,
  };
}

function getCoord(s: MoveState, axis: 0 | 1 | 2): number {
  if (axis === 0) return s.x;
  if (axis === 1) return s.y;
  return s.z;
}

function setCoord(s: MoveState, axis: 0 | 1 | 2, value: number): void {
  if (axis === 0) s.x = value;
  else if (axis === 1) s.y = value;
  else s.z = value;
}

function zeroVelocity(s: MoveState, axis: 0 | 1 | 2): void {
  if (axis === 0) s.vx = 0;
  else if (axis === 1) s.vy = 0;
  else s.vz = 0;
}

/**
 * Moves along one axis, then either accepts the move, steps the body up onto a
 * low obstacle, or snaps the body flush and kills that velocity component.
 */
function resolveAxis(
  boxes: readonly (Box | null)[],
  s: MoveState,
  axis: 0 | 1 | 2,
  delta: number,
  hx: number,
  hy: number,
  hz: number,
  startGrounded: boolean,
): void {
  const next = getCoord(s, axis) + delta;
  if (!Number.isFinite(next)) {
    zeroVelocity(s, axis);
    return;
  }

  const cx = axis === 0 ? next : s.x;
  const cy = axis === 1 ? next : s.y;
  const cz = axis === 2 ? next : s.z;
  const halfAxis = axis === 0 ? hx : hz;
  const feet = s.y - hy;

  let found = false;
  let snap = next;
  let snapBox: Box | null = null;
  let snapIndex = -1;
  let stepTop = -Infinity;
  let stepBox: Box | null = null;
  let stepIndex = -1;

  const minX = cx - hx;
  const maxX = cx + hx;
  const minY = cy - hy;
  const maxY = cy + hy;
  const minZ = cz - hz;
  const maxZ = cz + hz;

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!box) continue;
    if (
      !(
        minX < box.max.x &&
        box.min.x < maxX &&
        minY < box.max.y &&
        box.min.y < maxY &&
        minZ < box.max.z &&
        box.min.z < maxZ
      )
    ) {
      continue;
    }

    found = true;

    if (axis === 1) {
      if (delta > 0) {
        const candidate = box.min.y - hy - SNAP_EPS;
        if (candidate < snap) {
          snap = candidate;
          snapBox = box;
          snapIndex = i;
        }
      } else {
        const candidate = box.max.y + hy + SNAP_EPS;
        if (candidate > snap) {
          snap = candidate;
          snapBox = box;
          snapIndex = i;
        }
      }
      continue;
    }

    if (delta > 0) {
      const candidate = (axis === 0 ? box.min.x : box.min.z) - halfAxis - SNAP_EPS;
      if (candidate < snap) {
        snap = candidate;
        snapBox = box;
        snapIndex = i;
      }
    } else {
      const candidate = (axis === 0 ? box.max.x : box.max.z) + halfAxis + SNAP_EPS;
      if (candidate > snap) {
        snap = candidate;
        snapBox = box;
        snapIndex = i;
      }
    }

    if (startGrounded) {
      const top = box.max.y;
      if (top > feet + STEP_EPS && top <= feet + STEP_HEIGHT + STEP_EPS && top > stepTop) {
        stepTop = top;
        stepBox = box;
        stepIndex = i;
      }
    }
  }

  if (!found) {
    setCoord(s, axis, next);
    return;
  }

  if (axis !== 1 && stepBox) {
    const liftedY = stepTop + hy + SNAP_EPS;
    if (
      Number.isFinite(liftedY) &&
      !overlapsAt(boxes, cx, liftedY, cz, hx, hy, hz)
    ) {
      s.x = cx;
      s.y = liftedY;
      s.z = cz;
      s.grounded = true;
      s.ground = makeHit(stepBox, stepIndex, '+y', s.x, s.y, s.z);
      return;
    }
  }

  if (!Number.isFinite(snap)) {
    zeroVelocity(s, axis);
    return;
  }

  setCoord(s, axis, snap);

  if (axis === 1) {
    if (delta < 0 && snapBox) {
      s.grounded = true;
      s.ground = makeHit(snapBox, snapIndex, '+y', s.x, s.y, s.z);
    }
    s.vy = 0;
    return;
  }

  if (!s.wall && snapBox) {
    const face: Face = axis === 0 ? (delta > 0 ? '-x' : '+x') : delta > 0 ? '-z' : '+z';
    s.wall = makeHit(snapBox, snapIndex, face, s.x, s.y, s.z);
  }
  zeroVelocity(s, axis);
}

export function createCollision(stage: Pick<StageData, 'boxes'>): ICollision {
  const boxes: (Box | null)[] = [];
  for (let i = 0; i < stage.boxes.length; i++) {
    const entry = stage.boxes[i];
    boxes.push(entry ? toSolidBox(entry.box) : null);
  }

  function moveAndSlide(pos: Vec3, vel: Vec3, half: Vec3, dt: number): MoveResult {
    if (!isFiniteVec(pos) || !isFiniteVec(vel)) {
      return {
        pos: cloneVec(pos),
        vel: zeroVec(),
        grounded: false,
        ground: null,
        wall: null,
      };
    }

    const hx = Math.abs(half.x);
    const hy = Math.abs(half.y);
    const hz = Math.abs(half.z);
    if (!Number.isFinite(hx) || !Number.isFinite(hy) || !Number.isFinite(hz)) {
      return {
        pos: cloneVec(pos),
        vel: zeroVec(),
        grounded: false,
        ground: null,
        wall: null,
      };
    }

    if (!Number.isFinite(dt) || dt <= 0) {
      return {
        pos: cloneVec(pos),
        vel: cloneVec(vel),
        grounded: false,
        ground: null,
        wall: null,
      };
    }

    const travel = Math.hypot(vel.x, vel.y, vel.z) * dt;
    if (!Number.isFinite(travel)) {
      return {
        pos: cloneVec(pos),
        vel: zeroVec(),
        grounded: false,
        ground: null,
        wall: null,
      };
    }

    if (travel === 0) {
      return {
        pos: cloneVec(pos),
        vel: cloneVec(vel),
        grounded: false,
        ground: null,
        wall: null,
      };
    }

    const smallestHalf = Math.min(hx, hy, hz);
    const maxDisp = Math.max(smallestHalf * 0.5, MIN_SUBSTEP);
    let substeps = Math.ceil(travel / maxDisp);
    if (!Number.isFinite(substeps) || substeps < 1) substeps = 1;
    if (substeps > MAX_SUBSTEPS) substeps = MAX_SUBSTEPS;
    const stepDt = dt / substeps;

    const startGrounded = isStanding(boxes, pos.x, pos.y, pos.z, hx, hy, hz);
    const state: MoveState = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      vx: vel.x,
      vy: vel.y,
      vz: vel.z,
      grounded: false,
      ground: null,
      wall: null,
    };

    for (let s = 0; s < substeps; s++) {
      if (state.vx !== 0) {
        resolveAxis(boxes, state, 0, state.vx * stepDt, hx, hy, hz, startGrounded);
      }
      if (state.vy !== 0) {
        resolveAxis(boxes, state, 1, state.vy * stepDt, hx, hy, hz, startGrounded);
      }
      if (state.vz !== 0) {
        resolveAxis(boxes, state, 2, state.vz * stepDt, hx, hy, hz, startGrounded);
      }
    }

    return {
      pos: { x: state.x, y: state.y, z: state.z },
      vel: { x: state.vx, y: state.vy, z: state.vz },
      grounded: state.grounded,
      ground: state.ground,
      wall: state.wall,
    };
  }

  /**
   * Tests a single point against every solid box. Faces, edges and corners are
   * not "inside": a point resting exactly on a surface is outside the solid.
   */
  function containsPoint(pos: Vec3): boolean {
    if (!isFiniteVec(pos)) return false;

    const px = pos.x;
    const py = pos.y;
    const pz = pos.z;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!box) continue;
      if (
        px > box.min.x &&
        px < box.max.x &&
        py > box.min.y &&
        py < box.max.y &&
        pz > box.min.z &&
        pz < box.max.z
      ) {
        return true;
      }
    }

    return false;
  }

  function raycast(origin: Vec3, dir: Vec3, maxDist: number): SurfaceHit | null {
    if (maxDist <= 0 || !Number.isFinite(maxDist)) return null;
    if (!isFiniteVec(origin) || !isFiniteVec(dir)) return null;

    let bestT = Infinity;
    let bestFace: Face | null = null;
    let bestIndex = -1;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!box) continue;
      const hit = rayBox(origin, dir, box, maxDist);
      if (!hit) continue;
      if (hit.t < bestT) {
        bestT = hit.t;
        bestFace = hit.face;
        bestIndex = i;
      }
    }

    if (!bestFace || bestIndex < 0 || !Number.isFinite(bestT)) return null;

    const px = origin.x + dir.x * bestT;
    const py = origin.y + dir.y * bestT;
    const pz = origin.z + dir.z * bestT;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;

    return {
      pos: { x: px, y: py, z: pz },
      normal: faceNormal(bestFace),
      boxIndex: bestIndex,
      face: bestFace,
    };
  }

  return { moveAndSlide, raycast, containsPoint };
}
