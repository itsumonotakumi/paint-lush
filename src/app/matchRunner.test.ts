import { describe, expect, it, vi } from 'vitest';
import { FIXED_DT } from '../core/types';
import type { ISaveStore } from '../engine/ports';
import { defaultSave } from '../engine/save/saveStore';
import type { MatchResult } from '../game/contracts';
import type { SaveData } from '../game/data/schemas';
import { parseWeapons } from '../game/data/load';
import { LOCAL_PLAYER_ID } from '../game/sim/simulation';
import weaponsJson from '../data/weapons.json';
import {
  COLORBLIND_TEAMS,
  TEAM_PAIRS,
  bgmTrackForPhase,
  frameDeltaSeconds,
  killLogLine,
  pickTeams,
  recordMatchResult,
  recordWeaponUse,
  resolveStageId,
  resolveWeapon,
  resultScreenParams,
  shouldStepMatch,
  touchLookSensitivity,
} from './matchRunner';

function memoryStore(initial: SaveData): { store: ISaveStore; current(): SaveData } {
  let stored = initial;
  return {
    store: {
      load: () => stored,
      save: (data) => {
        stored = data;
        return true;
      },
    },
    current: () => stored,
  };
}

describe('team selection', () => {
  it('uses the colour-blind-safe pair whenever the setting is on', () => {
    for (const seed of [0, 1, 2, 3, 999]) {
      expect(pickTeams(seed, true)).toBe(COLORBLIND_TEAMS);
    }
    expect(COLORBLIND_TEAMS.map((team) => team.name)).toEqual(['山吹', '群青']);
  });

  it('always returns a complete pair with readings and finite colours', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      const pair = pickTeams(seed, false);
      expect(pair).toHaveLength(2);
      for (const team of pair) {
        expect(team.name.length).toBeGreaterThan(0);
        expect(team.reading.length).toBeGreaterThan(0);
        expect(Number.isFinite(team.color)).toBe(true);
        expect(team.color).toBeGreaterThanOrEqual(0);
        expect(team.color).toBeLessThanOrEqual(0xffffff);
      }
      seen.add(pair.map((team) => team.name).join(':'));
    }
    // Every declared pair is reachable.
    expect(seen.size).toBe(TEAM_PAIRS.length);
  });

  it('is deterministic for the same seed and keeps the local team first', () => {
    expect(pickTeams(42, false)).toBe(pickTeams(42, false));
    const firstPair = pickTeams(0, false);
    expect(firstPair[0].name).toBe('紅蓮');
    expect(firstPair[1].name).toBe('蒼雷');
  });
});

describe('result params', () => {
  it('carries the pair picked for the match with the local side first', () => {
    const pair = pickTeams(0, false);
    const result: MatchResult = { winner: 0, ratio: [62.5, 37.5], players: [] };
    const params = resultScreenParams(result, pair);

    expect(params.kind).toBe('result');
    if (params.kind !== 'result') throw new Error('expected result params');
    expect(params.localId).toBe(LOCAL_PLAYER_ID);
    expect(params.result).toBe(result);
    expect(params.teams).toEqual([
      { name: '紅蓮', reading: 'ぐれん', color: 0xff2e88 },
      { name: '蒼雷', reading: 'そうらい', color: 0x19e6d0 },
    ]);
  });

  it('passes the colour-blind pair through unchanged', () => {
    const result: MatchResult = { winner: null, ratio: [0, 0], players: [] };
    const params = resultScreenParams(result, COLORBLIND_TEAMS);

    if (params.kind !== 'result') throw new Error('expected result params');
    expect(params.teams.map((team) => team.name)).toEqual(['山吹', '群青']);
    expect(params.teams[0].color).toBe(COLORBLIND_TEAMS[0].color);
    expect(params.teams[1].color).toBe(COLORBLIND_TEAMS[1].color);
    expect(params.teams[0].reading).toBe('やまぶき');
  });
});

describe('fallbacks', () => {
  it('falls back to neon-town for unknown stages and to iro-shuriken for unknown weapons', () => {
    expect(resolveStageId('neon-town')).toBe('neon-town');
    expect(resolveStageId('karakuri-port')).toBe('karakuri-port');
    expect(resolveStageId('not-a-stage')).toBe('neon-town');
    expect(resolveStageId('__proto__')).toBe('neon-town');

    const weapons = parseWeapons(weaponsJson);
    expect(resolveWeapon(weapons, 'oofude').id).toBe('oofude');
    expect(resolveWeapon(weapons, 'not-a-weapon').id).toBe('iro-shuriken');
  });
});

describe('frame delta', () => {
  it('clamps long stalls and rejects bad timestamps', () => {
    expect(frameDeltaSeconds(FIXED_DT * 1000, 0)).toBeCloseTo(FIXED_DT, 12);
    expect(frameDeltaSeconds(10_000, 0)).toBe(0.25);
    expect(frameDeltaSeconds(Number.NaN, 0)).toBe(0);
    expect(frameDeltaSeconds(100, 200)).toBe(0);
    expect(frameDeltaSeconds(Number.POSITIVE_INFINITY, 0)).toBe(0);
  });
});

describe('kill call-outs', () => {
  it('only speaks when the local player is involved', () => {
    expect(killLogLine(1, 7, 1)).toBe('あなたが やっつけた！');
    expect(killLogLine(8, 1, 1)).toBe('やられた！');
    expect(killLogLine(8, 9, 1)).toBeNull();
    expect(killLogLine(1, 1, 1)).toBeNull();
  });
});

describe('weapon records', () => {
  it('increments only weaponUses and never matches or wins', () => {
    const initial = defaultSave();
    initial.records.matches = 5;
    initial.records.wins = 3;
    initial.records.weaponUses = { oofude: 2 };
    const { store, current } = memoryStore(initial);

    recordWeaponUse(store, 'oofude');

    expect(current().records.weaponUses).toEqual({ oofude: 3 });
    expect(current().records.matches).toBe(5);
    expect(current().records.wins).toBe(3);
  });

  it('ignores ids the save schema would reject', () => {
    const { store, current } = memoryStore(defaultSave());
    const before = current();

    recordWeaponUse(store, 'Bad Id!');
    recordWeaponUse(store, '');

    expect(current()).toBe(before);
    expect(current().records.weaponUses).toEqual({});
  });

  it('stops at the schema count ceiling', () => {
    const initial = defaultSave();
    initial.records.weaponUses = { 'iro-shuriken': 1_000_000_000 };
    const { store, current } = memoryStore(initial);

    recordWeaponUse(store, 'iro-shuriken');

    expect(current().records.weaponUses['iro-shuriken']).toBe(1_000_000_000);
  });

  it('saves the loaded settings and last setup unchanged', () => {
    const initial = defaultSave();
    initial.settings.volume.bgm = 0.25;
    initial.last.stageId = 'karakuri-port';
    const { store, current } = memoryStore(initial);
    const save = vi.spyOn(store, 'save');

    recordWeaponUse(store, 'naga-fukiya');

    expect(save).toHaveBeenCalledTimes(1);
    expect(current().settings.volume.bgm).toBe(0.25);
    expect(current().last.stageId).toBe('karakuri-port');
  });
});

describe('match end records', () => {
  it('writes matches, wins, weapon uses and best paint in one save', () => {
    const initial = defaultSave();
    initial.records.matches = 5;
    initial.records.wins = 3;
    initial.records.weaponUses = { oofude: 2 };
    initial.records.bestPaintCells = 500;
    const { store, current } = memoryStore(initial);
    const save = vi.spyOn(store, 'save');

    recordMatchResult(store, 'iro-shuriken', 1, {
      winner: 0,
      ratio: [60, 40],
      players: [
        { id: 1, team: 0, paintCells: 900, kills: 4, deaths: 1 },
        { id: 2, team: 1, paintCells: 300, kills: 1, deaths: 4 },
      ],
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(current().records).toEqual({
      matches: 6,
      wins: 4,
      weaponUses: { oofude: 2, 'iro-shuriken': 1 },
      bestPaintCells: 900,
    });
  });

  it('does not count a draw or a loss as a win and keeps the best paint', () => {
    const initial = defaultSave();
    initial.records.bestPaintCells = 1200;
    const { store, current } = memoryStore(initial);

    recordMatchResult(store, 'oofude', 1, {
      winner: null,
      ratio: [50, 50],
      players: [{ id: 1, team: 0, paintCells: 700, kills: 0, deaths: 0 }],
    });
    expect(current().records.wins).toBe(0);
    expect(current().records.matches).toBe(1);
    expect(current().records.bestPaintCells).toBe(1200);

    recordMatchResult(store, 'oofude', 1, {
      winner: 1,
      ratio: [30, 70],
      players: [{ id: 1, team: 0, paintCells: Number.NaN, kills: 0, deaths: 0 }],
    });
    expect(current().records.wins).toBe(0);
    expect(current().records.matches).toBe(2);
    expect(current().records.bestPaintCells).toBe(1200);
  });

  it('keeps non-finite counts finite and stops at the ceiling', () => {
    const initial = defaultSave();
    initial.records.matches = 1_000_000_000;
    initial.records.wins = 1_000_000_000;
    const { store, current } = memoryStore(initial);

    recordMatchResult(store, 'oofude', 1, {
      winner: 0,
      ratio: [0, 0],
      players: [{ id: 1, team: 0, paintCells: Number.POSITIVE_INFINITY, kills: 0, deaths: 0 }],
    });

    expect(current().records.matches).toBe(1_000_000_000);
    expect(current().records.wins).toBe(1_000_000_000);
    expect(current().records.bestPaintCells).toBe(0);
  });
});

describe('phase music', () => {
  it('treats lastMinute, countdown and finished as the urgent track', () => {
    expect(bgmTrackForPhase('lastMinute', 'battle')).toBe('lastMinute');
    expect(bgmTrackForPhase('countdown', 'battle')).toBe('lastMinute');
    expect(bgmTrackForPhase('finished', 'battle')).toBe('lastMinute');
    expect(bgmTrackForPhase('play', 'battle')).toBe('battle');
    expect(bgmTrackForPhase('pre', 'battle')).toBe('battle');
  });

  it('keeps the settle clock running while paused', () => {
    expect(shouldStepMatch(true, 'play')).toBe(false);
    expect(shouldStepMatch(true, 'countdown')).toBe(false);
    expect(shouldStepMatch(true, 'finished')).toBe(true);
    expect(shouldStepMatch(false, 'play')).toBe(true);
  });

  it('derives a finite touch look speed', () => {
    expect(touchLookSensitivity(2)).toBeCloseTo(0.002, 12);
    expect(touchLookSensitivity(Number.NaN)).toBe(0.0001);
    expect(touchLookSensitivity(0)).toBe(0.0001);
    expect(touchLookSensitivity(1_000_000)).toBe(0.05);
  });
});
