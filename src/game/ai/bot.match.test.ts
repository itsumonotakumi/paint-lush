import { beforeAll, describe, expect, it } from 'vitest';
import type { GameEvent } from '../../core/events';
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
import type { AiProfile, Difficulty, StageData } from '../data/schemas';
import { createSimulation } from '../sim/simulation';

const weapons = parseWeapons(weaponsJson);
const playerCfg = parsePlayerConfig(playerJson);
const matchCfg = parseMatchConfig(matchJson);
const aiProfiles = parseAi(aiJson);
const sub = parseSub(subsJson);
const special = parseSpecial(specialsJson);

const STAGES: readonly [string, StageData][] = [
  ['neon', parseStage(neonJson)],
  ['kara', parseStage(karakuriJson)],
];
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const MATCH_SECONDS = 90;
const SEED = 4242;

interface RunMetrics {
  paint: number;
  kills: number;
  shots: number;
  subs: number;
  dryShare: number;
}

/** Symmetric 4v4 rosters: the same mixed loadout on both teams. */
function mixedRoster(): RosterEntry[] {
  const mix = ['iro-shuriken', 'oofude', 'naga-fukiya', 'iro-shuriken'];
  const out: RosterEntry[] = [];
  for (let i = 0; i < 4; i += 1) {
    out.push({ id: i + 1, team: 0, weaponId: mix[i] ?? 'iro-shuriken', control: 'ai' });
    out.push({ id: i + 5, team: 1, weaponId: mix[i] ?? 'iro-shuriken', control: 'ai' });
  }
  return out;
}

/** Every bot uses the charge weapon so the match is a true mirror. */
function chargeMirror(): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (let i = 0; i < 4; i += 1) {
    out.push({ id: i + 1, team: 0, weaponId: 'naga-fukiya', control: 'ai' });
    out.push({ id: i + 5, team: 1, weaponId: 'naga-fukiya', control: 'ai' });
  }
  return out;
}

function runMatch(
  stage: StageData,
  profile: AiProfile,
  roster: readonly RosterEntry[],
): RunMetrics {
  const sim = createSimulation({
    stage,
    weapons,
    sub,
    special,
    player: playerCfg,
    match: { ...matchCfg, durationSeconds: MATCH_SECONDS },
    ai: profile,
    roster,
    seed: SEED,
    mode: 'match',
  });

  let shots = 0;
  let subs = 0;
  let dryTicks = 0;
  let aliveTicks = 0;
  let result = sim.result();
  let guard = 0;

  while (result === null && guard < 30_000) {
    const events: GameEvent[] = sim.step(new Map());
    for (const event of events) {
      if (event.t === 'shoot') shots += 1;
      else if (event.t === 'sub' && event.phase === 'throw') subs += 1;
    }

    const snap = sim.snapshot();
    for (const player of snap.players) {
      if (player.state === 'down' || player.state === 'respawn') continue;
      aliveTicks += 1;
      if (player.ink < 1) dryTicks += 1;
    }

    result = sim.result();
    guard += 1;
  }

  return {
    paint: result === null ? 0 : result.ratio[0] + result.ratio[1],
    kills: result === null ? 0 : result.players.reduce((sum, player) => sum + player.kills, 0),
    shots,
    subs,
    dryShare: aliveTicks === 0 ? 0 : dryTicks / aliveTicks,
  };
}

function key(stage: string, difficulty: Difficulty): string {
  return `${stage}:${difficulty}`;
}

function read(metrics: ReadonlyMap<string, RunMetrics>, stage: string, difficulty: Difficulty): RunMetrics {
  const value = metrics.get(key(stage, difficulty));
  if (value === undefined) throw new Error(`missing measurement for ${stage}/${difficulty}`);
  return value;
}

const mixed = new Map<string, RunMetrics>();
const charge = new Map<string, RunMetrics>();

describe('90 second headless bot matches', () => {
  beforeAll(() => {
    for (const [stageName, stage] of STAGES) {
      for (const difficulty of DIFFICULTIES) {
        mixed.set(key(stageName, difficulty), runMatch(stage, aiProfiles[difficulty], mixedRoster()));
        charge.set(key(stageName, difficulty), runMatch(stage, aiProfiles[difficulty], chargeMirror()));
      }
    }
  }, 35_000);

  it('has charge bots firing repeatedly in every mirror match', () => {
    for (const [stageName] of STAGES) {
      for (const difficulty of DIFFICULTIES) {
        const metrics = read(charge, stageName, difficulty);
        expect(metrics.shots, `${stageName}/${difficulty} charge shots`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('keeps easy bots out of a dry tank for most of their alive time', () => {
    for (const [stageName] of STAGES) {
      const metrics = read(mixed, stageName, 'easy');
      expect(metrics.dryShare, `${stageName}/easy dry share`).toBeLessThan(0.25);
    }
  });

  it('throws a sub at least once on every difficulty across both stages', () => {
    for (const difficulty of DIFFICULTIES) {
      let total = 0;
      for (const [stageName] of STAGES) total += read(mixed, stageName, difficulty).subs;
      expect(total, `${difficulty} sub throws`).toBeGreaterThanOrEqual(1);
    }
  });

  it('makes hard more lethal than normal on at least one stage', () => {
    const lethal = STAGES.some(
      ([stageName]) =>
        read(mixed, stageName, 'hard').kills > read(mixed, stageName, 'normal').kills,
    );
    expect(lethal).toBe(true);
  });

  it('keeps hard paint at least 0.7 times normal paint overall', () => {
    let normalPaint = 0;
    let hardPaint = 0;
    for (const [stageName] of STAGES) {
      normalPaint += read(mixed, stageName, 'normal').paint;
      hardPaint += read(mixed, stageName, 'hard').paint;
    }
    expect(normalPaint).toBeGreaterThan(0);
    expect(hardPaint).toBeGreaterThanOrEqual(normalPaint * 0.7);
  });

  it('keeps every measured value finite', () => {
    for (const metrics of [...mixed.values(), ...charge.values()]) {
      expect(Number.isFinite(metrics.paint)).toBe(true);
      expect(Number.isFinite(metrics.kills)).toBe(true);
      expect(Number.isFinite(metrics.shots)).toBe(true);
      expect(Number.isFinite(metrics.subs)).toBe(true);
      expect(Number.isFinite(metrics.dryShare)).toBe(true);
      expect(metrics.dryShare).toBeGreaterThanOrEqual(0);
      expect(metrics.dryShare).toBeLessThanOrEqual(1);
    }
  });
});
