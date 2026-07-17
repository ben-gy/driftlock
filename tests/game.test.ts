/**
 * game.test.ts — the rules.
 *
 * Covers the PATHS, not one happy trip: legal vs locked vs empty lines, wrapping
 * at both edges, the tide at each radius, the harvest, turn-0 fairness, and the
 * two fast paths that must agree with the slow ones they replaced.
 */

import { describe, expect, it } from 'vitest';
import {
  applyMove,
  bankCount,
  bestBankAvailable,
  centre,
  chooseAiMove,
  generateBoard,
  isWell,
  legalMoves,
  moveError,
  stoneValue,
  stonesLeft,
  tideRadius,
  wellCells,
  type GameOpts,
  type GameState,
  type Move,
} from '../src/game';
import { MODES } from '../src/modes';

const DUEL: GameOpts = MODES.duel;

/** Build an exact board so a case says what it means. `.` empty, `o` stone. */
function boardOf(rows: string[], opts: GameOpts = DUEL, patch: Partial<GameState> = {}): GameState {
  const size = rows.length;
  const cells = new Uint8Array(size * size);
  rows.forEach((row, r) => [...row].forEach((ch, c) => (cells[r * size + c] = ch === 'o' ? 1 : 0)));
  return {
    size,
    opts: { ...opts, size },
    cells,
    scores: [0, 0],
    turn: 0,
    turnNo: 0,
    locked: null,
    finished: false,
    winner: -1,
    best: [0, 0],
    missed: [0, 0],
    ...patch,
  };
}

describe('the tide', () => {
  it('starts as a single cell and only ever grows', () => {
    expect(tideRadius(0, DUEL, 5)).toBe(0);
    expect(wellCells(0, 5)).toEqual([{ r: 2, c: 2 }]);
    let last = -1;
    for (let t = 0; t < 60; t++) {
      const r = tideRadius(t, DUEL, 5);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });

  it('rises on schedule and caps at tideMax', () => {
    expect(tideRadius(6, DUEL, 5)).toBe(0);
    expect(tideRadius(7, DUEL, 5)).toBe(1);
    expect(tideRadius(13, DUEL, 5)).toBe(1);
    expect(tideRadius(14, DUEL, 5)).toBe(2);
    expect(tideRadius(999, DUEL, 5)).toBe(2); // never past tideMax
  });

  it('is a cross, symmetric under 180 degrees, and never wraps', () => {
    const m = centre(5);
    expect(m).toEqual({ r: 2, c: 2 });
    for (const radius of [0, 1, 2]) {
      for (const p of wellCells(radius, 5)) {
        // Rotating the board 180 degrees maps the Well onto itself, which is what
        // makes the geometry seat-neutral.
        expect(isWell(4 - p.r, 4 - p.c, radius, 5)).toBe(true);
      }
    }
    // Radius 1 is a plus, not a 3x3 block: corners are out.
    expect(isWell(1, 1, 1, 5)).toBe(false);
    expect(isWell(1, 2, 1, 5)).toBe(true);
  });

  it('at full radius puts a Well cell in EVERY line — the reason the board empties', () => {
    // If any line lacked one, stones could hide there forever and the game would
    // never end. Measured cost of getting this wrong: 19-35% draws.
    const full = MODES.duel.tideMax;
    for (let i = 0; i < 5; i++) {
      expect(wellCells(full, 5).some((p) => p.r === i)).toBe(true);
      expect(wellCells(full, 5).some((p) => p.c === i)).toBe(true);
    }
    for (let i = 0; i < 9; i++) {
      expect(wellCells(MODES.deepwell.tideMax, 9).some((p) => p.r === i)).toBe(true);
      expect(wellCells(MODES.deepwell.tideMax, 9).some((p) => p.c === i)).toBe(true);
    }
  });

  it('makes a stone worth more the later it lands', () => {
    expect(stoneValue(0)).toBe(1);
    expect(stoneValue(1)).toBe(2);
    expect(stoneValue(2)).toBe(3);
  });
});

describe('shifting', () => {
  it('slides a whole line and wraps at the edge', () => {
    const s = boardOf(['oo...', '.....', '.....', '.....', '.....']);
    const res = applyMove(s, 0, { axis: 'row', index: 0, dir: -1 });
    // (0,0) wraps to (0,4); (0,1) slides to (0,0).
    expect(res.state.cells[0 * 5 + 4]).toBe(1);
    expect(res.state.cells[0 * 5 + 0]).toBe(1);
    expect(res.state.cells[0 * 5 + 1]).toBe(0);
    expect(res.moved).toContainEqual({ from: { r: 0, c: 0 }, to: { r: 0, c: 4 } });
  });

  it('shifts a column the other way', () => {
    const s = boardOf(['o....', '.....', '.....', '.....', '.....']);
    const res = applyMove(s, 0, { axis: 'col', index: 0, dir: -1 });
    expect(res.state.cells[4 * 5 + 0]).toBe(1); // wrapped to the bottom
  });

  it('never loses or duplicates a stone', () => {
    const s = boardOf(['oo.oo', 'o...o', '.....', 'o...o', 'oo.oo']);
    const before = stonesLeft(s);
    const res = applyMove(s, 0, { axis: 'row', index: 0, dir: 1 });
    expect(stonesLeft(res.state) + res.banked.length).toBe(before);
  });
});

describe('the lock', () => {
  it('locks the line just shifted, and only that line', () => {
    const s = boardOf(['oo...', '.....', '.....', '.....', '.....']);
    const after = applyMove(s, 0, { axis: 'row', index: 0, dir: 1 }).state;
    expect(after.locked).toEqual({ axis: 'row', index: 0 });
    expect(moveError(after, 1, { axis: 'row', index: 0, dir: 1 })).toMatch(/locked/i);
    expect(moveError(after, 1, { axis: 'row', index: 0, dir: -1 })).toMatch(/locked/i); // both directions
    // A different line is fine — col 1, which the shift just moved a stone onto.
    // (Col 0 is now empty, so it would be refused for the other reason entirely.)
    expect(moveError(after, 1, { axis: 'col', index: 1, dir: 1 })).toBeNull();
  });

  it('releases after one turn', () => {
    let s = boardOf(['oo...', 'oo...', '.....', '.....', '.....']);
    s = applyMove(s, 0, { axis: 'row', index: 0, dir: 1 }).state;
    s = applyMove(s, 1, { axis: 'row', index: 1, dir: 1 }).state;
    expect(moveError(s, 0, { axis: 'row', index: 0, dir: 1 })).toBeNull();
  });

  it('never leaves a player with no legal move', () => {
    // Every stone sits on two lines and only one line is ever locked, so there is
    // always something to shift. Checked against real play rather than argued.
    const rand = (() => {
      let a = 12345;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    for (let seed = 0; seed < 40; seed++) {
      let s = generateBoard(seed, DUEL);
      let guard = 0;
      while (!s.finished && guard++ < 200) {
        expect(legalMoves(s).length).toBeGreaterThan(0);
        s = applyMove(s, s.turn, chooseAiMove(s, s.turn, 'normal', rand)).state;
      }
    }
  });
});

describe('legality', () => {
  it('refuses an empty line — you can only shift a line a stone stands on', () => {
    const s = boardOf(['oo...', '.....', '.....', '.....', '.....']);
    expect(moveError(s, 0, { axis: 'row', index: 3, dir: 1 })).toMatch(/nothing stands/i);
    expect(legalMoves(s).every((m) => bankCountSafe(s, m) >= 0)).toBe(true);
  });

  it('refuses the wrong seat, a finished game, and a bad line', () => {
    const s = boardOf(['oo...', '.....', '.....', '.....', '.....']);
    expect(moveError(s, 1, { axis: 'row', index: 0, dir: 1 })).toMatch(/turn/i);
    expect(moveError(s, 0, { axis: 'row', index: 9, dir: 1 })).toMatch(/no such line/i);
    expect(moveError({ ...s, finished: true }, 0, { axis: 'row', index: 0, dir: 1 })).toMatch(/over/i);
  });

  it('applyMove rejects rather than corrupts', () => {
    const s = boardOf(['oo...', '.....', '.....', '.....', '.....']);
    const res = applyMove(s, 1, { axis: 'row', index: 0, dir: 1 });
    expect(res.illegal).toBe(true);
    expect(res.state).toBe(s); // the very same object — nothing mutated
  });
});

const bankCountSafe = (s: GameState, m: Move): number => bankCount(s, m);

describe('banking', () => {
  it('scores for whoever made the shift — stones are unowned', () => {
    // A stone one step left of the Well, and it is seat 1 to move.
    const s = boardOf(['.....', '.....', '.o...', '.....', '.....'], DUEL, { turn: 1 });
    const res = applyMove(s, 1, { axis: 'row', index: 2, dir: 1 });
    expect(res.banked).toEqual([{ r: 2, c: 2 }]);
    expect(res.state.scores).toEqual([0, 1]); // seat 1 shifted, so seat 1 scores
  });

  it('banks EVERY stone in the Well, not just the one that moved', () => {
    // The rule the sim forced. Radius 1 (turnNo 7) makes (2,1) and (1,2) Well
    // cells; a stone sitting on (1,2) banks even though this shift is row 2.
    const s = boardOf(['.....', '..o..', 'o....', '.....', '.....'], DUEL, { turnNo: 7 });
    expect(tideRadius(7, DUEL, 5)).toBe(1);
    const res = applyMove(s, 0, { axis: 'row', index: 2, dir: 1 });
    // (2,0) -> (2,1) which is Well at radius 1, plus the untouched (1,2).
    expect(res.banked).toHaveLength(2);
    expect(res.state.scores[0]).toBe(2 * stoneValue(1)); // 2 stones, worth 2 each
    expect(stonesLeft(res.state)).toBe(0);
  });

  it('leaves the Well empty after every single move of a real game', () => {
    // The invariant the "bank only what moved" bug broke: a stone could sit
    // inside the Well, unbanked, which is incoherent the moment you look at it.
    const rand = (() => {
      let a = 999;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    for (let seed = 0; seed < 25; seed++) {
      let s = generateBoard(seed, DUEL);
      let guard = 0;
      while (!s.finished && guard++ < 200) {
        s = applyMove(s, s.turn, chooseAiMove(s, s.turn, 'normal', rand)).state;
        const radius = tideRadius(s.turnNo - 1, s.opts, s.size);
        for (const p of wellCells(radius, s.size)) {
          expect(s.cells[p.r * s.size + p.c]).toBe(0);
        }
      }
    }
  });

  it('counts a walked-past stone as missed, and only when one was on offer', () => {
    const s = boardOf(['.....', '.....', '.o..o', '.....', '.....']);
    // Shifting row 2 left banks (2,1)->(2,2)... so going right instead is a miss.
    expect(bestBankAvailable(s)).toBe(1);
    const missed = applyMove(s, 0, { axis: 'col', index: 4, dir: 1 }).state;
    expect(missed.missed).toEqual([1, 0]);
    // With nothing on offer, a scoreless move is not a miss.
    const quiet = boardOf(['o....', '.....', '.....', '.....', '.....']);
    expect(bestBankAvailable(quiet)).toBe(0);
    expect(applyMove(quiet, 0, { axis: 'row', index: 0, dir: 1 }).state.missed).toEqual([0, 0]);
  });
});

describe('ending', () => {
  it('ends when the board empties and awards the higher score', () => {
    const s = boardOf(['.....', '.....', '.o...', '.....', '.....'], DUEL, { scores: [3, 0] });
    const res = applyMove(s, 0, { axis: 'row', index: 2, dir: 1 });
    expect(res.state.finished).toBe(true);
    expect(res.state.winner).toBe(0);
    expect(stonesLeft(res.state)).toBe(0);
  });

  it('draws on an equal score', () => {
    const s = boardOf(['.....', '.....', '.o...', '.....', '.....'], DUEL, { scores: [1, 0] });
    const res = applyMove(s, 0, { axis: 'row', index: 2, dir: 1 });
    expect(res.state.scores).toEqual([2, 0]);
    // Contrive the tie: seat 1 on 2 as well.
    const tied = applyMove({ ...s, scores: [1, 2] }, 0, { axis: 'row', index: 2, dir: 1 });
    expect(tied.state.scores).toEqual([2, 2]);
    expect(tied.state.winner).toBe(-1);
  });

  it('stops at the filibuster backstop', () => {
    const s = boardOf(['o....', '.....', '.....', '.....', '.....'], { ...DUEL, maxMoves: 1 });
    const res = applyMove(s, 0, { axis: 'row', index: 0, dir: 1 });
    expect(res.state.finished).toBe(true);
  });
});

describe('turn-0 fairness', () => {
  it('never deals a board the first player can bank from', () => {
    // No territory to equalise here — stones are unowned — so the only thing the
    // opening can hand out unfairly is a free first move. Over many seeds.
    for (let seed = 0; seed < 300; seed++) {
      const s = generateBoard(seed, DUEL);
      expect(bestBankAvailable(s)).toBe(0);
      for (const mv of legalMoves(s)) expect(bankCount(s, mv)).toBe(0);
    }
  });

  it('deals exactly the right number of stones, never on the Well', () => {
    for (const mode of Object.values(MODES)) {
      for (let seed = 0; seed < 40; seed++) {
        const s = generateBoard(seed, mode);
        expect(stonesLeft(s)).toBe(mode.stones);
        expect(s.cells[centre(mode.size).r * mode.size + centre(mode.size).c]).toBe(0);
      }
    }
  });

  it('is deterministic — the same seed deals the same board on every peer', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect([...generateBoard(seed, DUEL).cells]).toEqual([...generateBoard(seed, DUEL).cells]);
    }
    expect([...generateBoard(1, DUEL).cells]).not.toEqual([...generateBoard(2, DUEL).cells]);
  });
});

describe('fast paths agree with the slow ones they replaced', () => {
  it('bestBankAvailable matches max(bankCount) over legalMoves', () => {
    // bestBankAvailable was rewritten to walk each line once instead of rescanning
    // the board per move (375s -> 133s of sim). If it ever disagrees with the
    // naive version, every balance number in this project is measuring a bot that
    // is not the bot we ship.
    const naive = (s: GameState): number =>
      legalMoves(s).reduce((best, mv) => Math.max(best, bankCount(s, mv)), 0);
    const rand = (() => {
      let a = 4242;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    for (const mode of [MODES.duel, MODES.blitz, MODES.deepwell]) {
      for (let seed = 0; seed < 12; seed++) {
        let s = generateBoard(seed, mode);
        let guard = 0;
        while (!s.finished && guard++ < 120) {
          expect(bestBankAvailable(s)).toBe(naive(s));
          s = applyMove(s, s.turn, chooseAiMove(s, s.turn, 'normal', rand)).state;
        }
      }
    }
  });

  it('bankCount matches what applyMove actually banks', () => {
    // The UI preview and both bots read bankCount. If it disagrees with applyMove
    // the preview lies to the player and the bots play a different game.
    const rand = (() => {
      let a = 77;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    for (let seed = 0; seed < 30; seed++) {
      let s = generateBoard(seed, DUEL);
      let guard = 0;
      while (!s.finished && guard++ < 120) {
        for (const mv of legalMoves(s)) {
          expect(bankCount(s, mv)).toBe(applyMove(s, s.turn, mv).banked.length);
        }
        s = applyMove(s, s.turn, chooseAiMove(s, s.turn, 'normal', rand)).state;
      }
    }
  });
});

describe('bots', () => {
  it('always returns a legal move', () => {
    const rand = (() => {
      let a = 31337;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    for (const diff of ['easy', 'normal', 'hard'] as const) {
      for (let seed = 0; seed < 8; seed++) {
        let s = generateBoard(seed, DUEL);
        let guard = 0;
        while (!s.finished && guard++ < 200) {
          const mv = chooseAiMove(s, s.turn, diff, rand);
          expect(moveError(s, s.turn, mv)).toBeNull();
          s = applyMove(s, s.turn, mv).state;
        }
      }
    }
  });

  it('takes a free stone when one is sitting there', () => {
    const s = boardOf(['.....', '.....', '.o...', '.....', '....o']);
    const rand = (): number => 0.5;
    for (const diff of ['normal', 'hard'] as const) {
      expect(bankCount(s, chooseAiMove(s, 0, diff, rand))).toBe(1);
    }
  });
});
