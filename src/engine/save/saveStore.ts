import { saveDataSchema, type SaveData } from '../../game/data/schemas';
import type { ISaveStore } from '../ports';

/** Key used in `localStorage` (or any compatible storage). */
export const SAVE_KEY = 'paintrush.save';

/** Hard cap on the serialised payload, in UTF-8 bytes. */
export const MAX_SAVE_BYTES = 65536;

/** Current schema version. Older payloads are upgraded by `migrate`. */
const CURRENT_VERSION = 1;

/**
 * Fresh defaults for a brand-new player. A new object is returned on every
 * call so callers cannot mutate a shared singleton.
 */
export function defaultSave(): SaveData {
  return {
    version: CURRENT_VERSION,
    settings: {
      volume: { bgm: 0.8, se: 0.8, voice: 0.8 },
      mouseSensitivity: 0.001745,
      stickSensitivity: 2.094,
      invertY: false,
      keys: {
        forward: 'KeyW',
        back: 'KeyS',
        left: 'KeyA',
        right: 'KeyD',
        fire: 'Mouse0',
        jump: 'Space',
        dive: 'ShiftLeft',
        sub: 'KeyE',
        special: 'KeyQ',
        pause: 'Escape',
      },
    },
  };
}

type UnknownRecord = Record<string, unknown>;

/** Upgrade step: takes the raw payload of one version and returns the next. */
type Migration = (value: UnknownRecord) => unknown;

/**
 * Migration chain keyed by the payload's `version`. Version 1 is the current
 * schema, so its step is the identity; unknown versions have no step and are
 * rejected instead of guessed at.
 */
const migrations: Readonly<Record<number, Migration>> = {
  1: (value) => value,
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Applies the migration chain. Returns null for anything that is not a
 * versioned object with a known version.
 */
function migrate(value: unknown): unknown {
  if (!isRecord(value) || !hasOwn(value, 'version')) return null;
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) return null;
  const step = migrations[version];
  return step === undefined ? null : step(value);
}

/** UTF-8 byte length without relying on TextEncoder or any browser global. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        // A lone high surrogate is encoded as the 3-byte replacement char.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Creates a save store over any `getItem`/`setItem` pair (usually
 * `localStorage`). A null storage gives a store that is safe but inert:
 * `load` returns defaults and `save` always fails.
 */
export function createSaveStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null): ISaveStore {
  const load = (): SaveData => {
    try {
      if (storage === null) return defaultSave();
      const raw = storage.getItem(SAVE_KEY);
      if (typeof raw !== 'string') return defaultSave();
      if (utf8ByteLength(raw) > MAX_SAVE_BYTES) return defaultSave();
      const parsed: unknown = JSON.parse(raw);
      const migrated = migrate(parsed);
      if (migrated === null) return defaultSave();
      const result = saveDataSchema.safeParse(migrated);
      return result.success ? result.data : defaultSave();
    } catch {
      return defaultSave();
    }
  };

  const save = (data: SaveData): boolean => {
    if (storage === null) return false;
    try {
      const result = saveDataSchema.safeParse(data);
      if (!result.success) return false;
      const serialised: unknown = JSON.stringify(result.data);
      if (typeof serialised !== 'string') return false;
      if (utf8ByteLength(serialised) > MAX_SAVE_BYTES) return false;
      storage.setItem(SAVE_KEY, serialised);
      return true;
    } catch {
      return false;
    }
  };

  return { load, save };
}
