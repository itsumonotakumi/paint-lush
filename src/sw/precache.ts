import type { Plugin } from 'vite';

/**
 * Source of the Paint Rush service worker.
 *
 * The cache name is shared with every other page on the origin (GitHub Pages
 * project sites share CacheStorage), so a cached body is never trusted just
 * because it is present. Every precached body is pinned to a SHA-256 digest in
 * the generated worker: install refuses a mismatched body and the read path
 * drops a poisoned entry and falls back to the network.
 *
 * The template has no third-party requests, no message channel, and no
 * importScripts. Only bundle entries are precached; files in public/ (the icon
 * and the manifest) stay on the network because they have no build-time body.
 */
export const SW_TEMPLATE = `/* Paint Rush service worker. Generated at build time. */
'use strict';

const CACHE_PREFIX = 'paint-rush-';
const VERSION = __PAINT_RUSH_VERSION__;
const CACHE_NAME = CACHE_PREFIX + VERSION;
const PRECACHE_DIGESTS = __PAINT_RUSH_DIGESTS__;
const PRECACHE_FILES = Object.keys(PRECACHE_DIGESTS);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function scopedUrl(path) {
  return new URL(path, self.registration.scope).href;
}

function expectedDigest(path) {
  if (!Object.prototype.hasOwnProperty.call(PRECACHE_DIGESTS, path)) return null;
  const digest = PRECACHE_DIGESTS[path];
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) return null;
  return digest;
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes[index].toString(16).padStart(2, '0');
  }
  return hex;
}

async function digestHex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(hash);
}

function digestResponse(response) {
  return response.clone().arrayBuffer().then(digestHex);
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  try {
    for (let index = 0; index < PRECACHE_FILES.length; index += 1) {
      const path = PRECACHE_FILES[index];
      const expected = expectedDigest(path);
      if (expected === null) throw new Error('precache entry has no digest');
      const url = scopedUrl(path);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('precache request failed');
      const actual = await digestResponse(response);
      if (actual !== expected) throw new Error('precache integrity check failed');
      await cache.put(url, response);
    }
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

async function removeOldCaches() {
  const keys = await caches.keys();
  const stale = keys.filter(function (key) {
    return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME;
  });
  await Promise.all(stale.map(function (key) {
    return caches.delete(key);
  }));
}

self.addEventListener('install', function (event) {
  event.waitUntil(precache().then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(removeOldCaches().then(function () {
    return self.clients.claim();
  }));
});

function isInScope(url) {
  if (url.origin !== self.location.origin) return false;
  const scope = new URL(self.registration.scope);
  return url.pathname.indexOf(scope.pathname) === 0;
}

function relativePath(url) {
  if (!isInScope(url)) return null;
  const scope = new URL(self.registration.scope);
  return url.pathname.slice(scope.pathname.length);
}

async function readVerified(path) {
  const expected = expectedDigest(path);
  if (expected === null) return null;
  const key = scopedUrl(path);
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(key);
  if (!cached) return null;
  let valid = false;
  try {
    valid = (await digestResponse(cached)) === expected;
  } catch (error) {
    valid = false;
  }
  if (!valid) {
    await cache.delete(key);
    return null;
  }
  return cached;
}

async function refreshVerified(path, request) {
  const response = await fetch(request);
  const expected = expectedDigest(path);
  if (expected === null || !response.ok) return response;
  try {
    if ((await digestResponse(response)) !== expected) return response;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(scopedUrl(path), response.clone());
  } catch (error) {
    return response;
  }
  return response;
}

async function cacheFirst(request) {
  const url = new URL(request.url);
  const path = relativePath(url);
  if (path !== null && expectedDigest(path) !== null) {
    const cached = await readVerified(path);
    if (cached) return cached;
    return refreshVerified(path, request);
  }
  if (request.mode === 'navigate') {
    const index = await readVerified('index.html');
    if (index) return index;
  }
  return fetch(request);
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isInScope(url)) return;
  event.respondWith(cacheFirst(request));
});
`;

const DIGESTS_TOKEN = '__PAINT_RUSH_DIGESTS__';
const VERSION_TOKEN = '__PAINT_RUSH_VERSION__';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface PrecacheEntry {
  readonly fileName: string;
  readonly digest: string;
}

/** One emitted bundle entry, narrowed to the fields the plugin reads. */
export interface BundleFileLike {
  readonly type: string;
  readonly code?: string;
  readonly source?: string | Uint8Array;
}

export interface ServiceWorkerEmitter {
  emitFile(file: { type: 'asset'; fileName: string; source: string }): void;
}

/** The small part of SubtleCrypto needed to hash a body. */
export interface SubtleLike {
  digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
}

function defaultSubtle(): SubtleLike {
  const cryptoImpl: Crypto | undefined = globalThis.crypto;
  if (cryptoImpl === undefined || cryptoImpl.subtle === undefined) {
    throw new Error('Web Crypto is required to build the service worker.');
  }
  return cryptoImpl.subtle;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hex += (bytes[index] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Lowercase SHA-256 hex digest of a byte body. The view is copied first so a
 * subarray hashes only its visible bytes and the caller's buffer is untouched.
 * Pure with respect to its inputs; `subtle` exists so tests can inject it.
 */
export async function sha256Hex(
  bytes: Uint8Array,
  subtle: SubtleLike = defaultSubtle(),
): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return toHex(await subtle.digest('SHA-256', copy));
}

/**
 * Converts a bundle path to a path relative to the service worker scope.
 * Rejects absolute paths, protocol-like names, backslashes, parent traversal
 * and prototype-sensitive segments so a generated list can never point outside
 * the app or shadow object internals.
 */
function scopedPath(file: string): string | null {
  if (file.length === 0 || file.length > 1024) return null;
  if (file.indexOf(':') !== -1) return null;
  if (file.indexOf('\\') !== -1) return null;
  const trimmed = file.indexOf('./') === 0 ? file.slice(2) : file;
  if (trimmed.length === 0) return null;
  if (trimmed.charAt(0) === '/') return null;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') return null;
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') return null;
  }
  return trimmed;
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bodyOf(file: BundleFileLike): Uint8Array | null {
  if (typeof file.code === 'string') return encodeText(file.code);
  const source = file.source;
  if (typeof source === 'string') return encodeText(source);
  if (source instanceof Uint8Array) return source;
  return null;
}

function mix(hash: number, text: string): number {
  let value = hash;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/**
 * Stable version derived from sorted file names and their digests. Because the
 * digest covers the body, any content change rotates the cache name.
 */
export function hashFileList(entries: readonly PrecacheEntry[]): string {
  const rows: { name: string; digest: string }[] = [];
  for (const entry of entries) {
    const name = scopedPath(entry.fileName);
    if (name === null) continue;
    if (!DIGEST_PATTERN.test(entry.digest)) continue;
    rows.push({ name, digest: entry.digest });
  }
  rows.sort(function (left, right) {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });

  let hash = 0x811c9dc5;
  for (const row of rows) {
    hash = mix(hash, row.name);
    hash = mix(hash, ':');
    hash = mix(hash, row.digest);
    hash = mix(hash, ';');
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Collects one entry per digestible bundle file. Only files actually present in
 * the bundle qualify: public/ files such as icon.svg and the manifest are not
 * in the bundle and therefore stay on the network.
 */
export async function collectPrecacheEntries(
  bundle: Readonly<Record<string, BundleFileLike>>,
  subtle: SubtleLike = defaultSubtle(),
): Promise<PrecacheEntry[]> {
  const bodies = new Map<string, Uint8Array>();
  for (const fileName of Object.keys(bundle).sort()) {
    const path = scopedPath(fileName);
    if (path === null) continue;
    const file = bundle[fileName];
    if (file === undefined) continue;
    const body = bodyOf(file);
    if (body === null) continue;
    bodies.set(path, body);
  }

  const entries: PrecacheEntry[] = [];
  for (const [fileName, body] of bodies) {
    entries.push({ fileName, digest: await sha256Hex(body, subtle) });
  }
  entries.sort(function (left, right) {
    if (left.fileName < right.fileName) return -1;
    if (left.fileName > right.fileName) return 1;
    return 0;
  });
  return entries;
}

/** Builds the service worker source from verified entries and a version. */
export function buildServiceWorker(
  entries: readonly PrecacheEntry[],
  version: string,
): string {
  const digests = new Map<string, string>();
  for (const entry of entries) {
    const name = scopedPath(entry.fileName);
    if (name === null) continue;
    if (!DIGEST_PATTERN.test(entry.digest)) continue;
    digests.set(name, entry.digest);
  }
  const sorted = Array.from(digests.entries()).sort(function (left, right) {
    if (left[0] < right[0]) return -1;
    if (left[0] > right[0]) return 1;
    return 0;
  });
  const map: Record<string, string> = Object.fromEntries(sorted);
  const source = JSON.stringify(map);
  const stamp = JSON.stringify(version);
  return SW_TEMPLATE.split(DIGESTS_TOKEN)
    .join(source)
    .split(VERSION_TOKEN)
    .join(stamp);
}

/** Emits sw.js through any object exposing Vite's emitFile shape. */
export async function emitServiceWorker(
  emitter: ServiceWorkerEmitter,
  bundle: Readonly<Record<string, BundleFileLike>>,
  subtle: SubtleLike = defaultSubtle(),
): Promise<void> {
  const entries = await collectPrecacheEntries(bundle, subtle);
  const version = hashFileList(entries);
  emitter.emitFile({
    type: 'asset',
    fileName: 'sw.js',
    source: buildServiceWorker(entries, version),
  });
}

/** Vite build plugin that emits the service worker next to the built app. */
export function swPlugin(): Plugin {
  return {
    name: 'paint-rush-sw',
    apply: 'build',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      await emitServiceWorker(
        {
          emitFile: (file) => {
            this.emitFile(file);
          },
        },
        bundle,
      );
    },
  };
}
