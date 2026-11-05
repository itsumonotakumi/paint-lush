import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { emptyActions } from '../../core/actions';
import { createRng } from '../../core/rng';
import type { MatchPhase } from '../../core/events';
import { FIXED_DT, NO_TEAM } from '../../core/types';
import type { SurfaceHit, TeamId, Vec3 } from '../../core/types';
import type { AiWorldView, PlayerState, Waypoint } from '../contracts';
import type { AiProfile, Weapon } from '../data/schemas';
import { createBot, pickGoal } from './bot';

const TWO_PI = Math.PI * 2;

function makeWaypoint(
  id: number,
  x: number,
  z: number,
  links: number[] = [],
  tags: Waypoint['tags'] = [],
): Waypoint {
  return { id, pos: { x, y: 0, z }, links, tags };
}

function makeProfile(overrides: Partial<AiProfile> = {}): AiProfile {
  return {
    reactionSeconds: overrides.reactionSeconds ?? 0.25,
    aimJitterRadians: overrides.aimJitterRadians ?? 0,
    decisionIntervalSeconds: overrides.decisionIntervalSeconds ?? 0.25,
    engageRange: overrides.engageRange ?? 12,
    weights: {
      paint: overrides.weights?.paint ?? 1,
      chase: overrides.weights?.chase ?? 0,
      support: overrides.weights?.support ?? 0,
      retreat: overrides.weights?.retreat ?? 0,
    },
    specialUse: overrides.specialUse ?? false,
  };
}

interface PlayerOptions {
  state?: PlayerState['state'];
  yaw?: number;
  pitch?: number;
  hp?: number;
  ink?: number;
  charge?: number;
}

function makePlayer(id: number, team: TeamId, pos: Vec3, options: PlayerOptions = {}): PlayerState {
  return {
    id,
    team,
    state: options.state ?? 'stance',
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: options.yaw ?? 0,
    pitch: options.pitch ?? 0,
    hp: options.hp ?? 100,
    ink: options.ink ?? 100,
    diveTransition: 0,
    fireLock: 0,
    respawnTimer: 0,
    invuln: 0,
    prevDive: false,
    prevJump: false,
    weaponId: 'test-projectile',
    subCooldown: 0,
    kills: 0,
    deaths: 0,
    paintCells: 0,
    special: { gauge: 0, activeLeft: 0, prevButton: false },
    moveMultiplier: 1,
    charge: options.charge ?? 0,
  };
}

function makeWeapon(): Weapon {
  return {
    id: 'test-projectile',
    name: 'Test projectile',
    kind: 'projectile',
    specialGainPerCell: 0,
    intervalSeconds: 0.2,
    inkCost: 1,
    damage: 10,
    muzzleSpeed: 20,
    projectileGravity: 0,
    spreadRadians: 0,
    paintRadius: 1,
    trailSpacing: 1,
    trailRadius: 0.5,
    lifetimeSeconds: 2,
  };
}

interface ViewOptions {
  tick?: number;
  self?: PlayerState;
  allies?: readonly PlayerState[];
  enemies?: readonly PlayerState[];
  waypoints?: readonly Waypoint[];
  phase?: MatchPhase;
  weapon?: Weapon;
}

function makeView(options: ViewOptions = {}): AiWorldView {
  return {
    tick: options.tick ?? 0,
    self: options.self ?? makePlayer(1, 0, { x: 0, y: 0.8, z: 0 }),
    allies: options.allies ?? [],
    enemies: options.enemies ?? [],
    waypoints: options.waypoints ?? [],
    phase: options.phase ?? 'play',
    weapon: options.weapon ?? makeWeapon(),
    paint: {
      sampleHit: () => NO_TEAM,
      counts: (): [number, number] => [0, 0],
    },
    collision: {
      raycast(origin: Vec3, dir: Vec3, maxDist: number): SurfaceHit | null {
        if (!Number.isFinite(maxDist) || maxDist <= 0) return null;
        if (dir.y >= -0.5) return null;
        return {
          pos: { x: origin.x, y: 0, z: origin.z },
          normal: { x: 0, y: 1, z: 0 },
          boxIndex: 0,
          face: '+y',
        };
      },
    },
  };
}

function wrapAngle(value: number): number {
  let wrapped = value - TWO_PI * Math.floor((value + Math.PI) / TWO_PI);
  if (wrapped <= -Math.PI) wrapped = Math.PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  return wrapped;
}

describe('pickGoal', () => {
  it('keeps the current goal when another goal is within the hysteresis band', () => {
    const scores = [
      { goal: 'paint' as const, score: 0.5 },
      { goal: 'chase' as const, score: 0.55 },
      { goal: 'support' as const, score: 0 },
      { goal: 'retreat' as const, score: 0 },
    ];
    expect(pickGoal(scores, 'paint')).toBe('paint');
    expect(pickGoal(scores, null)).toBe('chase');
  });

  it('switches when another goal beats the hysteresis', () => {
    const scores = [
      { goal: 'paint' as const, score: 0.5 },
      { goal: 'chase' as const, score: 0.61 },
    ];
    expect(pickGoal(scores, 'paint')).toBe('chase');
  });

  it('breaks exact ties in favour of the current goal', () => {
    const scores = [
      { goal: 'paint' as const, score: 0.7 },
      { goal: 'chase' as const, score: 0.6 },
    ];
    expect(pickGoal(scores, 'chase')).toBe('chase');
    expect(pickGoal(scores, null)).toBe('paint');
  });
});

describe('createBot movement', () => {
  it('follows the waypoint path towards a paint target', () => {
    const waypoints = [
      makeWaypoint(0, 0, 0, [1], ['spawn0']),
      makeWaypoint(1, 0, -10, [0, 2]),
      makeWaypoint(2, 10, -10, [1], ['mid']),
    ];
    const bot = createBot(makeProfile(), createRng(7), 0);
    const self = makePlayer(1, 0, { x: 0, y: 0.8, z: 0 });

    for (let tick = 0; tick < 300; tick += 1) {
      const view = makeView({ tick, self, waypoints });
      const actions = bot.decide(view);
      expect(Number.isFinite(actions.move[0])).toBe(true);
      expect(Number.isFinite(actions.move[1])).toBe(true);
      expect(Number.isFinite(actions.look[0])).toBe(true);
      expect(Number.isFinite(actions.look[1])).toBe(true);
      self.yaw += actions.look[0];
      self.pos.x += Math.sin(self.yaw) * 6 * FIXED_DT * actions.move[1];
      self.pos.z += -Math.cos(self.yaw) * 6 * FIXED_DT * actions.move[1];
    }

    expect(self.pos.z).toBeLessThan(-7);
    expect(self.pos.x).toBeGreaterThan(2);
  });

  it('fires at a visible enemy in range', () => {
    const enemy = makePlayer(2, 1, { x: 0, y: 0.8, z: -5 });
    const bot = createBot(makeProfile({ weights: { paint: 0, chase: 1, support: 0, retreat: 0 } }), createRng(3), 0);
    const actions = bot.decide(makeView({ tick: 0, enemies: [enemy] }));
    expect(actions.fire).toBe(true);
  });
});

describe('createBot phases', () => {
  it('returns empty actions before the match and after it finishes', () => {
    const bot = createBot(makeProfile(), createRng(11), 0);
    expect(bot.decide(makeView({ tick: 0, phase: 'pre' }))).toEqual(emptyActions());
    expect(bot.decide(makeView({ tick: 1, phase: 'finished' }))).toEqual(emptyActions());
  });
});

describe('createBot determinism', () => {
  it('produces identical decisions for identical seeds', () => {
    const settings = fc.record({
      seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
      offset: fc.integer({ min: -240, max: 240 }),
      reaction: fc.integer({ min: 2, max: 120 }).map((n) => n / 100),
      jitter: fc.integer({ min: 0, max: 60 }).map((n) => n / 100),
      interval: fc.integer({ min: 3, max: 90 }).map((n) => n / 60),
      engage: fc.integer({ min: 1, max: 30 }),
      paint: fc.integer({ min: 0, max: 300 }),
      chase: fc.integer({ min: 0, max: 300 }),
      support: fc.integer({ min: 0, max: 300 }),
      retreat: fc.integer({ min: 0, max: 300 }),
      specialUse: fc.boolean(),
    });

    fc.assert(
      fc.property(settings, (settingsValue) => {
        const profile = makeProfile({
          reactionSeconds: settingsValue.reaction,
          aimJitterRadians: settingsValue.jitter,
          decisionIntervalSeconds: settingsValue.interval,
          engageRange: settingsValue.engage,
          weights: {
            paint: settingsValue.paint,
            chase: settingsValue.chase,
            support: settingsValue.support,
            retreat: settingsValue.retreat,
          },
          specialUse: settingsValue.specialUse,
        });
        const waypoints = [
          makeWaypoint(0, 0, 15, [1], ['spawn0']),
          makeWaypoint(1, 0, -15, [0, 2], ['spawn1']),
          makeWaypoint(2, 0, 0, [0, 1], ['mid']),
        ];

        const first = createBot(profile, createRng(settingsValue.seed), settingsValue.offset);
        const second = createBot(profile, createRng(settingsValue.seed), settingsValue.offset);

        const buildView = (tick: number): AiWorldView => {
          const self = makePlayer(1, 0, { x: tick * 0.02, y: 0.8, z: 0 }, { yaw: tick * 0.01 });
          const ally = makePlayer(2, 0, { x: 2, y: 0.8, z: 1 });
          const enemy = makePlayer(3, 1, { x: 4, y: 0.8, z: -3 });
          return makeView({ tick, self, allies: [ally], enemies: [enemy], waypoints });
        };

        for (let tick = 0; tick < 48; tick += 1) {
          const firstActions = first.decide(buildView(tick));
          const secondActions = second.decide(buildView(tick));
          expect(firstActions).toEqual(secondActions);
          for (let i = 0; i < firstActions.move.length; i += 1) {
            expect(Number.isFinite(firstActions.move[i])).toBe(true);
          }
          for (let i = 0; i < firstActions.look.length; i += 1) {
            expect(Number.isFinite(firstActions.look[i])).toBe(true);
          }
        }
      }),
      { numRuns: 20 },
    );
  });
});

describe('createBot difficulty', () => {
  it('aims tighter with a faster reaction and less jitter', () => {
    const enemy = makePlayer(2, 1, { x: 0, y: 0.8, z: -10 });

    const averageError = (profile: AiProfile, seed: number): number => {
      const bot = createBot(profile, createRng(seed), 0);
      const self = makePlayer(1, 0, { x: 0, y: 0.8, z: 0 }, { yaw: 0.6 });
      let total = 0;
      let samples = 0;

      for (let tick = 0; tick < 180; tick += 1) {
        const actions = bot.decide(makeView({ tick, self, enemies: [enemy] }));
        self.yaw = wrapAngle(self.yaw + actions.look[0]);
        self.pitch = Math.max(-1.2, Math.min(1.2, self.pitch + actions.look[1]));
        if (tick >= 60) {
          total += Math.abs(wrapAngle(self.yaw));
          samples += 1;
        }
      }

      return samples === 0 ? Number.POSITIVE_INFINITY : total / samples;
    };

    const easy = makeProfile({
      reactionSeconds: 0.8,
      aimJitterRadians: 0.5,
      decisionIntervalSeconds: 0.25,
      engageRange: 20,
      weights: { paint: 0, chase: 1, support: 0, retreat: 0 },
    });
    const hard = makeProfile({
      reactionSeconds: 0.08,
      aimJitterRadians: 0,
      decisionIntervalSeconds: 0.15,
      engageRange: 20,
      weights: { paint: 0, chase: 1, support: 0, retreat: 0 },
    });

    const seeds = [1, 2, 3, 4, 5];
    let easyTotal = 0;
    let hardTotal = 0;
    for (let i = 0; i < seeds.length; i += 1) {
      const seed = seeds[i];
      if (seed === undefined) continue;
      easyTotal += averageError(easy, seed);
      hardTotal += averageError(hard, seed);
    }

    const easyAverage = easyTotal / seeds.length;
    const hardAverage = hardTotal / seeds.length;
    expect(hardAverage).toBeLessThan(easyAverage);
    expect(hardAverage).toBeLessThan(0.05);
  });
});
