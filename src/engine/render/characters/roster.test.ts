import { describe, expect, it } from 'vitest';
import { assignCharacters, CHARACTER_IDS, DEFAULT_CHARACTER_ID, isCharacterId } from './roster';

describe('assignCharacters', () => {
  const ids = [0, 1, 2, 3, 4, 5, 6, 7];

  it('keeps the local pick and gives everyone a different character', () => {
    const map = assignCharacters(ids, 0, 'mame', 42);
    expect(map.get(0)).toBe('mame');
    expect(new Set(map.values()).size).toBe(8);
    for (const value of map.values()) expect(CHARACTER_IDS).toContain(value);
  });

  it('is deterministic for a seed and varies across seeds', () => {
    expect([...assignCharacters(ids, 3, 'gonta', 7)]).toEqual([...assignCharacters(ids, 3, 'gonta', 7)]);
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) seen.add(JSON.stringify([...assignCharacters(ids, 0, 'hayate', seed)]));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('falls back to the default for unknown picks and bad seeds', () => {
    const map = assignCharacters(ids, 0, '<script>', Number.NaN);
    expect(map.get(0)).toBe(DEFAULT_CHARACTER_ID);
    expect(isCharacterId('gen-san')).toBe(true);
    expect(isCharacterId('nope')).toBe(false);
  });
});
