import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { saveDataSchema, saveDataV1Schema, type SaveDataV1 } from '../../game/data/schemas';
import { createSaveStore, defaultSave, MAX_SAVE_BYTES, SAVE_KEY } from './saveStore';

class FakeStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>();
  failGet = false;
  failSet = false;

  getItem(key: string): string | null {
    if (this.failGet) throw new Error('storage read blocked');
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('quota or security error');
    this.values.set(key, value);
  }
}

function storeWith(raw: string | null): { storage: FakeStorage; store: ReturnType<typeof createSaveStore> } {
  const storage = new FakeStorage();
  if (raw !== null) storage.values.set(SAVE_KEY, raw);
  return { storage, store: createSaveStore(storage) };
}

function withSettings(overrides: Record<string, unknown>): string {
  const base = defaultSave();
  return JSON.stringify({ ...base, settings: { ...base.settings, ...overrides } });
}

function withRecords(overrides: Record<string, unknown>): string {
  const base = defaultSave();
  return JSON.stringify({ ...base, records: { ...base.records, ...overrides } });
}

function withLast(overrides: Record<string, unknown>): string {
  const base = defaultSave();
  return JSON.stringify({ ...base, last: { ...base.last, ...overrides } });
}

function v1Payload(): SaveDataV1 {
  return {
    version: 1,
    settings: {
      volume: { bgm: 0.5, se: 0.4, voice: 0.3 },
      mouseSensitivity: 0.002,
      stickSensitivity: 3.5,
      invertY: true,
      keys: {
        forward: 'KeyI',
        back: 'KeyK',
        left: 'KeyJ',
        right: 'KeyL',
        fire: 'Mouse2',
        jump: 'KeyN',
        dive: 'KeyM',
        sub: 'KeyO',
        special: 'KeyP',
        pause: 'Enter',
      },
    },
  };
}

describe('save constants', () => {
  it('exposes the documented key and size cap', () => {
    expect(SAVE_KEY).toBe('paintrush.save');
    expect(MAX_SAVE_BYTES).toBe(65536);
  });
});

describe('defaultSave', () => {
  it('matches the documented version 2 defaults and passes the schema', () => {
    const data = defaultSave();
    expect(saveDataSchema.safeParse(data).success).toBe(true);
    expect(data.version).toBe(2);
    expect(data.settings.volume).toEqual({ bgm: 0.8, se: 0.8, voice: 0.8 });
    expect(data.settings.mouseSensitivity).toBe(0.001745);
    expect(data.settings.stickSensitivity).toBe(2.094);
    expect(data.settings.invertY).toBe(false);
    expect(data.settings.gyro).toBe(false);
    expect(data.settings.quality).toBe('auto');
    expect(data.settings.colorblind).toBe(false);
    expect(data.settings.touchLayout).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(data.settings.keys).toEqual({
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
    });
    expect(data.records).toEqual({ matches: 0, wins: 0, weaponUses: {}, bestPaintCells: 0 });
    expect(data.last).toEqual({
      weaponId: 'iro-shuriken',
      stageId: 'neon-town',
      difficulty: 'normal',
      durationSeconds: 180,
    });
  });

  it('returns a fresh object every call', () => {
    const first = defaultSave();
    first.settings.volume.bgm = 0;
    first.settings.touchLayout.scale = 1.5;
    first.records.weaponUses['iro-shuriken'] = 3;
    expect(defaultSave().settings.volume.bgm).toBe(0.8);
    expect(defaultSave().settings.touchLayout.scale).toBe(1);
    expect(defaultSave().records.weaponUses).toEqual({});
  });
});

describe('version 1 migration', () => {
  it('upgrades a valid v1 payload and keeps every existing setting', () => {
    const v1 = v1Payload();
    expect(saveDataV1Schema.safeParse(v1).success).toBe(true);

    const expected = defaultSave();
    expected.settings.volume = { bgm: 0.5, se: 0.4, voice: 0.3 };
    expected.settings.mouseSensitivity = 0.002;
    expected.settings.stickSensitivity = 3.5;
    expected.settings.invertY = true;
    expected.settings.keys = { ...v1.settings.keys };

    const { store } = storeWith(JSON.stringify(v1));
    expect(store.load()).toEqual(expected);
  });

  it('fills every new v2 field with its documented default', () => {
    const { store } = storeWith(JSON.stringify(v1Payload()));
    const loaded = store.load();
    expect(loaded.settings.gyro).toBe(false);
    expect(loaded.settings.quality).toBe('auto');
    expect(loaded.settings.colorblind).toBe(false);
    expect(loaded.settings.touchLayout).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(loaded.records).toEqual({ matches: 0, wins: 0, weaponUses: {}, bestPaintCells: 0 });
    expect(loaded.last).toEqual({
      weaponId: 'iro-shuriken',
      stageId: 'neon-town',
      difficulty: 'normal',
      durationSeconds: 180,
    });
  });

  it('falls back to defaults when a v1 value is out of range or invalid', () => {
    const base = v1Payload();
    const payloads = [
      JSON.stringify({ ...base, settings: { ...base.settings, volume: { bgm: 2, se: 0, voice: 0 } } }),
      JSON.stringify({ ...base, settings: { ...base.settings, mouseSensitivity: -1 } }),
      JSON.stringify({ ...base, settings: { ...base.settings, stickSensitivity: 0 } }),
      JSON.stringify({ ...base, settings: { ...base.settings, keys: { ...base.settings.keys, dive: 'F13' } } }),
      JSON.stringify({ ...base, settings: { ...base.settings, invertY: 'yes' } }),
      JSON.stringify({ ...base, settings: { ...base.settings, extra: true } }),
      JSON.stringify({ ...base, extra: true }),
    ];
    for (const raw of payloads) {
      const { store } = storeWith(raw);
      expect(store.load(), raw).toEqual(defaultSave());
    }
  });
});

describe('round trip', () => {
  it('saves and loads a custom v2 payload unchanged', () => {
    const storage = new FakeStorage();
    const store = createSaveStore(storage);
    const data = defaultSave();
    data.settings.volume = { bgm: 0.42, se: 0.11, voice: 1 };
    data.settings.mouseSensitivity = 0.02;
    data.settings.stickSensitivity = 7.5;
    data.settings.invertY = true;
    data.settings.gyro = true;
    data.settings.quality = 'high';
    data.settings.colorblind = true;
    data.settings.touchLayout = { scale: 1.2, offsetX: -0.1, offsetY: 0.2 };
    data.settings.keys.fire = 'Mouse2';
    data.settings.keys.pause = 'Enter';
    data.records = { matches: 12, wins: 7, weaponUses: { 'iro-shuriken': 9 }, bestPaintCells: 1500 };
    data.last = { weaponId: 'fude', stageId: 'neon-town', difficulty: 'hard', durationSeconds: 240 };

    expect(store.save(data)).toBe(true);
    expect(storage.values.has(SAVE_KEY)).toBe(true);
    expect(createSaveStore(storage).load()).toEqual(data);
  });

  it('loads defaults from empty storage without sharing state', () => {
    const store = createSaveStore(new FakeStorage());
    const loaded = store.load();
    expect(loaded).toEqual(defaultSave());
    loaded.settings.volume.se = 0;
    expect(store.load().settings.volume.se).toBe(0.8);
  });
});

describe('load rejection paths', () => {
  it('falls back to defaults for corrupt JSON', () => {
    const { store } = storeWith('{"version":2,');
    expect(store.load()).toEqual(defaultSave());
  });

  it('falls back to defaults for oversized payloads', () => {
    const { store } = storeWith('x'.repeat(MAX_SAVE_BYTES + 1));
    expect(store.load()).toEqual(defaultSave());
  });

  it('falls back to defaults for unknown or malformed versions', () => {
    const base = defaultSave();
    const payloads = [
      JSON.stringify({ ...base, version: 3 }),
      JSON.stringify({ ...base, version: 0 }),
      JSON.stringify({ ...base, version: '2' }),
      JSON.stringify({ ...base, version: 2.5 }),
      JSON.stringify({ settings: base.settings }),
    ];
    for (const raw of payloads) {
      const { store } = storeWith(raw);
      expect(store.load(), raw).toEqual(defaultSave());
    }
  });

  it('falls back to defaults when a v2 payload misses new fields', () => {
    const v1 = v1Payload();
    const { store } = storeWith(JSON.stringify({ ...v1, version: 2 }));
    expect(store.load()).toEqual(defaultSave());
  });

  it('falls back to defaults when an unknown key is present', () => {
    const base = defaultSave();
    const payloads = [
      JSON.stringify({ ...base, extra: true }),
      JSON.stringify({ ...base, settings: { ...base.settings, extra: true } }),
      JSON.stringify({ ...base, settings: { ...base.settings, volume: { ...base.settings.volume, extra: 1 } } }),
      JSON.stringify({ ...base, settings: { ...base.settings, keys: { ...base.settings.keys, extra: 'KeyZ' } } }),
      JSON.stringify({ ...base, records: { ...base.records, extra: 1 } }),
      JSON.stringify({ ...base, last: { ...base.last, extra: 1 } }),
    ];
    for (const raw of payloads) {
      const { store } = storeWith(raw);
      expect(store.load(), raw).toEqual(defaultSave());
    }
  });

  it('falls back to defaults for out of range v2 values', () => {
    const payloads = [
      withSettings({ volume: { bgm: 2, se: 0.8, voice: 0.8 } }),
      withSettings({ mouseSensitivity: -1 }),
      withSettings({ stickSensitivity: 0 }),
      withSettings({ invertY: 'yes' }),
      withSettings({ gyro: 'yes' }),
      withSettings({ quality: 'ultra' }),
      withSettings({ colorblind: 1 }),
      withSettings({ touchLayout: { scale: 5, offsetX: 0, offsetY: 0 } }),
      withSettings({ touchLayout: { scale: 1, offsetX: -1, offsetY: 0 } }),
      withSettings({ keys: { ...defaultSave().settings.keys, dive: 'F13' } }),
      withRecords({ matches: -1 }),
      withRecords({ wins: 1.5 }),
      withRecords({ bestPaintCells: 2_000_000_000 }),
      withLast({ durationSeconds: 10 }),
      withLast({ difficulty: 'impossible' }),
      withLast({ weaponId: 'Bad Id!' }),
    ];
    for (const raw of payloads) {
      const { store } = storeWith(raw);
      expect(store.load(), raw).toEqual(defaultSave());
    }
  });

  it('rejects hostile record keys such as __proto__ without polluting prototypes', () => {
    const payloads = [
      JSON.stringify(defaultSave()).replace('"weaponUses":{}', '"weaponUses":{"__proto__":3}'),
      JSON.stringify(defaultSave()).replace('"weaponUses":{}', '"weaponUses":{"constructor":3}'),
      JSON.stringify(defaultSave()).replace('"weaponUses":{}', '"weaponUses":{"prototype":3}'),
    ];
    for (const raw of payloads) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('expected an object');
      const records: unknown = Reflect.get(parsed, 'records');
      if (typeof records !== 'object' || records === null) throw new Error('expected records');
      expect(Object.keys(records)).toContain('weaponUses');

      const { store } = storeWith(raw);
      expect(store.load(), raw).toEqual(defaultSave());
      expect('polluted' in {}).toBe(false);
      expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
    }
  });

  it('resists a __proto__ prototype pollution attempt in every object', () => {
    const base = JSON.stringify(defaultSave());
    const polluted = base
      .replace('{"version":2', '{"__proto__":{"polluted":true},"version":2')
      .replace('"settings":{', '"settings":{"__proto__":{"polluted":true},')
      .replace('"volume":{', '"volume":{"__proto__":{"polluted":true},')
      .replace('"keys":{', '"keys":{"__proto__":{"polluted":true},')
      .replace('"records":{', '"records":{"__proto__":{"polluted":true},')
      .replace('"last":{', '"last":{"__proto__":{"polluted":true},');

    // The payload really does carry own __proto__ keys after parsing.
    const parsed: unknown = JSON.parse(polluted);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('expected an object');
    expect(Object.keys(parsed)).toContain('__proto__');

    const { store } = storeWith(polluted);
    expect(store.load()).toEqual(defaultSave());
    expect('polluted' in {}).toBe(false);
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
  });

  it('returns defaults when getItem throws', () => {
    const storage = new FakeStorage();
    storage.failGet = true;
    const store = createSaveStore(storage);
    expect(store.load()).toEqual(defaultSave());
  });
});

describe('save rejection paths', () => {
  it('validates before writing and leaves storage alone on failure', () => {
    const storage = new FakeStorage();
    const store = createSaveStore(storage);
    const bad = defaultSave();
    bad.settings.volume.se = Number.NaN;
    expect(store.save(bad)).toBe(false);

    const badKey = defaultSave();
    badKey.settings.keys.fire = 'Mouse9';
    expect(store.save(badKey)).toBe(false);

    const badQuality = defaultSave();
    Reflect.set(badQuality.settings, 'quality', 'ultra');
    expect(store.save(badQuality)).toBe(false);

    expect(storage.values.size).toBe(0);
  });

  it('refuses to write hostile record keys', () => {
    const storage = new FakeStorage();
    const store = createSaveStore(storage);

    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const hostile = defaultSave();
      Object.defineProperty(hostile.records.weaponUses, key, { value: 1, enumerable: true });
      expect(store.save(hostile), key).toBe(false);
    }

    expect(storage.values.size).toBe(0);
  });

  it('refuses to write a payload over the 64 KB cap', () => {
    const storage = new FakeStorage();
    const store = createSaveStore(storage);
    const data = defaultSave();
    for (let index = 0; index < 3000; index += 1) {
      const suffix = String(index).padStart(5, '0');
      data.records.weaponUses[`w${suffix}${'a'.repeat(25)}`] = 1;
    }

    expect(store.save(data)).toBe(false);
    expect(storage.values.size).toBe(0);
  });

  it('returns false when setItem throws', () => {
    const storage = new FakeStorage();
    storage.failSet = true;
    const store = createSaveStore(storage);
    expect(store.save(defaultSave())).toBe(false);
  });

  it('is inert with null storage', () => {
    const store = createSaveStore(null);
    expect(store.load()).toEqual(defaultSave());
    expect(store.save(defaultSave())).toBe(false);
  });
});

describe('robustness', () => {
  it('never throws and always returns schema-valid data for arbitrary stored text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const { store } = storeWith(text);
        expect(saveDataSchema.safeParse(store.load()).success).toBe(true);
      }),
    );
  });

  it('never throws for arbitrary JSON-shaped values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const { store } = storeWith(JSON.stringify(value));
        const loaded = store.load();
        expect(saveDataSchema.safeParse(loaded).success).toBe(true);
        expect(loaded.version).toBe(2);
      }),
    );
  });
});
