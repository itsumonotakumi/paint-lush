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
import type { BrushWeapon, ChargeWeapon, ProjectileWeapon, StageData, Weapon } from '../data/schemas';
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

const BASE_WEAPON: ProjectileWeapon = {
  id: 'sprayer',
  name: 'Sprayer',
  kind: 'projectile',
  specialGainPerCell: 0,
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

const BASE_BRUSH: BrushWeapon = {
  id: 'brush',
  name: 'Brush',
  kind: 'brush',
  specialGainPerCell: 0,
  rollInkPerSec: 6,
  rollWidth: 1.2,
  rollSpacing: 0.5,
  rollSpeedMultiplier: 0.6,
  rollDamage: 5,
  swingIntervalSeconds: 0.5,
  swingReach: 2,
  swingArcRadians: Math.PI / 2,
  swingDamage: 20,
  swingPaintRadius: 0.3,
  swingInkCost: 2,
};

const BASE_CHARGE: ChargeWeapon = {
  id: 'lance',
  name: 'Lance',
  kind: 'charge',
  specialGainPerCell: 0,
  fullChargeSeconds: 1,
  minChargeFraction: 0.25,
  rangeMin: 2,
  rangeFull: 10,
  damageMin: 10,
  damageFull: 50,
  lineRadius: 0.25,
  lineSpacing: 1,
  inkCostFull: 20,
  chargeMoveMultiplier: 0.4,
};

function makeProjectile(overrides: Partial<ProjectileWeapon> = {}): Weapon {
  return { ...BASE_WEAPON, ...overrides, kind: 'projectile' };
}

function makeBrush(overrides: Partial<BrushWeapon> = {}): Weapon {
  return { ...BASE_BRUSH, ...overrides, kind: 'brush' };
}

function makeCharge(overrides: Partial<ChargeWeapon> = {}): Weapon {
  return { ...BASE_CHARGE, ...overrides, kind: 'charge' };
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
    weaponId: 'sprayer',
    holdFire: false,
    grounded: true,
    mods: { fireRateMul: 1, paintMul: 1, inkCostMul: 1 },
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

function systemOf(
  weapons: Weapon[],
  options: { floorY?: number | null; cells?: number; seed?: number } = {},
): Harness {
  const paint = new FakePaint();
  paint.cellsPerHit = options.cells ?? 1;
  const collision = new FakeCollision(options.floorY ?? null);
  const system = createWeaponSystem(weapons, {
    collision,
    paint,
    rng: createRng(options.seed ?? 1),
  });
  return { system, paint, collision };
}

function harness(
  options: { weapon?: Partial<ProjectileWeapon>; floorY?: number | null; cells?: number; seed?: number } = {},
): Harness {
  return systemOf([makeProjectile(options.weapon ?? {})], options);
}

describe('createWeaponSystem / tryFire', () => {
  it('spawns a projectile at the muzzle and reports the weapon id and ink cost', () => {
    const h = harness({
      weapon: { inkCost: 2, intervalSeconds: 1 / 600 },
    });

    const result = h.system.tryFire(
      shooter({ pos: { x: 1, y: 2, z: 3 }, holdFire: true }),
      [],
      7,
    );

    expect(result.fired).toBe(true);
    expect(result.inkSpent).toBe(2);
    expect(result.events).toEqual([
      { t: 'shoot', weapon: 'sprayer', pos: { x: 1, y: 2, z: 3 }, id: 1 },
    ]);
    expect(h.system.projectiles()).toHaveLength(1);
    expect(h.paint.hits).toHaveLength(0);
  });

  it('does nothing for an unknown weapon id', () => {
    const h = harness();
    const result = h.system.tryFire(shooter({ weaponId: 'missing' }), [], 0);
    expect(result).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
      charging: 0,
      moveMultiplier: 1,
      hits: [],
    });
    expect(h.system.projectiles()).toHaveLength(0);
  });

  it('enforces the per-shooter fire interval in ticks', () => {
    const h = harness({ weapon: { intervalSeconds: 0.2 } });
    const s = shooter({ holdFire: true });

    expect(h.system.tryFire(s, [], 0).fired).toBe(true);
    expect(h.system.tryFire(s, [], 11).fired).toBe(false);
    expect(h.system.tryFire(s, [], 12).fired).toBe(true);
  });

  it('tracks the interval independently for each shooter', () => {
    const h = harness({ weapon: { intervalSeconds: 0.5 } });

    expect(h.system.tryFire(shooter({ id: 1, holdFire: true }), [], 0).fired).toBe(true);
    expect(h.system.tryFire(shooter({ id: 2, holdFire: true }), [], 0).fired).toBe(true);
    expect(h.system.tryFire(shooter({ id: 1, holdFire: true }), [], 1).fired).toBe(false);
  });

  it('refuses when canFire is false or ink is below the cost', () => {
    const h = harness({ weapon: { inkCost: 5, intervalSeconds: 0.5 } });

    expect(h.system.tryFire(shooter({ canFire: false, holdFire: true }), [], 0)).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
      charging: 0,
      moveMultiplier: 1,
      hits: [],
    });
    expect(h.system.tryFire(shooter({ ink: 4, holdFire: true }), [], 0)).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
      charging: 0,
      moveMultiplier: 1,
      hits: [],
    });
    expect(h.system.projectiles()).toHaveLength(0);
    // Refusals must not record a shot, so a valid attempt at the same tick works.
    expect(h.system.tryFire(shooter({ ink: 5, holdFire: true }), [], 0).fired).toBe(true);
  });

  it('accepts exactly the ink cost', () => {
    const h = harness({ weapon: { inkCost: 5, intervalSeconds: 1 / 600 } });
    expect(h.system.tryFire(shooter({ ink: 5, holdFire: true }), [], 0).fired).toBe(true);
  });

  it('never fires a projectile while holdFire is false', () => {
    const h = harness({ weapon: { inkCost: 2, intervalSeconds: 1 / 60 } });
    const idle = shooter({ holdFire: false });

    for (let tick = 0; tick < 240; tick += 1) {
      const result = h.system.tryFire(idle, [], tick);
      expect(result.fired).toBe(false);
      expect(result.inkSpent).toBe(0);
      expect(result.events).toHaveLength(0);
    }
    expect(h.system.projectiles()).toHaveLength(0);

    // Idle calls must not leave a cooldown behind: the first held tick fires.
    const held = h.system.tryFire(shooter({ holdFire: true }), [], 240);
    expect(held.fired).toBe(true);
    expect(held.events).toEqual([{ t: 'shoot', weapon: 'sprayer', pos: { x: 0, y: 1, z: 0 }, id: 1 }]);
  });

  it('fires only on ticks where holdFire is true', () => {
    const h = harness({ weapon: { inkCost: 1, intervalSeconds: 0.1 } });

    expect(h.system.tryFire(shooter({ holdFire: true }), [], 0).fired).toBe(true);
    expect(h.system.tryFire(shooter({ holdFire: false }), [], 6).fired).toBe(false);
    expect(h.system.tryFire(shooter({ holdFire: false }), [], 12).fired).toBe(false);
    expect(h.system.tryFire(shooter({ holdFire: true }), [], 12).fired).toBe(true);
    expect(h.system.projectiles()).toHaveLength(2);
  });

  it('refuses a muzzle inside a solid without spending ink or blocking later shots', () => {
    const h = harness({ weapon: { inkCost: 5, intervalSeconds: 0.5 } });
    h.collision.solid = { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } };

    expect(h.system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 }, holdFire: true }), [], 0)).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
      charging: 0,
      moveMultiplier: 1,
      hits: [],
    });
    expect(h.system.projectiles()).toHaveLength(0);
    expect(h.system.tryFire(shooter({ pos: { x: 3, y: 1, z: 0 }, holdFire: true }), [], 0).fired).toBe(true);
  });
});

describe('createWeaponSystem / shooter mods', () => {
  it('divides the interval by fireRateMul', () => {
    const h = harness({ weapon: { intervalSeconds: 0.2 } });
    const fast = shooter({ holdFire: true, mods: { fireRateMul: 2, paintMul: 1, inkCostMul: 1 } });

    expect(h.system.tryFire(fast, [], 0).fired).toBe(true);
    expect(h.system.tryFire(fast, [], 5).fired).toBe(false);
    expect(h.system.tryFire(fast, [], 6).fired).toBe(true);
  });

  it('multiplies the ink cost by inkCostMul', () => {
    const h = harness({ weapon: { inkCost: 2, intervalSeconds: 1 / 600 } });
    const mods = { fireRateMul: 1, paintMul: 1, inkCostMul: 1.5 };

    const refused = h.system.tryFire(shooter({ ink: 2.9, mods, holdFire: true }), [], 0);
    expect(refused.fired).toBe(false);
    expect(refused.inkSpent).toBe(0);

    const fired = h.system.tryFire(shooter({ ink: 3, mods, holdFire: true }), [], 1);
    expect(fired.fired).toBe(true);
    expect(fired.inkSpent).toBeCloseTo(3);
  });

  it('multiplies projectile paint radii by paintMul', () => {
    const h = harness({
      floorY: 0,
      weapon: { muzzleSpeed: 100, paintRadius: 2, trailSpacing: 1000 },
    });
    const mods = { fireRateMul: 1, paintMul: 0.5, inkCostMul: 1 };
    h.system.tryFire(shooter({ pitch: -Math.PI / 2, mods, holdFire: true }), [], 0);

    h.system.step(0.02, []);

    expect(h.paint.hits).toHaveLength(1);
    expect(h.paint.hits[0]?.radius).toBeCloseTo(1);
  });
});

describe('createWeaponSystem / step', () => {
  it('moves projectiles along the aim direction', () => {
    const h = harness({ weapon: { muzzleSpeed: 10, trailSpacing: 1000 } });
    h.system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 }, holdFire: true }), [], 0);

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
    h.system.tryFire(shooter({ id: 1, team: 0, holdFire: true }), [], 0);

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
    enemyHarness.system.tryFire(shooter({ id: 1, team: 0, holdFire: true }), [], 0);
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
    h.system.tryFire(shooter({ id: 4, team: 0, pos: { x: 0, y: 1, z: 0 }, holdFire: true }), [], 0);

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
    h.system.tryFire(shooter({ id: 4, team: 0, holdFire: true }), [], 0);

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
    h.system.tryFire(
      shooter({ pos: { x: 0, y: 1, z: 0 }, pitch: -Math.PI / 2, holdFire: true }),
      [],
      0,
    );

    const result = h.system.step(0.02, []);

    expect(result.hits).toHaveLength(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ t: 'impact' });
    const impact = result.events[0];
    if (impact?.t === 'impact') expect(impact.pos.y).toBeCloseTo(0);
    expect(result.events[1]).toMatchObject({ t: 'paint', team: 0, cells: 4, by: 1 });
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
    h.system.tryFire(
      shooter({ pos: { x: 0, y: 1, z: 0 }, pitch: -Math.PI / 2, holdFire: true }),
      [],
      0,
    );

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
    h.system.tryFire(shooter({ pos: { x: 0, y: 2, z: 0 }, holdFire: true }), [], 0);

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
    h.system.tryFire(shooter({ pos: { x: 0, y: 2, z: 0 }, holdFire: true }), [], 0);

    const result = h.system.step(0.02, []);

    // 2 m travelled -> samples at 0.5, 1.0, 1.5 and 2.0 m.
    expect(h.paint.hits).toHaveLength(4);
    const paintEvents = result.events.filter((e) => e.t === 'paint');
    expect(paintEvents).toHaveLength(1);
    expect(paintEvents[0]).toMatchObject({ t: 'paint', team: 0, cells: 12, by: 1 });
  });

  it('removes projectiles when their lifetime has passed', () => {
    const h = harness({
      weapon: { muzzleSpeed: 0, lifetimeSeconds: 0.05, trailSpacing: 1000 },
    });
    h.system.tryFire(shooter({ holdFire: true }), [], 0);

    expect(h.system.projectiles()).toHaveLength(1);
    h.system.step(0.04, []);
    expect(h.system.projectiles()).toHaveLength(1);
    h.system.step(0.04, []);
    expect(h.system.projectiles()).toHaveLength(0);
  });
});

describe('createWeaponSystem / pool', () => {
  it('recycles the oldest projectile when all 512 slots are live', () => {
    const h = harness({
      weapon: {
        intervalSeconds: 0.001,
        inkCost: 0,
        muzzleSpeed: 0,
        lifetimeSeconds: 100,
        trailSpacing: 1000,
      },
    });
    const s = shooter({ holdFire: true });

    for (let i = 0; i < 513; i += 1) {
      expect(h.system.tryFire(s, [], 0).fired).toBe(true);
    }

    const views = h.system.projectiles();
    expect(views).toHaveLength(512);
    const ids = views.map((view) => view.id);
    expect(ids.includes(0)).toBe(false);
    expect(ids.includes(512)).toBe(true);
  });

  it('returns a reused array from projectiles()', () => {
    const h = harness({ weapon: { intervalSeconds: 0.001, inkCost: 0 } });
    h.system.tryFire(shooter({ holdFire: true }), [], 0);
    const first = h.system.projectiles();
    const second = h.system.projectiles();
    expect(second).toBe(first);
  });
});

describe('createWeaponSystem / brush', () => {
  it('swings on a rising press, damages once in the arc and paints three arc points', () => {
    const h = systemOf([makeBrush()], { floorY: 0, cells: 2 });
    const s = shooter({ weaponId: 'brush', holdFire: true });
    const enemy = target({ id: 7, pos: { x: 0, y: 1, z: -1 }, half: { x: 0.2, y: 0.5, z: 0.2 } });

    const result = h.system.tryFire(s, [enemy], 0);

    expect(result.fired).toBe(true);
    expect(result.inkSpent).toBe(2);
    expect(result.events[0]).toEqual({ t: 'swing', id: 1, pos: { x: 0, y: 1, z: 0 } });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.target).toBe(7);
    expect(result.hits[0]?.attacker).toBe(1);
    expect(result.hits[0]?.damage).toBe(20);
    expect(h.paint.hits).toHaveLength(3);
    expect(result.events.some((e) => e.t === 'paint' && e.by === 1)).toBe(true);

    // Holding does not repeat the swing.
    const held = h.system.tryFire(s, [enemy], 1);
    expect(held.fired).toBe(false);
    expect(held.hits).toHaveLength(0);
    expect(held.events).toHaveLength(0);
  });

  it('requires the swing interval before a second press swings', () => {
    const h = systemOf([makeBrush()], { floorY: 0 });
    const down = shooter({ weaponId: 'brush', holdFire: true });
    const up = shooter({ weaponId: 'brush', holdFire: false });

    expect(h.system.tryFire(down, [], 0).fired).toBe(true);
    expect(h.system.tryFire(up, [], 1).fired).toBe(false);
    expect(h.system.tryFire(down, [], 10).fired).toBe(false);
    expect(h.system.tryFire(up, [], 11).fired).toBe(false);
    expect(h.system.tryFire(down, [], 30).fired).toBe(true);
  });

  it('rolls after 0.2 s of grounded holding, paints strips and damages once per interval', () => {
    const h = systemOf([makeBrush({ swingReach: 0.2, rollInkPerSec: 6, rollSpacing: 0.5 })], {
      floorY: 0,
      cells: 1,
    });
    const enemy = target({ id: 5, pos: { x: 0, y: 1, z: -1 }, half: { x: 0.2, y: 0.5, z: 0.2 } });
    let hits = 0;

    // tick 0 swings, then hold still until the roll delay has elapsed.
    h.system.tryFire(shooter({ weaponId: 'brush', holdFire: true }), [enemy], 0);
    for (let i = 1; i <= 11; i += 1) {
      const idle = h.system.tryFire(
        shooter({ weaponId: 'brush', holdFire: true, pos: { x: 0, y: 1, z: 0 } }),
        [enemy],
        i,
      );
      expect(idle.moveMultiplier).toBe(1);
      hits += idle.hits.length;
    }

    const start = h.system.tryFire(
      shooter({ weaponId: 'brush', holdFire: true, pos: { x: 0, y: 1, z: 0 } }),
      [enemy],
      12,
    );
    expect(start.moveMultiplier).toBe(0.6);
    expect(start.inkSpent).toBeCloseTo(0.1);

    h.paint.hits.length = 0;
    hits = 0;
    for (let i = 1; i <= 6; i += 1) {
      const rolled = h.system.tryFire(
        shooter({ weaponId: 'brush', holdFire: true, pos: { x: 0, y: 1, z: -0.5 * i } }),
        [enemy],
        12 + i,
      );
      expect(rolled.moveMultiplier).toBe(0.6);
      expect(rolled.inkSpent).toBeCloseTo(0.1);
      hits += rolled.hits.length;
    }

    // One strip sample per 0.5 m, three discs each.
    expect(h.paint.hits.length).toBe(18);
    expect(hits).toBe(1);
  });

  it('does not count airborne hold time toward the roll delay', () => {
    const h = systemOf([makeBrush()], { floorY: 0 });
    for (let tick = 0; tick < 20; tick += 1) {
      h.system.tryFire(
        shooter({ weaponId: 'brush', holdFire: true, grounded: false }),
        [],
        tick,
      );
    }

    const landed = h.system.tryFire(
      shooter({ weaponId: 'brush', holdFire: true, grounded: true }),
      [],
      20,
    );
    expect(landed.moveMultiplier).toBe(1);

    const rolling = h.system.tryFire(
      shooter({ weaponId: 'brush', holdFire: true, grounded: true }),
      [],
      32,
    );
    expect(rolling.moveMultiplier).toBe(0.6);
  });

  it('stops rolling when out of ink', () => {    const h = systemOf([makeBrush()], { floorY: 0 });
    const low = shooter({ weaponId: 'brush', holdFire: true, ink: 0 });
    const result = h.system.tryFire(low, [], 60);
    expect(result.moveMultiplier).toBe(1);
    expect(result.inkSpent).toBe(0);
  });

  it('applies paint and ink modifiers to a swing', () => {
    const h = systemOf([makeBrush({ swingInkCost: 2, swingPaintRadius: 0.6 })], { floorY: 0 });
    const mods = { fireRateMul: 1, paintMul: 0.5, inkCostMul: 2 };
    const result = h.system.tryFire(
      shooter({ weaponId: 'brush', holdFire: true, mods }),
      [],
      0,
    );
    expect(result.inkSpent).toBe(4);
    expect(h.paint.hits[0]?.radius).toBeCloseTo(0.3);
  });
});

describe('createWeaponSystem / charge', () => {
  function chargeHarness(weapons: Weapon = makeCharge(), floorY: number | null = 0): Harness {
    return systemOf([weapons], { floorY, cells: 2 });
  }

  function hold(
    h: Harness,
    tick: number,
    overrides: Partial<ShooterState> = {},
  ): ReturnType<IWeaponSystem['tryFire']> {
    return h.system.tryFire(shooter({ weaponId: 'lance', holdFire: true, ...overrides }), [], tick);
  }

  it('charges to 1 and emits levels 0, 1 and 2', () => {
    const h = chargeHarness();

    const start = hold(h, 0);
    expect(start.charging).toBe(0);
    expect(start.moveMultiplier).toBe(0.4);
    expect(start.events).toEqual([{ t: 'charge', id: 1, level: 0 }]);

    const half = hold(h, 30);
    expect(half.charging).toBeCloseTo(0.5);
    expect(half.events).toEqual([{ t: 'charge', id: 1, level: 1 }]);

    const full = hold(h, 60);
    expect(full.charging).toBe(1);
    expect(full.events).toEqual([{ t: 'charge', id: 1, level: 2 }]);
  });

  it('fires on release with charge-scaled range, damage, cost and a painted line', () => {
    const h = chargeHarness();
    const enemy = target({ id: 8, pos: { x: 0, y: 1, z: -5 }, half: { x: 0.4, y: 0.6, z: 0.4 } });

    hold(h, 0);
    const result = h.system.tryFire(shooter({ weaponId: 'lance' }), [enemy], 60);

    expect(result.fired).toBe(true);
    expect(result.inkSpent).toBeCloseTo(20);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.damage).toBeCloseTo(50);
    expect(result.events[0]).toMatchObject({ t: 'shoot', weapon: 'lance', id: 1 });
    expect(result.events.some((e) => e.t === 'paint' && e.by === 1)).toBe(true);
    // Samples at 1..4 m and a final splat at the target surface.
    expect(h.paint.hits.length).toBeGreaterThanOrEqual(5);
  });

  it('uses half charge when released halfway', () => {
    const h = chargeHarness();
    const enemy = target({ id: 8, pos: { x: 0, y: 1, z: -3 }, half: { x: 0.4, y: 0.6, z: 0.4 } });

    hold(h, 0);
    const result = h.system.tryFire(shooter({ weaponId: 'lance' }), [enemy], 30);

    expect(result.fired).toBe(true);
    expect(result.inkSpent).toBeCloseTo(10);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.damage).toBeCloseTo(30);
    // Range at half charge is 6 m, so a target at 3 m is comfortably in reach.
    expect(result.hits[0]?.pos.z).toBeCloseTo(-2.6);
  });

  it('cancels a release below the minimum charge', () => {
    const h = chargeHarness();
    hold(h, 0);
    const result = h.system.tryFire(shooter({ weaponId: 'lance' }), [], 10);
    expect(result.fired).toBe(false);
    expect(result.inkSpent).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it('cancels the charge when canFire becomes false', () => {
    const h = chargeHarness();
    hold(h, 0);
    hold(h, 30);
    const cancelled = hold(h, 31, { canFire: false });
    expect(cancelled.charging).toBe(0);

    const restart = hold(h, 32);
    expect(restart.charging).toBe(0);
    expect(restart.events).toEqual([{ t: 'charge', id: 1, level: 0 }]);
  });

  it('refuses when ink cannot cover the charged shot', () => {
    const h = chargeHarness();
    hold(h, 0);
    const result = h.system.tryFire(shooter({ weaponId: 'lance', ink: 5 }), [], 60);
    expect(result.fired).toBe(false);
    expect(result.inkSpent).toBe(0);
  });

  it('applies ink, range and paint modifiers', () => {
    const h = chargeHarness(makeCharge({ lineRadius: 0.4 }), 0);
    const mods = { fireRateMul: 1, paintMul: 0.5, inkCostMul: 0.5 };
    hold(h, 0, { mods });
    const result = h.system.tryFire(shooter({ weaponId: 'lance', mods }), [], 60);
    expect(result.fired).toBe(true);
    expect(result.inkSpent).toBeCloseTo(10);
    expect(h.paint.hits[0]?.radius).toBeCloseTo(0.2);
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
    const s = shooter({ id: 5, team: 0, yaw: 0.4, pitch: 0.25, holdFire: true });
    const trace: unknown[] = [];

    for (let i = 0; i < 12; i += 1) {
      trace.push(h.system.tryFire(s, [], i * 4));
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
    h.system.tryFire(shooter({ pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, holdFire: true }), [], 0);

    h.system.step(0.1, []);
    const view = h.system.projectiles()[0];
    if (view === undefined) throw new Error('expected a projectile');

    const length = Math.hypot(view.pos.x, view.pos.y, view.pos.z);
    const unitZ = -view.pos.z / length;
    const angle = Math.acos(Math.min(1, Math.max(-1, unitZ)));
    expect(angle).toBeLessThanOrEqual(0.2 + EPS);
  });

  it('gives identical snapshots for every weapon kind with the same calls', () => {
    function mixed(): unknown[] {
      const h = systemOf([makeProjectile({ spreadRadians: 0.1 }), makeBrush(), makeCharge()], {
        seed: 42,
        floorY: 0,
        cells: 1,
      });
      const enemy = target({ id: 9, pos: { x: 0, y: 1, z: -4 }, half: { x: 0.5, y: 0.6, z: 0.5 } });
      const trace: unknown[] = [];
      for (let tick = 0; tick < 40; tick += 1) {
        trace.push(
          h.system.tryFire(
            shooter({ id: 1, weaponId: 'sprayer', yaw: 0.2, holdFire: true }),
            [enemy],
            tick,
          ),
        );
        trace.push(
          h.system.tryFire(
            shooter({
              id: 2,
              weaponId: 'brush',
              holdFire: tick % 25 < 20,
              pos: { x: 1, y: 1, z: -0.1 * tick },
            }),
            [enemy],
            tick,
          ),
        );
        trace.push(
          h.system.tryFire(
            shooter({ id: 3, weaponId: 'lance', holdFire: tick % 20 < 15 }),
            [enemy],
            tick,
          ),
        );
        trace.push(h.system.step(1 / 60, [enemy]));
      }
      trace.push(h.system.projectiles().map((p) => ({ ...p, pos: { ...p.pos } })));
      trace.push(h.paint.hits.map((entry) => ({ pos: { ...entry.hit.pos }, radius: entry.radius })));
      return trace;
    }
    expect(mixed()).toEqual(mixed());
  });
});

/** Builds a stage whose boxes are all solid and unpaintable. */
function stagesOf(boxes: Box[]): Pick<StageData, 'boxes'> {
  return { boxes: boxes.map((box) => ({ box, paintable: [] })) };
}

const FLOOR: Box = { min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 0, z: 20 } };
const WALL: Box = { min: { x: -2, y: 0, z: -4.1 }, max: { x: 2, y: 3, z: -4 } };

describe('createWeaponSystem / real stage collision', () => {
  const SHOT_WALL: Box = {
    min: { x: -4, y: 0, z: -5.1 },
    max: { x: 4, y: 3, z: -5 },
  };

  function realSystem(weapons: Weapon[], boxes: Box[]): { system: IWeaponSystem; paint: FakePaint } {
    const paint = new FakePaint();
    const collision = createCollision(stagesOf(boxes));
    const system = createWeaponSystem(weapons, { collision, paint, rng: createRng(3) });
    return { system, paint };
  }

  it('stops a shot at a wall, impacts on it and never passes through', () => {
    const { system, paint } = realSystem(
      [makeProjectile({ muzzleSpeed: 60, trailSpacing: 1000, lifetimeSeconds: 5 })],
      [SHOT_WALL],
    );
    const fired = system.tryFire(
      shooter({ pos: { x: 0, y: 1, z: 0 }, yaw: 0, pitch: 0, holdFire: true }),
      [],
      0,
    );
    expect(fired.fired).toBe(true);

    const impacts: Vec3[] = [];
    for (let i = 0; i < 12; i += 1) {
      const result = system.step(1 / 60, []);
      for (const event of result.events) {
        if (event.t === 'impact') impacts.push({ ...event.pos });
      }
      for (const view of system.projectiles()) {
        expect(view.pos.z).toBeGreaterThanOrEqual(SHOT_WALL.max.z - EPS);
      }
    }

    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.z).toBeCloseTo(SHOT_WALL.max.z, 6);
    expect(paint.hits).toHaveLength(1);
    expect(paint.hits[0]?.hit.boxIndex).toBe(0);
    expect(paint.hits[0]?.hit.face).toBe('+z');
    expect(paint.hits[0]?.hit.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(system.projectiles()).toHaveLength(0);
  });

  it('refuses to fire when the muzzle sits inside a solid', () => {
    const { system } = realSystem(
      [makeProjectile({ muzzleSpeed: 60, trailSpacing: 1000, lifetimeSeconds: 5 })],
      [SHOT_WALL],
    );
    const collision = createCollision(stagesOf([SHOT_WALL]));
    expect(collision.containsPoint({ x: 0, y: 1, z: -5.05 })).toBe(true);

    const result = system.tryFire(shooter({ pos: { x: 0, y: 1, z: -5.05 }, holdFire: true }), [], 0);
    expect(result).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
      charging: 0,
      moveMultiplier: 1,
      hits: [],
    });
    expect(system.projectiles()).toHaveLength(0);

    const clear = system.tryFire(shooter({ pos: { x: 0, y: 1, z: 0 }, holdFire: true }), [], 0);
    expect(clear.fired).toBe(true);
    expect(system.projectiles()).toHaveLength(1);
  });

  it('block a brush swing through a wall with a real line-of-sight ray', () => {
    const enemy = target({ id: 11, pos: { x: 0, y: 1, z: -6 }, half: { x: 0.3, y: 0.6, z: 0.3 } });

    const open = realSystem([makeBrush({ swingReach: 6 })], [FLOOR]);
    const openResult = open.system.tryFire(shooter({ weaponId: 'brush', holdFire: true }), [enemy], 0);
    expect(openResult.hits).toHaveLength(1);
    expect(openResult.hits[0]?.target).toBe(11);

    const blocked = realSystem([makeBrush({ swingReach: 6 })], [FLOOR, WALL]);
    const blockedResult = blocked.system.tryFire(
      shooter({ weaponId: 'brush', holdFire: true }),
      [enemy],
      0,
    );
    expect(blockedResult.fired).toBe(true);
    expect(blockedResult.hits).toHaveLength(0);
    // The swing still paints where it can reach.
    expect(blockedResult.events.some((e) => e.t === 'paint')).toBe(true);
  });

  it('blocks a charged shot at a wall with a real line-of-sight ray', () => {
    const enemy = target({ id: 12, pos: { x: 0, y: 1, z: -6 }, half: { x: 0.3, y: 0.6, z: 0.3 } });
    const charge = makeCharge({ rangeFull: 10 });

    const open = realSystem([charge], [FLOOR]);
    open.system.tryFire(shooter({ weaponId: 'lance', holdFire: true }), [enemy], 0);
    const openResult = open.system.tryFire(shooter({ weaponId: 'lance' }), [enemy], 60);
    expect(openResult.hits).toHaveLength(1);
    expect(openResult.hits[0]?.target).toBe(12);

    const blocked = realSystem([charge], [FLOOR, WALL]);
    blocked.system.tryFire(shooter({ weaponId: 'lance', holdFire: true }), [enemy], 0);
    const blockedResult = blocked.system.tryFire(shooter({ weaponId: 'lance' }), [enemy], 60);
    expect(blockedResult.fired).toBe(true);
    expect(blockedResult.hits).toHaveLength(0);
    // Every paint sample stopped on the near side of the wall.
    expect(blocked.paint.hits.length).toBeGreaterThan(0);
    for (const entry of blocked.paint.hits) {
      expect(entry.hit.pos.z).toBeGreaterThanOrEqual(WALL.max.z - 1e-6);
    }
  });
});
