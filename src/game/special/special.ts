import type { GameEvent } from '../../core/events';
import type { EntityId } from '../../core/types';
import type { SpecialModifiers, SpecialState } from '../contracts';
import type { SpecialWeapon, Weapon } from '../data/schemas';

/** Keeps a number finite, falling back when the input is NaN or infinite. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value + 0 : fallback;
}

/** Clamps a cell count or gain to a finite, non-negative value. */
function nonNegative(value: number): number {
  const safe = finiteOr(value, 0);
  return safe > 0 ? safe : 0;
}

/** A usable gauge maximum, or 0 when the special data cannot define one. */
function gaugeLimit(sp: SpecialWeapon): number {
  const max = finiteOr(sp.gaugeMax, 0);
  return max > 0 ? max : 0;
}

/** A finite positive multiplier, falling back to neutral. */
function positiveOrOne(value: number): number {
  const safe = finiteOr(value, 0);
  return safe > 0 ? safe : 1;
}

/** Brings a stored gauge back into [0, max], keeping it finite. */
function clampGauge(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < max ? value + 0 : max;
}

/**
 * Adds special-gauge charge from painted cells. Charge is ignored while the
 * special is active. The gauge is clamped at its maximum and a single `ready`
 * event is emitted when the gauge first reaches the top.
 */
export function gainGauge(
  s: SpecialState,
  cells: number,
  weapon: Weapon,
  sp: SpecialWeapon,
  id: EntityId,
): GameEvent[] {
  if (s.activeLeft > 0) return [];

  const max = gaugeLimit(sp);
  if (max <= 0) return [];

  const before = clampGauge(s.gauge, max);
  s.gauge = before;

  const gain = nonNegative(cells) * nonNegative(weapon.specialGainPerCell);
  if (!(gain > 0) || !Number.isFinite(gain)) return [];

  const after = before + gain < max ? before + gain : max;
  s.gauge = after;

  if (before < max && after >= max) {
    return [{ t: 'special', id, phase: 'ready' }];
  }
  return [];
}

/**
 * Starts the special on the rising edge of the button while the gauge is full.
 * The previous button state is always recorded so edge detection stays in sync
 * even when activation is refused.
 */
export function tryActivate(
  s: SpecialState,
  pressed: boolean,
  sp: SpecialWeapon,
  id: EntityId,
): GameEvent[] {
  const wasPressed = s.prevButton === true;
  s.prevButton = pressed === true;
  if (!pressed || wasPressed) return [];

  const max = gaugeLimit(sp);
  if (max <= 0) return [];

  const gauge = clampGauge(s.gauge, max);
  s.gauge = gauge;
  if (gauge < max) return [];
  if (s.activeLeft > 0) return [];

  const duration = finiteOr(sp.durationSeconds, 0);
  s.gauge = 0;
  s.activeLeft = duration > 0 ? duration : 0;
  return [{ t: 'special', id, phase: 'start' }];
}

/**
 * Ticks down an active special by one fixed step. When the timer reaches zero
 * exactly one `end` event is emitted.
 */
export function stepSpecial(
  s: SpecialState,
  dt: number,
  id: EntityId,
): GameEvent[] {
  if (!Number.isFinite(dt) || dt <= 0) return [];

  const before = finiteOr(s.activeLeft, 0);
  if (!(before > 0)) {
    s.activeLeft = 0;
    return [];
  }

  const after = before - dt > 0 ? before - dt : 0;
  s.activeLeft = after;
  return after === 0 ? [{ t: 'special', id, phase: 'end' }] : [];
}

/**
 * Multipliers applied while the special is active. Every value is finite; an
 * inactive special always yields the neutral triple.
 */
export function modifiers(s: SpecialState, sp: SpecialWeapon): SpecialModifiers {
  if (!(s.activeLeft > 0)) {
    return { fireRateMul: 1, paintMul: 1, inkCostMul: 1 };
  }
  return {
    fireRateMul: positiveOrOne(sp.fireRateMultiplier),
    paintMul: positiveOrOne(sp.paintRadiusMultiplier),
    inkCostMul: nonNegative(sp.inkCostMultiplier),
  };
}
