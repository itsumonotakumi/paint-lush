/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  return declarationsIn(css, selector);
}

function declarationsIn(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(block);
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

/** Returns the body of the first block opened by `opener`, honouring nesting. */
function blockAfter(opener: string): string {
  const start = css.indexOf(opener);
  expect(start, `missing ${opener}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  expect(open, `missing body for ${opener}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const ch = css[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unclosed ${opener}`);
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

  it('fills the gourd from --pr-ink on the fill element itself', () => {
    const fill = declarations('.pr-gourd__fill');
    expect(fill).toMatch(/width:\s*100%;/);
    expect(fill).toMatch(/height:\s*var\(--pr-ink, 0%\);/);
    expect(fill).toMatch(/background:\s*var\(--pr-team-color\);/);

    // No other rule may give the fill a fixed height, and the gauge variable
    // must not be shadowed by a colour of the same name.
    const heightRules = Array.from(css.matchAll(/([^{}]+)\{([^}]*height:\s*var\(--pr-ink[^}]*)\}/g));
    expect(heightRules).toHaveLength(1);
    expect(css).not.toMatch(/--pr-ink\s*:\s*[^;]*#/);
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

  it('styles the pause resume button and its muted reason line', () => {
    const button = declarations('.pr-paused__button');
    expect(button).toMatch(/min-height:\s*64px;/);
    expect(button).toMatch(/pointer-events:\s*auto;/);

    const reason = declarations('.pr-paused__reason');
    expect(reason).toMatch(/color:\s*rgba\(43, 47, 92, 0\.66\);/);
    expect(reason).toMatch(/font-size:\s*clamp\(/);

    expect(css).not.toMatch(/\.pr-paused__hint/);
  });

  it('keeps overlays light and sunny instead of dark', () => {
    const start = declarations('.pr-start');
    expect(start).toMatch(/rgba\(255, 246, 229, 0\.62\)/);

    const paused = declarations('.pr-paused');
    expect(paused).toMatch(/rgba\(255, 246, 229, 0\.72\)/);

    const orientation = declarations('.pr-orientation');
    expect(orientation).toMatch(/rgba\(255, 240, 211, 0\.96\)/);
    expect(orientation).toMatch(/color:\s*#2b2f5c;/);
    expect(orientation).toMatch(/z-index:\s*40;/);
    // The notice is app-wide now and only shows on touch devices in portrait.
    expect(css).toMatch(/@media \(orientation: portrait\) and \(any-pointer: coarse\)\s*\{/);
  });

  it('styles the gesture-gated たたかう button above the match HUD', () => {
    const gate = declarations('.pr-start-gate');
    expect(gate).toMatch(/position:\s*absolute;/);
    expect(gate).toMatch(/pointer-events:\s*none;/);

    const button = declarations('.pr-start-gate__button');
    expect(button).toMatch(/pointer-events:\s*auto;/);
    expect(button).toMatch(/min-height:\s*72px;/);
  });

  it('gives the debug panel its own dark surface for a bright scene', () => {
    expect(declarations('.pr-debug')).toMatch(/--pr-debug-panel:\s*#232847;/);
    const body = declarations('.pr-debug__body');
    expect(body).toMatch(/background:\s*var\(--pr-debug-panel\);/);
    expect(declarations('.pr-debug__output')).toMatch(/background:\s*#171b33;/);
  });

  it('centres a big rounded match clock at the top', () => {
    const time = declarations('.pr-time');
    expect(time).toMatch(/position:\s*absolute;/);
    expect(time).toMatch(/top:\s*max\(14px, env\(safe-area-inset-top\)\);/);
    expect(time).toMatch(/left:\s*50%;/);
    expect(time).toMatch(/transform:\s*translateX\(-50%\);/);
    expect(time).toMatch(/font-size:\s*clamp\(34px, 6vw, 64px\);/);
    expect(time).toMatch(/font-variant-numeric:\s*tabular-nums;/);
  });

  it('draws the countdown numeral huge in the middle of the screen', () => {
    const countdown = declarations('.pr-countdown');
    expect(countdown).toMatch(/top:\s*50%;/);
    expect(countdown).toMatch(/left:\s*50%;/);
    expect(countdown).toMatch(/transform:\s*translate\(-50%, -50%\);/);
    expect(countdown).toMatch(/font-size:\s*clamp\(96px, 22vw, 220px\);/);
    expect(countdown).toMatch(/-webkit-text-stroke:\s*6px #2b2f5c;/);
  });

  it('styles the call-out banner as a sunny tilted sign that fades in', () => {
    const banner = declarations('.pr-banner');
    expect(banner).toMatch(/background:\s*#ffc14d;/);
    expect(banner).toMatch(/color:\s*#2b2f5c;/);
    expect(banner).toMatch(/opacity:\s*0;/);
    expect(banner).toMatch(/transition:/);
    expect(banner).toMatch(/transform:\s*translate\(-50%, -16px\) rotate\(-2deg\);/);

    expect(declarations('.pr-banner.is-visible')).toMatch(/opacity:\s*1;/);
  });

  it('lines up eight round roster dots and greys downed players', () => {
    const roster = declarations('.pr-roster');
    expect(roster).toMatch(/display:\s*flex;/);
    expect(roster).toMatch(/gap:\s*6px;/);
    expect(roster).toMatch(/background:\s*var\(--pr-panel\);/);

    const dot = declarations('.pr-roster__dot');
    expect(dot).toMatch(/width:\s*13px;/);
    expect(dot).toMatch(/height:\s*13px;/);
    expect(dot).toMatch(/border-radius:\s*50%;/);
    expect(dot).toMatch(/background:\s*var\(--pr-dot-color, #b9b4ac\);/);

    expect(declarations('.pr-roster__dot.is-down')).toMatch(/background:\s*#b9b4ac;/);
    expect(declarations('.pr-roster__dot.is-enemy')).toMatch(/box-shadow:/);
  });

  it('fades kill log lines out over four hundred milliseconds', () => {
    const line = declarations('.pr-killlog__line');
    expect(line).toMatch(/border-radius:\s*12px;/);
    expect(line).toMatch(/background:\s*var\(--pr-panel\);/);
    expect(line).toMatch(/transition:\s*opacity 400ms ease-out;/);

    expect(declarations('.pr-killlog__line.is-faded')).toMatch(/opacity:\s*0;/);
  });

  it('draws the おうぎ gauge as a ring that glows when full', () => {
    const ring = declarations('.pr-gauge__ring');
    expect(ring).toMatch(/width:\s*74px;/);
    expect(ring).toMatch(/height:\s*74px;/);
    expect(ring).toMatch(/border-radius:\s*50%;/);
    expect(ring).toMatch(/--pr-gauge-fill:\s*0%;/);
    expect(ring).toMatch(
      /background:\s*conic-gradient\(var\(--pr-team-color\) var\(--pr-gauge-fill\), rgba\(255, 255, 255, 0\.48\) 0\);/,
    );

    const full = declarations('.pr-gauge.is-full .pr-gauge__ring');
    expect(full).toMatch(/box-shadow:/);
    expect(full).toMatch(/animation:\s*pr-gauge-glow 1\.15s ease-in-out infinite;/);

    expect(declarations('.pr-gauge__label')).toMatch(/border-radius:\s*999px;/);
  });

  it('wraps a charge ring around the crosshair', () => {
    const charge = declarations('.pr-charge');
    expect(charge).toMatch(/--pr-charge-fill:\s*0%;/);
    expect(charge).toMatch(/border-radius:\s*50%;/);
    expect(charge).toMatch(/background:\s*conic-gradient\(/);
    expect(charge).toMatch(/transform:\s*translate\(-50%, -50%\);/);
    expect(charge).toMatch(/-webkit-mask:\s*radial-gradient\(/);
    expect(charge).toMatch(/mask:\s*radial-gradient\(/);
  });

  it('loads no external resources', () => {
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/@import/);
  });
});

describe('ui.css short landscape phones', () => {
  const compact = blockAfter('@media (max-height: 480px)');

  it('adds a compact query for screens shorter than 480 px', () => {
    expect(css).toMatch(/@media \(max-height: 480px\)\s*\{/);
  });

  it('shrinks the match clock and its padding', () => {
    const time = declarationsIn(compact, '.pr-time');
    expect(time).toMatch(/font-size:\s*28px;/);
    expect(time).toMatch(/padding:\s*3px 14px 4px;/);
    expect(time).toMatch(/border-radius:\s*15px;/);
  });

  it('puts small hearts in the top left row with the roster dots beside them', () => {
    const hp = declarationsIn(compact, '.pr-hp');
    expect(hp).toMatch(/top:/);
    expect(hp).toMatch(/bottom:\s*auto;/);
    expect(hp).toMatch(/gap:\s*4px;/);

    const heart = declarationsIn(compact, '.pr-hp__heart');
    expect(heart).toMatch(/width:\s*22px;/);
    expect(heart).toMatch(/height:\s*21px;/);

    const roster = declarationsIn(compact, '.pr-roster');
    expect(roster).toMatch(/top:/);
    expect(roster).toMatch(/left:\s*max\(90px/);
    expect(roster).toMatch(/gap:\s*3px;/);

    const dot = declarationsIn(compact, '.pr-roster__dot');
    expect(dot).toMatch(/width:\s*8px;/);
    expect(dot).toMatch(/height:\s*8px;/);
  });

  it('shrinks the gourd, form label and gauge', () => {
    const gourd = declarationsIn(compact, '.pr-gourd');
    expect(gourd).toMatch(/width:\s*40px;/);
    expect(gourd).toMatch(/height:\s*58px;/);
    expect(gourd).toMatch(/bottom:\s*auto;/);

    const form = declarationsIn(compact, '.pr-form');
    expect(form).toMatch(/font-size:\s*12px;/);
    expect(form).toMatch(/padding:\s*3px 8px 4px;/);

    const ring = declarationsIn(compact, '.pr-gauge__ring');
    expect(ring).toMatch(/width:\s*56px;/);
    expect(ring).toMatch(/height:\s*56px;/);
  });

  it('keeps the gauge left of the fire and sub button cluster', () => {
    const gauge = declarationsIn(compact, '.pr-gauge');
    // The cluster starts at 564 px from the left at 844 x 390, so 300 px from
    // the right leaves the ring completely clear on the same screen.
    expect(gauge).toMatch(/right:\s*max\(300px, calc\(env\(safe-area-inset-right\) \+ 290px\)\);/);
    expect(gauge).toMatch(/bottom:/);
  });

  it('uses no huge fixed sizes inside the compact query', () => {
    const pattern = /(?:^|[;{\s])(width|height|min-width|min-height|font-size):\s*(\d+(?:\.\d+)?)px/g;
    const sizes = Array.from(compact.matchAll(pattern), (match) => Number(match[2]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(58);
  });
});
