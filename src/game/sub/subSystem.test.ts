import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../core/events';
import type { Box, CellValue, Face, SurfaceHit, SurfaceId, TeamId } from '../../core/types';
import { NO_TEAM } from '../../core/types';
import type {
  DamageHit,
  IPaintGrid,
  ShooterState,
  StepResult,
  SurfaceGrid,
  TargetState,
} from '../contracts';
import type { StageData, SubWeapon } from '../data/schemas';
import { createPaintGrid } from '../paint/paintGrid';
import { createCollision } from '../physics/collision';
import { createSubSystem } from './subSystem';

const BASE_SUB: SubWeapon = {
  id: 'ink-bomb',
  name: 'Ink Bomb',
  kind: 'smokeBomb',
  inkCost: 10,
  throwSpeed: 8,
  throwPitchRadians: 0,
  gravity: 10,
  restitution: 0.35,
  fuseSeconds: 0.4,
  blastRadius: 2,
  damage: 50,
  cooldownSeconds: 0.5,
  lifetimeSeconds: 3,
};

function makeSub(overrides: Partial<SubWeapon> = {}): SubWeapon {
  return { ...BASE_SUB, ...overrides };
}

function thrower(overrides: Partial<ShooterState> = {}): ShooterState {
  return {
    id: 1,
    team: 0,
    pos: { x: 0, y: 2, z: 0 },
    yaw: 0,
    pitch: 0,
    ink: 100,
    canFire: true,
    weaponId: 'paint-brush',
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
    pos: { x: 0, y: 2, z: 0 },
    half: { x: 0.4, y: 0.6, z: 0.4 },
    hittable: true,
    ...overrides,
  };
}

interface SplatLog {
  hit: SurfaceHit;
  radius: number;
  team: TeamId;
}

class RecordingPaint implements IPaintGrid {
  readonly surfaces: readonly SurfaceGrid[] = [];
  cellsPerSplat = 4;
  readonly splats: SplatLog[] = [];

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
    this.splats.push({
      hit: {
        pos: { ...hit.pos },
        normal: { ...hit.normal },
        boxIndex: hit.boxIndex,
        face: hit.face,
      },
      radius,
      team,
    });
    return this.cellsPerSplat;
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

interface StageBox {
  box: Box;
  paintable?: Face[];
}

function stageOf(boxes: StageBox[]): Pick<StageData, 'boxes' | 'cellSize'> {
  return {
    cellSize: 0.25,
    boxes: boxes.map((entry) => ({
      box: entry.box,
      paintable: entry.paintable ?? [],
    })),
  };
}

function emptyStage(): Pick<StageData, 'boxes' | 'cellSize'> {
  return { cellSize: 0.25, boxes: [] };
}

function bounceSystem(sub: SubWeapon = makeSub(), paint = new RecordingPaint()) {
  const collision = createCollision(emptyStage());
  const system = createSubSystem(sub, { collision, paint });
  return { system, paint, collision };
}

function stepUntilBurst(
  system: ReturnType<typeof createSubSystem>,
  targets: readonly TargetState[] = [],
  maxSteps = 400,
): StepResult {
  const events: GameEvent[] = [];
  const hits: DamageHit[] = [];
  let burstAt = -1;

  for (let i = 0; i < maxSteps; i += 1) {
    const result = system.step(1 / 60, targets);
    events.push(...result.events);
    hits.push(...result.hits);
    if (result.events.some((event) => event.t === 'sub' && event.phase === 'burst')) {
      burstAt = i;
      break;
    }
    if (system.bombs().length === 0) break;
  }

  expect(burstAt).toBeGreaterThanOrEqual(0);
  return { events, hits };
}

describe('createSubSystem / tryThrow', () => {
  it('throws a bomb along the aim and reports the ink spent', () => {
    const { system } = bounceSystem();

    const result = system.tryThrow(thrower(), 42);

    expect(result.fired).toBe(true);
    expect(result.inkSpent).toBe(10);
    expect(result.events).toEqual([
      { t: 'sub', phase: 'throw', team: 0, pos: { x: 0, y: 2, z: 0 } },
    ]);
    expect(result.charging).toBe(0);
    expect(result.moveMultiplier).toBe(1);
    expect(result.hits).toEqual([]);

    const bombs = system.bombs();
    expect(bombs).toHaveLength(1);
    expect(bombs[0]?.id).toBe(0);
    expect(bombs[0]?.team).toBe(0);
    expect(bombs[0]?.pos).toEqual({ x: 0, y: 2, z: 0 });
    expect(bombs[0]?.fuse).toBe(1);
  });

  it('scales the ink cost by the special ink multiplier', () => {
    const { system } = bounceSystem();

    const result = system.tryThrow(
      thrower({ mods: { fireRateMul: 1, paintMul: 1, inkCostMul: 0.5 }, ink: 5 }),
      0,
    );

    expect(result.fired).toBe(true);
    expect(result.inkSpent).toBe(5);
    expect(system.bombs()).toHaveLength(1);
  });

  it('refuses without canFire or with too little ink', () => {
    const { system } = bounceSystem();

    const blocked = system.tryThrow(thrower({ canFire: false }), 0);
    expect(blocked).toEqual({
      fired: false,
      inkSpent: 0,
      events: [],
      charging: 0,
      moveMultiplier: 1,
      hits: [],
    });

    const poor = system.tryThrow(thrower({ ink: 9.99 }), 0);
    expect(poor.fired).toBe(false);
    expect(poor.inkSpent).toBe(0);
    expect(system.bombs()).toHaveLength(0);

    // A refusal must not consume a slot or block a valid throw.
    expect(system.tryThrow(thrower({ ink: 10 }), 0).fired).toBe(true);
    expect(system.bombs()).toHaveLength(1);
  });

  it('recycles the oldest bomb when 32 are live', () => {
    const { system } = bounceSystem(makeSub({ inkCost: 0 }));

    for (let i = 0; i < 33; i += 1) {
      expect(system.tryThrow(thrower({ ink: 0 }), i).fired).toBe(true);
    }

    const views = system.bombs();
    expect(views).toHaveLength(32);
    const ids = views.map((view) => view.id);
    expect(ids.includes(0)).toBe(false);
    expect(ids.includes(32)).toBe(true);
  });

  it('returns a reused view array from bombs()', () => {
    const { system } = bounceSystem();
    system.tryThrow(thrower(), 0);

    expect(system.bombs()).toBe(system.bombs());
  });
});

describe('createSubSystem / flight and fuse', () => {
  it('applies gravity, sweeps to the floor and lights the fuse on contact', () => {
    const floor = stageOf([
      { box: { min: { x: -5, y: -0.5, z: -5 }, max: { x: 5, y: 0, z: 5 } } },
    ]);
    const paint = new RecordingPaint();
    const system = createSubSystem(makeSub({ fuseSeconds: 0.2 }), {
      collision: createCollision(floor),
      paint,
    });

    system.tryThrow(thrower({ pos: { x: 0, y: 1, z: 0 }, pitch: -Math.PI / 2 }), 0);

    let sawFuse = false;
    let lowest = Infinity;
    for (let i = 0; i < 30; i += 1) {
      system.step(1 / 60, []);
      const bomb = system.bombs()[0];
      if (bomb === undefined) break;
      lowest = Math.min(lowest, bomb.pos.y);
      if (bomb.fuse < 1) sawFuse = true;
      expect(bomb.fuse).toBeGreaterThanOrEqual(0);
      expect(bomb.fuse).toBeLessThanOrEqual(1);
    }

    expect(lowest).toBeLessThan(0.2);
    expect(sawFuse).toBe(true);
  });

  it('adds throwPitchRadians to the aim pitch', () => {
    const { system } = bounceSystem(
      makeSub({
        gravity: 0,
        throwSpeed: 4,
        throwPitchRadians: Math.PI / 2,
      }),
    );

    system.tryThrow(thrower({ pos: { x: 0, y: 2, z: 0 }, yaw: 0, pitch: 0 }), 0);
    system.step(0.5, []);

    const bomb = system.bombs()[0];
    if (bomb === undefined) throw new Error('expected a bomb');
    expect(bomb.pos.x).toBeCloseTo(0);
    expect(bomb.pos.y).toBeCloseTo(4);
    expect(bomb.pos.z).toBeCloseTo(0);
  });

  it('bounces off a floor with restitution', () => {
    const floor = stageOf([
      { box: { min: { x: -5, y: -0.5, z: -5 }, max: { x: 5, y: 0, z: 5 } } },
    ]);
    const paint = new RecordingPaint();
    const system = createSubSystem(
      makeSub({
        gravity: 10,
        throwSpeed: 0,
        restitution: 0.5,
        fuseSeconds: 10,
        lifetimeSeconds: 10,
      }),
      { collision: createCollision(floor), paint },
    );

    system.tryThrow(thrower({ pos: { x: 0, y: 2, z: 0 } }), 0);

    let previousY = 2;
    let contactY = Number.NaN;
    for (let i = 0; i < 60; i += 1) {
      system.step(1 / 60, []);
      const bomb = system.bombs()[0];
      if (bomb === undefined) break;
      if (bomb.pos.y < previousY && bomb.pos.y < 0.02) {
        contactY = bomb.pos.y;
        break;
      }
      previousY = bomb.pos.y;
    }

    expect(contactY).toBeLessThanOrEqual(0.02);
    system.step(1 / 60, []);
    const after = system.bombs()[0];
    if (after === undefined) throw new Error('expected a bouncing bomb');
    expect(after.pos.y).toBeGreaterThan(contactY);
  });

  it('starts the fuse after lifetimeSeconds when nothing is hit', () => {
    const { system } = bounceSystem(
      makeSub({ gravity: 0, throwSpeed: 0, lifetimeSeconds: 0.1, fuseSeconds: 0.1 }),
    );
    system.tryThrow(thrower(), 0);

    system.step(0.1, []);
    expect(system.bombs()).toHaveLength(1);
    expect(system.bombs()[0]?.fuse).toBe(1);

    const result = system.step(0.1, []);
    expect(system.bombs()).toHaveLength(0);
    expect(result.events).toEqual([
      { t: 'sub', phase: 'burst', team: 0, pos: { x: 0, y: 2, z: 0 } },
    ]);
  });

  it('ignores non-positive or non-finite dt', () => {
    const { system } = bounceSystem();
    system.tryThrow(thrower(), 0);

    const before = system.bombs()[0];
    if (before === undefined) throw new Error('expected a bomb');

    expect(system.step(0, []).events).toEqual([]);
    expect(system.step(-1, []).events).toEqual([]);
    expect(system.step(Number.NaN, []).events).toEqual([]);
    expect(system.step(Number.POSITIVE_INFINITY, []).events).toEqual([]);
    expect(before.pos).toEqual({ x: 0, y: 2, z: 0 });
    expect(before.fuse).toBe(1);
  });
});

describe('createSubSystem / burst', () => {
  it('emits burst then paint with the thrower id', () => {
    const floor = stageOf([
      { box: { min: { x: -5, y: -0.5, z: -5 }, max: { x: 5, y: 0, z: 5 } }, paintable: ['+y'] },
    ]);
    const paint = new RecordingPaint();
    paint.cellsPerSplat = 7;
    const system = createSubSystem(
      makeSub({ gravity: 0, throwSpeed: 0, lifetimeSeconds: 0.1, fuseSeconds: 0.1, blastRadius: 2 }),
      { collision: createCollision(floor), paint },
    );

    system.tryThrow(thrower(), 0);
    system.step(0.1, []);
    const result = system.step(0.1, []);

    expect(result.events).toEqual([
      { t: 'sub', phase: 'burst', team: 0, pos: { x: 0, y: 2, z: 0 } },
      { t: 'paint', team: 0, cells: 7, pos: { x: 0, y: 0, z: 0 }, by: 1 },
    ]);
    expect(paint.splats).toHaveLength(1);
    expect(paint.splats[0]?.radius).toBe(2);
    expect(paint.splats[0]?.team).toBe(0);
    expect(paint.splats[0]?.hit.face).toBe('+y');
  });

  it('still reports a paint event when the splat changes no cells', () => {
    const floor = stageOf([
      { box: { min: { x: -5, y: -0.5, z: -5 }, max: { x: 5, y: 0, z: 5 } }, paintable: ['+y'] },
    ]);
    const paint = new RecordingPaint();
    paint.cellsPerSplat = 0;
    const system = createSubSystem(
      makeSub({ gravity: 0, throwSpeed: 0, lifetimeSeconds: 0.1, fuseSeconds: 0.1, blastRadius: 2 }),
      { collision: createCollision(floor), paint },
    );

    system.tryThrow(thrower(), 0);
    system.step(0.1, []);
    const result = system.step(0.1, []);

    expect(result.events).toEqual([
      { t: 'sub', phase: 'burst', team: 0, pos: { x: 0, y: 2, z: 0 } },
      { t: 'paint', team: 0, cells: 0, pos: { x: 0, y: 0, z: 0 }, by: 1 },
    ]);
  });

  it('falls back to the last wall hit when there is no floor below', () => {
    const wall = stageOf([
      {
        box: { min: { x: -2, y: 0, z: -2.1 }, max: { x: 2, y: 4, z: -2 } },
        paintable: ['+z'],
      },
    ]);
    const paint = new RecordingPaint();
    const system = createSubSystem(
      makeSub({ throwSpeed: 6, gravity: 8, fuseSeconds: 0.1, lifetimeSeconds: 5 }),
      { collision: createCollision(wall), paint },
    );

    system.tryThrow(thrower(), 0);
    const bursts = stepUntilBurst(system);

    expect(bursts.events[0]).toMatchObject({ t: 'sub', phase: 'burst' });
    expect(paint.splats).toHaveLength(1);
    expect(paint.splats[0]?.hit.face).toBe('+z');
    expect(system.bombs()).toHaveLength(0);
  });

  it('damages enemies with linear falloff and skips allies and the thrower', () => {
    const { system } = bounceSystem(
      makeSub({
        gravity: 0,
        throwSpeed: 0,
        damage: 100,
        blastRadius: 2,
        lifetimeSeconds: 0.1,
        fuseSeconds: 0.1,
      }),
    );
    system.tryThrow(thrower({ id: 1, team: 0 }), 0);
    system.step(0.1, []);

    const result = system.step(0.1, [
      target({ id: 10, team: 0, pos: { x: 0.5, y: 2, z: 0 } }), // ally
      target({ id: 11, team: 1, pos: { x: 0, y: 2, z: 0 } }), // centre
      target({ id: 12, team: 1, pos: { x: 1, y: 2, z: 0 } }), // half radius
      target({ id: 13, team: 1, pos: { x: 0, y: 2, z: -2 } }), // edge
      target({ id: 14, team: 1, pos: { x: 0, y: 2, z: -2.5 } }), // outside
      target({ id: 15, team: 1, pos: { x: 0, y: 2, z: 0 }, hittable: false }),
    ]);

    expect(result.hits.map((hit) => hit.target)).toEqual([11, 12, 13]);
    const damages = result.hits.map((hit) => hit.damage);
    expect(damages[0]).toBeCloseTo(100);
    expect(damages[1]).toBeCloseTo(65);
    expect(damages[2]).toBeCloseTo(30);
    expect(result.hits.every((hit) => hit.attacker === 1)).toBe(true);
    expect(result.hits[2]?.pos).toEqual({ x: 0, y: 2, z: -2 });
    expect(result.events).toEqual([
      { t: 'sub', phase: 'burst', team: 0, pos: { x: 0, y: 2, z: 0 } },
    ]);
  });

  it('requires line of sight from the blast to the target', () => {
    const wall = stageOf([
      {
        box: { min: { x: -1, y: 1, z: -1.5 }, max: { x: 1, y: 3, z: -1 } },
      },
    ]);
    const paint = new RecordingPaint();
    const system = createSubSystem(
      makeSub({
        gravity: 0,
        throwSpeed: 0,
        damage: 100,
        blastRadius: 2,
        lifetimeSeconds: 0.1,
        fuseSeconds: 0.1,
      }),
      { collision: createCollision(wall), paint },
    );
    system.tryThrow(thrower(), 0);
    system.step(0.1, []);

    const result = system.step(0.1, [
      target({ id: 21, team: 1, pos: { x: 0, y: 2, z: -2 } }), // behind wall
      target({ id: 22, team: 1, pos: { x: 1, y: 2, z: 0 } }), // clear
    ]);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.target).toBe(22);
    expect(result.hits[0]?.damage).toBeCloseTo(65);
  });

  it('keeps damage finite for malformed targets and data', () => {
    const { system } = bounceSystem(
      makeSub({
        gravity: 0,
        throwSpeed: 0,
        damage: Number.POSITIVE_INFINITY,
        blastRadius: 2,
        lifetimeSeconds: 0.1,
        fuseSeconds: 0.1,
      }),
    );
    system.tryThrow(thrower(), 0);
    system.step(0.1, []);

    const result = system.step(0.1, [
      target({ id: 31, pos: { x: Number.NaN, y: 2, z: 0 } }),
      target({ id: 32, pos: { x: 0.5, y: 2, z: 0 } }),
    ]);

    expect(result.hits).toHaveLength(1);
    const dealt = result.hits[0]?.damage;
    expect(dealt).toBeDefined();
    expect(Number.isFinite(dealt ?? Number.NaN)).toBe(true);
    expect(dealt ?? -1).toBeGreaterThanOrEqual(0);
  });
});

describe('createSubSystem / real paint grid', () => {
  it('paints the floor on a real stage when the fuse ends', () => {
    const stage = stageOf([
      { box: { min: { x: -5, y: -0.5, z: -5 }, max: { x: 5, y: 0, z: 5 } }, paintable: ['+y'] },
    ]);
    const collision = createCollision(stage);
    const paint = createPaintGrid(stage);
    const system = createSubSystem(
      makeSub({ gravity: 12, throwSpeed: 5, fuseSeconds: 0.2, blastRadius: 1.5 }),
      { collision, paint },
    );

    system.tryThrow(thrower({ pos: { x: 0, y: 2, z: 0 }, yaw: 0, pitch: 0 }), 0);
    const bursts = stepUntilBurst(system);

    const burst = bursts.events.find((event) => event.t === 'sub' && event.phase === 'burst');
    expect(burst).toBeDefined();

    const painted = bursts.events.find((event) => event.t === 'paint');
    expect(painted).toBeDefined();
    if (painted?.t === 'paint') {
      expect(painted.by).toBe(1);
      expect(painted.team).toBe(0);
      expect(painted.cells).toBeGreaterThan(0);
      expect(painted.pos.y).toBeCloseTo(0, 6);
    }

    const [team0, team1] = paint.counts();
    expect(team0).toBeGreaterThan(0);
    expect(team1).toBe(0);
    expect(paint.takeDirty().length).toBeGreaterThan(0);
    expect(system.bombs()).toHaveLength(0);
  });

  it('paints a wall on a real stage when the bomb bursts against it', () => {
    const stage = stageOf([
      {
        box: { min: { x: -2, y: 0, z: -2.1 }, max: { x: 2, y: 4, z: -2 } },
        paintable: ['+z'],
      },
    ]);
    const collision = createCollision(stage);
    const paint = createPaintGrid(stage);
    const system = createSubSystem(
      makeSub({
        gravity: 8,
        throwSpeed: 6,
        fuseSeconds: 0.1,
        blastRadius: 1.2,
        lifetimeSeconds: 5,
      }),
      { collision, paint },
    );

    system.tryThrow(thrower({ pos: { x: 0, y: 2, z: 0 }, yaw: 0, pitch: 0 }), 0);
    const bursts = stepUntilBurst(system);

    expect(
      bursts.events.some((event) => event.t === 'sub' && event.phase === 'burst'),
    ).toBe(true);
    const painted = bursts.events.find((event) => event.t === 'paint');
    expect(painted).toBeDefined();
    if (painted?.t === 'paint') {
      expect(painted.by).toBe(1);
      expect(painted.cells).toBeGreaterThan(0);
      expect(painted.pos.z).toBeCloseTo(-2, 6);
    }
    expect(paint.counts()[0]).toBeGreaterThan(0);
  });
});
