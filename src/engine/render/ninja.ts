import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { MeshToonMaterial } from 'three';
import type { GameEvent } from '../../core/events';
import { lerpAngle } from '../../core/math/vec3';
import type { PlayerView, WorldSnapshot } from '../../core/snapshot';
import type { EntityId, TeamId, Vec3 } from '../../core/types';
import type { RenderModule, RenderModuleDeps } from './module';
import { PALETTE } from './palette';
import { createNinjaPose, pose } from './ninjaPose';
import type { NinjaPose } from './ninjaPose';
import { createToonMaterial } from './toon';

/** Waist-to-floor distance: the model's feet sit 0.8 m below the player position. */
const FEET_OFFSET = 0.8;
/** Squared distance beyond which interpolation snaps instead of sliding. */
const SNAP_DISTANCE_SQUARED = 3 * 3;
/** Seconds of white flash after a hit. */
const FLASH_SECONDS = 0.15;
const FLASH_COLOR = 0xffffff;
const NO_FLASH_COLOR = 0x000000;
/** Frequency of the headband tail flutter. */
const TAIL_FLUTTER = 9;
/** Ripple lifetime in seconds. */
const RIPPLE_SECONDS = 1;
/** Seconds a brush swing animation lasts. */
const SWING_SECONDS = 0.32;
/** Petals in the special ring. */
const SPECIAL_PETALS = 8;
const SPECIAL_RING_RADIUS = 0.62;
const TAU = Math.PI * 2;

/** Which weapon model to hang from the right hand. */
export type WeaponVisualKind = 'shuriken' | 'brush' | 'blowgun' | 'none';

/** Maps a simulation weapon id to its hand-held model. */
export function weaponVisualKind(weaponId: string): WeaponVisualKind {
  if (weaponId === 'iro-shuriken') return 'shuriken';
  if (weaponId === 'oofude') return 'brush';
  if (weaponId === 'naga-fukiya') return 'blowgun';
  return 'none';
}

/**
 * Team-coloured glow strength for the blowgun tube. Charge 0 keeps the tube
 * visible, charge 1 makes it shine at full brightness.
 */
export function chargeGlow(charge: number): number {
  const value = Number.isFinite(charge) ? Math.min(1, Math.max(0, charge)) : 0;
  return 0.35 + 0.65 * value;
}

type ToonMesh = Mesh<BufferGeometry, MeshToonMaterial>;
type BasicMesh = Mesh<BufferGeometry, MeshBasicMaterial>;

interface WeaponVisual {
  kind: WeaponVisualKind;
  group: Group;
  spinner: BasicMesh | null;
  glow: MeshBasicMaterial | null;
}

interface NinjaVisual {
  id: EntityId;
  group: Group;
  body: Group;
  dive: Group;
  legs: [Group, Group];
  arms: [Group, Group];
  tails: [Group, Group];
  ripples: [ToonMesh, ToonMesh];
  teamMeshes: ToonMesh[];
  garbMaterial: MeshToonMaterial;
  ring: Group;
  ringPetals: BasicMesh[];
  weapon: WeaponVisual | null;
  weaponId: string;
  teamHex: number;
  team: TeamId;
  flash: number;
  swing: number;
  /** Last update frame in which this visual was present in the snapshot. */
  lastSeen: number;
}

function safe(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

function safeHex(n: number): number {
  return Number.isFinite(n) ? n : 0xffffff;
}

function jumpedTooFar(from: Vec3, to: Vec3): boolean {
  const dx = safe(to.x) - safe(from.x);
  const dy = safe(to.y) - safe(from.y);
  const dz = safe(to.z) - safe(from.z);
  return dx * dx + dy * dy + dz * dz > SNAP_DISTANCE_SQUARED;
}

/** Linear lookup over the previous snapshot, avoiding a per-frame map rebuild. */
function findPrevious(
  players: readonly PlayerView[],
  id: EntityId,
): PlayerView | undefined {
  for (let i = 0; i < players.length; i += 1) {
    const player = players[i];
    if (player !== undefined && player.id === id) return player;
  }
  return undefined;
}

function horizontalSpeed(previous: PlayerView, current: PlayerView, dtSec: number): number {
  if (!(dtSec > 0) || !Number.isFinite(dtSec)) return 0;
  const dx = safe(current.pos.x) - safe(previous.pos.x);
  const dz = safe(current.pos.z) - safe(previous.pos.z);
  const speed = Math.hypot(dx, dz) / dtSec;
  return Number.isFinite(speed) ? speed : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A chunky four-point shuriken, extruded a little so it reads from every side. */
function createShurikenGeometry(): BufferGeometry {
  const outer = 0.24;
  const inner = 0.085;
  const halfDepth = 0.035;
  const rim: { x: number; y: number }[] = [];
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * TAU;
    const radius = i % 2 === 0 ? outer : inner;
    rim.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const push3 = (x: number, y: number, z: number, nx: number, ny: number, nz: number): void => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  };

  for (let i = 0; i < 8; i += 1) {
    const p = rim[i];
    const q = rim[(i + 1) % 8];
    if (!p || !q) continue;
    push3(0, 0, halfDepth, 0, 0, 1);
    push3(p.x, p.y, halfDepth, 0, 0, 1);
    push3(q.x, q.y, halfDepth, 0, 0, 1);
    push3(0, 0, -halfDepth, 0, 0, -1);
    push3(q.x, q.y, -halfDepth, 0, 0, -1);
    push3(p.x, p.y, -halfDepth, 0, 0, -1);
    push3(p.x, p.y, halfDepth, p.x, p.y, 0);
    push3(q.x, q.y, halfDepth, q.x, q.y, 0);
    push3(q.x, q.y, -halfDepth, q.x, q.y, 0);
    push3(p.x, p.y, halfDepth, p.x, p.y, 0);
    push3(q.x, q.y, -halfDepth, q.x, q.y, 0);
    push3(p.x, p.y, -halfDepth, p.x, p.y, 0);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  return geometry;
}

/** Expands one ripple ring over its lifetime while thinning its vertical tube. */
function setRippleScale(ring: ToonMesh, time: number): void {
  const cycle = ((time % RIPPLE_SECONDS) + RIPPLE_SECONDS) % RIPPLE_SECONDS;
  const grow = 1 + cycle * 1.25;
  ring.scale.set(grow, grow, 0.85 / grow);
}

/**
 * Draws one bright toon ninja per player, all built from primitives and the
 * shared palette. The module owns its meshes and removes only its own groups.
 */
export function createNinjas(deps: RenderModuleDeps): RenderModule {
  const { scene, teamColors, gradient, lowDetail } = deps;

  const geometries: BufferGeometry[] = [];
  const materials: MeshToonMaterial[] = [];
  const basicMaterials: MeshBasicMaterial[] = [];

  function trackGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function trackMaterial<T extends MeshToonMaterial>(material: T): T {
    materials.push(material);
    return material;
  }

  function trackBasic<T extends MeshBasicMaterial>(material: T): T {
    basicMaterials.push(material);
    return material;
  }

  /* ---------- shared geometry ---------- */

  const headGeometry = trackGeometry(new SphereGeometry(0.34, 18, 14));
  const bodyGeometry = trackGeometry(new CapsuleGeometry(0.21, 0.22, 6, 14));
  const hipGeometry = trackGeometry(new BoxGeometry(0.32, 0.15, 0.22));
  const armGeometry = trackGeometry(new CapsuleGeometry(0.07, 0.22, 4, 8));
  const legGeometry = trackGeometry(new BoxGeometry(0.14, 0.36, 0.16));
  const footGeometry = trackGeometry(new BoxGeometry(0.18, 0.09, 0.26));
  const eyeGeometry = trackGeometry(new SphereGeometry(0.085, 12, 10));
  const pupilGeometry = trackGeometry(new SphereGeometry(0.045, 10, 8));
  const highlightGeometry = trackGeometry(new SphereGeometry(0.018, 8, 6));
  const maskGeometry = trackGeometry(new SphereGeometry(0.34, 18, 12));
  const bandGeometry = trackGeometry(new TorusGeometry(0.335, 0.045, 8, 22));
  const tailGeometry = trackGeometry(new BoxGeometry(0.08, 0.05, 0.35));
  const scarfGeometry = trackGeometry(new TorusGeometry(0.19, 0.055, 8, 18));
  const scarfTailGeometry = trackGeometry(new BoxGeometry(0.12, 0.34, 0.06));
  const gourdGeometry = trackGeometry(new SphereGeometry(0.1, 12, 10));
  const gourdNeckGeometry = trackGeometry(new CylinderGeometry(0.035, 0.045, 0.08, 8));
  const cordGeometry = trackGeometry(new BoxGeometry(0.03, 0.18, 0.03));
  const blobGeometry = trackGeometry(new SphereGeometry(0.55, 18, 12));
  const rippleGeometry = trackGeometry(new TorusGeometry(0.5, 0.03, 6, 28));
  const shurikenGeometry = trackGeometry(createShurikenGeometry());
  const brushHandleGeometry = trackGeometry(new CylinderGeometry(0.035, 0.045, 1.05, 8));
  const brushHeadGeometry = trackGeometry(new CylinderGeometry(0.14, 0.09, 0.34, 10));
  const blowgunGeometry = trackGeometry(new CylinderGeometry(0.028, 0.032, 1.2, 8));
  const petalGeometry = trackGeometry(new PlaneGeometry(0.16, 0.28));

  /* ---------- shared materials ---------- */

  const eyeMaterial = trackMaterial(createToonMaterial(PALETTE.outline, gradient));
  const whiteMaterial = trackMaterial(createToonMaterial(0xffffff, gradient));
  const gourdMaterial = trackMaterial(createToonMaterial(PALETTE.signYellow, gradient));
  const outlineMaterial = trackBasic(
    new MeshBasicMaterial({ color: PALETTE.outline, side: BackSide }),
  );
  const highlightMaterial = trackBasic(
    new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
  );

  const teamMaterials: [MeshToonMaterial, MeshToonMaterial] = [
    trackMaterial(createToonMaterial(safeHex(teamColors[0]), gradient)),
    trackMaterial(createToonMaterial(safeHex(teamColors[1]), gradient)),
  ];

  const timberMaterial = trackMaterial(createToonMaterial(PALETTE.timber, gradient));

  const teamStarMaterials: [MeshBasicMaterial, MeshBasicMaterial] = [
    trackBasic(
      new MeshBasicMaterial({
        color: safeHex(teamColors[0]),
        side: DoubleSide,
        toneMapped: false,
      }),
    ),
    trackBasic(
      new MeshBasicMaterial({
        color: safeHex(teamColors[1]),
        side: DoubleSide,
        toneMapped: false,
      }),
    ),
  ];

  const teamPetalMaterials: [MeshBasicMaterial, MeshBasicMaterial] = [
    trackBasic(
      new MeshBasicMaterial({
        color: safeHex(teamColors[0]),
        transparent: true,
        opacity: 0.92,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    ),
    trackBasic(
      new MeshBasicMaterial({
        color: safeHex(teamColors[1]),
        transparent: true,
        opacity: 0.92,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    ),
  ];

  /** Materials created per blowgun so each player can glow with their own charge. */
  const weaponMaterials: MeshBasicMaterial[] = [];

  const visualById = new Map<EntityId, NinjaVisual>();
  const visuals: NinjaVisual[] = [];
  const scratchPose: NinjaPose = createNinjaPose();
  let frame = 0;

  function addOutline(parent: Group, source: Mesh, scale: number): void {
    if (lowDetail) return;
    const outline = new Mesh(source.geometry, outlineMaterial);
    outline.position.copy(source.position);
    outline.scale.copy(source.scale).multiplyScalar(scale);
    parent.add(outline);
  }

  function detachWeapon(visual: NinjaVisual): void {
    if (visual.weapon === null) return;
    visual.arms[1].remove(visual.weapon.group);
    visual.weapon = null;
  }

  function attachWeapon(visual: NinjaVisual, kind: WeaponVisualKind, team: TeamId): void {
    detachWeapon(visual);
    if (kind === 'none') return;

    const group = new Group();
    group.userData.weaponKind = kind;
    group.position.set(0, -0.4, -0.04);

    let spinner: BasicMesh | null = null;
    let glow: MeshBasicMaterial | null = null;

    if (kind === 'shuriken') {
      group.position.set(0, -0.38, -0.1);
      const star = new Mesh(shurikenGeometry, teamStarMaterials[team]);
      star.userData.weaponRole = 'shuriken';
      group.add(star);
      spinner = star;
    } else if (kind === 'brush') {
      const handle = new Mesh(brushHandleGeometry, timberMaterial);
      handle.rotation.x = -Math.PI * 0.5;
      handle.position.z = -0.525;
      group.add(handle);

      const head = new Mesh(brushHeadGeometry, teamMaterials[team]);
      head.rotation.x = -Math.PI * 0.5;
      head.position.z = -1.08;
      head.userData.weaponRole = 'brushHead';
      group.add(head);
    } else {
      const material = new MeshBasicMaterial({
        color: safeHex(teamColors[team]),
        toneMapped: false,
      });
      weaponMaterials.push(material);
      const tube = new Mesh(blowgunGeometry, material);
      tube.rotation.x = -Math.PI * 0.5;
      tube.position.z = -0.6;
      tube.userData.weaponRole = 'blowgun';
      group.add(tube);
      glow = material;
    }

    visual.arms[1].add(group);
    visual.weapon = { kind, group, spinner, glow };
  }

  function createSpecialRing(team: TeamId): { ring: Group; petals: BasicMesh[] } {
    const ring = new Group();
    ring.position.y = 0.05;
    ring.visible = false;
    const petals: BasicMesh[] = [];

    for (let i = 0; i < SPECIAL_PETALS; i += 1) {
      const angle = (i / SPECIAL_PETALS) * TAU;
      const petal = new Mesh(petalGeometry, teamPetalMaterials[team]);
      petal.position.set(
        Math.cos(angle) * SPECIAL_RING_RADIUS,
        0.12 + (i % 2) * 0.16,
        Math.sin(angle) * SPECIAL_RING_RADIUS,
      );
      petal.rotation.y = -angle;
      petal.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.32;
      ring.add(petal);
      petals.push(petal);
    }

    return { ring, petals };
  }

  function createVisual(id: EntityId, team: TeamId): NinjaVisual {
    const group = new Group();
    const body = new Group();
    group.add(body);

    const dive = new Group();
    dive.visible = false;
    group.add(dive);

    const garbMaterial = trackMaterial(createToonMaterial(PALETTE.garb, gradient));
    const teamMaterial = teamMaterials[team];
    const teamMeshes: ToonMesh[] = [];

    /* torso, hip and head */
    const torso = new Mesh(bodyGeometry, garbMaterial);
    torso.position.set(0, 0.12, 0);
    body.add(torso);
    addOutline(body, torso, 1.06);

    const hip = new Mesh(hipGeometry, garbMaterial);
    hip.position.set(0, -0.275, 0);
    body.add(hip);

    const head = new Mesh(headGeometry, garbMaterial);
    head.position.set(0, 0.62, 0);
    body.add(head);
    addOutline(body, head, 1.06);

    /* face */
    const leftEye = new Mesh(eyeGeometry, whiteMaterial);
    leftEye.position.set(-0.11, 0.64, -0.27);
    leftEye.scale.set(1, 1.35, 0.45);
    body.add(leftEye);

    const rightEye = new Mesh(eyeGeometry, whiteMaterial);
    rightEye.position.set(0.11, 0.64, -0.27);
    rightEye.scale.set(1, 1.35, 0.45);
    body.add(rightEye);

    for (const side of [-1, 1]) {
      const pupil = new Mesh(pupilGeometry, eyeMaterial);
      pupil.position.set(side * 0.11, 0.645, -0.306);
      body.add(pupil);

      const highlight = new Mesh(highlightGeometry, highlightMaterial);
      highlight.position.set(side * 0.11 + 0.018, 0.664, -0.338);
      body.add(highlight);
    }

    const mask = new Mesh(maskGeometry, garbMaterial);
    mask.position.set(0, 0.62 - 0.187, 0);
    mask.scale.set(1.02, 0.55, 1.02);
    body.add(mask);

    /* headband, knot and trailing tails */
    const band = new Mesh(bandGeometry, teamMaterial);
    band.position.set(0, 0.8, 0);
    band.rotation.x = Math.PI / 2;
    body.add(band);
    teamMeshes.push(band);

    const tails: [Group, Group] = [new Group(), new Group()];
    tails.forEach((pivot, index) => {
      const side = index === 0 ? -1 : 1;
      pivot.position.set(side * 0.06, 0.8, 0.27);
      const tail = new Mesh(tailGeometry, teamMaterial);
      tail.position.set(0, 0, 0.175);
      pivot.add(tail);
      body.add(pivot);
      teamMeshes.push(tail);
    });

    /* scarf */
    const scarf = new Mesh(scarfGeometry, teamMaterial);
    scarf.position.set(0, 0.34, 0);
    scarf.rotation.x = Math.PI / 2;
    body.add(scarf);
    teamMeshes.push(scarf);

    const scarfTail = new Mesh(scarfTailGeometry, teamMaterial);
    scarfTail.position.set(0.13, 0.2, 0.15);
    scarfTail.rotation.set(0.2, 0, 0.18);
    body.add(scarfTail);
    teamMeshes.push(scarfTail);

    /* gourd and cord */
    const gourd = new Mesh(gourdGeometry, gourdMaterial);
    gourd.position.set(0.28, -0.08, 0.02);
    gourd.scale.set(1, 1.15, 1);
    body.add(gourd);

    const gourdNeck = new Mesh(gourdNeckGeometry, gourdMaterial);
    gourdNeck.position.set(0.28, 0.045, 0.02);
    body.add(gourdNeck);

    const cord = new Mesh(cordGeometry, teamMaterial);
    cord.position.set(0.25, 0.12, 0.02);
    cord.rotation.z = 0.18;
    body.add(cord);
    teamMeshes.push(cord);

    /* arms, pivoted at the shoulders */
    const arms: [Group, Group] = [new Group(), new Group()];
    arms.forEach((pivot, index) => {
      const side = index === 0 ? -1 : 1;
      pivot.position.set(side * 0.28, 0.34, 0);
      pivot.rotation.z = side * 0.1;
      const arm = new Mesh(armGeometry, garbMaterial);
      arm.position.set(0, -0.18, 0);
      pivot.add(arm);
      body.add(pivot);
    });

    /* legs and feet, pivoted at the hips; the feet land at local y = -0.8 */
    const legs: [Group, Group] = [new Group(), new Group()];
    legs.forEach((pivot, index) => {
      const side = index === 0 ? -1 : 1;
      pivot.position.set(side * 0.09, -0.35, 0);
      const leg = new Mesh(legGeometry, garbMaterial);
      leg.position.set(0, -0.18, 0);
      pivot.add(leg);
      const foot = new Mesh(footGeometry, garbMaterial);
      foot.position.set(0, -0.405, -0.04);
      pivot.add(foot);
      body.add(pivot);
    });

    /* dive blob and ripples */
    const blob = new Mesh(blobGeometry, teamMaterial);
    blob.position.set(0, -FEET_OFFSET + 0.08, 0);
    blob.scale.set(1.3, 0.16, 1.3);
    dive.add(blob);
    teamMeshes.push(blob);

    const ripples: [ToonMesh, ToonMesh] = [
      new Mesh(rippleGeometry, teamMaterial),
      new Mesh(rippleGeometry, teamMaterial),
    ];
    for (const ripple of ripples) {
      ripple.position.set(0, -FEET_OFFSET + 0.01, 0);
      ripple.rotation.x = -Math.PI / 2;
      dive.add(ripple);
      teamMeshes.push(ripple);
    }

    const special = createSpecialRing(team);
    group.add(special.ring);

    return {
      id,
      group,
      body,
      dive,
      legs,
      arms,
      tails,
      ripples,
      teamMeshes,
      garbMaterial,
      ring: special.ring,
      ringPetals: special.petals,
      weapon: null,
      weaponId: '',
      teamHex: safeHex(teamColors[team]),
      team,
      flash: 0,
      swing: 0,
      lastSeen: -1,
    };
  }

  let elapsed = 0;
  let disposed = false;

  function update(dtSec: number, prev: WorldSnapshot, curr: WorldSnapshot, alpha: number): void {
    if (disposed) return;

    const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
    elapsed = Number.isFinite(elapsed + dt) ? elapsed + dt : 0;
    const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
    frame += 1;
    if (!Number.isFinite(frame)) frame = 1;

    for (let i = 0; i < curr.players.length; i += 1) {
      const player = curr.players[i];
      if (player === undefined) continue;
      let visual = visualById.get(player.id);
      if (visual === undefined) {
        visual = createVisual(player.id, player.team);
        visualById.set(player.id, visual);
        visuals.push(visual);
        scene.add(visual.group);
      }
      visual.lastSeen = frame;

      if (visual.team !== player.team) {
        visual.team = player.team;
        visual.teamHex = safeHex(teamColors[player.team]);
        const teamMaterial = teamMaterials[player.team];
        for (let m = 0; m < visual.teamMeshes.length; m += 1) {
          const mesh = visual.teamMeshes[m];
          if (mesh !== undefined) mesh.material = teamMaterial;
        }
        for (let m = 0; m < visual.ringPetals.length; m += 1) {
          const petal = visual.ringPetals[m];
          if (petal !== undefined) petal.material = teamPetalMaterials[player.team];
        }
        if (visual.weapon !== null) attachWeapon(visual, visual.weapon.kind, player.team);
      }

      if (visual.weaponId !== player.weaponId) {
        visual.weaponId = player.weaponId;
        attachWeapon(visual, weaponVisualKind(player.weaponId), player.team);
      }

      const previous = findPrevious(prev.players, player.id);
      let px = safe(player.pos.x);
      let py = safe(player.pos.y);
      let pz = safe(player.pos.z);
      let yaw = safe(player.yaw);
      if (previous !== undefined && !jumpedTooFar(previous.pos, player.pos)) {
        px = safe(previous.pos.x + (player.pos.x - previous.pos.x) * blend);
        py = safe(previous.pos.y + (player.pos.y - previous.pos.y) * blend);
        pz = safe(previous.pos.z + (player.pos.z - previous.pos.z) * blend);
        yaw = lerpAngle(previous.yaw, player.yaw, blend);
      }

      const speed =
        previous === undefined ? 0 : horizontalSpeed(previous, player, dt);
      pose(elapsed, speed, player.state, scratchPose);

      const diving = player.state === 'dive';
      const hidden = player.state === 'down' || player.state === 'respawn';
      visual.group.visible = !hidden;
      visual.group.position.set(px, py, pz);
      visual.group.rotation.y = -yaw;
      visual.body.visible = !diving;
      visual.dive.visible = diving;

      if (player.state === 'air') {
        visual.legs[0].rotation.x = scratchPose.legSwing;
        visual.legs[1].rotation.x = scratchPose.legSwing;
        visual.arms[0].rotation.x = scratchPose.armSwing;
        visual.arms[1].rotation.x = scratchPose.armSwing;
      } else {
        visual.legs[0].rotation.x = scratchPose.legSwing;
        visual.legs[1].rotation.x = -scratchPose.legSwing;
        visual.arms[0].rotation.x = scratchPose.armSwing;
        visual.arms[1].rotation.x = -scratchPose.armSwing;
      }

      visual.body.rotation.x = -scratchPose.lean;
      visual.body.position.y = scratchPose.bounce;

      if (player.state === 'air') {
        visual.tails[0].rotation.x = 0;
        visual.tails[0].rotation.y = 0;
        visual.tails[1].rotation.x = 0;
        visual.tails[1].rotation.y = 0;
      } else {
        const flutter = Math.sin(elapsed * TAIL_FLUTTER);
        visual.tails[0].rotation.x = 0.12 + scratchPose.tailSwing + flutter * 0.3;
        visual.tails[0].rotation.y = Math.sin(elapsed * TAIL_FLUTTER + 0.6) * 0.12;
        visual.tails[1].rotation.x = 0.12 + scratchPose.tailSwing + flutter * 0.3;
        visual.tails[1].rotation.y = Math.sin(elapsed * TAIL_FLUTTER - 0.6) * 0.12;
      }

      if (diving) {
        setRippleScale(visual.ripples[0], elapsed);
        setRippleScale(visual.ripples[1], elapsed + 0.5);
      }

      visual.ring.visible = player.specialActive === true && !hidden;
      if (visual.ring.visible) {
        visual.ring.rotation.y = elapsed * 1.8;
        visual.ring.rotation.z = Math.sin(elapsed * 1.3) * 0.12;
      }

      const weapon = visual.weapon;
      if (weapon !== null) {
        if (weapon.glow !== null) {
          weapon.glow.color.setHex(visual.teamHex);
          weapon.glow.color.multiplyScalar(chargeGlow(player.charge));
        }
        if (weapon.spinner !== null) weapon.spinner.rotation.z = elapsed * 7;

        if (visual.swing > 0) visual.swing = Math.max(0, visual.swing - dt);
        if (visual.swing > 0 && weapon.kind === 'brush') {
          const progress = clamp01(1 - visual.swing / SWING_SECONDS);
          weapon.group.rotation.x = -Math.sin(progress * Math.PI) * 1.15;
        } else {
          weapon.group.rotation.x = 0;
        }
      } else if (visual.swing > 0) {
        visual.swing = Math.max(0, visual.swing - dt);
      }
    }

    for (let i = 0; i < visuals.length; i += 1) {
      const visual = visuals[i];
      if (visual !== undefined && visual.lastSeen !== frame) visual.group.visible = false;
    }

    for (let i = 0; i < visuals.length; i += 1) {
      const visual = visuals[i];
      if (visual === undefined) continue;
      if (visual.flash > 0) visual.flash = Math.max(0, visual.flash - dt);
      visual.garbMaterial.emissive.setHex(visual.flash > 0 ? FLASH_COLOR : NO_FLASH_COLOR);
    }
  }

  function handle(event: GameEvent): void {
    if (disposed) return;
    if (event.t === 'hit') {
      const visual = visualById.get(event.target);
      if (visual !== undefined) visual.flash = FLASH_SECONDS;
      return;
    }
    if (event.t === 'swing') {
      const visual = visualById.get(event.id);
      if (visual !== undefined) visual.swing = SWING_SECONDS;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    for (let i = 0; i < visuals.length; i += 1) {
      const visual = visuals[i];
      if (visual !== undefined) scene.remove(visual.group);
    }
    visualById.clear();
    visuals.length = 0;

    for (const geometry of geometries) geometry.dispose();
    geometries.length = 0;
    for (const material of materials) material.dispose();
    materials.length = 0;
    for (const material of basicMaterials) material.dispose();
    basicMaterials.length = 0;
    for (const material of weaponMaterials) material.dispose();
    weaponMaterials.length = 0;
  }

  return { update, handle, dispose };
}
