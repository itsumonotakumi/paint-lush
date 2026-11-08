import {
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Object3D,
  Scene,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerView, WorldSnapshot } from '../../core/snapshot';
import type { GameEvent } from '../../core/events';
import { DEFAULT_CHARACTER_ID } from './characters/roster';
import { createNinjas, weaponVisualKind } from './ninja';
import { createToonGradient } from './toon';
import type { RenderModule, RenderModuleDeps } from './module';

const cacheDisposeSpy = vi.hoisted(() => ({ dispose: vi.fn() }));

vi.mock('./characters/builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./characters/builder')>();
  return {
    ...actual,
    createCharacterCache: () => {
      const cache = actual.createCharacterCache();
      const originalDispose = cache.dispose.bind(cache);
      cache.dispose = () => {
        cacheDisposeSpy.dispose();
        originalDispose();
      };
      return cache;
    },
  };
});

const TEAM_COLORS: [number, number] = [0x2e5bbf, 0xd93a4a];

function snapshot(players: PlayerView[]): WorldSnapshot {
  return {
    tick: 0,
    players,
    projectiles: [],
    bombs: [],
    phase: 'play',
    timeLeft: 60,
    counts: [0, 0],
  };
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
    weaponId: 'iro-shuriken',
    gauge: 0,
    specialActive: false,
    charge: 0,
    kills: 0,
    ...overrides,
  };
}

function groupsIn(scene: Scene): Group[] {
  return scene.children.filter((child): child is Group => child instanceof Group);
}

function bodyOf(scene: Scene): Object3D | undefined {
  return groupsIn(scene)[0]?.children[0];
}

function maxEmissive(group: Object3D): number {
  let hex = 0;
  group.traverse((node) => {
    if (node instanceof Mesh && node.material instanceof MeshToonMaterial) {
      hex = Math.max(hex, node.material.emissive.getHex());
    }
  });
  return hex;
}

function toonHexes(group: Object3D): number[] {
  const hexes: number[] = [];
  group.traverse((node) => {
    if (node instanceof Mesh && node.material instanceof MeshToonMaterial) {
      hexes.push(node.material.color.getHex());
    }
  });
  return hexes;
}

function weaponNode(scene: Scene, role: string): Mesh | undefined {
  let found: Mesh | undefined;
  scene.traverse((node) => {
    if (found === undefined && node instanceof Mesh && node.userData.weaponRole === role) {
      found = node;
    }
  });
  return found;
}

describe('weapon visual mapping', () => {
  it('maps the three weapon ids to hand-held models', () => {
    expect(weaponVisualKind('iro-shuriken')).toBe('shuriken');
    expect(weaponVisualKind('oofude')).toBe('brush');
    expect(weaponVisualKind('naga-fukiya')).toBe('blowgun');
    expect(weaponVisualKind('mystery')).toBe('none');
  });
});

describe('ninja render module', () => {
  let scene: Scene;
  let gradient: ReturnType<typeof createToonGradient>;
  let sentinel: Object3D;
  let module: RenderModule;

  function makeModule(characterOf?: (id: number) => string): RenderModule {
    const deps: RenderModuleDeps = {
      scene,
      teamColors: TEAM_COLORS,
      gradient,
      localPlayerId: 1,
      lowDetail: false,
    };
    if (characterOf !== undefined) deps.characterOf = characterOf;
    return createNinjas(deps);
  }

  beforeEach(() => {
    scene = new Scene();
    gradient = createToonGradient();
    sentinel = new Object3D();
    scene.add(sentinel);
    module = makeModule();
  });

  afterEach(() => {
    module.dispose();
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

  it('flashes the rig white for 0.15 s after a hit', () => {
    const players = [player({ id: 1 })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);
    const body = bodyOf(scene);
    if (body === undefined) throw new Error('missing ninja body');
    expect(maxEmissive(body)).toBe(0x000000);

    const hit: GameEvent = { t: 'hit', target: 1, damage: 10, pos: { x: 0, y: 0, z: 0 } };
    module.handle?.(hit);
    module.update(0.01, snapshot(players), snapshot(players), 0);
    expect(maxEmissive(body)).toBe(0xffffff);

    module.update(0.2, snapshot(players), snapshot(players), 0);
    expect(maxEmissive(body)).toBe(0x000000);
  });

  it('hangs the matching weapon model on each ninja', () => {
    const players = [
      player({ id: 1, weaponId: 'iro-shuriken' }),
      player({ id: 2, weaponId: 'oofude' }),
      player({ id: 3, weaponId: 'naga-fukiya' }),
    ];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);

    expect(weaponNode(scene, 'shuriken')).toBeDefined();
    expect(weaponNode(scene, 'brushHead')).toBeDefined();
    expect(weaponNode(scene, 'blowgun')).toBeDefined();
  });

  it('brightens the blowgun tube with charge', () => {
    const cold = [player({ id: 1, weaponId: 'naga-fukiya', charge: 0 })];
    module.update(1 / 60, snapshot([]), snapshot(cold), 0);
    const first = weaponNode(scene, 'blowgun');
    if (!first || !(first.material instanceof MeshBasicMaterial)) throw new Error('no tube');
    const dim = first.material.color.r;

    const hot = [player({ id: 1, weaponId: 'naga-fukiya', charge: 1 })];
    module.update(1 / 60, snapshot(cold), snapshot(hot), 0);
    const second = weaponNode(scene, 'blowgun');
    if (!second || !(second.material instanceof MeshBasicMaterial)) throw new Error('no tube');
    expect(second.material.color.r).toBeGreaterThan(dim);
  });

  it('shows an eight-petal ring only while the special is active', () => {
    const idle = [player({ id: 1 })];
    module.update(1 / 60, snapshot([]), snapshot(idle), 0);
    const group = groupsIn(scene)[0];
    if (group === undefined) throw new Error('missing ninja group');
    const ring = group.children[2];
    if (ring === undefined) throw new Error('missing special ring');
    expect(ring.visible).toBe(false);
    expect(ring.children).toHaveLength(8);
    for (const petal of ring.children) {
      expect(petal instanceof Mesh).toBe(true);
      if (petal instanceof Mesh) expect(petal.material).toBeInstanceOf(MeshBasicMaterial);
    }

    const active = [player({ id: 1, specialActive: true })];
    module.update(1 / 60, snapshot(idle), snapshot(active), 0);
    expect(ring.visible).toBe(true);
  });

  it('swings the brush on a swing event and settles again', () => {
    const players = [player({ id: 1, weaponId: 'oofude' })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);
    const group = groupsIn(scene)[0];
    if (group === undefined) throw new Error('missing ninja group');

    let weapon: Object3D | null = null;
    group.traverse((node) => {
      if (node.userData.weaponKind === 'brush') weapon = node;
    });
    if (weapon === null) throw new Error('missing brush');
    const brush = weapon as Object3D;

    module.handle?.({ t: 'swing', id: 1, pos: { x: 0, y: 0, z: 0 } });
    module.update(0.08, snapshot(players), snapshot(players), 0);
    expect(Math.abs(brush.rotation.x)).toBeGreaterThan(0.1);

    module.update(0.4, snapshot(players), snapshot(players), 0);
    expect(brush.rotation.x).toBeCloseTo(0, 6);
  });

  it('builds a different rig for each roster id from characterOf', () => {
    module.dispose();
    module = makeModule((id) => (id === 1 ? 'komomo' : 'gonta'));

    const players = [player({ id: 1 }), player({ id: 2, team: 1 })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);

    const groups = groupsIn(scene);
    expect(groups).toHaveLength(2);
    const firstId = groups[0]?.children[0]?.name;
    const secondId = groups[1]?.children[0]?.name;
    expect(firstId).toBe('komomo');
    expect(secondId).toBe('gonta');
    expect(firstId).not.toBe(secondId);
  });

  it('falls back to the default character for an unknown id', () => {
    module.dispose();
    module = makeModule(() => 'not-in-the-roster');

    module.update(1 / 60, snapshot([]), snapshot([player({ id: 1 })]), 0);
    const body = bodyOf(scene);
    if (body === undefined) throw new Error('missing ninja body');
    expect(body.name).toBe(DEFAULT_CHARACTER_ID);
  });

  it('shows the hurt expression for 0.4 s after a hit and then relaxes', () => {
    const players = [player({ id: 1 })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);
    const body = bodyOf(scene);
    if (body === undefined) throw new Error('missing ninja body');
    const mouthO = body.getObjectByName('mouth-o');
    if (mouthO === undefined) throw new Error('missing hurt mouth');
    expect(mouthO.visible).toBe(false);

    module.handle?.({ t: 'hit', target: 1, damage: 10, pos: { x: 0, y: 0, z: 0 } });
    module.update(0.1, snapshot(players), snapshot(players), 0);
    expect(mouthO.visible).toBe(true);

    module.update(0.5, snapshot(players), snapshot(players), 0);
    expect(mouthO.visible).toBe(false);
  });

  it('shows the happy expression for 0.6 s after scoring a kill', () => {
    const players = [player({ id: 1 }), player({ id: 2, team: 1 })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);
    const body = bodyOf(scene);
    if (body === undefined) throw new Error('missing ninja body');
    const mouthWide = body.getObjectByName('mouth-wide');
    if (mouthWide === undefined) throw new Error('missing happy mouth');
    expect(mouthWide.visible).toBe(false);

    module.handle?.({
      t: 'kill',
      killer: 1,
      victim: 2,
      pos: { x: 0, y: 0, z: 0 },
    });
    module.update(0.1, snapshot(players), snapshot(players), 0);
    expect(mouthWide.visible).toBe(true);

    module.update(0.7, snapshot(players), snapshot(players), 0);
    expect(mouthWide.visible).toBe(false);
  });

  it('recolours the rig team meshes when a player switches team', () => {
    const players = [player({ id: 1, team: 0, weaponId: 'none' })];
    module.update(1 / 60, snapshot([]), snapshot(players), 0);
    const body = bodyOf(scene);
    if (body === undefined) throw new Error('missing ninja body');
    expect(toonHexes(body)).toContain(TEAM_COLORS[0]);

    const switched = [player({ id: 1, team: 1, weaponId: 'none' })];
    module.update(1 / 60, snapshot(players), snapshot(switched), 0);
    const hexes = toonHexes(body);
    expect(hexes).toContain(TEAM_COLORS[1]);
    expect(hexes).not.toContain(TEAM_COLORS[0]);
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

  it('disposes the shared character cache when the module is disposed', () => {
    module.dispose();
    cacheDisposeSpy.dispose.mockClear();

    module = makeModule();
    module.update(1 / 60, snapshot([]), snapshot([player({ id: 1 })]), 0);
    module.dispose();
    expect(cacheDisposeSpy.dispose).toHaveBeenCalledTimes(1);
  });
});
