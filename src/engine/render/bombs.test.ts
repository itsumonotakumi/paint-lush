import { InstancedMesh, Matrix4, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import type { WorldSnapshot } from '../../core/snapshot';
import { createToonGradient } from './toon';
import {
  BOMB_CAPACITY,
  BOMB_PULSE_AMOUNT,
  BOMB_PULSE_FAST,
  BOMB_PULSE_SLOW,
  bombPulseRate,
  bombPulseScale,
  createBombs,
} from './bombs';

function snapshot(bombs: WorldSnapshot['bombs']): WorldSnapshot {
  return { tick: 0, players: [], projectiles: [], bombs, phase: 'play', timeLeft: 60, counts: [0, 0] };
}

describe('bombPulseRate', () => {
  it('speeds up as the fuse runs down', () => {
    expect(bombPulseRate(1)).toBeCloseTo(BOMB_PULSE_SLOW, 6);
    expect(bombPulseRate(0)).toBeCloseTo(BOMB_PULSE_FAST, 6);
    expect(bombPulseRate(0.5)).toBeGreaterThan(bombPulseRate(0.8));
    expect(bombPulseRate(0.5)).toBeLessThan(bombPulseRate(0.2));
  });

  it('clamps hostile fuse values', () => {
    expect(bombPulseRate(Number.NaN)).toBeCloseTo(BOMB_PULSE_FAST, 6);
    expect(bombPulseRate(Number.POSITIVE_INFINITY)).toBeCloseTo(BOMB_PULSE_FAST, 6);
    expect(bombPulseRate(-3)).toBeCloseTo(BOMB_PULSE_FAST, 6);
    expect(bombPulseRate(9)).toBeCloseTo(BOMB_PULSE_SLOW, 6);
  });
});

describe('bombPulseScale', () => {
  it('stays within the designed pulse band', () => {
    for (let fuse = 0; fuse <= 1; fuse += 0.1) {
      for (let t = 0; t < 2; t += 0.05) {
        const scale = bombPulseScale(fuse, t);
        expect(Number.isFinite(scale)).toBe(true);
        expect(scale).toBeGreaterThanOrEqual(1);
        expect(scale).toBeLessThanOrEqual(1 + BOMB_PULSE_AMOUNT + 1e-9);
      }
    }
  });

  it('is finite for broken input', () => {
    expect(Number.isFinite(bombPulseScale(Number.NaN, Number.NaN))).toBe(true);
    expect(Number.isFinite(bombPulseScale(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY))).toBe(
      true,
    );
  });
});

describe('createBombs', () => {
  it('draws one pulsing instance per bomb, capped at 32', () => {
    const scene = new Scene();
    const gradient = createToonGradient();
    const module = createBombs({
      scene,
      teamColors: [0xff2e88, 0x19e6d0],
      gradient,
      localPlayerId: 0,
      lowDetail: false,
    });

    const bombs = Array.from({ length: 40 }, (_, index) => ({
      id: index,
      team: (index % 2) as 0 | 1,
      pos: { x: index, y: 1, z: -index },
      fuse: 1 - index / 40,
    }));
    module.update(1 / 60, snapshot(bombs), snapshot(bombs), 0);

    let mesh: InstancedMesh | undefined;
    scene.traverse((object) => {
      if (object instanceof InstancedMesh) mesh = object;
    });
    if (!(mesh instanceof InstancedMesh)) throw new Error('missing bomb mesh');
    expect(mesh.count).toBe(BOMB_CAPACITY);

    module.dispose();
    gradient.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('keeps matrices finite when a bomb position is broken', () => {
    const scene = new Scene();
    const gradient = createToonGradient();
    const module = createBombs({
      scene,
      teamColors: [0xff2e88, 0x19e6d0],
      gradient,
      localPlayerId: 0,
      lowDetail: false,
    });
    const broken = [
      { id: 0, team: 0 as const, pos: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 2 }, fuse: 0.5 },
    ];
    module.update(1 / 60, snapshot(broken), snapshot(broken), 0);

    let mesh: InstancedMesh | undefined;
    scene.traverse((object) => {
      if (object instanceof InstancedMesh) mesh = object;
    });
    const matrix = new Matrix4();
    if (!(mesh instanceof InstancedMesh)) throw new Error('missing bomb mesh');
    mesh.getMatrixAt(0, matrix);
    for (const value of matrix.elements) expect(Number.isFinite(value)).toBe(true);

    module.dispose();
    gradient.dispose();
  });
});
