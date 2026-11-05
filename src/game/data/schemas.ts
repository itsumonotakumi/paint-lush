import { z } from 'zod';

// The site CSP forbids eval, so zod must not probe for or use its JIT compiler.
z.config({ jitless: true });

const finite = z.number().finite();
const positive = finite.positive();
const nonNegative = finite.nonnegative();

export const vec3Schema = z.object({ x: finite, y: finite, z: finite }).strict();
export const boxSchema = z.object({ min: vec3Schema, max: vec3Schema }).strict();
export const faceSchema = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']);

export const stageSchema = z
  .object({
    id: z.string().min(1),
    /** Metres per paint cell. */
    cellSize: positive,
    boxes: z.array(z.object({ box: boxSchema, paintable: z.array(faceSchema) }).strict()).min(1),
    /** Index 0 is team 0, index 1 is team 1. */
    spawns: z.tuple([z.array(vec3Schema).min(1), z.array(vec3Schema).min(1)]),
    waypoints: z
      .array(z.object({ id: z.number().int(), pos: vec3Schema, links: z.array(z.number().int()) }).strict()),
    bounds: boxSchema,
  })
  .strict();
export type StageData = z.infer<typeof stageSchema>;

/** Constants that define how a player feels. Speeds m/s, durations s. */
export const playerConfigSchema = z
  .object({
    halfExtents: vec3Schema,
    gravity: positive,
    walkSpeed: positive,
    diveSpeed: positive,
    enemyInkSpeed: positive,
    /** Fraction of ground acceleration available in air, 0..1. */
    airControl: finite.min(0).max(1),
    /** Ground acceleration in m/s^2. */
    acceleration: positive,
    jumpSpeed: positive,
    wallClimbSpeed: positive,
    maxHp: positive,
    enemyInkDps: nonNegative,
    /** enemy ink never reduces hp below this. */
    enemyInkMinHp: nonNegative,
    /** hp per second regained while diving in own ink. */
    diveHealPerSec: nonNegative,
    respawnSeconds: positive,
    respawnInvulnSeconds: nonNegative,
    maxInk: positive,
    inkRegenDive: nonNegative,
    inkRegenIdle: nonNegative,
    /** Duration of the stance<->dive transition. */
    diveTransitionSeconds: nonNegative,
    /** Firing is locked for this long after leaving dive. */
    fireLockAfterDiveSeconds: nonNegative,
  })
  .strict();
export type PlayerConfig = z.infer<typeof playerConfigSchema>;

export const projectileWeaponSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.literal('projectile'),
    intervalSeconds: positive,
    inkCost: nonNegative,
    damage: positive,
    muzzleSpeed: positive,
    projectileGravity: nonNegative,
    /** Maximum random deviation in radians. */
    spreadRadians: nonNegative,
    paintRadius: positive,
    trailSpacing: positive,
    trailRadius: positive,
    lifetimeSeconds: positive,
  })
  .strict();
export type ProjectileWeapon = z.infer<typeof projectileWeaponSchema>;

/** MVP extends this into a discriminated union on `kind`. */
export const weaponSchema = projectileWeaponSchema;
export type Weapon = ProjectileWeapon;
export const weaponsSchema = z.array(weaponSchema).min(1);

const allowedKeyCode = z.string().regex(/^(Key[A-Z]|Digit[0-9]|Space|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Arrow(Up|Down|Left|Right)|Tab|Enter|Escape|Mouse[0-4])$/);

export const keyBindingsSchema = z
  .object({
    forward: allowedKeyCode,
    back: allowedKeyCode,
    left: allowedKeyCode,
    right: allowedKeyCode,
    fire: allowedKeyCode,
    jump: allowedKeyCode,
    dive: allowedKeyCode,
    sub: allowedKeyCode,
    special: allowedKeyCode,
    pause: allowedKeyCode,
  })
  .strict();
export type KeyBindings = z.infer<typeof keyBindingsSchema>;

const volume = finite.min(0).max(1);

export const saveDataSchema = z
  .object({
    version: z.literal(1),
    settings: z
      .object({
        volume: z.object({ bgm: volume, se: volume, voice: volume }).strict(),
        /** Radians per mouse pixel. */
        mouseSensitivity: positive.max(0.1),
        /** Radians per second at full stick deflection. */
        stickSensitivity: positive.max(20),
        invertY: z.boolean(),
        keys: keyBindingsSchema,
      })
      .strict(),
  })
  .strict();
export type SaveData = z.infer<typeof saveDataSchema>;
