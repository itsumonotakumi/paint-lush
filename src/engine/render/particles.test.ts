import { describe, expect, it } from 'vitest';
import {
  BOMB_DROPLETS,
  BOMB_LIFE,
  BOMB_SMOKE,
  CHARGE_DROPLETS,
  CONFETTI_COUNT,
  CONFETTI_LIFE,
  DROPLET_CAPACITY,
  DROPLET_LIFE,
  FOV_BOOST_DEGREES,
  FovBoostState,
  IMPACT_DROPLETS,
  PAINT_DROPLETS,
  PAINT_SPEED_MAX,
  PAINT_SPEED_MIN,
  ParticleSystem,
  SHAKE_AMPLITUDE,
  SHOOT_DROPLETS,
  SHOOT_FLASH_LIFE,
  SWING_DROPLETS,
  ShakeState,
} from './particles';
import type { ParticlePool, Rgb } from './particles';

const TEAM_A: Rgb = { r: 0.9, g: 0.25, b: 0.2 };
const TEAM_B: Rgb = { r: 0.15, g: 0.4, b: 0.95 };
const WHITE: Rgb = { r: 1, g: 1, b: 1 };
const YELLOW: Rgb = { r: 1, g: 0.75, b: 0.2 };

function step(system: ParticleSystem, seconds: number): void {
  const dt = 1 / 120;
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i += 1) system.update(dt);
}

function poolIsFinite(pool: ParticlePool): boolean {
  for (let i = 0; i < pool.count; i += 1) {
    const fields = [
      pool.x[i],
      pool.y[i],
      pool.z[i],
      pool.vx[i],
      pool.vy[i],
      pool.vz[i],
      pool.life[i],
      pool.lifeMax[i],
      pool.r[i],
      pool.g[i],
      pool.b[i],
      pool.sizeStart[i],
      pool.sizeEnd[i],
      pool.accelY[i],
      pool.rotX[i],
      pool.rotY[i],
      pool.rotZ[i],
      pool.spinX[i],
      pool.spinY[i],
      pool.spinZ[i],
    ];
    for (const value of fields) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    }
  }
  return true;
}

describe('paint bursts', () => {
  it('emits eight team-coloured droplets upwards at 3 to 5 m/s for 0.6 s', () => {
    const system = new ParticleSystem();
    const emitted = system.spawnPaint({ x: 2, y: 1, z: -3 }, TEAM_A);

    expect(emitted).toBe(true);
    expect(system.droplets.count).toBe(PAINT_DROPLETS);

    const pool = system.droplets;
    for (let i = 0; i < pool.count; i += 1) {
      const vx = pool.vx[i] ?? 0;
      const vy = pool.vy[i] ?? 0;
      const vz = pool.vz[i] ?? 0;
      const speed = Math.hypot(vx, vy, vz);

      expect(speed).toBeGreaterThanOrEqual(PAINT_SPEED_MIN - 1e-6);
      expect(speed).toBeLessThanOrEqual(PAINT_SPEED_MAX + 1e-6);
      expect(vy).toBeGreaterThanOrEqual(-1e-6);
      expect(pool.lifeMax[i] ?? 0).toBeCloseTo(DROPLET_LIFE, 5);
      expect(pool.r[i] ?? 0).toBeCloseTo(TEAM_A.r, 5);
      expect(pool.g[i] ?? 0).toBeCloseTo(TEAM_A.g, 5);
      expect(pool.b[i] ?? 0).toBeCloseTo(TEAM_A.b, 5);
      expect(Math.hypot((pool.x[i] ?? 0) - 2, (pool.z[i] ?? 0) + 3)).toBeLessThan(0.2);
    }
  });

  it('allows at most one burst per 30 ms', () => {
    const system = new ParticleSystem();

    expect(system.spawnPaint({ x: 0, y: 0, z: 0 }, TEAM_A)).toBe(true);
    expect(system.spawnPaint({ x: 0, y: 0, z: 0 }, TEAM_B)).toBe(false);
    expect(system.droplets.count).toBe(PAINT_DROPLETS);

    system.update(0.02);
    expect(system.spawnPaint({ x: 0, y: 0, z: 0 }, TEAM_B)).toBe(false);

    system.update(0.02);
    expect(system.spawnPaint({ x: 0, y: 0, z: 0 }, TEAM_B)).toBe(true);
    expect(system.droplets.count).toBe(PAINT_DROPLETS * 2);
  });
});

describe('impact and shoot flashes', () => {
  it('emits four white droplets on impact', () => {
    const system = new ParticleSystem();
    system.spawnImpact({ x: 0, y: 0, z: 0 }, WHITE);

    expect(system.droplets.count).toBe(IMPACT_DROPLETS);
    for (let i = 0; i < system.droplets.count; i += 1) {
      expect(system.droplets.r[i] ?? 0).toBeCloseTo(1, 5);
      expect(system.droplets.g[i] ?? 0).toBeCloseTo(1, 5);
      expect(system.droplets.b[i] ?? 0).toBeCloseTo(1, 5);
    }
  });

  it('makes a three droplet, 0.08 s yellow star flash when shooting', () => {
    const system = new ParticleSystem();
    system.spawnShootFlash({ x: 1, y: 2, z: 3 }, YELLOW);

    expect(system.droplets.count).toBe(SHOOT_DROPLETS);
    for (let i = 0; i < system.droplets.count; i += 1) {
      expect(system.droplets.lifeMax[i] ?? 0).toBeCloseTo(SHOOT_FLASH_LIFE, 5);
      expect(system.droplets.r[i] ?? 0).toBeCloseTo(YELLOW.r, 5);
    }
  });
});

describe('kill bursts', () => {
  it('creates six smoke puffs and six leaves, twelve pieces total', () => {
    const system = new ParticleSystem();
    system.spawnKill({ x: 1, y: 0, z: 1 }, WHITE, { r: 0.4, g: 0.8, b: 0.4 });

    const pieces = system.smoke.count + system.leaves.count;
    expect(pieces).toBe(12);
    expect(pieces).toBeLessThanOrEqual(12);
    expect(system.smoke.count).toBe(6);
    expect(system.leaves.count).toBe(6);
    expect(system.droplets.count).toBe(0);
  });

  it('leaves every particle dead one second after a kill burst', () => {
    const system = new ParticleSystem();
    system.spawnKill({ x: 0, y: 1, z: 0 }, WHITE, { r: 0.4, g: 0.8, b: 0.4 });

    step(system, 1);

    expect(system.droplets.count).toBe(0);
    expect(system.smoke.count).toBe(0);
    expect(system.leaves.count).toBe(0);
  });

  it('grows smoke from 0.3 to 1.4 and retires it after 0.4 s', () => {
    const system = new ParticleSystem();
    system.spawnKill({ x: 0, y: 0, z: 0 }, WHITE, { r: 0.4, g: 0.8, b: 0.4 });

    expect(system.smoke.sizeStart[0] ?? 0).toBeCloseTo(0.3, 5);
    expect(system.smoke.sizeEnd[0] ?? 0).toBeCloseTo(1.4, 5);
    expect(system.smoke.lifeMax[0] ?? 0).toBeCloseTo(0.4, 5);

    step(system, 0.5);
    expect(system.smoke.count).toBe(0);
    expect(system.leaves.count).toBeGreaterThan(0);
  });
});

describe('capacity', () => {
  it('never exceeds its configured droplet capacity and recycles the oldest', () => {
    const capacity = 10;
    const system = new ParticleSystem(capacity);

    for (let i = 0; i < 40; i += 1) {
      system.update(0.05);
      system.spawnPaint({ x: i, y: 0, z: 0 }, TEAM_A);
      expect(system.droplets.count).toBeLessThanOrEqual(capacity);
    }

    system.spawnConfetti({ x: 0, y: 4, z: 0 }, TEAM_A, TEAM_B);
    expect(system.droplets.count).toBe(capacity);

    // The last burst was at the origin, so the recycled slots sit near it.
    for (let i = 0; i < system.droplets.count; i += 1) {
      expect(Math.hypot(system.droplets.x[i] ?? 0, system.droplets.z[i] ?? 0)).toBeLessThan(3.5);
    }
  });

  it('replaces the oldest particle when a full pool must make room', () => {
    const system = new ParticleSystem(2);
    system.spawnImpact({ x: 50, y: 0, z: 0 }, WHITE);
    system.spawnShootFlash({ x: -50, y: 0, z: 0 }, YELLOW);

    expect(system.droplets.count).toBe(2);
    for (let i = 0; i < 2; i += 1) {
      expect(system.droplets.x[i] ?? 0).toBeLessThan(0);
      expect(system.droplets.lifeMax[i] ?? 0).toBeCloseTo(SHOOT_FLASH_LIFE, 5);
    }
  });

  it('defaults to the desktop octahedron capacity', () => {
    const system = new ParticleSystem();
    expect(system.droplets.capacity).toBe(DROPLET_CAPACITY);
  });
});

describe('confetti', () => {
  it('spawns 120 pieces in both team colours for three seconds', () => {
    const system = new ParticleSystem();
    system.spawnConfetti({ x: 0, y: 4, z: 0 }, TEAM_A, TEAM_B);

    expect(system.droplets.count).toBe(CONFETTI_COUNT);
    expect(system.droplets.r[0] ?? 0).toBeCloseTo(TEAM_A.r, 4);
    expect(system.droplets.r[1] ?? 0).toBeCloseTo(TEAM_B.r, 4);
    expect(system.droplets.lifeMax[0] ?? 0).toBeCloseTo(CONFETTI_LIFE, 5);

    step(system, 2.9);
    expect(system.droplets.count).toBeGreaterThan(0);

    step(system, 0.2);
    expect(system.droplets.count).toBe(0);
  });
});

describe('camera shake', () => {
  it('starts at 0.08 m and decays to exactly zero', () => {
    const shake = new ShakeState();
    const out = { x: 0, y: 0, z: 0 };

    shake.read(out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });

    shake.trigger();
    shake.read(out);
    const startMagnitude = Math.hypot(out.x, out.y, out.z);
    expect(startMagnitude).toBeCloseTo(SHAKE_AMPLITUDE, 5);
    expect(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)).toBe(true);

    shake.update(0.06);
    shake.read(out);
    const laterMagnitude = Math.hypot(out.x, out.y, out.z);
    expect(laterMagnitude).toBeLessThan(startMagnitude);
    expect(laterMagnitude).toBeGreaterThan(0);

    shake.update(0.2);
    shake.read(out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('re-triggers back to full strength', () => {
    const shake = new ShakeState();
    const out = { x: 0, y: 0, z: 0 };

    shake.trigger();
    shake.update(0.15);
    shake.trigger();
    shake.read(out);

    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(SHAKE_AMPLITUDE, 5);
  });
});

describe('field of view boost', () => {
  it('eases up to eight degrees over 0.3 s and back to zero', () => {
    const fov = new FovBoostState();

    expect(fov.value()).toBe(0);
    fov.start();
    expect(fov.value()).toBe(0);

    fov.update(0.15);
    expect(fov.value()).toBeGreaterThan(0);
    expect(fov.value()).toBeLessThan(FOV_BOOST_DEGREES);
    expect(fov.value()).toBeCloseTo(FOV_BOOST_DEGREES / 2, 5);

    fov.update(0.15);
    expect(fov.value()).toBeCloseTo(FOV_BOOST_DEGREES, 5);

    fov.end();
    fov.update(0.3);
    expect(fov.value()).toBeCloseTo(0, 6);
  });

  it('stays at zero when the boost is ended while idle', () => {
    const fov = new FovBoostState();
    fov.end();
    fov.update(0.1);
    expect(fov.value()).toBe(0);
  });
});

describe('smoke bomb and weapon sparks', () => {
  it('throws 24 team droplets and six smoke puffs for a bomb burst', () => {
    const system = new ParticleSystem();
    system.spawnBombBurst({ x: 1, y: 0, z: 2 }, TEAM_B, WHITE);

    expect(system.droplets.count).toBe(BOMB_DROPLETS);
    expect(system.smoke.count).toBe(BOMB_SMOKE);
    for (let i = 0; i < system.droplets.count; i += 1) {
      expect(system.droplets.r[i] ?? 0).toBeCloseTo(TEAM_B.r, 5);
      expect(system.droplets.g[i] ?? 0).toBeCloseTo(TEAM_B.g, 5);
      expect(system.droplets.b[i] ?? 0).toBeCloseTo(TEAM_B.b, 5);
      expect(system.droplets.lifeMax[i] ?? 0).toBeCloseTo(BOMB_LIFE, 5);
    }
  });

  it('emits small sparks for charge and swing without touching smoke', () => {
    const system = new ParticleSystem();
    system.spawnCharge({ x: 0, y: 1, z: 0 }, YELLOW);
    expect(system.droplets.count).toBe(CHARGE_DROPLETS);

    system.spawnSwing({ x: 0, y: 1, z: 0 }, YELLOW);
    expect(system.droplets.count).toBe(CHARGE_DROPLETS + SWING_DROPLETS);
    expect(system.smoke.count).toBe(0);
  });
});

describe('finite values', () => {
  it('sanitises hostile spawn inputs and keeps every pool finite', () => {
    const system = new ParticleSystem(32);
    const bad = { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
    const badColor: Rgb = { r: Number.NaN, g: Number.POSITIVE_INFINITY, b: -1 };

    system.spawnPaint(bad, badColor);
    system.spawnImpact(bad, badColor);
    system.spawnShootFlash(bad, badColor);
    system.spawnKill(bad, badColor, badColor);
    system.spawnConfetti(bad, badColor, badColor);

    expect(poolIsFinite(system.droplets)).toBe(true);
    expect(poolIsFinite(system.smoke)).toBe(true);
    expect(poolIsFinite(system.leaves)).toBe(true);

    for (let i = 0; i < 40; i += 1) system.update(0.05);

    expect(poolIsFinite(system.droplets)).toBe(true);
    expect(poolIsFinite(system.smoke)).toBe(true);
    expect(poolIsFinite(system.leaves)).toBe(true);
  });

  it('treats a non-finite frame delta as no time passing', () => {
    const system = new ParticleSystem();
    system.spawnPaint({ x: 0, y: 0, z: 0 }, TEAM_A);

    const before = system.droplets.life[0] ?? 0;
    system.update(Number.NaN);
    system.update(Number.POSITIVE_INFINITY);

    expect(system.droplets.life[0] ?? 0).toBeCloseTo(before, 6);
    expect(system.droplets.count).toBe(PAINT_DROPLETS);
  });
});
