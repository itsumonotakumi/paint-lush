import type { InputActions } from '../../core/actions';
import type { EntityId } from '../../core/types';
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
import type { Difficulty, StageData } from '../data/schemas';
import { createSimulation } from '../sim/simulation';

const weapons = parseWeapons(weaponsJson);
const playerCfg = parsePlayerConfig(playerJson);
const matchCfg = parseMatchConfig(matchJson);
const aiProfiles = parseAi(aiJson);
const sub = parseSub(subsJson);
const special = parseSpecial(specialsJson);

const STAGES: Readonly<Record<StageName, StageData>> = {
  neon: parseStage(neonJson),
  kara: parseStage(karakuriJson),
};

export type StageName = 'neon' | 'kara';

/** Stage keys in a fixed order, for exhaustive checks across stages. */
export const STAGE_NAMES: readonly StageName[] = ['neon', 'kara'];

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];

/** Length of every headless match, in seconds. */
export const MATCH_SECONDS = 90;

export const SEED = 4242;

/** Which symmetric 4v4 roster a match uses. */
export type RosterKind = 'mixed' | 'charge';

export interface RunMetrics {
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

/** Bots receive no human input, so one empty map serves every tick. */
const NO_INPUTS: ReadonlyMap<EntityId, InputActions> = new Map();

function rosterFor(kind: RosterKind): RosterEntry[] {
  return kind === 'mixed' ? mixedRoster() : chargeMirror();
}

/** Runs one full headless match and measures it. */
export function runMatch(
  stageName: StageName,
  difficulty: Difficulty,
  rosterKind: RosterKind,
): RunMetrics {
  const sim = createSimulation({
    stage: STAGES[stageName],
    weapons,
    sub,
    special,
    player: playerCfg,
    match: { ...matchCfg, durationSeconds: MATCH_SECONDS },
    ai: aiProfiles[difficulty],
    roster: rosterFor(rosterKind),
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
    const events: GameEvent[] = sim.step(NO_INPUTS);
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

/** Runs the three difficulties of one stage and roster, keyed by difficulty. */
export function runStage(stageName: StageName, rosterKind: RosterKind): Map<Difficulty, RunMetrics> {
  const out = new Map<Difficulty, RunMetrics>();
  for (const difficulty of DIFFICULTIES) {
    out.set(difficulty, runMatch(stageName, difficulty, rosterKind));
  }
  return out;
}

export function readMetrics(metrics: ReadonlyMap<Difficulty, RunMetrics>, difficulty: Difficulty): RunMetrics {
  const value = metrics.get(difficulty);
  if (value === undefined) throw new Error(`missing measurement for ${difficulty}`);
  return value;
}

export function readStage(metrics: ReadonlyMap<StageName, RunMetrics>, stage: StageName): RunMetrics {
  const value = metrics.get(stage);
  if (value === undefined) throw new Error(`missing measurement for ${stage}`);
  return value;
}
