import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import type { Box, CellValue, Face, SurfaceId, SurfaceHit, TeamId, Vec3 } from '../../core/types';
import { NO_TEAM } from '../../core/types';
import type {
  ICollision,
  IPaintGrid,
  IWeaponSystem,
  MoveResult,
  ShooterState,
  SurfaceGrid,
  TargetState,
} from '../contracts';
import type { StageData, Weapon } from '../data/schemas';
import { createCollision } from '../physics/collision';
import { createWeaponSystem } from './weaponSystem';

const EPS = 1e-9;

class FakeCollision implements ICollision {
  /** Optional solid used by `containsPoint`. */
  solid: Box | null = null;

  constructor(private readonly floorY: number | null) {}

  containsPoint(pos: Vec3): boolean {
    const box = this.solid;
    if (box === null) return false;
    return (
      pos.x > box.min.x &&
      pos.x < box.max.x &&
      pos.y > box.min.y &&
      pos.y < box.max.y &&
      pos.z > box.min.z &&
      pos.z < box.max.z
    );
  }

  moveAndSlide(pos: Vec3, vel: Vec3, half: Vec3, dt: number): MoveResult {
    void pos;
    void vel;
    void half;
    void dt;
    return {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      grounded: false,
      ground: null,
      wall: null,
    };
  }

  raycast(origin: Vec3, dir: Vec3, maxDist: number): SurfaceHit | null {
    if (this.floorY === null) return null;
    if (!(dir.y < -EPS)) return null;
    const t = (origin.y - this.floorY) / -dir.y;
    if (!Number.isFinite(t) || t < 0 || t > maxDist) return null;
    return {
      pos: { x: origin.x + dir.x * t, y: this.floorY, z: origin.z + dir.z * t },
      normal: { x: 0, y: 1, z: 0 },
      boxIndex: 0,
      face: '+y',
    };
  }
}

interface SplatLog {
  hit: SurfaceHit;
  radius: number;
  team: TeamId;
}

class FakePaint implements IPaintGrid {
  readonly surfaces: readonly SurfaceGrid[] = [];
  cellsPerHit = 1;
  readonly hits: SplatLog[] = [];

  surfaceAt(boxIndex: number, face: Face): SurfaceId | null {
    void boxIndex;
    void face;
    return null;
  }

  sampleHit(hit: SurfaceHit): CellValue {
    void hit;
    return NO_TEAM;
  }

  splatHit(hit: SurfaceHit, radius: number, team: TeamId): number {
    this.hits.push({
      hit: {
        pos: { ...hit.pos },
        normal: { ...hit.normal },
        boxIndex: hit.boxIndex,
        face: hit.face,
      },
      radius,
      team,
    });
    return this.cellsPerHit;
  }

  splat(surfaceId: SurfaceId, u: number, v: number, radius: number, team: TeamId): number {
    void surfaceId;
    void u;
    void v;
    void radius;
    void team;
    return 0;
  }

  counts(): [number, number] {
    return [0, 0];
  }

  totalCells(): number {
    return 0;
  }

  takeDirty(): SurfaceId[] {
    return [];
  }
}

const BASE_WEAPON: Weapon = {
  id: 'sprayer',
  name: 'Sprayer',
  kind: 'projectile',
  intervalSeconds: 0.1,
  inkCost: 1,
  damage: 10,
  muzzleSpeed: 10,
  projectileGravity: 0,
  spreadRadians: 0,
  paintRadius: 0.5,
  trailSpacing: 1,
  trailRadius: 0.3,
  lifetimeSeconds: 2,
};

function makeWeapon(overrides: Partial<Weapon> = {}): Weapon {
  return { ...BASE_WEAPON, ...overrides };
}

function shooter(overrides: Partial<ShooterState> = {}): ShooterState {
  return {
    id: 1,
    team: 0,
    pos: { x: 0, y: 1, z: 0 },
    yaw: 0,
    pitch: 0,
    ink: 100,
    canFire: true,
    ...overrides,
  };
}

function target(overrides: Partial<TargetState> = {}): TargetState {
  return {
    id: 2,
    team: 1,
    pos: { x: 0, y: 1, z: -2 },
    half: { x: 0.4, y: 0.6, z: 0.4 },
    hittable: true,
    ...overrides,
  };
}

interface Harness {
  system: IWeaponSystem;
  paint: FakePaint;
  collision: FakeCollision;
}

function harness(options: {
  weapon?: Partial<Weapon>;
  floorY?: number | null;
  cells?: number;
  seed?: number;
} = {}): Harness {
  const paint = new FakePaint();
  paint.cellsPerHit = options.cells ?? 1;
  const collision = new FakeCollision(options.floorY ?? null);
  const system = createWeaponSystem(makeWeapon(options.weapon ?? {}), {
    collision,
    paint,
    rng: createRng(options.seed ?? 1),
  });
  return { system, paint, collision };
}

describe('createWeaponSystem / tryFire', () => {
  it('spawns a projectile at the muzzle and reports the weapon id and ink cost', () => {
    const h = harness({
      weapon: { inkCost: 2, intervalSeconds: 1 / 600 },
    });

    const result = h.system.tryFire(shooter({ pos: { x: 1, y: 2, z: 3 } }), 7);

    expect(result.fired).toBe(true);
    expect(result.inkSpent).toBe(2);
    expect(result.events).toEqual([
      { t: 'shoot', weapon: 'sprayer', pos: { x: 1, y: 2, z: 3 } },
    ]);
    expect(h.system.projectiles()).toHaveLength(1);
    expect(h.paint.hits).toHaveLength(0);
  });

  it('enforces the per-shooter fire interval in ticks', () => {
    const h = harness({ weapon: { intervalSeconds: 0.2 } });
    const s = shooter();

    expect(h.system.tryFire(s, 0).fired).toBe(true);
    expect(h.system.tryFire(s, 11).fired).toBe(false);
    expect(h.system.tryFire(s, 12).fired).toBe(true);
  });

  it('tracks the interval independently for each shooter', () => {
    const h = harness({ weapon: { intervalSeconds: 0.5 } });

    expect(h.system.tryFire(shooter({ id: 1 }), 0).fired).toBe(true);
    expect(h.system.tryFire(shooter({ id: 2 }), 0).fired).toBe(true);
    expect(h.system.tryFire(shooter({ id: 1 }), 1).fired).toBe(false);
  });

  it('refuses when canFire is false or ink is below the cost', () => {
    const h = harness({ weapon: { inkCost: 5, intervalSeconds: 0.5 } });

    expect(h.system.tryFire(shooter({ canFire: false }), 0)).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
    });
    expect(h.system.tryFire(shooter({ ink: 4 }), 0)).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
    });
    expect(h.system.projectiles()).toHaveLength(0);
    // Refusals must not record a shot, so a valid attempt at the same tick works.
    expect(h.system.tryFire(shooter({ ink: 5 }), 0).fired).toBe(true);
  });

  it('accepts exactly the ink cost', () => {
    const h = harness({ weapon: { inkCost: 5, intervalSeconds: 1 / 600 } });
    expect(h.system.tryFire(shooter({ ink: 5 }), 0).fired).toBe(true);
  });

  it('refuses a muzzle inside a solid without spending ink or blocking later shots', () => {
    const h = harness({ weapon: { inkCost: 5, intervalSeconds: 0.5 } });
    h.collision.solid = { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } };

    expect(h.system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 } }), 0)).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
    });
    expect(h.system.projectiles()).toHaveLength(0);
    expect(h.system.tryFire(shooter({ pos: { x: 3, y: 1, z: 0 } }), 0).fired).toBe(true);
  });
});

describe('createWeaponSystem / step', () => {
  it('moves projectiles along the aim direction', () => {
    const h = harness({ weapon: { muzzleSpeed: 10, trailSpacing: 1000 } });
    h.system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 } }), 0);

    const view = h.system.projectiles()[0];
    if (view === undefined) throw new Error('expected a projectile');
    h.system.step(0.1, []);

    expect(view.pos.x).toBeCloseTo(0);
    expect(view.pos.y).toBeCloseTo(1);
    expect(view.pos.z).toBeCloseTo(-1);
  });

  it('ignores same-team targets but hits enemies', () => {
    const h = harness({
      weapon: { muzzleSpeed: 10, trailSpacing: 1000, damage: 7 },
    });
    h.system.tryFire(shooter({ id: 1, team: 0 }), 0);

    const friendly = target({
      id: 2,
      team: 0,
      pos: { x: 0, y: 1, z: -0.5 },
      half: { x: 0.2, y: 0.5, z: 0.2 },
    });
    const friendlyResult = h.system.step(0.1, [friendly]);
    expect(friendlyResult.hits).toHaveLength(0);
    expect(h.system.projectiles()).toHaveLength(1);

    const enemyHarness = harness({
      weapon: { muzzleSpeed: 10, trailSpacing: 1000, damage: 7 },
    });
    enemyHarness.system.tryFire(shooter({ id: 1, team: 0 }), 0);
    const enemy = target({
      id: 3,
      team: 1,
      pos: { x: 0, y: 1, z: -0.5 },
      half: { x: 0.2, y: 0.5, z: 0.2 },
    });
    const enemyResult = enemyHarness.system.step(0.1, [enemy]);

    expect(enemyResult.hits).toHaveLength(1);
    expect(enemyResult.hits[0]?.target).toBe(3);
    expect(enemyResult.hits[0]?.attacker).toBe(1);
    expect(enemyResult.hits[0]?.damage).toBe(7);
    expect(enemyResult.hits[0]?.pos.z).toBeCloseTo(-0.3);
    expect(enemyHarness.system.projectiles()).toHaveLength(0);
  });

  it('treats a projectile starting inside an enemy AABB as an immediate hit', () => {
    const h = harness({ weapon: { muzzleSpeed: 0, trailSpacing: 1000 } });
    h.system.tryFire(shooter({ id: 4, team: 0, pos: { x: 0, y: 1, z: 0 } }), 0);

    const inside = target({
      id: 9,
      team: 1,
      pos: { x: 0, y: 1, z: 0 },
      half: { x: 0.5, y: 0.5, z: 0.5 },
    });
    const result = h.system.step(1 / 60, [inside]);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.pos).toEqual({ x: 0, y: 1, z: 0 });
    expect(h.system.projectiles()).toHaveLength(0);
  });

  it('detects a target crossed in a single fast step', () => {
    const h = harness({
      weapon: { muzzleSpeed: 200, trailSpacing: 1000, lifetimeSeconds: 2 },
    });
    h.system.tryFire(shooter({ id: 4, team: 0 }), 0);

    const fast = target({
      id: 9,
      team: 1,
      pos: { x: 0, y: 1, z: -3 },
      half: { x: 0.1, y: 0.1, z: 0.1 },
    });
    const result = h.system.step(1 / 60, [fast]);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.target).toBe(9);
    expect(h.system.projectiles()).toHaveLength(0);
  });

  it('splats, impacts and paints when a stage surface is hit', () => {
    const h = harness({
      floorY: 0,
      cells: 4,
      weapon: {
        muzzleSpeed: 100,
        paintRadius: 2,
        trailSpacing: 1000,
        lifetimeSeconds: 2,
      },
    });
    h.system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 }, pitch: -Math.PI / 2 }), 0);

    const result = h.system.step(0.02, []);

    expect(result.hits).toHaveLength(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ t: 'impact' });
    const impact = result.events[0];
    if (impact?.t === 'impact') expect(impact.pos.y).toBeCloseTo(0);
    expect(result.events[1]).toMatchObject({ t: 'paint', team: 0, cells: 4 });
    expect(h.paint.hits).toHaveLength(1);
    expect(h.paint.hits[0]?.radius).toBe(2);
    expect(h.paint.hits[0]?.team).toBe(0);
    expect(h.system.projectiles()).toHaveLength(0);
  });

  it('emits impact without a paint event when no cells change', () => {
    const h = harness({
      floorY: 0,
      cells: 0,
      weapon: { muzzleSpeed: 100, trailSpacing: 1000 },
    });
    h.system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 }, pitch: -Math.PI / 2 }), 0);

    const result = h.system.step(0.02, []);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ t: 'impact' });
    expect(h.paint.hits).toHaveLength(1);
  });

  it('probes a trail down every trailSpacing metres', () => {
    const h = harness({
      floorY: 0,
      cells: 2,
      weapon: {
        muzzleSpeed: 6,
        trailSpacing: 0.25,
        trailRadius: 0.4,
        lifetimeSeconds: 5,
      },
    });
    h.system.tryFire(shooter({ pos: { x: 0, y: 2, z: 0 } }), 0);

    let paintEvents = 0;
    for (let i = 0; i < 3; i += 1) {
      const result = h.system.step(1 / 60, []);
      paintEvents += result.events.filter((e) => e.t === 'paint').length;
    }

    // 3 steps at 6 m/s travel 0.3 m, crossing the first 0.25 m sample once.
    expect(h.paint.hits).toHaveLength(1);
    expect(h.paint.hits[0]?.radius).toBe(0.4);
    expect(paintEvents).toBe(1);
    expect(h.system.projectiles()).toHaveLength(1);
  });

  it('accumulates at most one trail paint event per projectile per step', () => {
    const h = harness({
      floorY: 0,
      cells: 3,
      weapon: {
        muzzleSpeed: 100,
        trailSpacing: 0.5,
        trailRadius: 0.4,
        lifetimeSeconds: 5,
      },
    });
    h.system.tryFire(shooter({ pos: { x: 0, y: 2, z: 0 } }), 0);

    const result = h.system.step(0.02, []);

    // 2 m travelled -> samples at 0.5, 1.0, 1.5 and 2.0 m.
    expect(h.paint.hits).toHaveLength(4);
    const paintEvents = result.events.filter((e) => e.t === 'paint');
    expect(paintEvents).toHaveLength(1);
    expect(paintEvents[0]).toMatchObject({ t: 'paint', team: 0, cells: 12 });
  });

  it('removes projectiles when their lifetime has passed', () => {
    const h = harness({
      weapon: { muzzleSpeed: 0, lifetimeSeconds: 0.05, trailSpacing: 1000 },
    });
    h.system.tryFire(shooter(), 0);

    expect(h.system.projectiles()).toHaveLength(1);
    h.system.step(0.04, []);
    expect(h.system.projectiles()).toHaveLength(1);
    h.system.step(0.04, []);
    expect(h.system.projectiles()).toHaveLength(0);
  });
});

describe('createWeaponSystem / pool', () => {
  it('recycles the oldest projectile when all 256 slots are live', () => {
    const h = harness({
      weapon: {
        intervalSeconds: 0.001,
        inkCost: 0,
        muzzleSpeed: 0,
        lifetimeSeconds: 100,
        trailSpacing: 1000,
      },
    });
    const s = shooter();

    for (let i = 0; i < 257; i += 1) {
      expect(h.system.tryFire(s, 0).fired).toBe(true);
    }

    const views = h.system.projectiles();
    expect(views).toHaveLength(256);
    const ids = views.map((view) => view.id);
    expect(ids.includes(0)).toBe(false);
    expect(ids.includes(256)).toBe(true);
  });

  it('returns a reused array from projectiles()', () => {
    const h = harness({ weapon: { intervalSeconds: 0.001, inkCost: 0 } });
    h.system.tryFire(shooter(), 0);
    const first = h.system.projectiles();
    const second = h.system.projectiles();
    expect(second).toBe(first);
  });
});

describe('createWeaponSystem / determinism and spread', () => {
  function run(seed: number): unknown[] {
    const h = harness({
      seed,
      floorY: 0,
      weapon: {
        muzzleSpeed: 15,
        projectileGravity: 6,
        spreadRadians: 0.15,
        intervalSeconds: 0.05,
        lifetimeSeconds: 4,
        trailSpacing: 0.6,
        paintRadius: 0.8,
        trailRadius: 0.4,
      },
    });
    const s = shooter({ id: 5, team: 0, yaw: 0.4, pitch: 0.25 });
    const trace: unknown[] = [];

    for (let i = 0; i < 12; i += 1) {
      trace.push(h.system.tryFire(s, i * 4));
      trace.push(
        h.system.step(1 / 60, [
          target({ id: 7, team: 1, pos: { x: 0, y: 1, z: -6 }, half: { x: 0.5, y: 0.5, z: 0.5 } }),
        ]),
      );
    }

    trace.push(
      h.system.projectiles().map((p) => ({ id: p.id, team: p.team, pos: { ...p.pos } })),
    );
    trace.push(
      h.paint.hits.map((entry) => ({
        pos: { ...entry.hit.pos },
        radius: entry.radius,
        team: entry.team,
      })),
    );
    return trace;
  }

  it('produces identical results for the same seed and calls', () => {
    expect(run(99)).toEqual(run(99));
  });

  it('uses the rng so a different seed changes the trace', () => {
    expect(run(99)).not.toEqual(run(100));
  });

  it('keeps each shot inside the spread cone', () => {
    const h = harness({
      weapon: { muzzleSpeed: 10, spreadRadians: 0.2, trailSpacing: 1000 },
    });
    h.system.tryFire(shooter({ pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }), 0);

    h.system.step(0.1, []);
    const view = h.system.projectiles()[0];
    if (view === undefined) throw new Error('expected a projectile');

    const length = Math.hypot(view.pos.x, view.pos.y, view.pos.z);
    const unitZ = -view.pos.z / length;
    const angle = Math.acos(Math.min(1, Math.max(-1, unitZ)));
    expect(angle).toBeLessThanOrEqual(0.2 + 1e-9);
  });
});

/** Builds a stage whose boxes are all solid and unpaintable. */
function stagesOf(boxes: Box[]): Pick<StageData, 'boxes'> {
  return { boxes: boxes.map((box) => ({ box, paintable: [] })) };
}

describe('createWeaponSystem / real stage collision', () => {
  const WALL: Box = {
    min: { x: -4, y: 0, z: -5.1 },
    max: { x: 4, y: 3, z: -5 },
  };

  function realSystem(boxes: Box[]): { system: IWeaponSystem; paint: FakePaint } {
    const paint = new FakePaint();
    const collision = createCollision(stagesOf(boxes));
    const system = createWeaponSystem(
      makeWeapon({ muzzleSpeed: 60, trailSpacing: 1000, lifetimeSeconds: 5 }),
      { collision, paint, rng: createRng(3) },
    );
    return { system, paint };
  }

  it('stops a shot at a wall, impacts on it and never passes through', () => {
    const { system, paint } = realSystem([WALL]);
    const fired = system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 }, yaw: 0, pitch: 0 }), 0);
    expect(fired.fired).toBe(true);

    const impacts: Vec3[] = [];
    for (let i = 0; i < 12; i += 1) {
      const result = system.step(1 / 60, []);
      for (const event of result.events) {
        if (event.t === 'impact') impacts.push({ ...event.pos });
      }
      // Whatever is still alive must stay on the near side of the wall.
      for (const view of system.projectiles()) {
        expect(view.pos.z).toBeGreaterThanOrEqual(WALL.max.z - 1e-9);
      }
    }

    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.z).toBeCloseTo(WALL.max.z, 6);
    // The impact happened on the wall's +z face, not on the floor or inside it.
    expect(paint.hits).toHaveLength(1);
    expect(paint.hits[0]?.hit.boxIndex).toBe(0);
    expect(paint.hits[0]?.hit.face).toBe('+z');
    expect(paint.hits[0]?.hit.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(system.projectiles()).toHaveLength(0);
  });

  it('refuses to fire when the muzzle sits inside a solid', () => {
    const { system } = realSystem([WALL]);
    const collision = createCollision(stagesOf([WALL]));
    expect(collision.containsPoint({ x: 0, y: 1, z: -5.05 })).toBe(true);

    const result = system.tryFire(shooter({ pos: { x: 0, y: 1, z: -5.05 } }), 0);
    expect(result).toEqual({ fired: false, inkSpent: 0, events: [] });
    expect(system.projectiles()).toHaveLength(0);

    // The refusal must not become a cooldown: the same tick fires once free.
    const clear = system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 } }), 0);
    expect(clear.fired).toBe(true);
    expect(system.projectiles()).toHaveLength(1);
  });
});
