import { emptyActions, type InputActions } from '../../core/actions';
import type { GameEvent, MatchPhase } from '../../core/events';
import { aimDirection } from '../../core/math/aim';
import { createRng } from '../../core/rng';
import type { BombView, PlayerView, ProjectileView, WorldSnapshot } from '../../core/snapshot';
import { FIXED_DT, type EntityId, type TeamId, type Vec3 } from '../../core/types';
import { createBot } from '../ai/bot';
import type {
  AiWorldView,
  DamageHit,
  ICollision,
  IMatchClock,
  IPaintGrid,
  ISimulation,
  IWeaponSystem,
  MatchResult,
  PlayerState,
  RosterEntry,
  TargetState,
} from '../contracts';
import type {
  AiProfile,
  MatchConfig,
  PlayerConfig,
  SpecialWeapon,
  StageData,
  SubWeapon,
  Weapon,
} from '../data/schemas';
import { createMatchClock } from '../match/matchClock';
import { computeResult } from '../match/result';
import { createPaintGrid } from '../paint/paintGrid';
import { createCollision } from '../physics/collision';
import { applyDamage, canFire, createPlayer, stepPlayer } from '../player/player';
import { gainGauge, modifiers, stepSpecial, tryActivate } from '../special/special';
import { createSubSystem } from '../sub/subSystem';
import { createWeaponSystem } from '../weapons/weaponSystem';

export const LOCAL_PLAYER_ID: EntityId = 1;
export const DUMMY_PLAYER_ID: EntityId = 2;

const MUZZLE_HEIGHT = 0.5;
const MUZZLE_FORWARD = 0.5;
/** Metres outside the stage bounds before a player counts as lost. */
const OUT_OF_BOUNDS_MARGIN = 1;
/** How far short of a wall a muzzle clamped against it sits. */
const MUZZLE_SKIN = 0.02;
/** Training always provides three idle targets. */
const TRAINING_DUMMIES = 3;
/** MatchConfig allows at most four players per team, so the builder does too. */
const MAX_TEAM_SIZE = 4;

export interface SimulationOptions {
  stage: StageData;
  weapons: readonly Weapon[];
  sub: SubWeapon;
  special: SpecialWeapon;
  player: PlayerConfig;
  match: MatchConfig;
  ai: AiProfile;
  roster: readonly RosterEntry[];
  seed: number;
  mode: 'match' | 'training';
}

export interface Simulation extends ISimulation {
  readonly collision: ICollision;
  readonly paint: IPaintGrid;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value + 0 : fallback;
}

function nonNegative(value: number): number {
  const safe = finiteOr(value, 0);
  return safe > 0 ? safe : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function integerOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** The spawn of the Nth member of a team, wrapping when a team is larger than its list. */
function spawnOf(stage: StageData, team: TeamId, index: number): Vec3 {
  const list = stage.spawns[team];
  if (list.length === 0) throw new Error(`stage ${stage.id} has no spawn for team ${team}`);
  const spawn = list[index % list.length];
  if (spawn === undefined) throw new Error(`stage ${stage.id} has no spawn for team ${team}`);
  return spawn;
}

/** Deterministic local-plus-bots roster. The local player is always team 0. */
export function buildRoster(args: {
  localId: number;
  localWeaponId: string;
  teamSize: number;
  weapons: readonly Weapon[];
  seed: number;
}): RosterEntry[] {
  const localId = integerOr(args.localId, LOCAL_PLAYER_ID);
  const teamSize = Math.max(1, Math.min(MAX_TEAM_SIZE, integerOr(args.teamSize, 1)));
  const weapons = args.weapons;
  const fallbackWeaponId = args.localWeaponId;

  const rng = createRng(args.seed);
  const pickWeapon = (): string => {
    if (weapons.length === 0) return fallbackWeaponId;
    const weapon = weapons[rng.int(weapons.length)];
    return weapon === undefined ? fallbackWeaponId : weapon.id;
  };

  const roster: RosterEntry[] = [
    { id: localId, team: 0, weaponId: fallbackWeaponId, control: 'local' },
  ];
  let nextId = localId + 1;

  for (let i = 1; i < teamSize; i += 1) {
    roster.push({ id: nextId, team: 0, weaponId: pickWeapon(), control: 'ai' });
    nextId += 1;
  }
  for (let i = 0; i < teamSize; i += 1) {
    roster.push({ id: nextId, team: 1, weaponId: pickWeapon(), control: 'ai' });
    nextId += 1;
  }

  return roster;
}

/** The local player plus three idle targets on team 1. */
export function buildTrainingRoster(localId: number, weaponId: string): RosterEntry[] {
  const id = integerOr(localId, LOCAL_PLAYER_ID);
  const roster: RosterEntry[] = [{ id, team: 0, weaponId, control: 'local' }];
  for (let i = 1; i <= TRAINING_DUMMIES; i += 1) {
    roster.push({ id: id + i, team: 1, weaponId, control: 'dummy' });
  }
  return roster;
}

interface Slot {
  state: PlayerState;
  spawn: Vec3;
  control: RosterEntry['control'];
  weapon: Weapon;
  bot: ReturnType<typeof createBot> | null;
  allies: readonly PlayerState[];
  enemies: readonly PlayerState[];
  target: TargetState;
  /** Previous tick's sub button, for edge detection. */
  prevSub: boolean;
}

/**
 * One complete match or training session. All state lives in this closure; the
 * only randomness is the seeded generators handed to the weapon and AI systems.
 */
export function createSimulation(options: SimulationOptions): Simulation {
  const { stage, weapons, sub, special, player: cfg, match, ai, seed, mode } = options;

  const firstWeapon = weapons[0];
  if (firstWeapon === undefined) throw new Error('weapons: at least one weapon is required');

  const collision = createCollision(stage);
  const paint = createPaintGrid(stage);
  const weaponSystem: IWeaponSystem = createWeaponSystem(weapons, {
    collision,
    paint,
    rng: createRng(seed),
  });
  const subSystem = createSubSystem(sub, { collision, paint });
  const clock: IMatchClock | null = mode === 'match' ? createMatchClock(match) : null;

  const weaponById = new Map<string, Weapon>();
  for (const weapon of weapons) {
    if (!weaponById.has(weapon.id)) weaponById.set(weapon.id, weapon);
  }
  const weaponFor = (id: string): Weapon => weaponById.get(id) ?? firstWeapon;

  const ordered = [...options.roster].sort((a, b) => a.id - b.id);
  const teamStates: [PlayerState[], PlayerState[]] = [[], []];
  const teamCounts: [number, number] = [0, 0];
  const records = ordered.map((entry) => {
    const team: TeamId = entry.team === 1 ? 1 : 0;
    const spawn = spawnOf(stage, team, teamCounts[team]);
    teamCounts[team] += 1;
    const state = createPlayer(entry.id, team, spawn, cfg, entry.weaponId);
    state.yaw = team === 0 ? 0 : Math.PI;
    state.pitch = 0;
    teamStates[team].push(state);
    return {
      entry,
      team,
      spawn,
      state,
      weapon: weaponFor(entry.weaponId),
    };
  });

  const slots: Slot[] = records.map((record) => {
    const { entry, team, state } = record;
    const allies = teamStates[team].filter((other) => other !== state);
    const enemies: readonly PlayerState[] = teamStates[team === 0 ? 1 : 0];
    return {
      state,
      spawn: record.spawn,
      control: entry.control,
      weapon: record.weapon,
      bot:
        entry.control === 'ai'
          ? createBot(ai, createRng((seed ^ (entry.id * 0x9e3779b1)) >>> 0), entry.id * 7)
          : null,
      allies,
      enemies,
      target: {
        id: state.id,
        team,
        pos: state.pos,
        half: {
          x: cfg.halfExtents.x,
          y: cfg.halfExtents.y,
          z: cfg.halfExtents.z,
        },
        hittable: true,
      },
      prevSub: false,
    };
  });

  const slotById = new Map<EntityId, Slot>();
  for (const slot of slots) slotById.set(slot.state.id, slot);

  const playerStates = slots.map((slot) => slot.state);
  const targets = slots.map((slot) => slot.target);
  const aiPaint: Pick<IPaintGrid, 'sampleHit' | 'counts'> = {
    sampleHit: paint.sampleHit,
    counts: paint.counts,
  };
  const aiCollision: Pick<ICollision, 'raycast'> = { raycast: collision.raycast };

  let tick = 0;
  let finalResult: MatchResult | null = null;

  const { min, max } = stage.bounds;

  function isLost(p: PlayerState): boolean {
    return (
      p.pos.y < min.y - OUT_OF_BOUNDS_MARGIN ||
      p.pos.x < min.x - OUT_OF_BOUNDS_MARGIN ||
      p.pos.x > max.x + OUT_OF_BOUNDS_MARGIN ||
      p.pos.z < min.z - OUT_OF_BOUNDS_MARGIN ||
      p.pos.z > max.z + OUT_OF_BOUNDS_MARGIN
    );
  }

  function phaseNow(): MatchPhase {
    return clock === null ? 'play' : clock.phase();
  }

  function timeLeftNow(): number {
    return clock === null ? 0 : clock.timeLeft();
  }

  /** Chest position with the muzzle pushed back along the aim until it clears a wall. */
  function muzzleOf(p: PlayerState): Vec3 {
    const aim = aimDirection(p.yaw, p.pitch);
    const chest = { x: p.pos.x, y: p.pos.y + MUZZLE_HEIGHT, z: p.pos.z };
    const block = collision.raycast(chest, aim, MUZZLE_FORWARD);
    const reach =
      block === null
        ? MUZZLE_FORWARD
        : Math.max(
            0,
            Math.hypot(block.pos.x - chest.x, block.pos.y - chest.y, block.pos.z - chest.z) -
              MUZZLE_SKIN,
          );
    return {
      x: chest.x + aim.x * reach,
      y: chest.y + aim.y * reach,
      z: chest.z + aim.z * reach,
    };
  }

  function markTarget(slot: Slot): void {
    const p = slot.state;
    slot.target.pos = p.pos;
    slot.target.hittable = p.invuln <= 0 && p.state !== 'down' && p.state !== 'respawn';
  }

  function step(inputs: ReadonlyMap<EntityId, InputActions>): GameEvent[] {
    const events: GameEvent[] = [];
    const phase = phaseNow();
    const inputsAllowed = clock === null ? true : clock.inputsEnabled();

    /** Appends events while keeping kill counts, paint totals and the gauge in sync. */
    function absorb(incoming: readonly GameEvent[]): void {
      for (const event of incoming) {
        events.push(event);
        if (event.t === 'kill') {
          if (event.killer !== event.victim) {
            const killer = slotById.get(event.killer);
            if (killer !== undefined) killer.state.kills += 1;
          }
        } else if (event.t === 'paint') {
          const by = event.by;
          if (by === undefined) continue;
          const painter = slotById.get(by);
          if (painter === undefined) continue;
          const cells = Number.isFinite(event.cells) && event.cells > 0 ? event.cells : 0;
          if (cells <= 0) continue;
          painter.state.paintCells += cells;
          const gained = gainGauge(
            painter.state.special,
            cells,
            painter.weapon,
            special,
            painter.state.id,
          );
          for (const extra of gained) events.push(extra);
        }
      }
    }

    function applyHit(hit: DamageHit): void {
      const target = slotById.get(hit.target);
      if (target === undefined) return;
      absorb(applyDamage(target.state, hit, cfg));
    }

    for (const slot of slots) {
      const p = slot.state;

      let input: InputActions;
      if (!inputsAllowed) {
        // During the opening 'pre' beat only the local player may look around.
        const supplied = slot.control === 'local' ? inputs.get(p.id) : undefined;
        if (phase === 'pre' && supplied !== undefined) {
          input = {
            ...emptyActions(),
            look: [finiteOr(supplied.look[0], 0), finiteOr(supplied.look[1], 0)],
          };
        } else {
          input = emptyActions();
        }
      } else if (slot.control === 'local') {
        input = inputs.get(p.id) ?? emptyActions();
      } else if (slot.control === 'ai' && slot.bot !== null) {
        const view: AiWorldView = {
          tick,
          self: p,
          allies: slot.allies,
          enemies: slot.enemies,
          paint: aiPaint,
          collision: aiCollision,
          waypoints: stage.waypoints,
          phase,
          weapon: slot.weapon,
        };
        input = slot.bot.decide(view);
      } else {
        input = emptyActions();
      }

      const moveEvents = stepPlayer(
        p,
        input,
        { collision, paint, spawn: slot.spawn },
        cfg,
        FIXED_DT,
      );
      absorb(moveEvents);

      if (isLost(p) && p.state !== 'down' && p.state !== 'respawn') {
        p.invuln = 0;
        absorb(
          applyDamage(p, { target: p.id, attacker: p.id, damage: cfg.maxHp, pos: p.pos }, cfg),
        );
      }

      absorb(stepSpecial(p.special, FIXED_DT, p.id));

      const activation = tryActivate(p.special, input.special === true, special, p.id);
      let started = false;
      for (const event of activation) {
        if (event.t === 'special' && event.phase === 'start') started = true;
      }
      if (started) p.ink = Math.max(0, finiteOr(cfg.maxInk, 0));
      absorb(activation);

      const mods = modifiers(p.special, special);
      const shooter = {
        id: p.id,
        team: p.team,
        pos: muzzleOf(p),
        yaw: p.yaw,
        pitch: p.pitch,
        ink: p.ink,
        canFire: canFire(p),
        weaponId: p.weaponId,
        holdFire: input.fire === true,
        grounded: p.state === 'stance',
        mods,
      };

      const fire = weaponSystem.tryFire(shooter, targets, tick);
      p.ink = Math.max(0, p.ink - nonNegative(fire.inkSpent));
      p.moveMultiplier = fire.moveMultiplier;
      p.charge = fire.charging;
      absorb(fire.events);
      for (const hit of fire.hits) applyHit(hit);

      markTarget(slot);

      const subPressed = input.sub === true;
      const subEdge = subPressed && !slot.prevSub;
      slot.prevSub = subPressed;
      if (subEdge && p.subCooldown <= 0) {
        const thrown = subSystem.tryThrow(
          { ...shooter, ink: p.ink, canFire: canFire(p) },
          tick,
        );
        if (thrown.fired) {
          p.ink = Math.max(0, p.ink - nonNegative(thrown.inkSpent));
          p.subCooldown = nonNegative(sub.cooldownSeconds);
        }
        absorb(thrown.events);
        for (const hit of thrown.hits) applyHit(hit);
      }
    }

    for (const slot of slots) markTarget(slot);

    const weaponStep = weaponSystem.step(FIXED_DT, targets);
    absorb(weaponStep.events);
    const subStep = subSystem.step(FIXED_DT, targets);
    absorb(subStep.events);
    for (const hit of weaponStep.hits) applyHit(hit);
    for (const hit of subStep.hits) applyHit(hit);

    if (clock !== null) {
      absorb(clock.step());
      if (finalResult === null && clock.settled()) {
        finalResult = computeResult(playerStates, paint.counts(), paint.totalCells());
      }
    }

    tick += 1;
    return events;
  }

  function viewOf(p: PlayerState): PlayerView {
    const gaugeMax = finiteOr(special.gaugeMax, 0);
    const gauge = gaugeMax > 0 ? clamp(finiteOr(p.special.gauge, 0) / gaugeMax, 0, 1) : 0;
    return {
      id: p.id,
      team: p.team,
      state: p.state,
      pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      yaw: p.yaw,
      pitch: p.pitch,
      hp: p.hp,
      ink: p.ink,
      weaponId: p.weaponId,
      gauge,
      specialActive: p.special.activeLeft > 0,
      charge: clamp(finiteOr(p.charge, 0), 0, 1),
      kills: p.kills,
    };
  }

  function snapshot(): WorldSnapshot {
    const projectiles: ProjectileView[] = weaponSystem.projectiles().map((q) => ({
      id: q.id,
      team: q.team,
      pos: { x: q.pos.x, y: q.pos.y, z: q.pos.z },
    }));
    const bombs: BombView[] = subSystem.bombs().map((b) => ({
      id: b.id,
      team: b.team,
      pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z },
      fuse: clamp(finiteOr(b.fuse, 0), 0, 1),
    }));
    return {
      tick,
      players: playerStates.map(viewOf),
      projectiles,
      bombs,
      phase: phaseNow(),
      timeLeft: timeLeftNow(),
      counts: paint.counts(),
    };
  }

  function result(): MatchResult | null {
    return mode === 'match' ? finalResult : null;
  }

  return { step, snapshot, result, collision, paint };
}
