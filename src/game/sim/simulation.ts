import { emptyActions, type InputActions } from '../../core/actions';
import type { GameEvent } from '../../core/events';
import { aimDirection } from '../../core/math/aim';
import { createRng } from '../../core/rng';
import type { PlayerView, WorldSnapshot } from '../../core/snapshot';
import { FIXED_DT, type EntityId, type TeamId, type Vec3 } from '../../core/types';
import type { ICollision, IPaintGrid, ISimulation, IWeaponSystem, PlayerState, TargetState } from '../contracts';
import type { PlayerConfig, StageData, Weapon } from '../data/schemas';
import { createPaintGrid } from '../paint/paintGrid';
import { createCollision } from '../physics/collision';
import { applyDamage, canFire, createPlayer, stepPlayer } from '../player/player';
import { createWeaponSystem } from '../weapons/weaponSystem';

export const LOCAL_PLAYER_ID: EntityId = 1;
export const DUMMY_PLAYER_ID: EntityId = 2;

const MUZZLE_HEIGHT = 0.5;
const MUZZLE_FORWARD = 0.5;
const ENEMY_PATCH_RADIUS = 3;
/** Metres outside the stage bounds before a player counts as lost. */
const OUT_OF_BOUNDS_MARGIN = 1;
/** How far short of a wall a muzzle clamped against it sits. */
const MUZZLE_SKIN = 0.02;

export interface SimulationOptions {
  stage: StageData;
  weapon: Weapon;
  player: PlayerConfig;
  seed: number;
}

export interface Simulation extends ISimulation {
  readonly collision: ICollision;
  readonly paint: IPaintGrid;
}

interface Slot {
  state: PlayerState;
  spawn: Vec3;
}

function spawnOf(stage: StageData, team: TeamId): Vec3 {
  const spawn = stage.spawns[team][0];
  if (spawn === undefined) throw new Error(`stage ${stage.id} has no spawn for team ${team}`);
  return spawn;
}

/** Prototype world: one local player and one idle enemy, with a patch of enemy ink to test against. */
export function createSimulation(options: SimulationOptions): Simulation {
  const { stage, weapon, player: cfg, seed } = options;
  const collision = createCollision(stage);
  const paint = createPaintGrid(stage);
  const weapons: IWeaponSystem = createWeaponSystem(weapon, { collision, paint, rng: createRng(seed) });

  const spawn0 = spawnOf(stage, 0);
  const spawn1 = spawnOf(stage, 1);
  const slots: Slot[] = [
    { state: createPlayer(LOCAL_PLAYER_ID, 0, spawn0, cfg), spawn: spawn0 },
    { state: createPlayer(DUMMY_PLAYER_ID, 1, spawn1, cfg), spawn: spawn1 },
  ];

  const down = collision.raycast({ x: 0, y: stage.bounds.max.y, z: 0 }, { x: 0, y: -1, z: 0 }, 20);
  if (down !== null) paint.splatHit(down, ENEMY_PATCH_RADIUS, 1);

  const targets: TargetState[] = slots.map((slot) => ({
    id: slot.state.id,
    team: slot.state.team,
    pos: slot.state.pos,
    half: cfg.halfExtents,
    hittable: true,
  }));

  let tick = 0;
  const idle = emptyActions();
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

  function step(inputs: ReadonlyMap<EntityId, InputActions>): GameEvent[] {
    const events: GameEvent[] = [];

    for (const slot of slots) {
      const input = inputs.get(slot.state.id) ?? idle;
      events.push(...stepPlayer(slot.state, input, { collision, paint, spawn: slot.spawn }, cfg, FIXED_DT));

      const p = slot.state;
      if (isLost(p) && p.state !== 'down' && p.state !== 'respawn') {
        p.invuln = 0;
        events.push(...applyDamage(p, { target: p.id, attacker: p.id, damage: cfg.maxHp, pos: p.pos }, cfg));
      }
      if (input.fire && canFire(p)) {
        const aim = aimDirection(p.yaw, p.pitch);
        const chest = { x: p.pos.x, y: p.pos.y + MUZZLE_HEIGHT, z: p.pos.z };
        const block = collision.raycast(chest, aim, MUZZLE_FORWARD);
        const reach = block === null
          ? MUZZLE_FORWARD
          : Math.max(0, Math.hypot(block.pos.x - chest.x, block.pos.y - chest.y, block.pos.z - chest.z) - MUZZLE_SKIN);
        const result = weapons.tryFire(
          {
            id: p.id,
            team: p.team,
            pos: { x: chest.x + aim.x * reach, y: chest.y + aim.y * reach, z: chest.z + aim.z * reach },
            yaw: p.yaw,
            pitch: p.pitch,
            ink: p.ink,
            canFire: true,
          },
          tick,
        );
        p.ink = Math.max(0, p.ink - result.inkSpent);
        events.push(...result.events);
      }
    }

    slots.forEach((slot, index) => {
      const target = targets[index];
      if (target === undefined) return;
      const p = slot.state;
      target.pos = p.pos;
      target.hittable = p.invuln <= 0 && p.state !== 'down' && p.state !== 'respawn';
    });

    const result = weapons.step(FIXED_DT, targets);
    events.push(...result.events);
    for (const hit of result.hits) {
      const slot = slots.find((s) => s.state.id === hit.target);
      if (slot !== undefined) events.push(...applyDamage(slot.state, hit, cfg));
    }

    tick += 1;
    return events;
  }

  function view(p: PlayerState): PlayerView {
    return {
      id: p.id,
      team: p.team,
      state: p.state,
      pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      yaw: p.yaw,
      pitch: p.pitch,
      hp: p.hp,
      ink: p.ink,
    };
  }

  function snapshot(): WorldSnapshot {
    return {
      tick,
      players: slots.map((slot) => view(slot.state)),
      projectiles: weapons.projectiles().map((q) => ({ id: q.id, team: q.team, pos: { ...q.pos } })),
      counts: paint.counts(),
    };
  }

  return { step, snapshot, collision, paint };
}
