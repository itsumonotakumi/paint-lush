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
      .array(
        z
          .object({
            id: z.number().int(),
            pos: vec3Schema,
            links: z.array(z.number().int()),
            tags: z.array(z.enum(['spawn0', 'spawn1', 'mid', 'high', 'flank'])),
          })
          .strict(),
      ),
    bounds: boxSchema,
    /** BGM id played during the match on this stage. */
    bgm: z.string().min(1),
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

const weaponCommon = {
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  name: z.string().min(1),
  /** Special gauge gained per painted cell. */
  specialGainPerCell: nonNegative,
};

export const projectileWeaponSchema = z
  .object({
    ...weaponCommon,
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

/** Great brush: holding fire on the ground rolls a wide strip; a fresh press swings. */
export const brushWeaponSchema = z
  .object({
    ...weaponCommon,
    kind: z.literal('brush'),
    rollInkPerSec: nonNegative,
    rollWidth: positive,
    rollSpacing: positive,
    rollSpeedMultiplier: finite.min(0).max(1),
    /** Contact damage while rolling, per hit, at most once per swingIntervalSeconds per target. */
    rollDamage: nonNegative,
    swingIntervalSeconds: positive,
    swingReach: positive,
    swingArcRadians: positive,
    swingDamage: positive,
    swingPaintRadius: positive,
    swingInkCost: nonNegative,
  })
  .strict();
export type BrushWeapon = z.infer<typeof brushWeaponSchema>;

/** Long blowgun: hold to charge, release to fire an instant line. */
export const chargeWeaponSchema = z
  .object({
    ...weaponCommon,
    kind: z.literal('charge'),
    fullChargeSeconds: positive,
    /** Charge fraction below which a release fires nothing. */
    minChargeFraction: finite.min(0).max(1),
    rangeMin: positive,
    rangeFull: positive,
    damageMin: positive,
    damageFull: positive,
    lineRadius: positive,
    lineSpacing: positive,
    inkCostFull: nonNegative,
    chargeMoveMultiplier: finite.min(0).max(1),
  })
  .strict();
export type ChargeWeapon = z.infer<typeof chargeWeaponSchema>;

export const weaponSchema = z.discriminatedUnion('kind', [
  projectileWeaponSchema,
  brushWeaponSchema,
  chargeWeaponSchema,
]);
export type Weapon = z.infer<typeof weaponSchema>;
export const weaponsSchema = z
  .array(weaponSchema)
  .min(1)
  .refine((list) => new Set(list.map((w) => w.id)).size === list.length, 'weapon ids must be unique');

export const subSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.literal('smokeBomb'),
    inkCost: nonNegative,
    throwSpeed: positive,
    throwPitchRadians: finite,
    gravity: positive,
    restitution: finite.min(0).max(1),
    fuseSeconds: positive,
    blastRadius: positive,
    damage: positive,
    cooldownSeconds: nonNegative,
    lifetimeSeconds: positive,
  })
  .strict();
export type SubWeapon = z.infer<typeof subSchema>;

export const specialSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.literal('hyakka'),
    gaugeMax: positive,
    durationSeconds: positive,
    fireRateMultiplier: positive,
    paintRadiusMultiplier: positive,
    inkCostMultiplier: nonNegative,
    bgmId: z.string().min(1),
  })
  .strict();
export type SpecialWeapon = z.infer<typeof specialSchema>;

export const difficultySchema = z.enum(['easy', 'normal', 'hard']);
export type Difficulty = z.infer<typeof difficultySchema>;

const aiProfileSchema = z
  .object({
    reactionSeconds: positive,
    aimJitterRadians: nonNegative,
    decisionIntervalSeconds: positive,
    engageRange: positive,
    weights: z.object({ paint: nonNegative, chase: nonNegative, support: nonNegative, retreat: nonNegative }).strict(),
    specialUse: z.boolean(),
  })
  .strict();
export type AiProfile = z.infer<typeof aiProfileSchema>;
export const aiSchema = z.object({ easy: aiProfileSchema, normal: aiProfileSchema, hard: aiProfileSchema }).strict();
export type AiProfiles = z.infer<typeof aiSchema>;

export const matchConfigSchema = z
  .object({
    durationSeconds: z.number().int().min(60).max(300),
    preSeconds: positive,
    lastMinuteAt: positive,
    countdownAt: positive,
    settleSeconds: positive,
    teamSize: z.number().int().min(1).max(4),
  })
  .strict();
export type MatchConfig = z.infer<typeof matchConfigSchema>;

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

const saveSettingsV1 = {
  volume: z.object({ bgm: volume, se: volume, voice: volume }).strict(),
  /** Radians per mouse pixel. */
  mouseSensitivity: positive.max(0.1),
  /** Radians per second at full stick deflection. */
  stickSensitivity: positive.max(20),
  invertY: z.boolean(),
  keys: keyBindingsSchema,
};

export const saveDataV1Schema = z
  .object({ version: z.literal(1), settings: z.object(saveSettingsV1).strict() })
  .strict();
export type SaveDataV1 = z.infer<typeof saveDataV1Schema>;

const recordKey = z.string().regex(/^[a-z0-9-]{1,32}$/);
const count = z.number().int().min(0).max(1_000_000_000);

export const saveDataSchema = z
  .object({
    version: z.literal(2),
    settings: z
      .object({
        ...saveSettingsV1,
        gyro: z.boolean(),
        quality: z.enum(['auto', 'low', 'mid', 'high']),
        colorblind: z.boolean(),
        touchLayout: z
          .object({
            scale: finite.min(0.7).max(1.5),
            offsetX: finite.min(-0.3).max(0.3),
            offsetY: finite.min(-0.3).max(0.3),
          })
          .strict(),
      })
      .strict(),
    records: z
      .object({
        matches: count,
        wins: count,
        weaponUses: z.record(recordKey, count),
        bestPaintCells: count,
      })
      .strict(),
    last: z
      .object({
        weaponId: recordKey,
        stageId: recordKey,
        difficulty: difficultySchema,
        durationSeconds: z.number().int().min(60).max(300),
        characterId: recordKey.optional(),
      })
      .strict(),
  })
  .strict();
export type SaveData = z.infer<typeof saveDataSchema>;
