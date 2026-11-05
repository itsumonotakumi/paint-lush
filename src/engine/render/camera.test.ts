import { describe, expect, it } from 'vitest';
import type { PlayerView } from '../../core/snapshot';
import type { Vec3 } from '../../core/types';
import type { ICollision } from '../../game/contracts';
import {
  CAMERA_DISTANCE,
  CAMERA_FOV,
  CAMERA_HEIGHT,
  COLLISION_MARGIN,
  HEAD_HEIGHT,
  LOOK_AHEAD_DISTANCE,
  computeCamera,
} from './camera';
import type { CameraOutput } from './camera';

interface ViewOverrides {
  pos?: Vec3;
  yaw?: number;
  pitch?: number;
}

function makeView(overrides: ViewOverrides = {}): PlayerView {
  return {
    id: 7,
    team: 0,
    state: 'stance',
    pos: overrides.pos ?? { x: 0, y: 0, z: 0 },
    yaw: overrides.yaw ?? 0,
    pitch: overrides.pitch ?? 0,
    hp: 100,
    ink: 100,
  };
}

function makeOut(): CameraOutput {
  return {
    position: { x: 0, y: 0, z: 0 },
    lookTarget: { x: 0, y: 0, z: 0 },
    fov: 0,
  };
}

const noHit: ICollision['raycast'] = () => null;

function finite(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

describe('computeCamera', () => {
  it('sits behind and above the head with a 70 degree FOV', () => {
    const out = computeCamera(makeView(), noHit, makeOut());

    expect(out.fov).toBe(CAMERA_FOV);
    expect(out.fov).toBe(70);
    expect(out.position.x).toBeCloseTo(0);
    expect(out.position.y).toBeCloseTo(HEAD_HEIGHT + CAMERA_HEIGHT);
    expect(out.position.z).toBeCloseTo(CAMERA_DISTANCE);
    expect(out.lookTarget.x).toBeCloseTo(0);
    expect(out.lookTarget.y).toBeCloseTo(HEAD_HEIGHT);
    expect(out.lookTarget.z).toBeCloseTo(-LOOK_AHEAD_DISTANCE);
  });

  it('uses the yaw convention from aim.ts', () => {
    const out = computeCamera(makeView({ yaw: Math.PI / 2 }), noHit, makeOut());

    expect(out.position.x).toBeCloseTo(-CAMERA_DISTANCE);
    expect(out.position.y).toBeCloseTo(HEAD_HEIGHT + CAMERA_HEIGHT);
    expect(out.position.z).toBeCloseTo(0);
    expect(out.lookTarget.x).toBeCloseTo(LOOK_AHEAD_DISTANCE);
    expect(out.lookTarget.z).toBeCloseTo(0);
  });

  it('pulls in to just short of a blocking hit', () => {
    const head = { x: 0, y: HEAD_HEIGHT, z: 0 };
    const desired = { x: 0, y: HEAD_HEIGHT + CAMERA_HEIGHT, z: CAMERA_DISTANCE };
    const dx = desired.x - head.x;
    const dy = desired.y - head.y;
    const dz = desired.z - head.z;
    const total = Math.hypot(dx, dy, dz);
    const dir = { x: dx / total, y: dy / total, z: dz / total };
    const hitDistance = 2;

    const recorded: { origin: Vec3 | null; dir: Vec3 | null; max: number } = {
      origin: null,
      dir: null,
      max: -1,
    };

    const raycast: ICollision['raycast'] = (origin, direction, maxDist) => {
      recorded.origin = origin;
      recorded.dir = direction;
      recorded.max = maxDist;
      return {
        pos: {
          x: origin.x + direction.x * hitDistance,
          y: origin.y + direction.y * hitDistance,
          z: origin.z + direction.z * hitDistance,
        },
        normal: { x: 0, y: 0, z: 1 },
        boxIndex: 0,
        face: '+z',
      };
    };

    const out = computeCamera(makeView(), raycast, makeOut());

    expect(recorded.origin).toEqual(head);
    expect(recorded.dir?.x).toBeCloseTo(dir.x);
    expect(recorded.dir?.y).toBeCloseTo(dir.y);
    expect(recorded.dir?.z).toBeCloseTo(dir.z);
    expect(recorded.max).toBeCloseTo(total);

    const pulled = hitDistance - COLLISION_MARGIN;
    expect(out.position.x).toBeCloseTo(head.x + dir.x * pulled);
    expect(out.position.y).toBeCloseTo(head.y + dir.y * pulled);
    expect(out.position.z).toBeCloseTo(head.z + dir.z * pulled);

    const cameraDistance = Math.hypot(
      out.position.x - head.x,
      out.position.y - head.y,
      out.position.z - head.z,
    );
    expect(cameraDistance).toBeCloseTo(pulled);
  });

  it('leaves the camera alone when the reported hit is beyond the desired position', () => {
    const head = { x: 0, y: HEAD_HEIGHT, z: 0 };
    const raycast: ICollision['raycast'] = (origin, direction) => {
      const t = CAMERA_DISTANCE + 5;
      return {
        pos: {
          x: origin.x + direction.x * t,
          y: origin.y + direction.y * t,
          z: origin.z + direction.z * t,
        },
        normal: { x: 0, y: 0, z: 1 },
        boxIndex: 0,
        face: '+z',
      };
    };

    const out = computeCamera(makeView(), raycast, makeOut());
    const cameraDistance = Math.hypot(
      out.position.x - head.x,
      out.position.y - head.y,
      out.position.z - head.z,
    );
    expect(cameraDistance).toBeGreaterThanOrEqual(CAMERA_DISTANCE - 1e-9);
    expect(out.position.z).toBeCloseTo(CAMERA_DISTANCE);
  });

  it('collapses to the head when the blocker is closer than the margin', () => {
    const raycast: ICollision['raycast'] = (origin, direction) => ({
      pos: {
        x: origin.x + direction.x * 0.05,
        y: origin.y + direction.y * 0.05,
        z: origin.z + direction.z * 0.05,
      },
      normal: { x: 0, y: 0, z: 1 },
      boxIndex: 0,
      face: '+z',
    });

    const out = computeCamera(makeView(), raycast, makeOut());
    expect(out.position.x).toBeCloseTo(0);
    expect(out.position.y).toBeCloseTo(HEAD_HEIGHT);
    expect(out.position.z).toBeCloseTo(0);
  });

  it('keeps every output finite for non-finite inputs and hits', () => {
    const raycast: ICollision['raycast'] = (origin) => ({
      pos: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: origin.z },
      normal: { x: 0, y: 0, z: 1 },
      boxIndex: 0,
      face: '+z',
    });

    const out = computeCamera(
      makeView({
        pos: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: Number.NEGATIVE_INFINITY },
        yaw: Number.NaN,
        pitch: Number.POSITIVE_INFINITY,
      }),
      raycast,
      makeOut(),
    );

    expect(finite(out.position)).toBe(true);
    expect(finite(out.lookTarget)).toBe(true);
    expect(Number.isFinite(out.fov)).toBe(true);
    expect(out.position.y).toBeCloseTo(HEAD_HEIGHT + CAMERA_HEIGHT);
  });

  it('mutates and returns the supplied output object', () => {
    const out = makeOut();
    const returned = computeCamera(makeView(), noHit, out);
    expect(returned).toBe(out);
  });
});
