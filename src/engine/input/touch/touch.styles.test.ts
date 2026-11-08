/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTION_BUTTON_LAYOUT } from './layout';

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

  it('draws the special gauge as a ring around the button', () => {
    const special = declarations('.pr-touch__button--special');
    expect(special).toMatch(/--pr-special-fill:\s*0%;/);
    expect(special).toMatch(/conic-gradient\(#ffc14d var\(--pr-special-fill, 0%\)/);
    expect(special).toMatch(/radial-gradient\(/);
    expect(special).toMatch(/saturate\(0\.45\)/);
  });

  it('glows the special ring only when ready and respects reduced motion', () => {
    const ready = declarations('.pr-touch__button--special.pr-touch__button--ready');
    expect(ready).toMatch(/animation:\s*pr-touch-special-glow/);
    expect(css).toMatch(/@keyframes pr-touch-special-glow/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.pr-touch__button--special\.pr-touch__button--ready\s*\{[^}]*animation:\s*none;/s,
    );
  });

  it('hides the duplicate HUD gauge while the touch overlay is visible', () => {
    expect(css).toMatch(
      /body:has\(\.pr-touch:not\(\.pr-touch--hidden\):not\(\[hidden\]\)\)\s+\.pr-gauge\s*\{[^}]*display:\s*none;/,
    );
  });

  it('keeps the CSS geometry in sync with the exported layout constants', () => {
    for (const spec of ACTION_BUTTON_LAYOUT) {
      const block = declarations(`.pr-touch__button--${spec.id}`);
      expect(block, spec.id).toContain(`right: ${spec.rightPx}px;`);
      expect(block, spec.id).toContain(
        `width: min(calc(${spec.sizePx}px * var(--pr-touch-scale)), ${spec.sizeVw}vw);`,
      );
      expect(block, spec.id).toContain(
        `height: min(calc(${spec.sizePx}px * var(--pr-touch-scale)), ${spec.sizeVw}vw);`,
      );
      if (spec.bottomScalePx > 0) {
        expect(block, spec.id).toContain(
          `bottom: calc(${spec.bottomPx}px + ${spec.bottomScalePx}px * var(--pr-touch-scale));`,
        );
      } else {
        expect(block, spec.id).toContain(`bottom: ${spec.bottomPx}px;`);
      }
    }
  });
});
