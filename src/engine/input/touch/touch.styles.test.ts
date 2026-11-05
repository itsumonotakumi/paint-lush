/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./touch.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('touch.css', () => {
  it('disables browser gestures on the overlay and its zones', () => {
    expect(declarations('.pr-touch')).toMatch(/touch-action:\s*none;/);
    expect(declarations('.pr-touch__zone')).toMatch(/touch-action:\s*none;/);
    expect(declarations('.pr-touch__button')).toMatch(/touch-action:\s*none;/);
  });

  it('keeps buttons round and at least 64 px at scale 1', () => {
    const button = declarations('.pr-touch__button');
    expect(button).toMatch(/width:\s*calc\(64px \* var\(--pr-touch-scale\)\)/);
    expect(button).toMatch(/height:\s*calc\(64px \* var\(--pr-touch-scale\)\)/);
    expect(button).toMatch(/min-width:\s*calc\(64px \* var\(--pr-touch-scale\)\)/);
    expect(button).toMatch(/min-height:\s*calc\(64px \* var\(--pr-touch-scale\)\)/);
    expect(button).toMatch(/border-radius:\s*50%;/);
  });

  it('draws the floating stick with classes and no external assets', () => {
    expect(declarations('.pr-touch__stick')).toMatch(/border-radius:\s*50%;/);
    expect(declarations('.pr-touch__stick-knob')).toMatch(/border-radius:\s*50%;/);
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/@import/);
  });
});
