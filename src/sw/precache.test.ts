import { describe, expect, it } from 'vitest';
import iconSvg from '../../public/icon.svg?raw';
import manifestRaw from '../../public/manifest.webmanifest?raw';
import {
  SW_TEMPLATE,
  buildServiceWorker,
  collectPrecacheEntries,
  emitServiceWorker,
  hashFileList,
  sha256Hex,
  swPlugin,
  type BundleFileLike,
  type PrecacheEntry,
} from './precache';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const VERSION = 'v1-7c9e';
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function namesOf(entries: readonly PrecacheEntry[]): string[] {
  return entries.map((entry) => entry.fileName);
}

function digestOf(entries: readonly PrecacheEntry[], fileName: string): string | undefined {
  return entries.find((entry) => entry.fileName === fileName)?.digest;
}

const SAMPLE_BUNDLE: Record<string, BundleFileLike> = {
  'assets/main.js': { type: 'chunk', code: 'console' },
  'assets/icon.svg': { type: 'asset', source: '<svg></svg>' },
  'assets/blob.bin': { type: 'asset', source: new Uint8Array([1, 2, 3, 4]) },
  'index.html': { type: 'asset', source: '<!doctype html>' },
};

describe('sha256Hex', () => {
  it('matches the known SHA-256 vectors for an empty body and "abc"', async () => {
    await expect(sha256Hex(encoder.encode(''))).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    await expect(sha256Hex(encoder.encode('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes only the visible bytes of a subarray, leaving the source intact', async () => {
    const buffer = encoder.encode('xabcx');
    const view = buffer.subarray(1, 4);

    await expect(sha256Hex(view)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(Array.from(buffer)).toEqual(Array.from(encoder.encode('xabcx')));
  });

  it('changes when a single byte changes', async () => {
    const first = await sha256Hex(new Uint8Array([1, 2, 3]));
    const second = await sha256Hex(new Uint8Array([1, 2, 4]));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('collectPrecacheEntries', () => {
  it('gives every digestible bundle file exactly one hex digest', async () => {
    const entries = await collectPrecacheEntries(SAMPLE_BUNDLE);

    expect(namesOf(entries)).toEqual([
      'assets/blob.bin',
      'assets/icon.svg',
      'assets/main.js',
      'index.html',
    ]);
    for (const entry of entries) {
      expect(entry.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.digest).toHaveLength(64);
    }
    expect(new Set(entries.map((entry) => entry.fileName)).size).toBe(entries.length);
  });

  it('computes digests over chunk code, text assets, and binary assets', async () => {
    const entries = await collectPrecacheEntries(SAMPLE_BUNDLE);

    await expect(Promise.resolve(digestOf(entries, 'assets/main.js'))).resolves.toBe(
      await sha256Hex(encoder.encode('console')),
    );
    expect(digestOf(entries, 'assets/icon.svg')).toBe(
      await sha256Hex(encoder.encode('<svg></svg>')),
    );
    expect(digestOf(entries, 'assets/blob.bin')).toBe(
      await sha256Hex(new Uint8Array([1, 2, 3, 4])),
    );
  });

  it('does not invent public files: only bundle entries are precached', async () => {
    const entries = await collectPrecacheEntries({
      'assets/main.js': { type: 'chunk', code: 'console' },
      'index.html': { type: 'asset', source: '<!doctype html>' },
    });

    expect(namesOf(entries)).toEqual(['assets/main.js', 'index.html']);
    expect(namesOf(entries)).not.toContain('manifest.webmanifest');
    expect(namesOf(entries)).not.toContain('icon.svg');
  });

  it('drops unsafe paths, entries without a body, and prototype keys', async () => {
    const entries = await collectPrecacheEntries({
      '/etc/passwd': { type: 'asset', source: 'root' },
      '../secret.txt': { type: 'asset', source: 'secret' },
      'a:b.js': { type: 'asset', source: 'protocol' },
      'https://evil.test/x.js': { type: 'asset', source: 'evil' },
      '__proto__/x.js': { type: 'asset', source: 'proto' },
      'constructor/y.js': { type: 'asset', source: 'ctor' },
      'empty.js': { type: 'asset' },
      'assets/ok.js': { type: 'asset', source: 'ok' },
    });

    expect(namesOf(entries)).toEqual(['assets/ok.js']);
  });

  it('produces a different digest when the body changes', async () => {
    const before = await collectPrecacheEntries({ 'a.js': { type: 'asset', source: 'one' } });
    const after = await collectPrecacheEntries({ 'a.js': { type: 'asset', source: 'two' } });

    expect(digestOf(before, 'a.js')).not.toBe(digestOf(after, 'a.js'));
  });
});

describe('buildServiceWorker', () => {
  const entries: PrecacheEntry[] = [
    { fileName: 'assets/main-4f2a.js', digest: DIGEST_A },
    { fileName: 'index.html', digest: DIGEST_B },
  ];

  it('embeds the version, every path, and every digest', () => {
    const source = buildServiceWorker(entries, VERSION);

    expect(source).toContain(JSON.stringify(VERSION));
    expect(source).toContain('paint-rush-');
    for (const entry of entries) {
      expect(source).toContain(entry.fileName);
      expect(source).toContain(entry.digest);
    }
  });

  it('verifies fetched bodies before cache.put on the install path', () => {
    const guard = SW_TEMPLATE.indexOf('precache integrity check failed');
    const put = SW_TEMPLATE.indexOf('cache.put(url, response)');

    expect(SW_TEMPLATE).toContain("crypto.subtle.digest('SHA-256'");
    expect(SW_TEMPLATE).toContain('digestResponse(response)');
    expect(SW_TEMPLATE).toContain('actual !== expected');
    expect(guard).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(guard);
    expect(SW_TEMPLATE).toContain('await caches.delete(CACHE_NAME)');
  });

  it('verifies cached bodies on the read path and deletes mismatches', () => {
    expect(SW_TEMPLATE).toContain('digestResponse(cached)');
    expect(SW_TEMPLATE).toContain('(await digestResponse(cached)) === expected');
    expect(SW_TEMPLATE).toContain('cache.delete(key)');
    expect(SW_TEMPLATE).toContain('readVerified(path)');
    expect(SW_TEMPLATE).toContain("readVerified('index.html')");
  });

  it('never stores an unverified network body on the read path', () => {
    const refresh = SW_TEMPLATE.indexOf('async function refreshVerified');
    const check = SW_TEMPLATE.indexOf('(await digestResponse(response)) !== expected');
    const store = SW_TEMPLATE.indexOf('cache.put(scopedUrl(path), response.clone())');

    expect(refresh).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(refresh);
    expect(store).toBeGreaterThan(check);
  });

  it('describes install, activate, and same-origin cache-first fetching', () => {
    const source = buildServiceWorker(entries, VERSION);

    expect(source).toContain("addEventListener('install'");
    expect(source).toContain("addEventListener('activate'");
    expect(source).toContain("addEventListener('fetch'");
    expect(source).toContain('caches.open(CACHE_NAME)');
    expect(source).toContain('skipWaiting');
    expect(source).toContain('clients.claim');
    expect(source).toContain('caches.delete');
    expect(source).toContain('caches.keys');
    expect(source).toContain("request.method !== 'GET'");
    expect(source).toContain("request.mode === 'navigate'");
    expect(source).toContain('respondWith');
    expect(source).toContain('scope.pathname');
  });

  it('has no importScripts, external URLs, or message handlers', () => {
    const source = buildServiceWorker(entries, VERSION);

    expect(source).not.toContain('importScripts');
    expect(source).not.toContain('http:');
    expect(source).not.toContain('https:');
    expect(source).not.toContain('//evil.test');
    expect(source).not.toContain("addEventListener('message'");
    expect(source).not.toContain('postMessage');
  });

  it('rejects unsafe paths and malformed digests instead of embedding them', () => {
    const source = buildServiceWorker(
      [
        { fileName: 'assets/ok.js', digest: DIGEST_A },
        { fileName: '/etc/passwd', digest: DIGEST_B },
        { fileName: '../secret.txt', digest: DIGEST_B },
        { fileName: 'a:b.js', digest: DIGEST_B },
        { fileName: 'assets/bad.js', digest: 'not-a-digest' },
      ],
      VERSION,
    );

    expect(source).toContain('assets/ok.js');
    expect(source).not.toContain('passwd');
    expect(source).not.toContain('secret.txt');
    expect(source).not.toContain('a:b.js');
    expect(source).not.toContain('not-a-digest');
  });

  it('escapes an unusual version instead of injecting it raw', () => {
    const tricky = 'v"1\n2';
    const source = buildServiceWorker([{ fileName: 'index.html', digest: DIGEST_A }], tricky);

    expect(source).toContain(JSON.stringify(tricky));
    expect(source).not.toContain(tricky);
  });

  it('keeps SW_TEMPLATE free of protocol literals', () => {
    expect(typeof SW_TEMPLATE).toBe('string');
    expect(SW_TEMPLATE).not.toContain('importScripts');
    expect(SW_TEMPLATE).not.toContain('http:');
    expect(SW_TEMPLATE).not.toContain('https:');
  });
});

describe('hashFileList', () => {
  const entries: PrecacheEntry[] = [
    { fileName: 'assets/b.js', digest: DIGEST_B },
    { fileName: 'assets/a.js', digest: DIGEST_A },
  ];

  it('is stable across input order and uses sorted names', () => {
    const forward = hashFileList(entries);
    const backward = hashFileList([...entries].reverse());

    expect(forward).toBe(backward);
    expect(forward).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changes when a name or a digest changes', () => {
    const base = hashFileList(entries);

    expect(
      hashFileList([
        { fileName: 'assets/a.js', digest: 'c'.repeat(64) },
        { fileName: 'assets/b.js', digest: DIGEST_B },
      ]),
    ).not.toBe(base);
    expect(
      hashFileList([
        { fileName: 'assets/a.js', digest: DIGEST_A },
        { fileName: 'assets/c.js', digest: DIGEST_B },
      ]),
    ).not.toBe(base);
  });

  it('ignores malformed digests and unsafe names', () => {
    expect(hashFileList([{ fileName: 'assets/a.js', digest: DIGEST_A }])).toBe(
      hashFileList([
        { fileName: 'assets/a.js', digest: DIGEST_A },
        { fileName: 'assets/bad.js', digest: 'nope' },
        { fileName: '../x.js', digest: DIGEST_B },
      ]),
    );
  });
});

describe('emitServiceWorker', () => {
  it('emits one sw.js asset with digests only for bundle entries', async () => {
    const emitted: { fileName: string; source: string }[] = [];
    await emitServiceWorker(
      {
        emitFile(file) {
          emitted.push({ fileName: file.fileName, source: file.source });
        },
      },
      SAMPLE_BUNDLE,
    );

    expect(emitted).toHaveLength(1);
    const asset = emitted[0];
    expect(asset?.fileName).toBe('sw.js');
    const source = asset?.source ?? '';
    const entries = await collectPrecacheEntries(SAMPLE_BUNDLE);

    expect(source).toContain(hashFileList(entries));
    for (const entry of entries) {
      expect(source).toContain(entry.fileName);
      expect(source).toContain(entry.digest);
    }
    expect(source).not.toContain('manifest.webmanifest');
    expect(source).not.toContain('importScripts');
  });

  it('rotates the version when a body changes', async () => {
    const capture = async (source: string): Promise<string> => {
      const emitted: string[] = [];
      await emitServiceWorker(
        {
          emitFile(file) {
            emitted.push(file.source);
          },
        },
        { 'index.html': { type: 'asset', source } },
      );
      return emitted[0] ?? '';
    };

    expect(await capture('<!doctype html>')).not.toBe(await capture('<!doctype html two>'));
  });
});

describe('swPlugin', () => {
  it('runs after index.html is emitted and writes a digest-bearing sw.js', async () => {
    const plugin = swPlugin();
    expect(plugin.name).toBe('paint-rush-sw');
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('post');
    expect(typeof plugin.generateBundle).toBe('function');

    const hook = plugin.generateBundle;
    if (typeof hook !== 'function') throw new Error('generateBundle must be a function');

    const bundle: Record<string, BundleFileLike> = {
      'assets/main.js': { type: 'chunk', code: 'console' },
      'index.html': { type: 'asset', source: '<!doctype html>' },
    };
    const emitted: { fileName: string; source: string }[] = [];
    const context = {
      emitFile(file: { fileName: string; source: string }) {
        emitted.push({ fileName: file.fileName, source: file.source });
      },
    };

    await hook.call(context as never, { dir: 'dist' } as never, bundle as never, false);

    expect(emitted).toHaveLength(1);
    const source = emitted[0]?.source ?? '';
    const entries = await collectPrecacheEntries(bundle);

    expect(emitted[0]?.fileName).toBe('sw.js');
    expect(source).toContain('index.html');
    expect(source).toContain('assets/main.js');
    expect(source).toContain(hashFileList(entries));
    for (const entry of entries) expect(source).toContain(entry.digest);
    expect(source).not.toContain('manifest.webmanifest');
  });
});

describe('public assets', () => {
  it('ships an icon without scripts or links', () => {
    expect(iconSvg).toContain('<svg');
    expect(iconSvg).not.toMatch(/<script/i);
    expect(iconSvg).not.toMatch(/\bhref\s*=/i);
    expect(iconSvg).toContain('#FF8AB8');
    expect(iconSvg).toContain('#1FB9B0');
  });

  it('ships a manifest with the required install fields', () => {
    const manifest: unknown = JSON.parse(manifestRaw);
    expect(isRecord(manifest)).toBe(true);
    if (!isRecord(manifest)) throw new Error('manifest must be an object');

    expect(manifest.name).toBe('ペイントラッシュ！');
    expect(manifest.short_name).toBe('ペイントラッシュ');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.display).toBe('fullscreen');
    expect(manifest.orientation).toBe('landscape');
    expect(manifest.background_color).toBe('#FFC46B');
    expect(manifest.theme_color).toBe('#FF8AB8');

    const icons = manifest.icons;
    expect(Array.isArray(icons)).toBe(true);
    if (!Array.isArray(icons)) throw new Error('icons must be an array');
    const icon = icons[0];
    expect(isRecord(icon)).toBe(true);
    if (!isRecord(icon)) throw new Error('icon must be an object');

    expect(icon.src).toBe('icon.svg');
    expect(icon.type).toBe('image/svg+xml');
    expect(icon.sizes).toBe('any');
    expect(icon.purpose).toBe('any');
  });

  it('is not part of the precache list', async () => {
    const entries = await collectPrecacheEntries(SAMPLE_BUNDLE);
    expect(namesOf(entries)).not.toContain('manifest.webmanifest');
    expect(namesOf(entries)).not.toContain('icon.svg');
  });
});
