import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { saveDataSchema } from '../../game/data/schemas';
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

describe('save constants', () => {
  it('exposes the documented key and size cap', () => {
    expect(SAVE_KEY).toBe('paintrush.save');
    expect(MAX_SAVE_BYTES).toBe(65536);
  });
});

describe('defaultSave', () => {
  it('matches the documented defaults and passes the schema', () => {
    const data = defaultSave();
    expect(saveDataSchema.safeParse(data).success).toBe(true);
    expect(data.version).toBe(1);
    expect(data.settings.volume).toEqual({ bgm: 0.8, se: 0.8, voice: 0.8 });
    expect(data.settings.mouseSensitivity).toBe(0.001745);
    expect(data.settings.stickSensitivity).toBe(2.094);
    expect(data.settings.invertY).toBe(false);
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
  });

  it('returns a fresh object every call', () => {
    const first = defaultSave();
    first.settings.volume.bgm = 0;
    expect(defaultSave().settings.volume.bgm).toBe(0.8);
  });
});

describe('round trip', () => {
  it('saves and loads a custom payload unchanged', () => {
    const storage = new FakeStorage();
    const store = createSaveStore(storage);
    const data = defaultSave();
    data.settings.volume = { bgm: 0.42, se: 0.11, voice: 1 };
    data.settings.mouseSensitivity = 0.02;
    data.settings.stickSensitivity = 7.5;
    data.settings.invertY = true;
    data.settings.keys.fire = 'Mouse2';
    data.settings.keys.pause = 'Enter';

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
    const { store } = storeWith('{"version":1,');
    expect(store.load()).toEqual(defaultSave());
  });

  it('falls back to defaults for oversized payloads', () => {
    const { store } = storeWith('x'.repeat(MAX_SAVE_BYTES + 1));
    expect(store.load()).toEqual(defaultSave());
  });

  it('falls back to defaults for unknown or malformed versions', () => {
    const base = defaultSave();
    const payloads = [
      JSON.stringify({ ...base, version: 2 }),
      JSON.stringify({ ...base, version: 0 }),
      JSON.stringify({ ...base, version: '1' }),
      JSON.stringify({ ...base, version: 1.5 }),
      JSON.stringify({ settings: base.settings }),
    ];
    for (const raw of payloads) {
      const { store } = storeWith(raw);
      expect(store.load(), raw).toEqual(defaultSave());
    }
  });

  it('falls back to defaults when an unknown key is present', () => {
    const base = defaultSave();
    const payloads = [
      JSON.stringify({ ...base, extra: true }),
      JSON.stringify({ ...base, settings: { ...base.settings, extra: true } }),
      JSON.stringify({ ...base, settings: { ...base.settings, volume: { ...base.settings.volume, extra: 1 } } }),
      JSON.stringify({ ...base, settings: { ...base.settings, keys: { ...base.settings.keys, extra: 'KeyZ' } } }),
    ];
    for (const raw of payloads) {
      const { store } = storeWith(raw);
      expect(store.load(), raw).toEqual(defaultSave());
    }
  });

  it('rejects schema violations without trusting parsed JSON', () => {
    const base = defaultSave();
    const payloads = [
      JSON.stringify({ ...base, settings: { ...base.settings, volume: { ...base.settings.volume, bgm: 2 } } }),
      JSON.stringify({ ...base, settings: { ...base.settings, mouseSensitivity: -1 } }),
      JSON.stringify({ ...base, settings: { ...base.settings, invertY: 'yes' } }),
      JSON.stringify({ ...base, settings: { ...base.settings, keys: { ...base.settings.keys, dive: 'F13' } } }),
      JSON.stringify({ version: 1, settings: { volume: base.settings.volume } }),
    ];
    for (const raw of payloads) {
      const { store } = storeWith(raw);
      expect(store.load(), raw).toEqual(defaultSave());
    }
  });

  it('resists a __proto__ prototype pollution attempt', () => {
    const base = JSON.stringify(defaultSave());
    const polluted = base
      .replace('{"version":1', '{"__proto__":{"polluted":true},"version":1')
      .replace('"settings":{', '"settings":{"__proto__":{"polluted":true},')
      .replace('"volume":{', '"volume":{"__proto__":{"polluted":true},')
      .replace('"keys":{', '"keys":{"__proto__":{"polluted":true},');

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
});
