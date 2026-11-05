/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('ui.css', () => {
  it('resets the page and pins the canvas to the viewport', () => {
    const page = declarations('html,\nbody');
    expect(page).toMatch(/margin:\s*0;/);
    expect(page).toMatch(/padding:\s*0;/);
    expect(page).toMatch(/height:\s*100%;/);
    expect(page).toMatch(/overflow:\s*hidden;/);
    expect(page).toMatch(/touch-action:\s*none;/);
    expect(page).toMatch(/user-select:\s*none;/);

    const game = declarations('#game');
    expect(game).toMatch(/position:\s*fixed;/);
    expect(game).toMatch(/inset:\s*0;/);
    expect(game).toMatch(/width:\s*100%;/);
    expect(game).toMatch(/height:\s*100%;/);
    expect(game).toMatch(/display:\s*block;/);

    const ui = declarations('#ui');
    expect(ui).toMatch(/position:\s*fixed;/);
    expect(ui).toMatch(/inset:\s*0;/);
  });

  it('lets the hidden attribute win inside the UI', () => {
    expect(css).toMatch(/#ui \[hidden\][^{]*\{[^}]*display:\s*none\s*!important/);
  });

  it('gives UI fields border-box sizing and keeps the debug body inside its width', () => {
    expect(css).toMatch(/#ui \*,[\s\S]*?box-sizing:\s*border-box/);

    const body = declarations('.pr-debug__body');
    expect(body).toMatch(/box-sizing:\s*border-box;/);
    expect(body).toMatch(/max-width:\s*100%;/);
    expect(body).toMatch(/overflow-x:\s*hidden;/);
  });

  it('assigns pink to team 0 and teal to team 1', () => {
    expect(declarations('.pr-ui')).toMatch(/--pr-team-color:\s*#ff2e88;/);
    expect(declarations('.pr-score__team--0')).toMatch(/color:\s*#ff2e88;/);
    expect(declarations('.pr-score__team--1')).toMatch(/color:\s*#19e6d0;/);
  });
});
