import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { InputActions } from '../../core/actions';
import { emptyActions } from '../../core/actions';
import type { GameEvent } from '../../core/events';
import type {
  CellValue,
  Face,
  SurfaceHit,
  SurfaceId,
  Vec3,
} from '../../core/types';
import { NO_TEAM } from '../../core/types';
import type {
  DamageHit,
  ICollision,
  IPaintGrid,
  MoveResult,
  PlayerState,
  SurfaceGrid,
} from '../contracts';
import type { PlayerConfig, StageData } from '../data/schemas';
import { createPaintGrid } from '../paint/paintGrid';
import { createCollision } from '../physics/collision';
import {
  applyDamage,
  canFire,
  createPlayer,
  stepPlayer,
  type PlayerEnv,
} from './player';

const DT = 1 / 60;
const ID = 7;
const spawn: Vec3 = { x: 0, y: 0.9, z: 0 };

function config(overrides: Partial<PlayerConfig> = {}): PlayerConfig {
  return {
    halfExtents: { x: 0.3, y: 0.9, z: 0.3 },
    gravity: 20,
    walkSpeed: 5,
    diveSpeed: 9,
    enemyInkSpeed: 2,
    airControl: 0.5,
    acceleration: 40,
    jumpSpeed: 7,
    wallClimbSpeed: 4,
    maxHp: 100,
    enemyInkDps: 20,
    enemyInkMinHp: 10,
    diveHealPerSec: 30,
    respawnSeconds: 3,
    respawnInvulnSeconds: 2,
    maxInk: 100,
    inkRegenDive: 40,
    inkRegenIdle: 10,
    diveTransitionSeconds: 0.2,
    fireLockAfterDiveSeconds: 0.3,
    ...overrides,
  };
}

function actions(patch: Partial<InputActions> = {}): InputActions {
  return { ...emptyActions(), ...patch };
}

class TestCollision implements ICollision {
  floorY = 0;
  hasFloor = true;
  wallX: number | null = null;
  wallTop = Infinity;

  moveAndSlide(pos: Vec3, vel: Vec3, half: Vec3, dt: number): MoveResult {
    const outPos: Vec3 = {
      x: pos.x + vel.x * dt,
      y: pos.y + vel.y * dt,
      z: pos.z + vel.z * dt,
    };
    const outVel: Vec3 = { x: vel.x, y: vel.y, z: vel.z };
    let grounded = false;
    let ground: SurfaceHit | null = null;
    let wall: SurfaceHit | null = null;

    if (this.hasFloor && outPos.y - half.y <= this.floorY && outVel.y <= 0) {
      outPos.y = this.floorY + half.y;
      outVel.y = 0;
      grounded = true;
      ground = {
        pos: { x: outPos.x, y: this.floorY, z: outPos.z },
        normal: { x: 0, y: 1, z: 0 },
        boxIndex: 0,
        face: '+y',
      };
    }

    if (
      this.wallX !== null &&
      outPos.x + half.x > this.wallX &&
      outPos.y - half.y < this.wallTop
    ) {
      outPos.x = this.wallX - half.x;
      outVel.x = 0;
      wall = {
        pos: { x: this.wallX, y: outPos.y, z: outPos.z },
        normal: { x: -1, y: 0, z: 0 },
        boxIndex: 1,
        face: '-x',
      };
    }

    return { pos: outPos, vel: outVel, grounded, ground, wall };
  }

  raycast(): SurfaceHit | null {
    return null;
  }

  containsPoint(): boolean {
    return false;
  }
}

class TestPaint implements IPaintGrid {
  readonly surfaces: readonly SurfaceGrid[] = [];
  groundTeam: CellValue = NO_TEAM;
  wallTeam: CellValue = NO_TEAM;

  surfaceAt(): SurfaceId | null {
    return null;
  }

  sampleHit(hit: SurfaceHit): CellValue {
    void (hit.face satisfies Face);
    return hit.boxIndex === 1 ? this.wallTeam : this.groundTeam;
  }

  splatHit(): number {
    return 0;
  }

  splat(): number {
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

function makeEnv(): { env: PlayerEnv; collision: TestCollision; paint: TestPaint } {
  const collision = new TestCollision();
  const paint = new TestPaint();
  return { env: { collision, paint, spawn: { ...spawn } }, collision, paint };
}

function run(
  p: PlayerState,
  input: InputActions,
  env: PlayerEnv,
  cfg: PlayerConfig,
  ticks: number,
): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i += 1) {
    events.push(...stepPlayer(p, input, env, cfg, DT));
  }
  return events;
}

function count(events: readonly GameEvent[], type: GameEvent['t']): number {
  return events.filter((event) => event.t === type).length;
}

/** Reads the live state without narrowing it in the caller's control flow. */
function inState(p: PlayerState, state: PlayerState['state']): boolean {
  return p.state === state;
}

describe('createPlayer', () => {
  it('copies the spawn and starts full, idle and facing forward', () => {
    const cfg = config();
    const p = createPlayer(42, 1, { x: 3, y: 4, z: 5 }, cfg);
    expect(p).toMatchObject({
      id: 42,
      team: 1,
      state: 'stance',
      pos: { x: 3, y: 4, z: 5 },
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      hp: 100,
      ink: 100,
      diveTransition: 0,
      fireLock: 0,
      respawnTimer: 0,
      invuln: 0,
      prevDive: false,
      prevJump: false,
    });
    const source = { x: 1, y: 2, z: 3 };
    const other = createPlayer(1, 0, source, cfg);
    source.x = 99;
    expect(other.pos).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('orientation', () => {
  it('adds look input to yaw and pitch', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, spawn, cfg);
    stepPlayer(p, actions({ look: [0.5, 0.4] }), env, cfg, DT);
    expect(p.yaw).toBeCloseTo(0.5, 10);
    expect(p.pitch).toBeCloseTo(0.4, 10);
  });

  it('wraps yaw into (-PI, PI]', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, spawn, cfg);
    p.yaw = 3.1;
    stepPlayer(p, actions({ look: [0.3, 0] }), env, cfg, DT);
    expect(p.yaw).toBeGreaterThan(-Math.PI);
    expect(p.yaw).toBeLessThanOrEqual(Math.PI);
    expect(p.yaw).toBeCloseTo(3.4 - Math.PI * 2, 10);

    p.yaw = -3.1;
    stepPlayer(p, actions({ look: [-0.2, 0] }), env, cfg, DT);
    expect(p.yaw).toBeCloseTo(-3.3 + Math.PI * 2, 10);
  });

  it('clamps pitch to +-1.2 and ignores non-finite look', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, spawn, cfg);
    stepPlayer(p, actions({ look: [0, 5] }), env, cfg, DT);
    expect(p.pitch).toBe(1.2);
    stepPlayer(p, actions({ look: [0, -10] }), env, cfg, DT);
    expect(p.pitch).toBe(-1.2);
    stepPlayer(p, actions({ look: [Number.NaN, Number.POSITIVE_INFINITY] }), env, cfg, DT);
    expect(Number.isFinite(p.yaw)).toBe(true);
    expect(p.pitch).toBe(-1.2);
  });
});

describe('dive form', () => {
  it('enters dive, arms the transition and emits a dive event', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);

    const events = stepPlayer(p, actions({ dive: true }), env, cfg, DT);
    expect(p.state).toBe('dive');
    expect(p.diveTransition).toBeCloseTo(cfg.diveTransitionSeconds, 10);
    expect(p.fireLock).toBe(0);
    expect(count(events, 'dive')).toBe(1);
    expect(events.find((e) => e.t === 'dive')).toMatchObject({ in: true, id: ID });
    expect(canFire(p)).toBe(false);

    const again = stepPlayer(p, actions({ dive: true }), env, cfg, DT);
    expect(count(again, 'dive')).toBe(0);
    expect(p.diveTransition).toBeCloseTo(cfg.diveTransitionSeconds - DT, 10);
  });

  it('leaves dive on release, arms the fire lock and allows fire afterwards', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    stepPlayer(p, actions({ dive: true }), env, cfg, DT);

    const events = stepPlayer(p, actions(), env, cfg, DT);
    expect(p.state).toBe('stance');
    expect(p.fireLock).toBeCloseTo(cfg.fireLockAfterDiveSeconds, 10);
    expect(p.diveTransition).toBeCloseTo(cfg.diveTransitionSeconds, 10);
    expect(events.find((e) => e.t === 'dive')).toMatchObject({ in: false, id: ID });
    expect(canFire(p)).toBe(false);

    run(p, actions(), env, cfg, 20);
    expect(p.diveTransition).toBe(0);
    expect(p.fireLock).toBe(0);
    expect(canFire(p)).toBe(true);
  });

  it('arms the fire lock and exits the form when jumping out of dive', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    run(p, actions({ dive: true }), env, cfg, 3);
    expect(p.state).toBe('dive');

    const events = stepPlayer(p, actions({ dive: true, jump: true }), env, cfg, DT);
    expect(p.state).toBe('air');
    expect(p.fireLock).toBeCloseTo(cfg.fireLockAfterDiveSeconds, 10);
    expect(canFire(p)).toBe(false);
    expect(count(events, 'jump')).toBe(1);
    const exits = events.filter((event) => event.t === 'dive');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ in: false, id: ID });
  });

  it('arms the fire lock when diving off a ledge into air', () => {
    const cfg = config();
    const { env, paint, collision } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    run(p, actions({ dive: true, move: [1, 0] }), env, cfg, 5);
    expect(p.state).toBe('dive');

    collision.hasFloor = false;
    const events = stepPlayer(p, actions({ dive: true, move: [1, 0] }), env, cfg, DT);
    expect(p.state).toBe('air');
    expect(p.fireLock).toBeCloseTo(cfg.fireLockAfterDiveSeconds, 10);
    expect(canFire(p)).toBe(false);
    const exits = events.filter((event) => event.t === 'dive');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ in: false, id: ID });
  });

  it('does not re-arm the fire lock on later air or stance ticks', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    run(p, actions({ dive: true }), env, cfg, 3);
    stepPlayer(p, actions({ dive: true, jump: true }), env, cfg, DT);
    const armed = p.fireLock;
    run(p, actions({ dive: true }), env, cfg, 2);
    expect(p.state).toBe('air');
    expect(p.fireLock).toBeLessThan(armed);
    expect(p.fireLock).toBeCloseTo(armed - DT * 2, 10);
  });
});

describe('jump and airborne state', () => {
  it('jumps on a rising edge only and lands with a land event', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, spawn, cfg);

    const jumpEvents = stepPlayer(p, actions({ jump: true }), env, cfg, DT);
    expect(count(jumpEvents, 'jump')).toBe(1);
    expect(p.state).toBe('air');
    expect(p.vel.y).toBeCloseTo(cfg.jumpSpeed, 10);

    const heldEvents = stepPlayer(p, actions({ jump: true }), env, cfg, DT);
    expect(count(heldEvents, 'jump')).toBe(0);
    expect(p.state).toBe('air');

    const releaseEvents = stepPlayer(p, actions({ jump: false }), env, cfg, DT);
    expect(count(releaseEvents, 'jump')).toBe(0);

    const landing: GameEvent[] = [];
    for (let i = 0; i < 240 && p.state === 'air'; i += 1) {
      landing.push(...stepPlayer(p, actions(), env, cfg, DT));
    }
    expect(p.state).toBe('stance');
    expect(count(landing, 'land')).toBe(1);
  });

  it('stays in air while dive is held and dives on landing', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    stepPlayer(p, actions({ jump: true }), env, cfg, DT);

    const airborne = stepPlayer(p, actions({ dive: true }), env, cfg, DT);
    expect(p.state).toBe('air');
    expect(count(airborne, 'dive')).toBe(0);

    const events: GameEvent[] = [];
    for (let i = 0; i < 240 && p.state === 'air'; i += 1) {
      events.push(...stepPlayer(p, actions({ dive: true }), env, cfg, DT));
    }
    expect(p.state).toBe('dive');
    expect(count(events, 'land')).toBe(1);
    expect(events.find((e) => e.t === 'dive')).toMatchObject({ in: true, id: ID });
    expect(p.diveTransition).toBeCloseTo(cfg.diveTransitionSeconds, 10);
  });

  it('jumps out of dive and applies no dive form change until landing', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    run(p, actions({ dive: true }), env, cfg, 3);
    expect(p.state).toBe('dive');

    const events = stepPlayer(p, actions({ dive: true, jump: true }), env, cfg, DT);
    expect(p.state).toBe('air');
    expect(count(events, 'jump')).toBe(1);
  });

  it('applies gravity every airborne step', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, { x: 0, y: 10, z: 0 }, cfg);
    p.state = 'air';
    stepPlayer(p, actions(), env, cfg, DT);
    expect(p.vel.y).toBeCloseTo(-cfg.gravity * DT, 10);
    stepPlayer(p, actions(), env, cfg, DT);
    expect(p.vel.y).toBeCloseTo(-cfg.gravity * DT * 2, 10);
    expect(p.state).toBe('air');
  });
});

describe('movement speeds from ground colour', () => {
  const cases: Array<{ label: string; dive: boolean; ground: CellValue; expected: number }> = [
    { label: 'dive on own ink', dive: true, ground: 0, expected: 9 },
    { label: 'dive on unpainted', dive: true, ground: NO_TEAM, expected: 2 },
    { label: 'dive on enemy ink', dive: true, ground: 1, expected: 2 },
    { label: 'stance on own ink', dive: false, ground: 0, expected: 5 },
    { label: 'stance on unpainted', dive: false, ground: NO_TEAM, expected: 5 },
    { label: 'stance on enemy ink', dive: false, ground: 1, expected: 2 },
  ];

  for (const item of cases) {
    it(`moves at ${item.expected} for ${item.label}`, () => {
      const cfg = config();
      const { env, paint } = makeEnv();
      paint.groundTeam = item.ground;
      const p = createPlayer(ID, 0, spawn, cfg);
      run(p, actions({ dive: item.dive, move: [1, 0] }), env, cfg, 120);
      expect(p.vel.x).toBeCloseTo(item.expected, 6);
      expect(p.vel.z).toBeCloseTo(0, 10);
      expect(Number.isFinite(p.vel.y)).toBe(true);
    });
  }
});

describe('acceleration', () => {
  it('ramps ground velocity towards the target speed', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, spawn, cfg);
    stepPlayer(p, actions({ move: [1, 0] }), env, cfg, DT);
    expect(p.vel.x).toBeCloseTo(cfg.acceleration * DT, 10);
    stepPlayer(p, actions({ move: [1, 0] }), env, cfg, DT);
    expect(p.vel.x).toBeCloseTo(cfg.acceleration * DT * 2, 10);
  });

  it('scales air acceleration by airControl', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, { x: 0, y: 10, z: 0 }, cfg);
    p.state = 'air';
    stepPlayer(p, actions({ move: [1, 0] }), env, cfg, DT);
    expect(p.vel.x).toBeCloseTo(cfg.acceleration * cfg.airControl * DT, 10);
  });

  it('decelerates with no input at the same rate', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, spawn, cfg);
    p.vel.x = 5;
    stepPlayer(p, actions(), env, cfg, DT);
    expect(p.vel.x).toBeCloseTo(5 - cfg.acceleration * DT, 10);
    run(p, actions(), env, cfg, 20);
    expect(p.vel.x).toBeCloseTo(0, 10);
  });
});

describe('wall climb', () => {
  function wallSetup(wallTeam: CellValue): {
    p: PlayerState;
    env: PlayerEnv;
    paint: TestPaint;
    collision: TestCollision;
    cfg: PlayerConfig;
  } {
    const cfg = config();
    const { env, paint, collision } = makeEnv();
    collision.wallX = 2;
    collision.wallTop = 3;
    paint.groundTeam = 0;
    paint.wallTeam = wallTeam;
    const p = createPlayer(ID, 0, { x: 1.55, y: 0.9, z: 0 }, cfg);
    p.yaw = Math.PI / 2;
    return { p, env, paint, collision, cfg };
  }

  it('climbs an own-ink wall without gravity and nudges onto the ledge', () => {
    const { p, env, cfg } = wallSetup(0);
    let sawClimbVelocity = false;
    let maxY = 0;
    let xAtTop = 0;
    for (let i = 0; i < 240; i += 1) {
      stepPlayer(p, actions({ dive: true, move: [0, 1] }), env, cfg, DT);
      if (p.vel.y === cfg.wallClimbSpeed) sawClimbVelocity = true;
      maxY = Math.max(maxY, p.pos.y);
      if (xAtTop === 0 && p.pos.y >= 3.89) xAtTop = p.pos.x;
    }
    expect(sawClimbVelocity).toBe(true);
    expect(maxY).toBeGreaterThan(3.5);
    expect(xAtTop).toBeGreaterThan(1.85);
  });

  it('does not climb an unpainted or enemy wall', () => {
    for (const team of [NO_TEAM, 1] as const) {
      const { p, env, cfg } = wallSetup(team);
      let maxY = 0;
      for (let i = 0; i < 120; i += 1) {
        stepPlayer(p, actions({ dive: true, move: [0, 1] }), env, cfg, DT);
        maxY = Math.max(maxY, p.pos.y);
      }
      expect(maxY).toBeLessThan(1.0);
    }
  });

  it('needs forward input, not just contact', () => {
    const { p, env, cfg } = wallSetup(0);
    p.yaw = 0;
    let maxY = 0;
    for (let i = 0; i < 120; i += 1) {
      stepPlayer(p, actions({ dive: true, move: [1, 0] }), env, cfg, DT);
      maxY = Math.max(maxY, p.pos.y);
    }
    expect(maxY).toBeLessThan(1.0);
  });
});

describe('ink and damage from ink', () => {
  it('regenerates ink quickly while diving on own ink', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    p.ink = 10;
    stepPlayer(p, actions({ dive: true }), env, cfg, DT);
    const before = p.ink;
    run(p, actions({ dive: true }), env, cfg, 60);
    expect(p.ink).toBeCloseTo(before + cfg.inkRegenDive, 6);
    expect(p.ink).toBeLessThanOrEqual(cfg.maxInk);
  });

  it('clamps dive regeneration at max ink', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    p.ink = 99;
    run(p, actions({ dive: true }), env, cfg, 120);
    expect(p.ink).toBe(cfg.maxInk);
  });

  it('regenerates idle ink only when stance, not firing and not moving', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const idle = createPlayer(ID, 0, spawn, cfg);
    idle.ink = 50;
    stepPlayer(idle, actions(), env, cfg, DT);
    const before = idle.ink;
    run(idle, actions(), env, cfg, 60);
    expect(idle.ink).toBeCloseTo(before + cfg.inkRegenIdle, 6);

    const moving = createPlayer(ID, 0, spawn, cfg);
    moving.ink = 50;
    run(moving, actions({ move: [1, 0] }), env, cfg, 60);
    expect(moving.ink).toBeCloseTo(50, 6);

    const firing = createPlayer(ID, 0, spawn, cfg);
    firing.ink = 50;
    run(firing, actions({ fire: true }), env, cfg, 60);
    expect(firing.ink).toBeCloseTo(50, 6);
  });

  it('takes enemy ink damage per second down to the floor', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 1;
    const p = createPlayer(ID, 0, spawn, cfg);
    stepPlayer(p, actions(), env, cfg, DT);
    const before = p.hp;
    run(p, actions(), env, cfg, 60);
    expect(p.hp).toBeCloseTo(before - cfg.enemyInkDps, 6);

    const low = createPlayer(ID, 0, spawn, cfg);
    low.hp = 15;
    run(low, actions(), env, cfg, 600);
    expect(low.hp).toBeCloseTo(cfg.enemyInkMinHp, 6);
  });

  it('heals while diving on own ink, clamped to max hp', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    p.hp = 50;
    stepPlayer(p, actions({ dive: true }), env, cfg, DT);
    const before = p.hp;
    run(p, actions({ dive: true }), env, cfg, 60);
    expect(p.hp).toBeCloseTo(before + cfg.diveHealPerSec, 6);

    const full = createPlayer(ID, 0, spawn, cfg);
    full.hp = 95;
    run(full, actions({ dive: true }), env, cfg, 60);
    expect(full.hp).toBe(cfg.maxHp);
  });

  it('does not heal in stance on own ink', () => {
    const cfg = config();
    const { env, paint } = makeEnv();
    paint.groundTeam = 0;
    const p = createPlayer(ID, 0, spawn, cfg);
    p.hp = 50;
    run(p, actions(), env, cfg, 60);
    expect(p.hp).toBe(50);
  });
});

describe('damage, death and respawn', () => {
  function hit(damage: number): DamageHit {
    return { target: ID, attacker: 99, damage, pos: { x: 1, y: 2, z: 3 } };
  }

  it('ignores damage while invulnerable or down', () => {
    const cfg = config();
    const p = createPlayer(ID, 0, spawn, cfg);
    p.invuln = 1;
    expect(applyDamage(p, hit(50), cfg)).toEqual([]);
    expect(p.hp).toBe(100);

    p.invuln = 0;
    p.state = 'down';
    expect(applyDamage(p, hit(50), cfg)).toEqual([]);
    expect(p.hp).toBe(100);
  });

  it('emits hit and kill and enters down with a respawn timer', () => {
    const cfg = config();
    const p = createPlayer(ID, 0, spawn, cfg);
    p.hp = 10;
    p.vel.x = 3;
    const events = applyDamage(p, hit(30), cfg);
    expect(count(events, 'hit')).toBe(1);
    expect(count(events, 'kill')).toBe(1);
    expect(events[0]).toMatchObject({ t: 'hit', target: ID, damage: 30 });
    expect(events[1]).toMatchObject({ t: 'kill', killer: 99, victim: ID });
    expect(p.hp).toBe(0);
    expect(p.state).toBe('down');
    expect(p.respawnTimer).toBeCloseTo(cfg.respawnSeconds, 10);
    expect(p.vel).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('ignores input while down and teleports only at the respawn tick', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, { x: 4, y: 0.9, z: 4 }, cfg);
    applyDamage(p, hit(200), cfg);
    const deathPos = { ...p.pos };

    const events: GameEvent[] = [];
    for (let i = 0; i < 120; i += 1) {
      events.push(...stepPlayer(p, actions({ move: [1, 0], look: [1, 0], jump: true }), env, cfg, DT));
    }
    expect(p.pos).toEqual(deathPos);
    expect(p.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(p.yaw).toBe(0);
    expect(count(events, 'jump')).toBe(0);
    expect(p.state).toBe('down');

    let guard = 0;
    while (p.state === 'down' && guard < 300) {
      expect(p.pos).toEqual(deathPos);
      events.push(...stepPlayer(p, actions(), env, cfg, DT));
      guard += 1;
    }
    expect(p.state).toBe('respawn');
    expect(p.pos).toEqual(deathPos);
    expect(p.hp).toBe(0);

    let respawnStep: GameEvent[] = [];
    guard = 0;
    while (inState(p, 'respawn') && guard < 300) {
      expect(p.pos).toEqual(deathPos);
      const stepEvents = stepPlayer(p, actions(), env, cfg, DT);
      if (inState(p, 'stance')) respawnStep = stepEvents;
      events.push(...stepEvents);
      guard += 1;
    }
    expect(p.state).toBe('stance');
    expect(p.pos).toEqual(spawn);
    expect(respawnStep).toHaveLength(1);
    expect(respawnStep[0]).toMatchObject({ t: 'respawn', id: ID, pos: spawn });
    expect(p.hp).toBe(cfg.maxHp);
    expect(p.ink).toBe(cfg.maxInk);
    expect(p.invuln).toBeCloseTo(cfg.respawnInvulnSeconds, 10);
    expect(count(events, 'respawn')).toBe(1);
  });

  it('holds the death position for the whole timer and teleports on the event tick', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, { x: -3, y: 0.9, z: 2 }, cfg);
    applyDamage(p, hit(999), cfg);
    const deathPos = { ...p.pos };

    let respawnTick = -1;
    let sawRespawnState = false;
    for (let i = 0; i < 400; i += 1) {
      const events = stepPlayer(p, actions(), env, cfg, DT);
      const respawnEvent = events.find((event) => event.t === 'respawn');
      if (respawnEvent !== undefined) {
        respawnTick = i + 1;
        expect(respawnEvent.pos).toEqual(spawn);
        expect(p.pos).toEqual(spawn);
        break;
      }
      if (p.state === 'respawn') sawRespawnState = true;
      expect(p.pos).toEqual(deathPos);
    }

    expect(sawRespawnState).toBe(true);
    expect(respawnTick).toBeGreaterThan(60 * 2.5);
    expect(respawnTick).toBeLessThanOrEqual(60 * 3 + 1);
  });

  it('ticks diveTransition, fireLock and invuln down to zero', () => {
    const cfg = config();
    const { env } = makeEnv();
    const p = createPlayer(ID, 0, spawn, cfg);
    p.diveTransition = 0.1;
    p.fireLock = 0.2;
    p.invuln = 0.3;
    stepPlayer(p, actions(), env, cfg, DT);
    expect(p.diveTransition).toBeCloseTo(0.1 - DT, 10);
    expect(p.fireLock).toBeCloseTo(0.2 - DT, 10);
    expect(p.invuln).toBeCloseTo(0.3 - DT, 10);
    run(p, actions(), env, cfg, 30);
    expect(p.diveTransition).toBe(0);
    expect(p.fireLock).toBe(0);
    expect(p.invuln).toBe(0);
  });
});

describe('canFire', () => {
  it('depends on state and both timers', () => {
    const cfg = config();
    const p = createPlayer(ID, 0, spawn, cfg);
    expect(canFire(p)).toBe(true);
    p.fireLock = 0.1;
    expect(canFire(p)).toBe(false);
    p.fireLock = 0;
    p.diveTransition = 0.1;
    expect(canFire(p)).toBe(false);
    p.diveTransition = 0;
    p.state = 'air';
    expect(canFire(p)).toBe(true);
    p.state = 'dive';
    expect(canFire(p)).toBe(false);
    p.state = 'down';
    expect(canFire(p)).toBe(false);
    p.state = 'respawn';
    expect(canFire(p)).toBe(false);
  });
});

describe('real collision and paint grid', () => {
  it('climbs an own-ink wall and ends standing on top of the box', () => {
    const cfg = config();
    const half = cfg.halfExtents;
    const wallTop = 2;
    const wallBox: StageData['boxes'][number] = {
      box: { min: { x: 2, y: 0, z: -2 }, max: { x: 3, y: wallTop, z: 2 } },
      paintable: ['-x', '+y'],
    };
    const boxes: StageData['boxes'] = [
      {
        box: { min: { x: -8, y: -1, z: -4 }, max: { x: 8, y: 0, z: 4 } },
        paintable: ['+y'],
      },
      wallBox,
    ];
    const stage = { cellSize: 0.25, boxes };
    const collision = createCollision(stage);
    const paint = createPaintGrid(stage);
    for (const surface of paint.surfaces) {
      expect(paint.splat(surface.id, 2, 2, 16, 0)).toBeGreaterThan(0);
    }

    const p = createPlayer(ID, 0, { x: 1, y: half.y, z: 0 }, cfg);
    p.yaw = Math.PI / 2;
    const targetY = wallTop + half.y;

    let guard = 0;
    while (guard < 600) {
      // Keep pushing until the climb has carried the body over the lip, then
      // release so it settles on the top face instead of running off it.
      const stopPushing = p.state === 'air' || p.pos.y > targetY + 1e-6;
      const input = stopPushing
        ? actions({ dive: true })
        : actions({ dive: true, move: [0, 1] });
      stepPlayer(p, input, { collision, paint, spawn: { x: 1, y: half.y, z: 0 } }, cfg, DT);
      guard += 1;
      const settled = p.vel.y <= 0 && Math.abs(p.pos.y - targetY) <= 1e-3;
      if (settled && p.state !== 'air') break;
    }

    const wall = wallBox.box;
    expect(p.pos.y).toBeCloseTo(targetY, 6);
    expect(p.state).not.toBe('air');
    expect(p.state).toBe('dive');
    // The body is no longer beside the wall but over the top face.
    expect(p.pos.x - half.x).toBeLessThan(wall.max.x);
    expect(p.pos.x + half.x).toBeGreaterThan(wall.min.x);
    expect(p.pos.z - half.z).toBeLessThan(wall.max.z);
    expect(p.pos.z + half.z).toBeGreaterThan(wall.min.z);
  });
});

describe('finite-value properties', () => {
  const arbNumber = fc.oneof(
    fc.double({ min: -1000, max: 1000 }),
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constant(Number.NEGATIVE_INFINITY),
  );

  const arbActions = fc.record({
    move: fc.tuple(arbNumber, arbNumber),
    look: fc.tuple(arbNumber, arbNumber),
    fire: fc.boolean(),
    jump: fc.boolean(),
    dive: fc.boolean(),
    sub: fc.boolean(),
    special: fc.boolean(),
    pause: fc.boolean(),
  });

  it('keeps every player number finite and in range for wild input', () => {
    const cfg = config();
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbActions, fc.double({ min: 0, max: 0.2 })), {
          minLength: 1,
          maxLength: 120,
        }),
        (frames) => {
          const { env } = makeEnv();
          const p = createPlayer(ID, 1, spawn, cfg);
          for (const [input, dt] of frames) {
            stepPlayer(p, { ...input }, env, cfg, dt);
            for (const value of [
              p.pos.x,
              p.pos.y,
              p.pos.z,
              p.vel.x,
              p.vel.y,
              p.vel.z,
              p.yaw,
              p.pitch,
              p.hp,
              p.ink,
              p.diveTransition,
              p.fireLock,
              p.invuln,
              p.respawnTimer,
            ]) {
              expect(Number.isFinite(value)).toBe(true);
            }
            expect(p.pitch).toBeGreaterThanOrEqual(-1.2);
            expect(p.pitch).toBeLessThanOrEqual(1.2);
            expect(p.yaw).toBeGreaterThan(-Math.PI);
            expect(p.yaw).toBeLessThanOrEqual(Math.PI);
            expect(p.hp).toBeGreaterThanOrEqual(0);
            expect(p.hp).toBeLessThanOrEqual(cfg.maxHp);
            expect(p.ink).toBeGreaterThanOrEqual(0);
            expect(p.ink).toBeLessThanOrEqual(cfg.maxInk);
            expect(p.diveTransition).toBeGreaterThanOrEqual(0);
            expect(p.fireLock).toBeGreaterThanOrEqual(0);
            expect(p.invuln).toBeGreaterThanOrEqual(0);
            expect(p.respawnTimer).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('keeps damage events and hp finite for wild hits', () => {
    const cfg = config();
    fc.assert(
      fc.property(
        arbNumber,
        fc.tuple(arbNumber, arbNumber, arbNumber),
        fc.double({ min: 0, max: 0.05 }),
        (damage, pos, dt) => {
          const { env } = makeEnv();
          const p = createPlayer(ID, 0, spawn, cfg);
          if (Number.isFinite(dt) && dt > 0) {
            stepPlayer(p, actions(), env, cfg, dt);
          }
          const events = applyDamage(
            p,
            { target: ID, attacker: 1, damage, pos: { x: pos[0], y: pos[1], z: pos[2] } },
            cfg,
          );
          expect(Number.isFinite(p.hp)).toBe(true);
          expect(p.hp).toBeGreaterThanOrEqual(0);
          for (const event of events) {
            if (event.t === 'hit' || event.t === 'kill') {
              expect(Number.isFinite(event.pos.x)).toBe(true);
              expect(Number.isFinite(event.pos.y)).toBe(true);
              expect(Number.isFinite(event.pos.z)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
