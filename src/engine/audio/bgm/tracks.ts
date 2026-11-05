import type { BgmInstrumentId, BgmNote, BgmPart, BgmTrack } from './sequencer';

/**
 * Six original compositions for PAINT RUSH!.
 *
 * Everything is built from tiny helpers so the note data stays readable. The
 * tuning mixes a bright major-pentatonic pop voice with taiko drums, a shamisen
 * pluck and a breathy shakuhachi pad.
 */

type NoteSpec = readonly [step: number, midi: number, length: number, velocity: number];

const SIXTEENTHS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const EIGHTHS: readonly number[] = [0, 2, 4, 6, 8, 10, 12, 14];
const OFFBEATS: readonly number[] = [2, 6, 10, 14];

const KICK = 36;
const SNARE = 38;
const HAT = 42;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function buildNotes(barCount: number, build: (bar: number) => readonly NoteSpec[]): BgmNote[] {
  const notes: BgmNote[] = [];
  for (let bar = 0; bar < barCount; bar += 1) {
    const specs = build(bar);
    for (const spec of specs) {
      const step = Math.round(spec[0]);
      const midi = Math.round(clamp(spec[1], 0, 127));
      const length = Math.max(0.01, Math.round(spec[2]));
      notes.push({
        step: bar * SIXTEENTHS.length + step,
        midi,
        length,
        velocity: clamp(spec[3], 0, 1),
      });
    }
  }
  notes.sort((a, b) => a.step - b.step || a.midi - b.midi);
  return notes;
}

function part(instrument: BgmInstrumentId, notes: readonly BgmNote[]): BgmPart {
  return { instrument, notes };
}

function hits(
  steps: readonly number[],
  midi: number,
  velocity: number,
  length = 1,
): NoteSpec[] {
  return steps.map((step) => [step, midi, length, velocity] as const);
}

function merge(...groups: readonly (readonly NoteSpec[])[]): NoteSpec[] {
  const out: NoteSpec[] = [];
  for (const group of groups) out.push(...group);
  return out;
}

function bassSteps(
  root: number,
  steps: readonly number[],
  length: number,
  velocity: number,
  octaveEvery = 0,
): NoteSpec[] {
  return steps.map((step, index) => {
    const octave = octaveEvery > 0 && index % octaveEvery === octaveEvery - 1;
    return [step, root + (octave ? 12 : 0), length, octave ? velocity * 0.82 : velocity] as const;
  });
}

function powerChord(step: number, root: number, length: number, velocity: number): NoteSpec[] {
  return [
    [step, root, length, velocity],
    [step, root + 7, length, velocity * 0.8],
    [step, root + 12, length, velocity * 0.68],
  ];
}

function strum(
  root: number,
  steps: readonly number[],
  length: number,
  velocity: number,
): NoteSpec[] {
  const out: NoteSpec[] = [];
  for (const step of steps) out.push(...powerChord(step, root, length, velocity));
  return out;
}

/* ---------- title: bright pop rock, 16 bars ---------- */

const TITLE_CHORDS = [38, 33, 35, 31] as const; // D, A, Bm, G

const TITLE_MELODY_A: readonly (readonly NoteSpec[])[] = [
  [
    [0, 74, 2, 0.9],
    [2, 76, 1, 0.72],
    [4, 78, 2, 0.86],
    [8, 81, 1, 0.94],
    [10, 78, 1, 0.78],
    [12, 76, 1, 0.84],
    [14, 74, 1, 0.78],
  ],
  [
    [0, 69, 2, 0.8],
    [4, 71, 1, 0.72],
    [6, 74, 2, 0.88],
    [9, 76, 1, 0.8],
    [12, 78, 2, 0.88],
  ],
  [
    [0, 79, 2, 0.94],
    [2, 78, 1, 0.76],
    [4, 76, 2, 0.84],
    [8, 74, 1, 0.9],
    [10, 76, 1, 0.78],
    [12, 78, 2, 0.88],
  ],
  [
    [0, 81, 3, 0.94],
    [4, 78, 1, 0.76],
    [6, 76, 1, 0.76],
    [8, 74, 4, 0.88],
  ],
];

const TITLE_MELODY_B: readonly (readonly NoteSpec[])[] = [
  [
    [0, 74, 1, 0.88],
    [2, 74, 1, 0.68],
    [4, 76, 2, 0.82],
    [8, 78, 1, 0.9],
    [10, 81, 1, 0.88],
    [12, 83, 2, 0.94],
  ],
  [
    [0, 81, 2, 0.88],
    [4, 78, 1, 0.76],
    [6, 76, 1, 0.76],
    [8, 74, 2, 0.84],
    [12, 71, 2, 0.76],
  ],
  [
    [0, 74, 2, 0.88],
    [4, 76, 1, 0.72],
    [6, 78, 2, 0.88],
    [9, 81, 1, 0.82],
    [12, 83, 2, 0.94],
  ],
  [
    [0, 86, 3, 0.94],
    [4, 83, 1, 0.78],
    [6, 81, 1, 0.78],
    [8, 78, 4, 0.88],
  ],
];

function titleDrums(bar: number): NoteSpec[] {
  const intro = bar < 2;
  const chorus = bar >= 8;
  const kick = intro ? [0, 8] : chorus ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 14];
  const hats = chorus ? SIXTEENTHS : EIGHTHS;
  const hatVelocity = chorus ? 0.3 : 0.38;
  const specs: NoteSpec[] = merge(
    hits(kick, KICK, intro ? 0.68 : 0.95),
    hits([4, 12], SNARE, intro ? 0.5 : 0.82),
    hats.map((step) => [
      step,
      HAT,
      1,
      step % 4 === 0 ? hatVelocity * 1.55 : hatVelocity,
    ] as const),
  );
  if (bar === 7 || bar === 15) specs.push(...hits([14, 15], SNARE, 0.55, 1));
  return specs;
}

function titleBass(bar: number): NoteSpec[] {
  const root = TITLE_CHORDS[bar % 4] ?? 38;
  if (bar < 2) return bassSteps(root, [0, 8], 4, 0.7, 2);
  if (bar < 4) return bassSteps(root, [0, 4, 8, 12], 2, 0.78, 2);
  if (bar < 8) return bassSteps(root, [0, 2, 4, 6, 8, 10, 12, 14], 1, 0.82, 2);
  return bassSteps(root, [0, 2, 4, 6, 8, 10, 12, 14], 1, 0.88, 4);
}

function titleGuitar(bar: number): NoteSpec[] {
  const root = 12 + (TITLE_CHORDS[bar % 4] ?? 38);
  if (bar < 2) return strum(root, [0, 8], 6, 0.46);
  if (bar < 4) return strum(root, [0, 4, 8, 12], 2, 0.6);
  if (bar < 8) return strum(root, [0, 3, 6, 8, 11, 14], 1, 0.7);
  return strum(root, [0, 2, 4, 6, 8, 10, 12, 14], 1, 0.8);
}

function titleMelody(bar: number): NoteSpec[] {
  const local = bar % 8;
  const phrase = local < 4 ? TITLE_MELODY_A : TITLE_MELODY_B;
  return [...(phrase[local % 4] ?? [])];
}

function titlePad(bar: number): NoteSpec[] {
  const pads = [62, 57, 59, 55] as const;
  if (bar === 0) return [[0, 62, 8, 0.3]];
  if (bar === 2) return [[0, 57, 8, 0.3]];
  if (bar < 8) return [];
  if (bar % 2 === 0) {
    const root = pads[(bar / 2) % 4] ?? 62;
    return [
      [0, root, 8, 0.35],
      [4, root + 7, 6, 0.2],
    ];
  }
  return [];
}

export const TITLE_TRACK: BgmTrack = {
  id: 'title',
  bpm: 168,
  loopBars: 16,
  loop: true,
  parts: [
    part('kick', buildNotes(16, (bar) => titleDrums(bar).filter((spec) => spec[1] === KICK))),
    part('snare', buildNotes(16, (bar) => titleDrums(bar).filter((spec) => spec[1] === SNARE))),
    part('hat', buildNotes(16, (bar) => titleDrums(bar).filter((spec) => spec[1] === HAT))),
    part('bass', buildNotes(16, titleBass)),
    part('guitar', buildNotes(16, titleGuitar)),
    part('shamisen', buildNotes(16, titleMelody)),
    part('shakuhachi', buildNotes(16, titlePad)),
  ],
};

/* ---------- battle: 32 bars with verse and chorus ---------- */

const BATTLE_CHORDS = [40, 36, 38, 35] as const; // Em, C, D, Bm

const BATTLE_VERSE: readonly (readonly NoteSpec[])[] = [
  [
    [0, 76, 1, 0.9],
    [2, 79, 1, 0.82],
    [4, 81, 2, 0.92],
    [8, 76, 1, 0.86],
    [12, 74, 1, 0.78],
    [14, 76, 1, 0.82],
  ],
  [
    [0, 72, 2, 0.8],
    [4, 74, 1, 0.76],
    [6, 76, 2, 0.86],
    [8, 74, 1, 0.78],
    [12, 71, 2, 0.76],
  ],
  [
    [0, 76, 1, 0.9],
    [2, 79, 1, 0.82],
    [4, 83, 2, 0.94],
    [8, 81, 1, 0.86],
    [12, 79, 2, 0.82],
  ],
  [
    [0, 74, 2, 0.82],
    [4, 76, 1, 0.78],
    [6, 79, 2, 0.88],
    [8, 81, 2, 0.9],
    [12, 83, 2, 0.92],
  ],
  [
    [0, 84, 1, 0.9],
    [2, 83, 1, 0.8],
    [4, 81, 2, 0.88],
    [8, 79, 1, 0.86],
    [12, 76, 1, 0.8],
    [14, 79, 1, 0.84],
  ],
  [
    [0, 81, 2, 0.88],
    [4, 79, 1, 0.78],
    [6, 76, 2, 0.84],
    [8, 74, 1, 0.8],
    [12, 71, 2, 0.76],
  ],
  [
    [0, 76, 1, 0.88],
    [2, 79, 1, 0.82],
    [4, 81, 2, 0.9],
    [8, 83, 2, 0.92],
    [12, 86, 2, 0.94],
  ],
  [
    [0, 83, 2, 0.9],
    [4, 81, 2, 0.84],
    [8, 79, 2, 0.82],
    [12, 76, 2, 0.8],
  ],
];

const BATTLE_CHORUS: readonly (readonly NoteSpec[])[] = [
  [
    [0, 83, 1, 0.94],
    [2, 86, 1, 0.9],
    [4, 88, 2, 0.96],
    [8, 86, 1, 0.88],
    [12, 83, 2, 0.9],
  ],
  [
    [0, 83, 1, 0.9],
    [2, 81, 1, 0.8],
    [4, 79, 1, 0.82],
    [6, 76, 2, 0.84],
    [10, 74, 1, 0.78],
    [12, 76, 2, 0.84],
  ],
  [
    [0, 83, 1, 0.92],
    [2, 86, 1, 0.88],
    [4, 88, 1, 0.94],
    [6, 91, 2, 0.96],
    [10, 88, 1, 0.86],
    [12, 86, 2, 0.9],
  ],
  [
    [0, 83, 2, 0.9],
    [4, 86, 1, 0.86],
    [6, 88, 2, 0.92],
    [10, 86, 1, 0.84],
    [12, 83, 2, 0.88],
  ],
  [
    [0, 83, 1, 0.94],
    [2, 86, 1, 0.9],
    [4, 88, 2, 0.96],
    [8, 86, 1, 0.88],
    [10, 83, 1, 0.82],
    [12, 81, 2, 0.86],
  ],
  [
    [0, 81, 1, 0.88],
    [2, 83, 1, 0.84],
    [4, 86, 2, 0.92],
    [8, 83, 1, 0.84],
    [10, 81, 1, 0.8],
    [12, 79, 2, 0.84],
  ],
  [
    [0, 76, 1, 0.86],
    [2, 79, 1, 0.82],
    [4, 81, 1, 0.88],
    [6, 83, 1, 0.88],
    [8, 86, 1, 0.92],
    [10, 88, 1, 0.94],
    [12, 91, 2, 0.96],
  ],
  [
    [0, 88, 4, 0.96],
    [8, 86, 2, 0.86],
    [12, 83, 2, 0.84],
  ],
];

function battleDrums(bar: number): NoteSpec[] {
  const chorus = bar >= 16;
  const kick = chorus ? [0, 2, 4, 6, 8, 10, 12, 14] : [0, 3, 6, 8, 11, 14];
  const hatVelocity = chorus ? 0.34 : 0.3;
  const specs: NoteSpec[] = merge(
    hits(kick, KICK, chorus ? 0.96 : 0.9),
    hits([4, 12], SNARE, chorus ? 0.9 : 0.82),
    hits(OFFBEATS, SNARE, chorus ? 0.32 : 0.24),
    SIXTEENTHS.map((step) => [
      step,
      HAT,
      1,
      step % 4 === 0 ? hatVelocity * 1.5 : hatVelocity,
    ] as const),
  );
  if (bar % 8 === 7) specs.push(...hits([10, 11, 12, 14, 15], SNARE, 0.6, 1));
  return specs;
}

function battleBass(bar: number): NoteSpec[] {
  const root = BATTLE_CHORDS[bar % 4] ?? 40;
  if (bar < 16) return bassSteps(root, EIGHTHS, 1, 0.84, 2);
  return bassSteps(root, [0, 1, 2, 4, 6, 7, 8, 10, 11, 12, 14, 15], 1, 0.9, 3);
}

function battleGuitar(bar: number): NoteSpec[] {
  const root = 12 + (BATTLE_CHORDS[bar % 4] ?? 40);
  if (bar < 16) return strum(root, [0, 2, 5, 8, 10, 13], 1, 0.66);
  return strum(root, [0, 4, 8, 12], 2, 0.82);
}

function battleMelody(bar: number): NoteSpec[] {
  const local = bar % 8;
  const phrase = bar < 16 ? BATTLE_VERSE : BATTLE_CHORUS;
  return [...(phrase[local] ?? [])];
}

function battlePad(bar: number): NoteSpec[] {
  const pads = [64, 60, 62, 59] as const;
  if (bar < 16) {
    if (bar % 8 === 0) return [[0, 64, 8, 0.22]];
    return [];
  }
  if (bar % 4 === 0) {
    const root = pads[(bar % 16) / 4] ?? 64;
    return [
      [0, root, 8, 0.28],
      [8, root + 7, 8, 0.18],
    ];
  }
  return [];
}

export const BATTLE_TRACK: BgmTrack = {
  id: 'battle',
  bpm: 170,
  loopBars: 32,
  loop: true,
  parts: [
    part('kick', buildNotes(32, (bar) => battleDrums(bar).filter((spec) => spec[1] === KICK))),
    part('snare', buildNotes(32, (bar) => battleDrums(bar).filter((spec) => spec[1] === SNARE))),
    part('hat', buildNotes(32, (bar) => battleDrums(bar).filter((spec) => spec[1] === HAT))),
    part('bass', buildNotes(32, battleBass)),
    part('guitar', buildNotes(32, battleGuitar)),
    part('shamisen', buildNotes(32, battleMelody)),
    part('shakuhachi', buildNotes(32, battlePad)),
  ],
};

/* ---------- lastMinute: 16 bars, urgent ---------- */

const LAST_CHORDS = [33, 33, 41, 43] as const; // A, A, F, G

const LAST_MELODY: readonly (readonly NoteSpec[])[] = [
  [
    [0, 81, 1, 0.96],
    [2, 88, 1, 0.92],
    [4, 86, 1, 0.9],
    [6, 84, 1, 0.88],
    [8, 81, 1, 0.92],
    [10, 84, 1, 0.88],
    [12, 86, 1, 0.92],
    [14, 88, 1, 0.96],
  ],
  [
    [0, 86, 1, 0.94],
    [2, 84, 1, 0.88],
    [4, 81, 1, 0.9],
    [6, 79, 1, 0.84],
    [8, 81, 1, 0.92],
    [12, 84, 2, 0.9],
  ],
  [
    [0, 88, 1, 0.96],
    [2, 86, 1, 0.9],
    [4, 84, 1, 0.88],
    [6, 81, 1, 0.86],
    [8, 84, 1, 0.9],
    [10, 86, 1, 0.92],
    [12, 88, 2, 0.96],
  ],
  [
    [0, 91, 2, 0.96],
    [4, 88, 1, 0.9],
    [6, 86, 1, 0.88],
    [8, 84, 1, 0.9],
    [12, 81, 2, 0.88],
  ],
  [
    [0, 81, 1, 0.96],
    [2, 81, 1, 0.8],
    [4, 84, 1, 0.9],
    [6, 86, 1, 0.9],
    [8, 88, 1, 0.94],
    [10, 86, 1, 0.88],
    [12, 84, 1, 0.9],
    [14, 81, 1, 0.86],
  ],
  [
    [0, 79, 1, 0.86],
    [2, 81, 1, 0.88],
    [4, 84, 1, 0.9],
    [6, 86, 1, 0.92],
    [8, 88, 2, 0.96],
    [12, 86, 2, 0.9],
  ],
  [
    [0, 84, 1, 0.92],
    [2, 86, 1, 0.92],
    [4, 88, 1, 0.96],
    [6, 91, 1, 0.96],
    [8, 86, 2, 0.9],
    [12, 84, 2, 0.88],
  ],
  [
    [0, 81, 2, 0.94],
    [4, 84, 1, 0.88],
    [6, 88, 1, 0.92],
    [8, 86, 2, 0.9],
    [12, 81, 4, 0.9],
  ],
];

function lastDrums(bar: number): NoteSpec[] {
  const specs: NoteSpec[] = merge(
    hits(SIXTEENTHS, KICK, bar % 4 === 0 ? 0.9 : 0.96),
    hits([4, 12], SNARE, 0.9),
    hits([7, 15], SNARE, 0.3),
    SIXTEENTHS.map((step) => [
      step,
      HAT,
      1,
      step % 4 === 0 ? 0.48 : step % 2 === 0 ? 0.32 : 0.24,
    ] as const),
  );
  if (bar === 7 || bar === 15) specs.push(...hits(SIXTEENTHS, SNARE, 0.58, 1));
  return specs;
}

function lastBass(bar: number): NoteSpec[] {
  const root = LAST_CHORDS[bar % 4] ?? 33;
  return bassSteps(
    root,
    [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14],
    1,
    0.92,
    3,
  );
}

function lastGuitar(bar: number): NoteSpec[] {
  const root = 12 + (LAST_CHORDS[bar % 4] ?? 33);
  const steps = bar >= 8 ? [0, 1, 2, 4, 6, 8, 10, 12, 14, 15] : [0, 2, 4, 6, 8, 10, 12, 14];
  return strum(root, steps, 1, 0.84);
}

function lastMelody(bar: number): NoteSpec[] {
  return [...(LAST_MELODY[bar % 8] ?? [])];
}

function lastPad(bar: number): NoteSpec[] {
  const pads = [57, 57, 53, 55] as const;
  const local = bar % 4;
  const root = pads[local] ?? 57;
  if (local === 0) return [[0, root, 8, 0.24]];
  if (local === 2) return [[8, root, 8, 0.2]];
  return [];
}

export const LAST_MINUTE_TRACK: BgmTrack = {
  id: 'lastMinute',
  bpm: 175,
  loopBars: 16,
  loop: true,
  parts: [
    part('kick', buildNotes(16, (bar) => lastDrums(bar).filter((spec) => spec[1] === KICK))),
    part('snare', buildNotes(16, (bar) => lastDrums(bar).filter((spec) => spec[1] === SNARE))),
    part('hat', buildNotes(16, (bar) => lastDrums(bar).filter((spec) => spec[1] === HAT))),
    part('bass', buildNotes(16, lastBass)),
    part('guitar', buildNotes(16, lastGuitar)),
    part('shamisen', buildNotes(16, lastMelody)),
    part('shakuhachi', buildNotes(16, lastPad)),
  ],
};

/* ---------- special: 8-bar fanfare ---------- */

const SPECIAL_CHORDS = [38, 38, 31, 31, 33, 33, 38, 38] as const;

const SPECIAL_MELODY: readonly (readonly NoteSpec[])[] = [
  [
    [0, 74, 2, 0.94],
    [2, 78, 1, 0.86],
    [4, 81, 2, 0.96],
    [6, 83, 1, 0.9],
  ],
  [
    [0, 86, 4, 0.98],
    [8, 83, 1, 0.86],
    [12, 81, 2, 0.9],
  ],
  [
    [0, 79, 2, 0.94],
    [2, 83, 1, 0.88],
    [4, 86, 2, 0.96],
    [6, 88, 1, 0.94],
  ],
  [
    [0, 91, 4, 0.98],
    [8, 88, 1, 0.9],
    [12, 86, 2, 0.92],
  ],
  [
    [0, 81, 2, 0.96],
    [2, 83, 1, 0.9],
    [4, 86, 2, 0.96],
    [6, 88, 1, 0.94],
  ],
  [
    [0, 86, 4, 0.98],
    [8, 83, 1, 0.88],
    [12, 81, 2, 0.92],
  ],
  [
    [0, 81, 2, 0.94],
    [2, 83, 1, 0.9],
    [4, 86, 2, 0.96],
    [6, 88, 1, 0.96],
  ],
  [
    [0, 86, 16, 0.98],
  ],
];

function specialDrums(bar: number): NoteSpec[] {
  const specs: NoteSpec[] = merge(
    hits(SIXTEENTHS, KICK, bar === 0 ? 0.86 : 0.98),
    hits([4, 12], SNARE, 0.92),
    hits(OFFBEATS, SNARE, 0.3),
    SIXTEENTHS.map((step) => [
      step,
      HAT,
      1,
      step % 4 === 0 ? 0.46 : 0.28,
    ] as const),
  );
  if (bar === 7) specs.push(...hits([8, 10, 12, 13, 14, 15], SNARE, 0.68, 1));
  return specs;
}

function specialBass(bar: number): NoteSpec[] {
  const root = SPECIAL_CHORDS[bar] ?? 38;
  if (bar === 7) return bassSteps(root, [0, 2, 4, 8, 12], 2, 0.95, 2);
  return bassSteps(root, [0, 2, 4, 6, 8, 10, 12, 14], 1, 0.94, 4);
}

function specialGuitar(bar: number): NoteSpec[] {
  const root = 12 + (SPECIAL_CHORDS[bar] ?? 38);
  if (bar === 7) return strum(root, [0, 8], 8, 0.86);
  return strum(root, [0, 4, 8, 12], 3, 0.82);
}

function specialPad(bar: number): NoteSpec[] {
  const pads = [62, 62, 55, 55, 57, 57, 62, 62] as const;
  const root = pads[bar] ?? 62;
  return [
    [0, root, 8, 0.3],
    [8, root + 7, 8, 0.2],
  ];
}

export const SPECIAL_TRACK: BgmTrack = {
  id: 'special',
  bpm: 174,
  loopBars: 8,
  loop: true,
  parts: [
    part('kick', buildNotes(8, (bar) => specialDrums(bar).filter((spec) => spec[1] === KICK))),
    part('snare', buildNotes(8, (bar) => specialDrums(bar).filter((spec) => spec[1] === SNARE))),
    part('hat', buildNotes(8, (bar) => specialDrums(bar).filter((spec) => spec[1] === HAT))),
    part('bass', buildNotes(8, specialBass)),
    part('guitar', buildNotes(8, specialGuitar)),
    part('shamisen', buildNotes(8, (bar) => [...(SPECIAL_MELODY[bar] ?? [])])),
    part('shakuhachi', buildNotes(8, specialPad)),
  ],
};

/* ---------- win: 12-second fanfare ---------- */

const WIN_CHORDS = [38, 38, 31, 31, 33, 33, 38, 38] as const;

const WIN_MELODY: readonly (readonly NoteSpec[])[] = [
  [
    [0, 74, 2, 0.9],
    [2, 74, 1, 0.8],
    [4, 78, 2, 0.92],
    [6, 81, 2, 0.96],
  ],
  [
    [0, 83, 3, 0.98],
    [4, 81, 1, 0.84],
    [6, 78, 2, 0.88],
  ],
  [
    [0, 74, 2, 0.9],
    [2, 76, 1, 0.82],
    [4, 78, 2, 0.92],
    [6, 81, 2, 0.94],
  ],
  [
    [0, 86, 4, 0.98],
  ],
  [
    [0, 83, 1, 0.9],
    [2, 81, 1, 0.84],
    [4, 78, 2, 0.9],
    [6, 81, 2, 0.92],
  ],
  [
    [0, 83, 4, 0.96],
  ],
  [
    [0, 81, 2, 0.92],
    [2, 83, 1, 0.88],
    [4, 86, 2, 0.96],
    [6, 88, 2, 0.98],
  ],
  [
    [0, 86, 16, 0.98],
  ],
];

function winDrums(bar: number): NoteSpec[] {
  const intro = bar < 2;
  const specs: NoteSpec[] = merge(
    hits(intro ? [0, 8] : [0, 4, 8, 12], KICK, intro ? 0.7 : 0.94),
    hits([4, 12], SNARE, intro ? 0.5 : 0.88),
    hits(intro ? EIGHTHS : SIXTEENTHS, HAT, intro ? 0.34 : 0.28),
  );
  if (bar === 7) specs.push(...hits([10, 11, 12, 13, 14, 15], SNARE, 0.7, 1));
  return specs;
}

function winBass(bar: number): NoteSpec[] {
  const root = WIN_CHORDS[bar] ?? 38;
  if (bar === 7) return bassSteps(root, [0], 16, 0.92);
  return bassSteps(root, [0, 4, 8, 12], 3, 0.84, 2);
}

function winGuitar(bar: number): NoteSpec[] {
  const root = 12 + (WIN_CHORDS[bar] ?? 38);
  if (bar === 7) return strum(root, [0], 16, 0.86);
  return strum(root, [0, 8], 7, 0.76);
}

function winPad(bar: number): NoteSpec[] {
  if (bar === 7) {
    return [
      [0, 74, 16, 0.36],
      [0, 81, 16, 0.22],
    ];
  }
  if (bar % 2 === 0) return [[0, WIN_CHORDS[bar] === 31 ? 67 : 62, 8, 0.26]];
  return [];
}

export const WIN_TRACK: BgmTrack = {
  id: 'win',
  bpm: 160,
  loopBars: 8,
  loop: false,
  parts: [
    part('kick', buildNotes(8, (bar) => winDrums(bar).filter((spec) => spec[1] === KICK))),
    part('snare', buildNotes(8, (bar) => winDrums(bar).filter((spec) => spec[1] === SNARE))),
    part('hat', buildNotes(8, (bar) => winDrums(bar).filter((spec) => spec[1] === HAT))),
    part('bass', buildNotes(8, winBass)),
    part('guitar', buildNotes(8, winGuitar)),
    part('shamisen', buildNotes(8, (bar) => [...(WIN_MELODY[bar] ?? [])])),
    part('shakuhachi', buildNotes(8, winPad)),
  ],
};

/* ---------- lose: gently comic 12-second jingle ---------- */

const LOSE_CHORDS = [31, 36, 38, 31, 31, 36, 38, 31] as const;

const LOSE_MELODY: readonly (readonly NoteSpec[])[] = [
  [
    [0, 79, 2, 0.82],
    [2, 78, 1, 0.7],
    [4, 76, 2, 0.78],
    [6, 74, 2, 0.74],
  ],
  [
    [0, 72, 2, 0.74],
    [2, 71, 1, 0.66],
    [4, 69, 2, 0.72],
    [6, 67, 2, 0.68],
  ],
  [
    [0, 74, 2, 0.76],
    [2, 72, 1, 0.66],
    [4, 71, 2, 0.7],
    [8, 69, 2, 0.72],
  ],
  [
    [0, 67, 4, 0.74],
    [8, 65, 2, 0.66],
  ],
  [
    [0, 76, 2, 0.78],
    [2, 74, 1, 0.68],
    [4, 72, 2, 0.74],
    [6, 71, 2, 0.7],
  ],
  [
    [0, 69, 2, 0.7],
    [4, 67, 2, 0.66],
    [8, 64, 3, 0.68],
  ],
  [
    [0, 65, 2, 0.72],
    [2, 64, 1, 0.62],
    [4, 62, 2, 0.68],
    [6, 60, 2, 0.64],
  ],
  [
    [0, 59, 8, 0.7],
    [8, 60, 2, 0.54],
  ],
];

function loseDrums(bar: number): NoteSpec[] {
  const specs: NoteSpec[] = merge(
    hits([0, 8], KICK, 0.66, 1),
    hits([4, 12], SNARE, 0.52, 1),
    hits(EIGHTHS, HAT, 0.26, 1),
  );
  if (bar === 7) specs.push(...hits([8, 10, 12, 14], SNARE, 0.3, 1));
  return specs;
}

function loseBass(bar: number): NoteSpec[] {
  const root = LOSE_CHORDS[bar] ?? 31;
  return bassSteps(root, [0, 4, 8, 12], 2, 0.66, 2);
}

function loseGuitar(bar: number): NoteSpec[] {
  const root = 12 + (LOSE_CHORDS[bar] ?? 31);
  return strum(root, [2, 6, 10, 14], 1, 0.38);
}

function losePad(bar: number): NoteSpec[] {
  if (bar === 7) return [[0, 55, 16, 0.24]];
  if (bar % 4 === 0) return [[0, LOSE_CHORDS[bar] === 31 ? 55 : 60, 8, 0.2]];
  return [];
}

export const LOSE_TRACK: BgmTrack = {
  id: 'lose',
  bpm: 150,
  loopBars: 8,
  loop: false,
  parts: [
    part('kick', buildNotes(8, (bar) => loseDrums(bar).filter((spec) => spec[1] === KICK))),
    part('snare', buildNotes(8, (bar) => loseDrums(bar).filter((spec) => spec[1] === SNARE))),
    part('hat', buildNotes(8, (bar) => loseDrums(bar).filter((spec) => spec[1] === HAT))),
    part('bass', buildNotes(8, loseBass)),
    part('guitar', buildNotes(8, loseGuitar)),
    part('shamisen', buildNotes(8, (bar) => [...(LOSE_MELODY[bar] ?? [])])),
    part('shakuhachi', buildNotes(8, losePad)),
  ],
};

export const TRACKS: readonly BgmTrack[] = [
  TITLE_TRACK,
  BATTLE_TRACK,
  LAST_MINUTE_TRACK,
  WIN_TRACK,
  LOSE_TRACK,
  SPECIAL_TRACK,
];

export const TRACK_IDS = ['title', 'battle', 'lastMinute', 'win', 'lose', 'special'] as const;

const BY_ID = new Map<string, BgmTrack>(TRACKS.map((track) => [track.id, track]));

/** Returns a track by id, or null for an unknown id. */
export function getTrack(id: string): BgmTrack | null {
  return BY_ID.get(id) ?? null;
}
