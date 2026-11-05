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
    expect(page).toMatch(/background:\s*linear-gradient\(/);

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

  it('uses the child friendly rounded font stack and dark blue ink', () => {
    const ui = declarations('.pr-ui');
    expect(ui).toMatch(/system-ui/);
    expect(ui).toMatch(/Hiragino Maru Gothic ProN/);
    expect(ui).toMatch(/BIZ UDPGothic/);
    expect(ui).toMatch(/sans-serif/);
    expect(ui).toMatch(/color:\s*#2b2f5c;/);
    expect(ui).toMatch(/--pr-panel:\s*rgba\(255, 255, 255, 0\.85\);/);
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

  it('styles the title as a pink to orange logo with a dark outline and three drips', () => {
    const logo = declarations('.pr-start__logo');
    expect(logo).toMatch(/transform:\s*rotate\(-4deg\);/);

    const title = declarations('.pr-start__title');
    expect(title).toMatch(/font-weight:\s*900;/);
    expect(title).toMatch(/-webkit-text-stroke:\s*3px #2b2f5c;/);
    expect(title).toMatch(/background:\s*linear-gradient\(180deg, #ff2e88 0%, #ffc14d 100%\);/);
    expect(title).toMatch(/background-clip:\s*text;/);
    expect(title).toMatch(/-webkit-background-clip:\s*text;/);
    expect(title).toMatch(/color:\s*transparent;/);

    const drip = declarations('.pr-start__drip');
    expect(drip).toMatch(/border-radius:\s*50%;/);
    expect(drip).toMatch(/background:\s*linear-gradient\(/);
    expect(css.match(/\.pr-start__drip--[123]\s*\{/g)).toHaveLength(3);
  });

  it('gives the main button the big sunny arcade shape', () => {
    const button = declarations('.pr-start__button');
    expect(button).toMatch(/min-height:\s*64px;/);
    expect(button).toMatch(/border-radius:\s*999px;/);
    expect(button).toMatch(/background:\s*#ffc14d;/);
    expect(button).toMatch(/color:\s*#2b2f5c;/);
    expect(button).toMatch(/font-size:\s*24px;/);
    expect(button).toMatch(/box-shadow:\s*0 6px 0 #b7832b;/);

    const active = declarations('.pr-start__button:active');
    expect(active).toMatch(/transform:\s*translateY\(4px\);/);
    expect(active).toMatch(/box-shadow:\s*0 2px 0 #b7832b;/);
  });

  it('enlarges the gourd gauge and draws three round hearts', () => {
    const gourd = declarations('.pr-gourd');
    expect(gourd).toMatch(/width:\s*72px;/);
    expect(gourd).toMatch(/height:\s*104px;/);

    const heart = declarations('.pr-hp__heart');
    expect(heart).toMatch(/background:\s*#c9c4ba;/);

    const fill = declarations('.pr-hp__heart-fill');
    expect(fill).toMatch(/background:\s*#ff4d6d;/);
    expect(fill).toMatch(/width:\s*var\(--pr-heart-fill, 100%\);/);
  });

  it('uses rounded score pills with team coloured paint tube caps', () => {
    const pill = declarations('.pr-score__team');
    expect(pill).toMatch(/border-radius:\s*18px;/);
    expect(pill).toMatch(/background:\s*var\(--pr-panel\);/);
    expect(pill).toMatch(/color:\s*#2b2f5c;/);

    expect(css).toMatch(
      /\.pr-score__team::before,\s*\.pr-score__team::after\s*\{[^}]*background:\s*var\(--pr-team-color\);/,
    );

    expect(declarations('.pr-score__team--0')).toMatch(/--pr-team-color:\s*#ff2e88;/);
    expect(declarations('.pr-score__team--1')).toMatch(/--pr-team-color:\s*#19e6d0;/);
  });

  it('keeps overlays light and sunny instead of dark', () => {
    const start = declarations('.pr-start');
    expect(start).toMatch(/rgba\(255, 246, 229, 0\.62\)/);

    const paused = declarations('.pr-paused');
    expect(paused).toMatch(/rgba\(255, 246, 229, 0\.72\)/);

    const orientation = declarations('.pr-orientation');
    expect(orientation).toMatch(/rgba\(255, 240, 211, 0\.96\)/);
    expect(orientation).toMatch(/color:\s*#2b2f5c;/);
  });

  it('gives the debug panel its own dark surface for a bright scene', () => {
    expect(declarations('.pr-debug')).toMatch(/--pr-debug-panel:\s*#232847;/);
    const body = declarations('.pr-debug__body');
    expect(body).toMatch(/background:\s*var\(--pr-debug-panel\);/);
    expect(declarations('.pr-debug__output')).toMatch(/background:\s*#171b33;/);
  });

  it('loads no external resources', () => {
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/@import/);
  });
});
