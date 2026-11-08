import { describe, expect, it } from 'vitest';
import { CHARACTERS, getCharacter } from './defs';
import { CHARACTER_IDS, DEFAULT_CHARACTER_ID } from './roster';
import type { CharacterDef, PartDef, Prim } from './types';

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const TEAM_SLOT_MESH_BASE = 26;
const MAX_MESHES = 44;
const SATURATION_LIMIT = 0.35;
const LIGHT_LIMIT = 0.85;
const DARK_LIMIT = 0.3;
const EPSILON = 1e-9;
/** Feet-origin frame: everything must stay above the soles and below 1.76 m. */
const POS_X_LIMIT = 0.9;
const POS_Y_MIN = -0.01;
const POS_Y_MAX = 1.76;
const POS_Z_LIMIT = 0.9;
/** Primitives whose length runs along local +Y, so `anchor: 'base'` is meaningful. */
const BASE_ANCHOR_PRIMS: ReadonlySet<Prim['t']> = new Set(['cone', 'capsule', 'cylinder', 'box']);

interface Hsl {
  s: number;
  l: number;
}

function isHexColour(value: string): boolean {
  return HEX_PATTERN.test(value);
}

function hslOf(hex: string): Hsl | null {
  if (!HEX_PATTERN.test(hex)) return null;
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

function expectMuted(hex: string, label: string): void {
  const hsl = hslOf(hex);
  expect(hsl, `${label} is not a #rrggbb colour: ${hex}`).not.toBeNull();
  if (hsl === null) return;
  const allowed =
    hsl.s <= SATURATION_LIMIT + EPSILON ||
    hsl.l >= LIGHT_LIMIT - EPSILON ||
    hsl.l <= DARK_LIMIT + EPSILON;
  expect(
    allowed,
    `${label} (${hex}) must be muted or very light/dark, got s=${hsl.s.toFixed(3)} l=${hsl.l.toFixed(3)}`,
  ).toBe(true);
}

function partDimensions(prim: Prim): readonly [number, number, number] {
  switch (prim.t) {
    case 'sphere':
      return [prim.r * 2, prim.r * 2, prim.r * 2];
    case 'capsule':
      return [prim.r * 2, prim.len + prim.r * 2, prim.r * 2];
    case 'cylinder': {
      const width = Math.max(prim.rTop, prim.rBot) * 2;
      return [width, prim.h, width];
    }
    case 'cone':
      return [prim.r * 2, prim.h, prim.r * 2];
    case 'box':
      return [prim.w, prim.h, prim.d];
    case 'torus': {
      const width = (prim.R + prim.r) * 2;
      return [width, width, prim.r * 2];
    }
    case 'lathe': {
      let maxRadius = 0;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const [radius, y] of prim.profile) {
        maxRadius = Math.max(maxRadius, radius);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const width = maxRadius * 2;
      return [width, maxY - minY, width];
    }
  }
}

function isTinyPart(part: PartDef): boolean {
  return partDimensions(part.prim).every((dimension) => dimension < 0.06);
}

function estimatedMeshes(def: CharacterDef): number {
  let total = TEAM_SLOT_MESH_BASE;
  for (const part of def.parts) {
    const copies = part.mirror === true ? 2 : 1;
    total += copies * (part.chain ?? 1);
    if (part.chainTip !== undefined) total += copies;
  }
  return total;
}

function partOf(def: CharacterDef, id: string): PartDef {
  const found = def.parts.find((part) => part.id === id);
  if (found === undefined) throw new Error(`${def.id} is missing part ${id}`);
  return found;
}

function collectNumbers(value: unknown, out: number[]): void {
  if (typeof value === 'number') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      collectNumbers(inner, out);
    }
  }
}

describe('CHARACTERS', () => {
  it('lists one unique definition per roster id, in roster order', () => {
    expect(CHARACTERS.map((def) => def.id)).toEqual([...CHARACTER_IDS]);
    expect(new Set(CHARACTERS.map((def) => def.id)).size).toBe(CHARACTER_IDS.length);
  });

  it('uses unique part ids within each character', () => {
    for (const def of CHARACTERS) {
      const ids = def.parts.map((part) => part.id);
      expect(new Set(ids).size, def.id).toBe(ids.length);
    }
  });

  it('keeps every numeric field finite', () => {
    for (const def of CHARACTERS) {
      const numbers: number[] = [];
      collectNumbers(def, numbers);
      expect(numbers.length, `${def.id} has no numeric data`).toBeGreaterThan(0);
      for (const value of numbers) {
        expect(Number.isFinite(value), `${def.id} contains a non-finite number`).toBe(true);
      }
    }
  });

  it('keeps every part origin inside the body envelope', () => {
    for (const def of CHARACTERS) {
      for (const part of def.parts) {
        const [x, y, z] = part.pos;
        expect(Math.abs(x), `${def.id}.${part.id} x`).toBeLessThanOrEqual(POS_X_LIMIT);
        expect(y, `${def.id}.${part.id} y`).toBeGreaterThanOrEqual(POS_Y_MIN);
        expect(y, `${def.id}.${part.id} y`).toBeLessThanOrEqual(POS_Y_MAX);
        expect(Math.abs(z), `${def.id}.${part.id} z`).toBeLessThanOrEqual(POS_Z_LIMIT);
      }
    }
  });

  it('uses only valid #rrggbb colours', () => {
    for (const def of CHARACTERS) {
      for (const [key, value] of Object.entries(def.colors)) {
        expect(isHexColour(value), `${def.id}.colors.${key}: ${value}`).toBe(true);
      }
      if (def.face.cheeks !== undefined) {
        expect(isHexColour(def.face.cheeks), `${def.id}.face.cheeks: ${def.face.cheeks}`).toBe(true);
      }
      for (const part of def.parts) {
        if (part.color.startsWith('#')) {
          expect(isHexColour(part.color), `${def.id}.${part.id}: ${part.color}`).toBe(true);
        }
        const tipColor = part.chainTip?.color;
        if (tipColor !== undefined && tipColor.startsWith('#')) {
          expect(isHexColour(tipColor), `${def.id}.${part.id} tip: ${tipColor}`).toBe(true);
        }
      }
    }
  });

  it('keeps personal colours clear of the saturated team palette', () => {
    const personalKeys = ['skin', 'garb', 'garbDark', 'accent', 'accent2'] as const;
    for (const def of CHARACTERS) {
      for (const key of personalKeys) {
        expectMuted(def.colors[key], `${def.id}.colors.${key}`);
      }
      for (const part of def.parts) {
        if (!part.color.startsWith('#')) continue;
        if (isTinyPart(part)) continue;
        expectMuted(part.color, `${def.id}.${part.id}`);
      }
    }
  });

  it('gives every character a team-coloured headBand', () => {
    for (const def of CHARACTERS) {
      const teamHead = def.parts.filter(
        (part) => part.slot === 'headBand' && part.color === 'team' && part.attach === 'head',
      );
      expect(teamHead.length, `${def.id} needs a team headBand`).toBeGreaterThanOrEqual(1);
    }
  });

  it('stays inside the per-character mesh budget', () => {
    for (const def of CHARACTERS) {
      expect(estimatedMeshes(def), def.id).toBeLessThanOrEqual(MAX_MESHES);
    }
  });

  it('has safe, non-empty display text', () => {
    for (const def of CHARACTERS) {
      for (const text of [def.name, def.tagline, def.catchphrase]) {
        expect(text.length, def.id).toBeGreaterThan(0);
        expect(text, `${def.id} contains markup`).not.toContain('<');
        expect(text, `${def.id} contains markup`).not.toContain('>');
      }
    }
  });
});

describe('face data', () => {
  it('keeps every eye height at or below the head centre', () => {
    for (const def of CHARACTERS) {
      expect(Number.isFinite(def.face.eyeY), def.id).toBe(true);
      expect(def.face.eyeY, `${def.id} eyes must sit at or below the head centre`).toBeLessThanOrEqual(0);
    }
  });
});

describe('part anchors and chains', () => {
  it('only uses anchor "base" on primitives that have a length along +Y', () => {
    for (const def of CHARACTERS) {
      for (const part of def.parts) {
        if (part.anchor !== 'base') continue;
        expect(BASE_ANCHOR_PRIMS.has(part.prim.t), `${def.id}.${part.id} anchors ${part.prim.t}`).toBe(true);
      }
    }
  });

  it('gives nyanta a bent, chained tail ending in a tip mesh', () => {
    const tail = partOf(getCharacter('nyanta'), 'tail');
    expect(tail.chain, 'nyanta tail needs several links').toBeGreaterThanOrEqual(3);
    expect(tail.chainBend, 'nyanta tail needs a per-link bend').toBeDefined();
    const bend = tail.chainBend ?? [0, 0, 0];
    expect(Number.isFinite(bend[0]) && Number.isFinite(bend[1]) && Number.isFinite(bend[2])).toBe(true);
    expect(Math.abs(bend[0]) + Math.abs(bend[1]) + Math.abs(bend[2])).toBeGreaterThan(0);
    expect(tail.chainTip, 'nyanta tail needs a tip mesh').toBeDefined();
  });

  it('turns gonta onigiri upright with a negative x rotation', () => {
    const onigiri = partOf(getCharacter('gonta'), 'onigiri');
    expect(onigiri.prim.t).toBe('cylinder');
    const rotX = onigiri.rot?.[0];
    expect(rotX, 'onigiri needs an x rotation').toBeDefined();
    expect(rotX ?? 1, 'onigiri apex must point up').toBeLessThan(0);
    expect(rotX ?? 1).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe('mame scroll', () => {
  it('carries a big scroll on the back with team-coloured rope', () => {
    const mame = getCharacter('mame');
    const scroll = partOf(mame, 'scroll');
    expect(scroll.prim.t).toBe('cylinder');
    const dims = partDimensions(scroll.prim);
    expect(dims[1], 'scroll must be taller than mame is').toBeGreaterThan(1.1);
    expect(scroll.pos[2], 'scroll hangs behind the torso').toBeGreaterThan(0.1);

    const ropes = mame.parts.filter((part) => part.id.startsWith('scrollRope'));
    expect(ropes.length, 'mame needs scroll rope').toBeGreaterThan(0);
    for (const rope of ropes) {
      expect(rope.color, `${rope.id} must use the team colour`).toBe('team');
      expect(rope.prim.t).toBe('torus');
    }
    expect(ropes.some((rope) => rope.slot === 'backCrest'), 'one rope fills the backCrest slot').toBe(true);
  });
});

describe('visual polish data', () => {
  it('gives gonta a wide rice-ball hat with a slim team band', () => {
    const gonta = getCharacter('gonta');
    const hat = partOf(gonta, 'onigiri');
    expect(hat.prim.t).toBe('cylinder');
    if (hat.prim.t !== 'cylinder') return;
    expect(hat.prim.rTop).toBeGreaterThanOrEqual(0.3);
    expect(hat.prim.h).toBeLessThanOrEqual(0.32);
    expect(hat.prim.seg).toBe(3);

    const band = partOf(gonta, 'hatBand');
    expect(band.slot).toBe('headBand');
    expect(band.color).toBe('team');
    expect(band.prim.t).toBe('torus');
    if (band.prim.t === 'torus') expect(band.prim.r).toBeLessThanOrEqual(0.05);
    /* the chin-level box that hid the mouth is gone */
    expect(gonta.parts.some((part) => part.id === 'headBand')).toBe(false);

    const nori = partOf(gonta, 'nori');
    expect(nori.color).toBe('ink');
    expect(nori.pos[2], 'nori wraps the front of the hat').toBeLessThan(0);

    const belly = partOf(gonta, 'belly');
    expect(belly.prim.t).toBe('sphere');
    if (belly.prim.t === 'sphere') expect(belly.prim.r).toBeLessThanOrEqual(0.18);
  });

  it('gives mame a hair cap and a fringe above the eyes', () => {
    const mame = getCharacter('mame');
    const hair = partOf(mame, 'hairCap');
    expect(hair.prim.t).toBe('sphere');
    expect(hair.outline).toBe(true);
    if (hair.prim.t === 'sphere') expect(hair.prim.r).toBeCloseTo(0.345, 3);
    expect(hair.scale?.[1]).toBeLessThan(1);

    const bangs = partOf(mame, 'bangs');
    expect(bangs.pos[2], 'the fringe hangs off the forehead').toBeLessThan(-0.15);
  });

  it('draws gen-san brows as white parts instead of ink tusks', () => {
    const gen = getCharacter('gen-san');
    expect(gen.face.brow).toBe('none');
    const brows = gen.parts.filter((part) => part.id.startsWith('brow'));
    expect(brows.length).toBeGreaterThan(0);
    for (const brow of brows) {
      expect(brow.color).toBe('accent');
      expect(brow.mirror).toBe(true);
    }
  });

  it('paints kuroha beak in crow charcoal', () => {
    const beak = partOf(getCharacter('kuroha'), 'beakMask');
    expect(beak.color).toBe('#3a3a44');
    expect(beak.pos[0]).toBeGreaterThan(0.2);
  });

  it('keeps kerosuke throat small enough to clear the mouth', () => {
    const throat = partOf(getCharacter('kerosuke'), 'throat');
    expect(throat.prim.t).toBe('sphere');
    if (throat.prim.t === 'sphere') expect(throat.prim.r).toBeLessThanOrEqual(0.1);
  });
});

describe('getCharacter', () => {
  it('returns the definition matching each roster id', () => {
    for (const id of CHARACTER_IDS) {
      expect(getCharacter(id).id).toBe(id);
    }
  });

  it('falls back to the default character for unknown ids', () => {
    expect(getCharacter('not-a-ninja').id).toBe(DEFAULT_CHARACTER_ID);
    expect(getCharacter('').id).toBe(DEFAULT_CHARACTER_ID);
    expect(getCharacter('<script>').id).toBe(DEFAULT_CHARACTER_ID);
  });
});
