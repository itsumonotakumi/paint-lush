import { describe, expect, it } from 'vitest';
import { emptyActions, type InputActions } from '../../core/actions';
import type { GameEvent } from '../../core/events';
import type { Vec3 } from '../../core/types';
import aiJson from '../../data/ai.json';
import matchJson from '../../data/match.json';
import playerJson from '../../data/player.json';
import karakuriJson from '../../data/stages/karakuri-port.json';
import neonJson from '../../data/stages/neon-town.json';
import specialsJson from '../../data/specials.json';
import subsJson from '../../data/subs.json';
import weaponsJson from '../../data/weapons.json';
import type { RosterEntry } from '../contracts';
import {
  parseAi,
  parseMatchConfig,
  parsePlayerConfig,
  parseSpecial,
  parseStage,
  parseSub,
  parseWeapons,
} from '../data/load';
import type { StageData, Weapon } from '../data/schemas';
import {
  LOCAL_PLAYER_ID,
  buildRoster,
  createSimulation,
  type Simulation,
} from './simulation';

const weapons = parseWeapons(weaponsJson);
const playerConfig = parsePlayerConfig(playerJson);
const matchConfig = parseMatchConfig(matchJson);
const ai = parseAi(aiJson).normal;
const sub = parseSub(subsJson);
const special = parseSpecial(specialsJson);
const neonTown = parseStage(neonJson);
const karakuriPort = parseStage(karakuriJson);

function weaponAt(index: number): Weapon {
  const weapon = weapons[index];
  if (weapon === undefined) throw new Error(`no weapon at ${index}`);
  return weapon;
}

function makeSim(options: {
  stage?: StageData;
  roster: readonly RosterEntry[];
  seed?: number;
  mode?: 'match' | 'training';
}): Simulation {
  return createSimulation({
    stage: options.stage ?? neonTown,
    weapons,
    sub,
    special,
    player: playerConfig,
    match: matchConfig,
    ai,
    roster: options.roster,
    seed: options.seed ?? 7,
    mode: options.mode ?? 'training',
  });
}

/** One local player on team 0 and one idle team 1 target, for the legacy cases. */
function makeDuel(seed = 7, weaponIndex = 0): Simulation {
  const weapon = weaponAt(weaponIndex);
  return makeSim({
    roster: [
      { id: LOCAL_PLAYER_ID, team: 0, weaponId: weapon.id, control: 'local' },
      { id: 2, team: 1, weaponId: weapon.id, control: 'dummy' },
    ],
    seed,
    mode: 'training',
  });
}

function makeTeamOfFour(stage: StageData, seed: number): { sim: Simulation; roster: RosterEntry[] } {
  const localWeapon = weaponAt(0);
  const roster = buildRoster({
    localId: LOCAL_PLAYER_ID,
    localWeaponId: localWeapon.id,
    teamSize: 4,
    weapons,
    seed,
  });
  return { sim: makeSim({ stage, roster, seed, mode: 'match' }), roster };
}

function run(
  sim: Simulation,
  ticks: number,
  make: (tick: number) => Partial<InputActions>,
): void {
  for (let i = 0; i < ticks; i += 1) {
    sim.step(new Map([[LOCAL_PLAYER_ID, { ...emptyActions(), ...make(i) }]]));
  }
}

function local(sim: Simulation) {
  const view = sim.snapshot().players.find((p) => p.id === LOCAL_PLAYER_ID);
  if (view === undefined) throw new Error('no local player');
  return view;
}

/** A deterministic local script: advance, weave and shoot. */
function attackScript(tick: number): InputActions {
  return {
    ...emptyActions(),
    move: [Math.sin(tick / 23) * 0.6, 1],
    look: [Math.sin(tick / 31) * 0.02, 0],
    fire: tick % 9 < 6,
  };
}

function assertFinitePlayer(view: {
  pos: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  ink: number;
  gauge: number;
  charge: number;
  kills: number;
}): void {
  for (const value of [
    view.pos.x,
    view.pos.y,
    view.pos.z,
    view.yaw,
    view.pitch,
    view.hp,
    view.ink,
    view.gauge,
    view.charge,
    view.kills,
  ]) {
    expect(Number.isFinite(value)).toBe(true);
  }
}

function spawnFor(roster: readonly RosterEntry[], stage: StageData): Map<number, Vec3> {
  const counts: [number, number] = [0, 0];
  const spawns = new Map<number, Vec3>();
  const sorted = [...roster].sort((a, b) => a.id - b.id);
  for (const entry of sorted) {
    const team = entry.team;
    const list = stage.spawns[team];
    if (list.length === 0) throw new Error('stage has no spawns');
    const spawn = list[counts[team] % list.length];
    counts[team] += 1;
    if (spawn === undefined) throw new Error('missing spawn');
    spawns.set(entry.id, spawn);
  }
  return spawns;
}

describe('simulation: legacy behaviour on a duel (training, local vs dummy)', () => {
  it('settles on the ground at spawn without falling through', () => {
    const sim = makeDuel();
    run(sim, 120, () => ({}));
    const p = local(sim);
    expect(p.state).toBe('stance');
    expect(p.pos.y).toBeCloseTo(0.8, 1);
  });

  it('walks forward and stays finite', () => {
    const sim = makeDuel();
    const start = local(sim).pos.z;
    run(sim, 60, () => ({ move: [0, 1] }));
    const p = local(sim);
    expect(p.pos.z).toBeLessThan(start - 3);
    expect(Number.isFinite(p.pos.x + p.pos.y + p.pos.z)).toBe(true);
  });

  it('firing spends ink and paints own team cells', () => {
    const sim = makeDuel();
    run(sim, 30, () => ({}));
    const before = sim.snapshot().counts[0];
    run(sim, 180, () => ({ fire: true, look: [0, 0] }));
    const snap = sim.snapshot();
    expect(snap.counts[0]).toBeGreaterThan(before);
    expect(local(sim).ink).toBeLessThan(100);
  });

  it('stops shots at a wall the player is pressed against', () => {
    const sim = makeDuel();
    const box = neonTown.boxes[8];
    if (box === undefined) throw new Error('no box');
    // Walk east along z=9 into the -x face of box 8 and keep firing into it.
    run(sim, 1, () => ({ look: [Math.PI / 2, 0] }));
    const start = local(sim).pos;
    run(sim, 240, () => ({ move: [0, 1], fire: true, look: [0, 0] }));
    const snap = sim.snapshot();
    for (const shot of snap.projectiles) {
      const inside =
        shot.pos.x > box.box.min.x &&
        shot.pos.x < box.box.max.x &&
        shot.pos.y > box.box.min.y &&
        shot.pos.y < box.box.max.y &&
        shot.pos.z > box.box.min.z &&
        shot.pos.z < box.box.max.z;
      expect(inside).toBe(false);
    }
    expect(local(sim).pos.x).toBeGreaterThan(start.x);
  });

  it('respawns a player who leaves the stage', () => {
    const shrunken: StageData = {
      ...neonTown,
      bounds: { min: { ...neonTown.bounds.min }, max: { ...neonTown.bounds.max, x: -5 } },
    };
    const weapon = weaponAt(0);
    const sim = makeSim({
      stage: shrunken,
      roster: [
        { id: LOCAL_PLAYER_ID, team: 0, weaponId: weapon.id, control: 'local' },
        { id: 2, team: 1, weaponId: weapon.id, control: 'dummy' },
      ],
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

  it('survives a long random-looking session with finite state', () => {
    const sim = makeDuel(11);
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

describe('simulation: full match integration', () => {
  it('keeps a silent local player from shooting or painting while bots play on', () => {
    const { sim, roster } = makeTeamOfFour(neonTown, 2026);
    const maxInk = playerConfig.maxInk;
    let localEvents = 0;
    let inkStayedFull = true;
    let botShots = 0;
    let botPaintEvents = 0;
    const botsInRoster = roster.filter((entry) => entry.control === 'ai');

    for (let tick = 0; tick < 1500; tick += 1) {
      const events: readonly GameEvent[] = sim.step(
        new Map([[LOCAL_PLAYER_ID, emptyActions()]]),
      );
      for (const event of events) {
        if (event.t === 'shoot' && event.id === LOCAL_PLAYER_ID) localEvents += 1;
        if (event.t === 'paint' && event.by === LOCAL_PLAYER_ID) localEvents += 1;
        if (event.t === 'shoot' && event.id !== undefined && event.id !== LOCAL_PLAYER_ID) {
          botShots += 1;
        }
        if (event.t === 'paint' && event.by !== undefined && event.by !== LOCAL_PLAYER_ID) {
          botPaintEvents += 1;
        }
      }
      if (local(sim).ink !== maxInk) inkStayedFull = false;
    }

    expect(botsInRoster).toHaveLength(7);
    expect(localEvents).toBe(0);
    expect(inkStayedFull).toBe(true);
    expect(local(sim).ink).toBe(maxInk);
    // The fight continues without the local player.
    expect(botShots).toBeGreaterThan(0);
    expect(botPaintEvents).toBeGreaterThan(0);
    expect(sim.snapshot().counts[0] + sim.snapshot().counts[1]).toBeGreaterThan(0);
  }, 60_000);

  it('does not let anyone fire during the pre phase', () => {
    const { sim } = makeTeamOfFour(neonTown, 7);
    expect(sim.snapshot().phase).toBe('pre');

    const forbidden: GameEvent[] = [];
    let ticks = 0;
    while (sim.snapshot().phase === 'pre' && ticks < 600) {
      const events = sim.step(new Map([[LOCAL_PLAYER_ID, attackScript(ticks)]]));
      for (const event of events) {
        if (event.t === 'shoot' || event.t === 'swing' || event.t === 'charge') {
          forbidden.push(event);
        }
      }
      ticks += 1;
    }

    expect(ticks).toBeGreaterThan(0);
    expect(sim.snapshot().phase).not.toBe('pre');
    expect(forbidden).toHaveLength(0);
    expect(sim.snapshot().projectiles).toHaveLength(0);
  }, 30_000);

  it('plays a full 180 s 4v4 match with 7 bots (average tick under 2 ms, reported not asserted)', () => {
    const { sim } = makeTeamOfFour(neonTown, 2026);
    const started = performance.now();
    let ticks = 0;
    while (sim.result() === null && ticks < 12_000) {
      sim.step(new Map([[LOCAL_PLAYER_ID, attackScript(ticks)]]));
      ticks += 1;
    }
    const averageMsPerTick = (performance.now() - started) / Math.max(1, ticks);

    const snap = sim.snapshot();
    const result = sim.result();
    expect(result).not.toBeNull();
    expect(ticks).toBeGreaterThan(0);
    expect(Number.isFinite(averageMsPerTick)).toBe(true);
    if (result === null) return;

    for (const view of snap.players) assertFinitePlayer(view);
    for (const projectile of snap.projectiles) {
      expect(Number.isFinite(projectile.pos.x + projectile.pos.y + projectile.pos.z)).toBe(true);
    }
    for (const bomb of snap.bombs) {
      expect(Number.isFinite(bomb.pos.x + bomb.pos.y + bomb.pos.z + bomb.fuse)).toBe(true);
    }
    expect(Number.isFinite(snap.timeLeft)).toBe(true);
    expect(snap.phase).toBe('finished');

    const total = sim.paint.totalCells();
    expect(total).toBeGreaterThan(0);
    expect(snap.counts[0]).toBeGreaterThanOrEqual(Math.ceil(total * 0.03));
    expect(snap.counts[1]).toBeGreaterThanOrEqual(Math.ceil(total * 0.03));

    expect(result.ratio[0] + result.ratio[1]).toBeLessThanOrEqual(100.000001);
    for (const player of result.players) {
      expect(Number.isFinite(player.paintCells)).toBe(true);
      expect(Number.isFinite(player.kills)).toBe(true);
      expect(Number.isFinite(player.deaths)).toBe(true);
    }
    const kills = result.players.reduce((sum, player) => sum + player.kills, 0);
    expect(kills).toBeGreaterThan(0);
  }, 120_000);

  it('is deterministic for identical seeds and inputs over 1800 ticks', () => {
    const a = makeTeamOfFour(neonTown, 424242).sim;
    const b = makeTeamOfFour(neonTown, 424242).sim;
    for (let tick = 0; tick < 1800; tick += 1) {
      const input = attackScript(tick);
      a.step(new Map([[LOCAL_PLAYER_ID, input]]));
      b.step(new Map([[LOCAL_PLAYER_ID, input]]));
    }
    expect(a.snapshot()).toEqual(b.snapshot());
  }, 60_000);

  it('fires every weapon kind and paints with each', () => {
    for (let index = 0; index < weapons.length; index += 1) {
      const sim = makeDuel(5, index);
      run(sim, 30, () => ({}));
      const before = sim.snapshot().counts[0];
      // Charge weapons need a held button and then a release; the others fire while held.
      run(sim, 90, () => ({ fire: true }));
      run(sim, 120, () => ({ fire: false }));
      const p = local(sim);
      expect(p.ink).toBeLessThan(100);
      expect(sim.snapshot().counts[0]).toBeGreaterThan(before);
    }
  }, 30_000);

  for (const stage of [neonTown, karakuriPort]) {
    it(`moves bots away from spawn after 60 s on ${stage.id}`, () => {
      const { sim, roster } = makeTeamOfFour(stage, 99);
      // 3 s pre + 60 s of play.
      const tickCount = 60 * 63;
      for (let tick = 0; tick < tickCount; tick += 1) {
        sim.step(new Map([[LOCAL_PLAYER_ID, emptyActions()]]));
      }
      const snap = sim.snapshot();
      const spawns = spawnFor(roster, stage);
      let distanceSum = 0;
      let bots = 0;
      for (const entry of roster) {
        if (entry.control !== 'ai') continue;
        const view = snap.players.find((p) => p.id === entry.id);
        const spawn = spawns.get(entry.id);
        if (view === undefined || spawn === undefined) continue;
        distanceSum += Math.hypot(view.pos.x - spawn.x, view.pos.z - spawn.z);
        bots += 1;
      }
      expect(bots).toBe(7);
      expect(distanceSum / bots).toBeGreaterThan(8);
    }, 60_000);
  }
});
