/**
 * Pure, headless particle simulation and camera-feel helpers.
 *
 * Nothing here imports three.js, touches the DOM, or reads the clock, so the
 * whole module can be exercised by vitest. Rendering lives in effects.ts and
 * only reads the preallocated arrays exposed by the pools.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface RandomSource {
  next(): number;
}

/** Main octahedron pool on desktop. */
export const DROPLET_CAPACITY = 512;
/** Main octahedron pool on the phone profile. */
export const DROPLET_CAPACITY_LOW = 256;
export const SMOKE_CAPACITY = 48;
export const LEAF_CAPACITY = 48;

export const PAINT_DROPLETS = 8;
export const PAINT_THROTTLE_SECONDS = 0.03;
export const PAINT_SPEED_MIN = 3;
export const PAINT_SPEED_MAX = 5;
export const DROPLET_LIFE = 0.6;
export const DROPLET_GRAVITY = -9.8;

export const IMPACT_DROPLETS = 4;
export const SHOOT_DROPLETS = 3;
export const SHOOT_FLASH_LIFE = 0.08;

export const KILL_SMOKE = 6;
export const KILL_LEAVES = 6;
export const SMOKE_LIFE = 0.4;
export const LEAF_LIFE = 0.8;
export const SMOKE_SCALE_START = 0.3;
export const SMOKE_SCALE_END = 1.4;

/** Droplets thrown by one smoke-bomb burst. */
export const BOMB_DROPLETS = 24;
/** Smoke puffs layered under the bomb droplets. */
export const BOMB_SMOKE = 6;
export const BOMB_LIFE = 0.7;
export const CHARGE_DROPLETS = 4;
export const SWING_DROPLETS = 6;
export const SWING_LIFE = 0.35;

export const CONFETTI_COUNT = 120;
export const CONFETTI_LIFE = 3;

export const SHAKE_AMPLITUDE = 0.08;
export const SHAKE_DURATION = 0.18;
/** Angular frequency of the shake wobble, radians per second. */
export const SHAKE_OMEGA = 90;
/** Exponential falloff rate of the shake, per second. */
export const SHAKE_DECAY = 22;

export const FOV_BOOST_DEGREES = 8;
export const FOV_BOOST_DURATION = 0.3;

/** Longest simulation step accepted from one frame, so a stall cannot fling particles. */
const MAX_STEP = 0.5;
const TAU = Math.PI * 2;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Small deterministic LCG. Presentation-only; never feeds the simulation. */
export class Lcg implements RandomSource {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    const raw = Math.trunc(finite(seed, 1)) >>> 0;
    this.state = raw === 0 ? 0x6d2b79f5 : raw;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
}

/** Immutable description of one radial burst. Reused for every event. */
export interface BurstSpec {
  readonly count: number;
  readonly speedMin: number;
  readonly speedMax: number;
  readonly life: number;
  readonly accelY: number;
  readonly sizeStart: number;
  readonly sizeEnd: number;
  /** Smallest allowed vertical component of the unit direction, in [-1, 1]. */
  readonly minUp: number;
  readonly spinMax: number;
  /** Maximum spawn offset from the burst origin, in metres. */
  readonly spread: number;
}

/**
 * Fixed-size dense pool. Live particles occupy slots [0, count). When a new
 * particle arrives and the pool is full, the slot with the oldest spawn serial
 * is reused. Removing a dead particle swaps the last live one into its slot, so
 * the renderer can write instance i for every i < count.
 */
export class ParticlePool {
  readonly capacity: number;
  count = 0;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly lifeMax: Float32Array;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly sizeStart: Float32Array;
  readonly sizeEnd: Float32Array;
  readonly accelY: Float32Array;
  readonly rotX: Float32Array;
  readonly rotY: Float32Array;
  readonly rotZ: Float32Array;
  readonly spinX: Float32Array;
  readonly spinY: Float32Array;
  readonly spinZ: Float32Array;

  private readonly serial: Float64Array;
  private nextSerial = 1;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.trunc(finite(capacity, 1)));
    const size = this.capacity;

    this.x = new Float32Array(size);
    this.y = new Float32Array(size);
    this.z = new Float32Array(size);
    this.vx = new Float32Array(size);
    this.vy = new Float32Array(size);
    this.vz = new Float32Array(size);
    this.life = new Float32Array(size);
    this.lifeMax = new Float32Array(size);
    this.r = new Float32Array(size);
    this.g = new Float32Array(size);
    this.b = new Float32Array(size);
    this.sizeStart = new Float32Array(size);
    this.sizeEnd = new Float32Array(size);
    this.accelY = new Float32Array(size);
    this.rotX = new Float32Array(size);
    this.rotY = new Float32Array(size);
    this.rotZ = new Float32Array(size);
    this.spinX = new Float32Array(size);
    this.spinY = new Float32Array(size);
    this.spinZ = new Float32Array(size);
    this.serial = new Float64Array(size);
  }

  /** Emits up to `spec.count` particles. Returns how many were written. */
  spawnBurst(
    pos: Vec3Like,
    spec: BurstSpec,
    color: Rgb,
    altColor: Rgb | null,
    rng: RandomSource,
  ): number {
    const life = finite(spec.life, 0);
    const requested = Math.trunc(finite(spec.count, 0));
    if (!(life > 0) || requested <= 0) return 0;

    const total = Math.min(requested, this.capacity);
    const speedMin = Math.max(0, finite(spec.speedMin, 0));
    const speedMax = Math.max(speedMin, finite(spec.speedMax, speedMin));
    const minUp = clamp(finite(spec.minUp, 0), -1, 1);
    const spinMax = Math.max(0, finite(spec.spinMax, 0));
    const spread = Math.max(0, finite(spec.spread, 0));
    const sizeStart = finite(spec.sizeStart, 1);
    const sizeEnd = finite(spec.sizeEnd, 0);
    const accelY = finite(spec.accelY, 0);

    const baseX = finite(pos.x, 0);
    const baseY = finite(pos.y, 0);
    const baseZ = finite(pos.z, 0);

    const cr = clamp01(finite(color.r, 1));
    const cg = clamp01(finite(color.g, 1));
    const cb = clamp01(finite(color.b, 1));
    const ar = altColor ? clamp01(finite(altColor.r, cr)) : cr;
    const ag = altColor ? clamp01(finite(altColor.g, cg)) : cg;
    const ab = altColor ? clamp01(finite(altColor.b, cb)) : cb;

    for (let i = 0; i < total; i += 1) {
      const slot = this.acquireSlot();

      // Upper-hemisphere cone: pick the vertical component, then spin it around.
      const up = clamp(minUp + (1 - minUp) * clamp01(rng.next()), -1, 1);
      const horizontal = Math.sqrt(Math.max(0, 1 - up * up));
      const angle = clamp01(rng.next()) * TAU;
      const speed = speedMin + (speedMax - speedMin) * clamp01(rng.next());

      const dirX = Math.cos(angle) * horizontal;
      const dirZ = Math.sin(angle) * horizontal;

      const offsetX = (clamp01(rng.next()) * 2 - 1) * spread;
      const offsetY = (clamp01(rng.next()) * 2 - 1) * spread * 0.5;
      const offsetZ = (clamp01(rng.next()) * 2 - 1) * spread;

      this.x[slot] = baseX + offsetX;
      this.y[slot] = baseY + offsetY;
      this.z[slot] = baseZ + offsetZ;
      this.vx[slot] = dirX * speed;
      this.vy[slot] = up * speed;
      this.vz[slot] = dirZ * speed;
      this.life[slot] = life;
      this.lifeMax[slot] = life;
      this.sizeStart[slot] = sizeStart;
      this.sizeEnd[slot] = sizeEnd;
      this.accelY[slot] = accelY;

      const useAlt = altColor !== null && (i & 1) === 1;
      this.r[slot] = useAlt ? ar : cr;
      this.g[slot] = useAlt ? ag : cg;
      this.b[slot] = useAlt ? ab : cb;

      this.rotX[slot] = clamp01(rng.next()) * TAU;
      this.rotY[slot] = clamp01(rng.next()) * TAU;
      this.rotZ[slot] = clamp01(rng.next()) * TAU;
      this.spinX[slot] = (clamp01(rng.next()) * 2 - 1) * spinMax;
      this.spinY[slot] = (clamp01(rng.next()) * 2 - 1) * spinMax;
      this.spinZ[slot] = (clamp01(rng.next()) * 2 - 1) * spinMax;

      this.serial[slot] = this.nextSerial;
      this.nextSerial += 1;
    }

    return total;
  }

  /** Advances every live particle. Allocation-free. */
  update(dt: number): void {
    const step = Number.isFinite(dt) ? clamp(dt, 0, MAX_STEP) : 0;
    if (step <= 0) return;

    for (let i = this.count - 1; i >= 0; i -= 1) {
      const remaining = (this.life[i] ?? 0) - step;
      if (!(remaining > 0)) {
        this.removeAt(i);
        continue;
      }
      this.life[i] = remaining;

      const accel = this.accelY[i] ?? 0;
      const vx = (this.vx[i] ?? 0) + 0;
      const vy = (this.vy[i] ?? 0) + accel * step;
      const vz = (this.vz[i] ?? 0) + 0;

      const x = (this.x[i] ?? 0) + vx * step;
      const y = (this.y[i] ?? 0) + vy * step;
      const z = (this.z[i] ?? 0) + vz * step;

      if (
        !Number.isFinite(vx) ||
        !Number.isFinite(vy) ||
        !Number.isFinite(vz) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z)
      ) {
        this.removeAt(i);
        continue;
      }

      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = z;

      this.rotX[i] = (this.rotX[i] ?? 0) + (this.spinX[i] ?? 0) * step;
      this.rotY[i] = (this.rotY[i] ?? 0) + (this.spinY[i] ?? 0) * step;
      this.rotZ[i] = (this.rotZ[i] ?? 0) + (this.spinZ[i] ?? 0) * step;

      // Keep the trig inputs bounded for very long-lived confetti.
      if (Math.abs(this.rotX[i] ?? 0) > TAU * 64) this.rotX[i] = 0;
      if (Math.abs(this.rotY[i] ?? 0) > TAU * 64) this.rotY[i] = 0;
      if (Math.abs(this.rotZ[i] ?? 0) > TAU * 64) this.rotZ[i] = 0;
    }
  }

  private acquireSlot(): number {
    if (this.count < this.capacity) {
      const slot = this.count;
      this.count += 1;
      return slot;
    }

    let oldest = 0;
    let oldestSerial = Infinity;
    for (let i = 0; i < this.count; i += 1) {
      const serial = this.serial[i] ?? 0;
      if (serial < oldestSerial) {
        oldestSerial = serial;
        oldest = i;
      }
    }
    return oldest;
  }

  private removeAt(index: number): void {
    const last = this.count - 1;
    if (index !== last) this.copy(last, index);
    this.count = last;
  }

  private copy(from: number, to: number): void {
    this.x[to] = this.x[from] ?? 0;
    this.y[to] = this.y[from] ?? 0;
    this.z[to] = this.z[from] ?? 0;
    this.vx[to] = this.vx[from] ?? 0;
    this.vy[to] = this.vy[from] ?? 0;
    this.vz[to] = this.vz[from] ?? 0;
    this.life[to] = this.life[from] ?? 0;
    this.lifeMax[to] = this.lifeMax[from] ?? 0;
    this.r[to] = this.r[from] ?? 0;
    this.g[to] = this.g[from] ?? 0;
    this.b[to] = this.b[from] ?? 0;
    this.sizeStart[to] = this.sizeStart[from] ?? 0;
    this.sizeEnd[to] = this.sizeEnd[from] ?? 0;
    this.accelY[to] = this.accelY[from] ?? 0;
    this.rotX[to] = this.rotX[from] ?? 0;
    this.rotY[to] = this.rotY[from] ?? 0;
    this.rotZ[to] = this.rotZ[from] ?? 0;
    this.spinX[to] = this.spinX[from] ?? 0;
    this.spinY[to] = this.spinY[from] ?? 0;
    this.spinZ[to] = this.spinZ[from] ?? 0;
    this.serial[to] = this.serial[from] ?? 0;
  }
}

const PAINT_SPEC: BurstSpec = {
  count: PAINT_DROPLETS,
  speedMin: PAINT_SPEED_MIN,
  speedMax: PAINT_SPEED_MAX,
  life: DROPLET_LIFE,
  accelY: DROPLET_GRAVITY,
  sizeStart: 1,
  sizeEnd: 0,
  minUp: 0,
  spinMax: 6,
  spread: 0.04,
};

const IMPACT_SPEC: BurstSpec = {
  count: IMPACT_DROPLETS,
  speedMin: 2,
  speedMax: 3.2,
  life: 0.55,
  accelY: DROPLET_GRAVITY,
  sizeStart: 1,
  sizeEnd: 0,
  minUp: 0.12,
  spinMax: 7,
  spread: 0.05,
};

const SHOOT_SPEC: BurstSpec = {
  count: SHOOT_DROPLETS,
  speedMin: 2,
  speedMax: 3,
  life: SHOOT_FLASH_LIFE,
  accelY: -2,
  sizeStart: 1,
  sizeEnd: 0,
  minUp: -0.2,
  spinMax: 9,
  spread: 0.02,
};

const SMOKE_SPEC: BurstSpec = {
  count: KILL_SMOKE,
  speedMin: 0.5,
  speedMax: 1.3,
  life: SMOKE_LIFE,
  accelY: 0.7,
  sizeStart: SMOKE_SCALE_START,
  sizeEnd: SMOKE_SCALE_END,
  minUp: 0.1,
  spinMax: 1.2,
  spread: 0.16,
};

const LEAF_SPEC: BurstSpec = {
  count: KILL_LEAVES,
  speedMin: 1.2,
  speedMax: 2.4,
  life: LEAF_LIFE,
  accelY: -2.6,
  sizeStart: 1,
  sizeEnd: 0.55,
  minUp: 0.35,
  spinMax: 9,
  spread: 0.16,
};

const CONFETTI_SPEC: BurstSpec = {
  count: CONFETTI_COUNT,
  speedMin: 1.8,
  speedMax: 3.8,
  life: CONFETTI_LIFE,
  accelY: -2,
  sizeStart: 1,
  sizeEnd: 0.45,
  minUp: 0.15,
  spinMax: 10,
  spread: 2.4,
};

const BOMB_SPEC: BurstSpec = {
  count: BOMB_DROPLETS,
  speedMin: 3,
  speedMax: 6,
  life: BOMB_LIFE,
  accelY: DROPLET_GRAVITY,
  sizeStart: 1,
  sizeEnd: 0,
  minUp: 0.12,
  spinMax: 9,
  spread: 0.28,
};

const BOMB_SMOKE_SPEC: BurstSpec = {
  count: BOMB_SMOKE,
  speedMin: 0.6,
  speedMax: 1.4,
  life: SMOKE_LIFE,
  accelY: 0.8,
  sizeStart: SMOKE_SCALE_START,
  sizeEnd: SMOKE_SCALE_END * 1.2,
  minUp: 0.1,
  spinMax: 1.1,
  spread: 0.3,
};

const CHARGE_SPEC: BurstSpec = {
  count: CHARGE_DROPLETS,
  speedMin: 0.7,
  speedMax: 1.8,
  life: 0.24,
  accelY: 0.6,
  sizeStart: 0.7,
  sizeEnd: 0,
  minUp: 0.2,
  spinMax: 8,
  spread: 0.08,
};

const SWING_SPEC: BurstSpec = {
  count: SWING_DROPLETS,
  speedMin: 2,
  speedMax: 4,
  life: SWING_LIFE,
  accelY: DROPLET_GRAVITY,
  sizeStart: 0.85,
  sizeEnd: 0,
  minUp: 0.05,
  spinMax: 10,
  spread: 0.12,
};

/** Owns the three fixed pools and the paint-burst throttle. */
export class ParticleSystem {
  readonly droplets: ParticlePool;
  readonly smoke: ParticlePool;
  readonly leaves: ParticlePool;

  private readonly rng: RandomSource;
  private paintCooldown = 0;

  constructor(capacity = DROPLET_CAPACITY, seed = 0x5eed1234) {
    this.droplets = new ParticlePool(capacity);
    this.smoke = new ParticlePool(SMOKE_CAPACITY);
    this.leaves = new ParticlePool(LEAF_CAPACITY);
    this.rng = new Lcg(seed);
  }

  /** One paint burst at a time, at most once per 30 ms. Returns true when emitted. */
  spawnPaint(pos: Vec3Like, color: Rgb): boolean {
    if (this.paintCooldown > 0) return false;
    this.paintCooldown = PAINT_THROTTLE_SECONDS;
    this.droplets.spawnBurst(pos, PAINT_SPEC, color, null, this.rng);
    return true;
  }

  spawnImpact(pos: Vec3Like, color: Rgb): void {
    this.droplets.spawnBurst(pos, IMPACT_SPEC, color, null, this.rng);
  }

  /** Three yellow droplets with a very short life, read as a star flash. */
  spawnShootFlash(pos: Vec3Like, color: Rgb): void {
    this.droplets.spawnBurst(pos, SHOOT_SPEC, color, null, this.rng);
  }

  /** Six smoke puffs plus six spinning leaves: exactly twelve pieces. */
  spawnKill(pos: Vec3Like, smokeColor: Rgb, leafColor: Rgb): void {
    this.smoke.spawnBurst(pos, SMOKE_SPEC, smokeColor, null, this.rng);
    this.leaves.spawnBurst(pos, LEAF_SPEC, leafColor, null, this.rng);
  }

  /** 120 confetti pieces alternating between the two team colours. */
  spawnConfetti(pos: Vec3Like, teamA: Rgb, teamB: Rgb): void {
    this.droplets.spawnBurst(pos, CONFETTI_SPEC, teamA, teamB, this.rng);
  }

  /** A smoke bomb burst: 24 team droplets plus six smoke puffs. */
  spawnBombBurst(pos: Vec3Like, color: Rgb, smokeColor: Rgb): void {
    this.droplets.spawnBurst(pos, BOMB_SPEC, color, null, this.rng);
    this.smoke.spawnBurst(pos, BOMB_SMOKE_SPEC, smokeColor, null, this.rng);
  }

  /** A few warm sparks while a charge weapon builds up. */
  spawnCharge(pos: Vec3Like, color: Rgb): void {
    this.droplets.spawnBurst(pos, CHARGE_SPEC, color, null, this.rng);
  }

  /** A short brush-swing arc of droplets. */
  spawnSwing(pos: Vec3Like, color: Rgb): void {
    this.droplets.spawnBurst(pos, SWING_SPEC, color, null, this.rng);
  }

  update(dt: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    if (step > 0) this.paintCooldown = Math.max(0, this.paintCooldown - step);
    this.droplets.update(step);
    this.smoke.update(step);
    this.leaves.update(step);
  }
}

/** Horizontal camera shake that falls off exponentially and ends hard at zero. */
export class ShakeState {
  private elapsed = 0;
  private remaining = 0;

  trigger(): void {
    this.elapsed = 0;
    this.remaining = SHAKE_DURATION;
  }

  update(dt: number): void {
    if (this.remaining <= 0) return;
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.elapsed += step;
    this.remaining = Math.max(0, this.remaining - step);
  }

  /** Writes the offset into `out`; never allocates. */
  read(out: Vec3Like): Vec3Like {
    if (this.remaining <= 0) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return out;
    }

    const amplitude = SHAKE_AMPLITUDE * Math.exp(-this.elapsed * SHAKE_DECAY);
    const wave = this.elapsed * SHAKE_OMEGA;
    out.x = amplitude * Math.sin(wave);
    out.y = 0;
    out.z = amplitude * Math.cos(wave);
    return out;
  }
}

/** Smoothly eases the field of view between 0 and the special boost. */
export class FovBoostState {
  private current = 0;
  private from = 0;
  private target = 0;
  private elapsed = 0;
  private moving = false;

  start(): void {
    this.begin(FOV_BOOST_DEGREES);
  }

  end(): void {
    this.begin(0);
  }

  update(dt: number): void {
    if (!this.moving) return;
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.elapsed += step;
    const t = clamp01(this.elapsed / FOV_BOOST_DURATION);
    const eased = t * t * (3 - 2 * t);
    this.current = this.from + (this.target - this.from) * eased;
    if (t >= 1) {
      this.current = this.target;
      this.moving = false;
    }
  }

  value(): number {
    return Number.isFinite(this.current) ? this.current : 0;
  }

  private begin(target: number): void {
    this.from = this.current;
    this.target = target;
    this.elapsed = 0;
    this.moving = this.from !== target;
    if (!this.moving) this.current = target;
  }
}
