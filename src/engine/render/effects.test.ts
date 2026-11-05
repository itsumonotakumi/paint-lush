import { InstancedMesh, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import type { WorldSnapshot } from '../../core/snapshot';
import type { EffectsModule } from './module';
import { BOMB_DROPLETS, BOMB_SMOKE, CHARGE_DROPLETS, SWING_DROPLETS } from './particles';
import { createEffects } from './effects';
import { createToonGradient } from './toon';

const LOCAL_ID = 7;

function emptySnapshot(): WorldSnapshot {
  return {
    tick: 0,
    players: [],
    projectiles: [],
    bombs: [],
    phase: 'play',
    timeLeft: 60,
    counts: [0, 0],
  };
}

function makeEffects(): { effects: EffectsModule; scene: Scene; gradient: ReturnType<typeof createToonGradient> } {
  const scene = new Scene();
  const gradient = createToonGradient();
  const effects = createEffects({
    scene,
    teamColors: [0xff2e88, 0x19e6d0],
    gradient,
    localPlayerId: LOCAL_ID,
    lowDetail: false,
  });
  return { effects, scene, gradient };
}

function instanceCounts(scene: Scene): number[] {
  const counts: number[] = [];
  scene.traverse((object) => {
    if (object instanceof InstancedMesh) counts.push(object.count);
  });
  return counts.sort((a, b) => a - b);
}

describe('special camera boost', () => {
  it('boosts the field of view only for the local player', () => {
    const { effects, scene, gradient } = makeEffects();
    const snapshot = emptySnapshot();

    effects.handle?.({ t: 'special', id: LOCAL_ID + 1, phase: 'start' });
    effects.update(0.3, snapshot, snapshot, 0);
    expect(effects.fovBoost()).toBe(0);

    effects.handle?.({ t: 'special', id: LOCAL_ID, phase: 'start' });
    effects.update(0.3, snapshot, snapshot, 0);
    expect(effects.fovBoost()).toBeGreaterThan(0);

    effects.handle?.({ t: 'special', id: LOCAL_ID, phase: 'end' });
    effects.update(0.3, snapshot, snapshot, 0);
    expect(effects.fovBoost()).toBeCloseTo(0, 6);

    effects.dispose();
    gradient.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

describe('small combat effects', () => {
  it('throws 24 droplets and six smoke puffs on a bomb burst', () => {
    const { effects, scene, gradient } = makeEffects();
    const snapshot = emptySnapshot();

    effects.handle?.({ t: 'sub', phase: 'burst', team: 0, pos: { x: 1, y: 2, z: 3 } });
    effects.update(1 / 60, snapshot, snapshot, 0);

    const counts = instanceCounts(scene);
    expect(counts).toContain(BOMB_DROPLETS);
    expect(counts).toContain(BOMB_SMOKE);

    effects.dispose();
    gradient.dispose();
  });

  it('adds a few sparks on charge and swing events', () => {
    const { effects, scene, gradient } = makeEffects();
    const snapshot = emptySnapshot();

    effects.handle?.({ t: 'charge', id: LOCAL_ID, level: 2 });
    effects.update(1 / 60, snapshot, snapshot, 0);
    expect(instanceCounts(scene)).toContain(CHARGE_DROPLETS);

    effects.handle?.({ t: 'swing', id: LOCAL_ID, pos: { x: 0, y: 0, z: 0 } });
    effects.update(1 / 60, snapshot, snapshot, 0);
    expect(instanceCounts(scene)).toContain(CHARGE_DROPLETS + SWING_DROPLETS);

    effects.dispose();
    gradient.dispose();
  });
});
