import type { DataTexture, Group, Material, Mesh, Object3D } from 'three';

/**
 * Contract for the playable ninja roster. Characters are cosmetic only: they
 * never change gameplay. Units are metres; origin is between the soles, +Y up,
 * the face looks along -Z and the third-person camera sits on the +Z side.
 * Total height stays 1.6 m (head top at y = 1.60, accessories up to 1.75).
 */

export type Vec3Tuple = readonly [number, number, number];

/** Colour slot. Team slots are filled per match from the team colour. */
export type ColorRef =
  | 'team'
  | 'teamDark'
  | 'skin'
  | 'garb'
  | 'garbDark'
  | 'accent'
  | 'accent2'
  | 'white'
  | 'ink'
  | `#${string}`;

export type Prim =
  | { t: 'sphere'; r: number; seg?: readonly [number, number] }
  | { t: 'capsule'; r: number; len: number }
  | { t: 'cylinder'; rTop: number; rBot: number; h: number; seg?: number }
  | { t: 'cone'; r: number; h: number; seg?: number }
  | { t: 'box'; w: number; h: number; d: number }
  | { t: 'torus'; R: number; r: number; arc?: number }
  | { t: 'lathe'; profile: readonly (readonly [number, number])[] };

export type Anim =
  | { k: 'flutter'; amp: number; hz: number }
  | { k: 'swing'; amp: number; lag: number }
  | { k: 'wag'; axis: 'x' | 'y' | 'z'; amp: number; hz: number }
  | { k: 'spin'; axis: 'x' | 'y' | 'z'; idle: number; run: number }
  | { k: 'flap'; amp: number; hzIdle: number; hzAir: number }
  | { k: 'pulse'; from: number; to: number; hz: number };

export type AttachPoint = 'head' | 'torso' | 'hip' | 'armL' | 'armR' | 'legL' | 'legR' | 'root';

export type TeamSlot = 'headBand' | 'backCrest' | 'belt' | 'scarfTail';

export interface PartDef {
  id: string;
  prim: Prim;
  attach: AttachPoint;
  /** Position in the feet-origin frame; the builder converts it into the attach frame. */
  pos: Vec3Tuple;
  rot?: Vec3Tuple;
  scale?: Vec3Tuple;
  color: ColorRef;
  outline?: boolean;
  /** Adds a second copy mirrored across x = 0. */
  mirror?: boolean;
  anim?: Anim;
  /** Builds n linked segments of the same primitive, each a child pivot of the previous. */
  chain?: number;
  /** Extra rotation applied to every chain segment after the first (rot applies to the first only). */
  chainBend?: Vec3Tuple;
  /** Optional mesh fixed at the tip of the last chain segment. */
  chainTip?: { prim: Prim; color: ColorRef };
  /** 'base' puts pos at the bottom of the primitive (cones, spikes, wings) so it rotates and animates from its root. */
  anchor?: 'center' | 'base';
  /** Replaces the default part for this team slot. */
  slot?: TeamSlot;
  /** Unlit material (glowing eyes, highlights). */
  basic?: boolean;
}

export interface CharacterBody {
  headRadius: number;
  headScale: Vec3Tuple;
  headY?: number;
  /** Default sphere; 'box' builds a box head of headRadius*2 scaled by headScale. */
  headShape?: 'sphere' | 'box';
  torso: 'capsule' | 'sphere' | 'box' | 'skirt';
  bodyHeight: number;
  bodyWidth: number;
  legStyle: 'stub' | 'slim' | 'peg' | 'frog';
  legLength: number;
  armStyle: 'capsule' | 'slim' | 'cyl';
  handStyle: 'skin' | 'paw' | 'sleeve' | 'box';
  /** Forward lean in radians. */
  stoop?: number;
}

export interface CharacterColors {
  skin: string;
  garb: string;
  garbDark: string;
  accent: string;
  accent2: string;
  iris: string;
}

export type EyeStyle = 'round' | 'almond' | 'cat' | 'top' | 'sleepy' | 'disc' | 'huge';
export type BrowStyle = 'none' | 'flat' | 'soft' | 'thick' | 'thin' | 'worried';
export type MouthStyle = 'smile' | 'wide' | 'cat' | 'line' | 'o' | 'slit' | 'none';
export type FaceExtra = 'whiskers' | 'muzzle' | 'lashes' | 'bandaid' | 'beard';

export interface CharacterFace {
  eye: EyeStyle;
  eyeSpread: number;
  eyeY: number;
  brow: BrowStyle;
  mouth: MouthStyle;
  cheeks?: string;
  extras?: readonly FaceExtra[];
}

export interface CharacterDef {
  /** Lowercase kebab id, matches /^[a-z0-9-]{1,32}$/. */
  id: string;
  /** Display name in kana. */
  name: string;
  /** One-line personality. */
  tagline: string;
  catchphrase: string;
  body: CharacterBody;
  colors: CharacterColors;
  face: CharacterFace;
  parts: readonly PartDef[];
}

export type Expression = 'neutral' | 'hurt' | 'power' | 'happy';

/** Per-frame inputs for idle animation, blinking and expressions. */
export interface CharacterAnimInput {
  /** Seconds since the rig was created; finite, monotonic. */
  time: number;
  dtSec: number;
  /** 0 standing, 1 full run. */
  run: number;
  airborne: boolean;
  expression: Expression;
}

/** Shared geometry and material cache. One per renderer or preview; dispose once. */
export interface CharacterAssetCache {
  dispose(): void;
}

export interface CharacterBuildOptions {
  gradient: DataTexture;
  /** 0xRRGGBB for the 'team' slot. */
  teamColor: number;
  lowDetail: boolean;
  cache: CharacterAssetCache;
  /** Seeds blink timing so a crowd does not blink in sync. */
  seed: number;
}

/** A built character. Pose code rotates the pivots; it never rebuilds meshes. */
export interface CharacterRig {
  def: CharacterDef;
  /** Feet at the origin, facing -Z. Add to a parent group positioned at the feet. */
  root: Group;
  pivots: {
    /** Lean and bob for the whole upper body. */
    body: Object3D;
    head: Object3D;
    torso: Object3D;
    armL: Object3D;
    armR: Object3D;
    legL: Object3D;
    legR: Object3D;
    /** Where the right hand holds the weapon. */
    handR: Object3D;
  };
  /** Meshes painted in the team colour; recoloured via setTeamColor. */
  teamMeshes: readonly Mesh[];
  /** Materials whose emissive is driven for the white hit flash (owned by this rig). */
  flashMaterials: readonly Material[];
  setTeamColor(color: number): void;
  /** 0..1 white flash strength. */
  setFlash(strength: number): void;
  /** Runs data-driven part animations, blinking and expressions. Must not allocate. */
  update(input: CharacterAnimInput): void;
  /** Frees materials owned by this rig (shared cache entries stay). */
  dispose(): void;
}
