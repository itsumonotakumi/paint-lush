import { describe, expect, it } from 'vitest';
import { emptyActions } from '../../core/actions';
import { aimDirection } from '../../core/math/aim';
import { normalize, sub } from '../../core/math/vec3';
import playerJson from '../../data/player.json';
import stageJson from '../../data/stages/neon-town.json';
import weaponsJson from '../../data/weapons.json';
import { parsePlayerConfig, parseStage, parseWeapons } from '../../game/data/load';
import { createSimulation, LOCAL_PLAYER_ID } from '../../game/sim/simulation';
import { computeCamera, type CameraOutput } from './camera';

function makeSim() {
  const weapon = parseWeapons(weaponsJson)[0];
  if (weapon === undefined) throw new Error('no weapon');
  return createSimulation({
    stage: parseStage(stageJson),
    weapon,
    player: parsePlayerConfig(playerJson),
    seed: 1,
  });
}

describe('aim, movement and camera agree', () => {
  it.each([0, 0.7, -2.1, 3])('yaw %f: movement and shots follow the camera heading', (yaw) => {
    const sim = makeSim();
    sim.step(new Map([[LOCAL_PLAYER_ID, { ...emptyActions(), look: [yaw, 0] }]]));
    const first = sim.snapshot().players.find((p) => p.id === LOCAL_PLAYER_ID);
    if (first === undefined) throw new Error('no player');
    expect(first.yaw).toBeCloseTo(yaw, 6);

    const out: CameraOutput = {
      position: { x: 0, y: 0, z: 0 },
      lookTarget: { x: 0, y: 0, z: 0 },
      fov: 70,
    };
    computeCamera(first, () => null, out);
    const view = normalize(sub(out.lookTarget, out.position));
    const heading = Math.hypot(view.x, view.z);
    const aim = aimDirection(yaw, 0);
    expect(view.x / heading).toBeCloseTo(aim.x, 5);
    expect(view.z / heading).toBeCloseTo(aim.z, 5);

    for (let i = 0; i < 20; i += 1) {
      sim.step(new Map([[LOCAL_PLAYER_ID, { ...emptyActions(), move: [0, 1] }]]));
    }
    const moved = sim.snapshot().players.find((p) => p.id === LOCAL_PLAYER_ID);
    if (moved === undefined) throw new Error('no player');
    const step = normalize(sub(moved.pos, first.pos));
    const stepHeading = Math.hypot(step.x, step.z);
    expect(stepHeading).toBeGreaterThan(0);
    expect(step.x / stepHeading).toBeCloseTo(aim.x, 3);
    expect(step.z / stepHeading).toBeCloseTo(aim.z, 3);
  });
});
