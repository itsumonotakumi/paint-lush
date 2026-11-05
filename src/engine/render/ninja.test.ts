import { Mesh, MeshToonMaterial, Object3D, Scene } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlayerView, WorldSnapshot } from '../../core/snapshot';
import type { GameEvent } from '../../core/events';
import { createNinjas } from './ninja';
import { PALETTE } from './palette';
import { createToonGradient } from './toon';
import type { RenderModule } from './module';

function snapshot(players: PlayerView[]): WorldSnapshot {
  return { tick: 0, players, projectiles: [], counts: [0, 0] };
}

function player(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    id: 1,
    team: 0,
    state: 'stance',
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    ink: 100,
    ...overrides,
  };
}

function groupsIn(scene: Scene): Object3D[] {
  return scene.children.filter((child) => child.type === 'Group');
}

function garbFlash(group: Object3D): number {
  let hex = -1;
  group.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.material instanceof MeshToonMaterial && mesh.material.color.getHex() === PALETTE.garb) {
      hex = mesh.material.emissive.getHex();
    }
  });
  return hex;
}

describe('ninja render module', () => {
  let scene: Scene;
  let gradient: ReturnType<typeof createToonGradient>;
  let sentinel: Object3D;
  let module: RenderModule;

  beforeEach(() => {
    scene = new Scene();
    gradient = createToonGradient();
    sentinel = new Object3D();
    scene.add(sentinel);
    module = createNinjas({
      scene,
      teamColors: [0x2e5bbf, 0xd93a4a],
      gradient,
      localPlayerId: 1,
      lowDetail: false,
    });
  });

  it('draws one group per player and leaves other scene objects alone', () => {
    module.update(1 / 60, snapshot([]), snapshot([]), 0);
    expect(scene.children).toContain(sentinel);
    expect(groupsIn(scene)).toHaveLength(0);

    const players = [
      player({ id: 1, pos: { x: 1, y: 2, z: 3 }, yaw: 0.5 }),
      player({ id: 2, team: 1, pos: { x: -2, y: 0, z: 1 }, yaw: -1 }),
    ];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);

    expect(scene.children).toContain(sentinel);
    const groups = groupsIn(scene);
    expect(groups).toHaveLength(2);
    expect(
      groups.some(
        (group) =>
          Math.abs(group.position.x - 1) < 1e-9 &&
          Math.abs(group.position.y - 2) < 1e-9 &&
          Math.abs(group.position.z - 3) < 1e-9 &&
          Math.abs(group.rotation.y + 0.5) < 1e-9,
      ),
    ).toBe(true);
  });

  it('interpolates by alpha but snaps across a jump over 3 m', () => {
    const start = snapshot([player({ id: 1, pos: { x: 0, y: 0, z: 0 } })]);
    module.update(1 / 60, snapshot([]), start, 0);

    const moved = snapshot([player({ id: 1, pos: { x: 2, y: 0, z: 0 } })]);
    module.update(1 / 60, start, moved, 0.5);
    let groups = groupsIn(scene);
    expect(groups.some((group) => Math.abs(group.position.x - 1) < 1e-9)).toBe(true);

    const jumped = snapshot([player({ id: 1, pos: { x: 6, y: 0, z: 0 } })]);
    module.update(1 / 60, moved, jumped, 0.5);
    groups = groupsIn(scene);
    expect(groups.some((group) => Math.abs(group.position.x - 6) < 1e-9)).toBe(true);
    expect(groups.some((group) => Math.abs(group.position.x - 4) < 1e-9)).toBe(false);
  });

  it('swaps the body for a dive blob and hides downed players', () => {
    const players = [player({ id: 1, pos: { x: 0, y: 0, z: 0 } })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);
    const group = groupsIn(scene)[0];
    if (group === undefined) throw new Error('missing ninja group');

    module.update(
      1 / 60,
      snapshot(players),
      snapshot([player({ id: 1, state: 'dive' })]),
      0,
    );
    expect(group.children[0]?.visible).toBe(false);
    expect(group.children[1]?.visible).toBe(true);

    module.update(
      1 / 60,
      snapshot([player({ id: 1, state: 'dive' })]),
      snapshot([player({ id: 1, state: 'down' })]),
      0,
    );
    expect(group.visible).toBe(false);

    module.update(
      1 / 60,
      snapshot([player({ id: 1, state: 'down' })]),
      snapshot([player({ id: 1, state: 'respawn' })]),
      0,
    );
    expect(group.visible).toBe(false);
  });

  it('flashes the garb white for 0.15 s after a hit', () => {
    const players = [player({ id: 1 })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);
    const group = groupsIn(scene)[0];
    if (group === undefined) throw new Error('missing ninja group');
    expect(garbFlash(group)).toBe(0x000000);

    const hit: GameEvent = { t: 'hit', target: 1, damage: 10, pos: { x: 0, y: 0, z: 0 } };
    module.handle?.(hit);
    module.update(0.01, snapshot(players), snapshot(players), 0);
    expect(garbFlash(group)).toBe(0xffffff);

    module.update(0.2, snapshot(players), snapshot(players), 0);
    expect(garbFlash(group)).toBe(0x000000);
  });

  it('disposes its own groups but keeps the scene and gradient usable', () => {
    const players = [player({ id: 1 }), player({ id: 2, team: 1 })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);
    expect(groupsIn(scene)).toHaveLength(2);

    module.dispose();
    expect(scene.children).toContain(sentinel);
    expect(groupsIn(scene)).toHaveLength(0);

    expect(() => module.dispose()).not.toThrow();
    module.update(0.1, snapshot(players), snapshot(players), 0);
    expect(groupsIn(scene)).toHaveLength(0);
  });
});
