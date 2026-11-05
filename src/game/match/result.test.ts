import { describe, expect, it } from 'vitest';
import type { TeamId } from '../../core/types';
import type { PlayerState } from '../contracts';
import { computeResult } from './result';

function player(
  id: number,
  team: TeamId,
  paintCells: number,
  kills = 0,
  deaths = 0,
): PlayerState {
  return {
    id,
    team,
    state: 'stance',
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    ink: 100,
    diveTransition: 0,
    fireLock: 0,
    respawnTimer: 0,
    invuln: 0,
    prevDive: false,
    prevJump: false,
    weaponId: 'test-weapon',
    subCooldown: 0,
    kills,
    deaths,
    paintCells,
    special: { gauge: 0, activeLeft: 0, prevButton: false },
    moveMultiplier: 1,
    charge: 0,
  };
}

describe('computeResult', () => {
  it('sorts players by id and copies their stats', () => {
    const players = [player(9, 1, 4, 2, 1), player(2, 0, 10, 3, 0)];
    const result = computeResult(players, [10, 4], 100);

    expect(result.players.map((entry) => entry.id)).toEqual([2, 9]);
    expect(result.players[0]).toEqual({ id: 2, team: 0, paintCells: 10, kills: 3, deaths: 0 });
    expect(result.players[1]).toEqual({ id: 9, team: 1, paintCells: 4, kills: 2, deaths: 1 });
    // The input order is not mutated.
    expect(players[0]?.id).toBe(9);
  });

  it('reports percentages of total cells and the larger team as winner', () => {
    const result = computeResult([], [30, 70], 200);
    expect(result.ratio).toEqual([15, 35]);
    expect(result.winner).toBe(1);
    expect(Number.isFinite(result.ratio[0])).toBe(true);
    expect(Number.isFinite(result.ratio[1])).toBe(true);
  });

  it('reports a draw for equal counts', () => {
    const result = computeResult([], [7, 7], 14);
    expect(result.ratio).toEqual([50, 50]);
    expect(result.winner).toBeNull();
  });

  it('stays finite when totalCells is zero', () => {
    const result = computeResult([player(1, 0, 3), player(2, 1, 1)], [3, 1], 0);
    expect(result.ratio).toEqual([0, 0]);
    expect(result.winner).toBe(0);
    expect(Number.isFinite(result.ratio[0])).toBe(true);
    expect(Number.isFinite(result.ratio[1])).toBe(true);

    expect(computeResult([], [2, 2], 0).winner).toBeNull();
  });

  it('clamps percentages into 0..100 when counts exceed the total', () => {
    const result = computeResult([], [150, 20], 100);
    expect(result.ratio).toEqual([100, 20]);
    expect(result.winner).toBe(0);
  });

  it('turns non-finite and negative inputs into finite scores', () => {
    const result = computeResult(
      [player(1, 0, Number.NaN, Number.POSITIVE_INFINITY, -2)],
      [Number.NaN, Number.POSITIVE_INFINITY],
      50,
    );
    expect(result.ratio).toEqual([0, 0]);
    expect(result.winner).toBeNull();
    expect(result.players[0]).toEqual({
      id: 1,
      team: 0,
      paintCells: 0,
      kills: 0,
      deaths: -2,
    });
  });

  it('uses raw counts for the winner even with an invalid total', () => {
    expect(computeResult([], [1, 2], Number.NaN).winner).toBe(1);
    expect(computeResult([], [0, 0], Number.NEGATIVE_INFINITY).winner).toBeNull();
  });
});
