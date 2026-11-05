import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../core/types';
import { parseStage } from './load';
import { lintStage } from './stageLint';

const PLAYER_HALF: Vec3 = { x: 0.3, y: 0.8, z: 0.3 };
const KARAKURI_URL = '../../data/stages/karakuri-port.json';
const KARAKURI_FILE = fileURLToPath(new URL(KARAKURI_URL, import.meta.url));

/** The second stage is owned by another worker, so it is loaded only once it exists. */
async function loadKarakuri(): Promise<unknown> {
  if (!existsSync(KARAKURI_FILE)) return null;
  const module = (await import(/* @vite-ignore */ KARAKURI_URL)) as { default?: unknown };
  return module.default ?? null;
}

describe('karakuri-port stage', () => {
  it('passes the stage lint when the stage file exists', async () => {
    const json = await loadKarakuri();
    if (json === null) {
      expect(existsSync(KARAKURI_FILE)).toBe(false);
      return;
    }

    const stage = parseStage(json);
    expect(lintStage(stage, PLAYER_HALF)).toEqual([]);
  });
});
