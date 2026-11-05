import { describe, expect, it } from 'vitest';
import { emptyActions, type InputActions } from '../../core/actions';
import { parsePlayerConfig, parseStage, parseWeapons } from '../data/load';
import playerJson from '../../data/player.json';
import stageJson from '../../data/stages/neon-town.json';
import weaponsJson from '../../data/weapons.json';
import { createSimulation, LOCAL_PLAYER_ID, type Simulation } from './simulation';

function makeSim(seed = 7): Simulation {
  const weapon = parseWeapons(weaponsJson)[0];
  if (weapon === undefined) throw new Error('no weapon');
  return createSimulation({
    stage: parseStage(stageJson),
    weapon,
    player: parsePlayerConfig(playerJson),
    seed,
  });
}

function run(sim: Simulation, ticks: number, make: (tick: number) => Partial<InputActions>): void {
  for (let i = 0; i < ticks; i += 1) {
    sim.step(new Map([[LOCAL_PLAYER_ID, { ...emptyActions(), ...make(i) }]]));
  }
}

function local(sim: Simulation) {
  const p = sim.snapshot().players.find((v) => v.id === LOCAL_PLAYER_ID);
  if (p === undefined) throw new Error('no local player');
  return p;
}

describe('simulation on the real stage', () => {
  it('settles on the ground at spawn without falling through', () => {
    const sim = makeSim();
    run(sim, 120, () => ({}));
    const p = local(sim);
    expect(p.state).toBe('stance');
    expect(p.pos.y).toBeCloseTo(0.8, 1);
  });

  it('walks forward and stays finite', () => {
    const sim = makeSim();
    const start = local(sim).pos.z;
    run(sim, 60, () => ({ move: [0, 1] }));
    const p = local(sim);
    expect(p.pos.z).toBeLessThan(start - 3);
    expect(Number.isFinite(p.pos.x + p.pos.y + p.pos.z)).toBe(true);
  });

  it('firing spends ink and paints own team cells', () => {
    const sim = makeSim();
    run(sim, 30, () => ({}));
    const before = sim.snapshot().counts[0];
    run(sim, 180, () => ({ fire: true, look: [0, 0] }));
    const snap = sim.snapshot();
    expect(snap.counts[0]).toBeGreaterThan(before);
    expect(local(sim).ink).toBeLessThan(100);
  });

  it('stops shots at a wall the player is pressed against', () => {
    const sim = makeSim();
    const box = parseStage(stageJson).boxes[8];
    if (box === undefined) throw new Error('no box');
    // Walk east along z=9 into the -x face of box 8 and keep firing into it.
    run(sim, 1, () => ({ look: [Math.PI / 2, 0] }));
    const start = local(sim).pos;
    run(sim, 240, () => ({ move: [0, 1], fire: true, look: [0, 0] }));
    const snap = sim.snapshot();
    for (const shot of snap.projectiles) {
      const inside =
        shot.pos.x > box.box.min.x && shot.pos.x < box.box.max.x &&
        shot.pos.y > box.box.min.y && shot.pos.y < box.box.max.y &&
        shot.pos.z > box.box.min.z && shot.pos.z < box.box.max.z;
      expect(inside).toBe(false);
    }
    expect(local(sim).pos.x).toBeGreaterThan(start.x);
  });

  it('respawns a player who leaves the stage', () => {
    const stage = parseStage(stageJson);
    const weapon = parseWeapons(weaponsJson)[0];
    if (weapon === undefined) throw new Error('no weapon');
    const sim = createSimulation({
      stage: { ...stage, bounds: { min: { ...stage.bounds.min }, max: { ...stage.bounds.max, x: -5 } } },
      weapon,
      player: parsePlayerConfig(playerJson),
      seed: 1,
    });
    // Spawn x=-6 is inside; walking east past x=-4 leaves the shrunken bounds.
    const spawnX = local(sim).pos.x;
    run(sim, 1, () => ({ look: [Math.PI / 2, 0] }));
    let lost = false;
    for (let i = 0; i < 120 && !lost; i += 1) {
      run(sim, 1, () => ({ move: [0, 1], look: [0, 0] }));
      lost = local(sim).state === 'down';
    }
    expect(lost).toBe(true);
    run(sim, 60 * 6, () => ({}));
    const back = local(sim);
    expect(back.state).toBe('stance');
    expect(back.pos.x).toBeCloseTo(spawnX, 1);
    expect(back.hp).toBe(100);
  });

  it('is deterministic for the same seed and inputs', () => {
    const script = (i: number): Partial<InputActions> => ({
      move: [Math.sin(i / 17), 1],
      look: [0.01, 0],
      fire: i % 40 < 25,
      jump: i % 90 === 0,
      dive: i % 200 > 150,
    });
    const a = makeSim(3);
    const b = makeSim(3);
    run(a, 900, script);
    run(b, 900, script);
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('survives a long random-looking session with finite state', () => {
    const sim = makeSim(11);
    run(sim, 3600, (i) => ({
      move: [Math.sin(i * 0.13), Math.cos(i * 0.07)],
      look: [Math.sin(i * 0.05) * 0.05, Math.cos(i * 0.03) * 0.02],
      fire: i % 7 < 4,
      jump: i % 53 === 0,
      dive: i % 300 > 200,
    }));
    const p = local(sim);
    for (const v of [p.pos.x, p.pos.y, p.pos.z, p.yaw, p.pitch, p.hp, p.ink]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(20);
    expect(Math.abs(p.pos.z)).toBeLessThanOrEqual(20);
    expect(p.pos.y).toBeGreaterThan(0);
  });
});
