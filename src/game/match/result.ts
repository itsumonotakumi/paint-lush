import type { EntityId } from '../../core/types';
import type { MatchPlayerResult, MatchResult, PlayerState } from '../contracts';

/** Non-finite values become 0 so the result can never contain NaN or Infinity. */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** A team count clamped into the paintable range, for ratio maths. */
function clampCount(value: number, total: number): number {
  if (!Number.isFinite(value) || value <= 0 || total <= 0) return 0;
  return value > total ? total : value;
}

/**
 * Final score. Ratios are percentages of `totalCells`; a zero or invalid total
 * yields 0 % for both teams but still compares the raw cell counts for a winner.
 */
export function computeResult(
  players: readonly PlayerState[],
  counts: [number, number],
  totalCells: number,
): MatchResult {
  const total = Number.isFinite(totalCells) && totalCells > 0 ? totalCells : 0;
  const raw0 = finiteOrZero(counts[0]);
  const raw1 = finiteOrZero(counts[1]);
  const count0 = clampCount(raw0, total);
  const count1 = clampCount(raw1, total);
  const ratio: [number, number] = [
    total > 0 ? (count0 / total) * 100 : 0,
    total > 0 ? (count1 / total) * 100 : 0,
  ];

  const sorted: MatchPlayerResult[] = players
    .map((player) => ({
      id: player.id,
      team: player.team,
      paintCells: finiteOrZero(player.paintCells),
      kills: finiteOrZero(player.kills),
      deaths: finiteOrZero(player.deaths),
    }))
    .sort((a: MatchPlayerResult, b: MatchPlayerResult) => {
      const left: EntityId = Number.isFinite(a.id) ? a.id : 0;
      const right: EntityId = Number.isFinite(b.id) ? b.id : 0;
      return left - right;
    });

  return {
    winner: raw0 === raw1 ? null : raw0 > raw1 ? 0 : 1,
    ratio,
    players: sorted,
  };
}
