/** Roster order shown on the select screen. Ids match CharacterDef.id. */
export const CHARACTER_IDS = [
  'hayate',
  'komomo',
  'gonta',
  'kasane',
  'nyanta',
  'kerosuke',
  'kuroha',
  'zenmai',
  'mame',
  'gen-san',
] as const;

export type CharacterId = (typeof CHARACTER_IDS)[number];

export const DEFAULT_CHARACTER_ID: CharacterId = 'hayate';

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === 'string' && (CHARACTER_IDS as readonly string[]).includes(value);
}

/**
 * Gives every player in a match a different character. The local player keeps
 * their pick; the others take the rest of the roster in an order fixed by seed.
 * Pure and deterministic; never returns an id outside the roster.
 */
export function assignCharacters(
  playerIds: readonly number[],
  localId: number,
  localPick: string | undefined,
  seed: number,
): Map<number, CharacterId> {
  const pick: CharacterId = isCharacterId(localPick) ? localPick : DEFAULT_CHARACTER_ID;
  const rest: CharacterId[] = CHARACTER_IDS.filter((id) => id !== pick);
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  for (let i = rest.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const tmp = rest[i] as CharacterId;
    rest[i] = rest[j] as CharacterId;
    rest[j] = tmp;
  }
  const out = new Map<number, CharacterId>();
  let next = 0;
  for (const id of playerIds) {
    if (id === localId) {
      out.set(id, pick);
    } else {
      out.set(id, rest[next % rest.length] as CharacterId);
      next++;
    }
  }
  return out;
}
