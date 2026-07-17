/**
 * balance.test.ts — is this still a game on move 8?
 *
 * Every other suite here proves the rules WORK. Not one of them can tell you the
 * winner was already decided. Hexbloom shipped 34 green tests, a clean two-tab
 * smoke test and a live production check while whoever led after 3 moves won 64%
 * of the time. A snowball is invisible to unit tests and to the 90 seconds you
 * spend playing it yourself.
 *
 * So: play a few hundred fixed-seed bot-vs-bot games and assert on the SHAPE of
 * the outcome. This suite refereed every balance decision in Driftlock and
 * overruled me at every step — see the tide comment in game.ts for the list of
 * confident stories it killed. Trust it over any argument, including mine.
 *
 * TWO METHOD NOTES, both learned the hard way here:
 *
 *  1. ALWAYS CHECK n. "82% decided by move 4" was computed from 17 games. Early
 *     leads are rare, so the early columns have tiny samples and read exactly like
 *     the big ones. leaderHoldsAt returns its sample size and the tests assert on
 *     it. A percentage without an n is a rumour.
 *
 *  2. MEASURE THE COUNTERFACTUAL. Two constants below are pinned as "must be odd"
 *     / "must be even". Both are inherited-sounding rules, and one of them (odd)
 *     I nearly dismissed as cargo cult because all the odd values behaved
 *     differently. Running the even case is what proved it: 95% first-player wins.
 *     So each rule ships next to a test that measures the bad configuration and
 *     fails if it ever stops being bad — otherwise the rule is folklore.
 *
 * Deterministic and seeded: no Math.random, identical numbers on every machine.
 */

import { describe, expect, it } from 'vitest';
import {
  applyMove,
  chooseAiMove,
  generateBoard,
  type Difficulty,
  type GameOpts,
  type GameState,
} from '../src/game';
import { MODES } from '../src/modes';

/** Seeded rng so the bots' tiebreaks and the sim itself never vary run to run. */
function makeRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Outcome {
  leadAt: Record<number, number>;
  /** Sole winner, or -1 on a draw. */
  winner: number;
  moves: number;
  /** Winner's lead as a share of all points banked. */
  margin: number;
  hauls: number[];
}

function playOut(seed: number, diffs: Difficulty[], opts: GameOpts, sample: number[]): Outcome {
  const rand = makeRand(seed * 7919 + 13);
  let s: GameState = generateBoard(seed, opts);
  const leadAt: Record<number, number> = {};
  const hauls: number[] = [];
  let guard = 0;
  while (!s.finished && guard++ < opts.maxMoves + 5) {
    const p = s.turn;
    const res = applyMove(s, p, chooseAiMove(s, p, diffs[p], rand));
    if (res.illegal) break; // no legal progress — shouldn't happen
    hauls.push(res.banked.length);
    s = res.state;
    if (sample.includes(s.turnNo)) {
      const [a, b] = s.scores;
      leadAt[s.turnNo] = a === b ? -1 : a > b ? 0 : 1;
    }
  }
  const banked = s.scores[0] + s.scores[1] || 1;
  return {
    leadAt,
    winner: s.winner,
    moves: s.turnNo,
    margin: Math.abs(s.scores[0] - s.scores[1]) / banked,
    hauls,
  };
}

const SAMPLE = [3, 8, 12, 16];

function run(diffs: Difficulty[], games: number, opts: GameOpts = MODES.duel): Outcome[] {
  const out: Outcome[] = [];
  for (let i = 0; i < games; i++) out.push(playOut(i * 1013 + 7, diffs, opts, SAMPLE));
  return out;
}

/**
 * How often the sole leader at move `n` went on to win, AND how many games that
 * was measured over. Ties excluded — and note that excluding them is exactly what
 * makes the early samples small, which is why the count comes back with it.
 */
function leaderHoldsAt(rs: Outcome[], n: number): { rate: number; n: number } {
  const decided = rs.filter((r) => r.leadAt[n] !== undefined && r.leadAt[n] !== -1 && r.winner >= 0);
  if (!decided.length) return { rate: NaN, n: 0 };
  return {
    rate: decided.filter((r) => r.leadAt[n] === r.winner).length / decided.length,
    n: decided.length,
  };
}

function seatWinRates(rs: Outcome[]): number[] {
  const wins = [0, 0];
  for (const r of rs) if (r.winner >= 0) wins[r.winner]++;
  return wins.map((w) => w / rs.length);
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (x: number): string => (Number.isNaN(x) ? ' n/a' : `${(x * 100).toFixed(1)}%`);

describe('balance — baseline', () => {
  // Not an assertion — the printout. Every number in this file was READ off this
  // before it was asserted. Keep it: the next person to touch the tide needs the
  // baseline far more than they need my conclusions.
  it('prints the measured shape of a Duel', () => {
    const rs = run(['normal', 'normal'], 220);
    const hauls = rs.flatMap((r) => r.hauls).filter((h) => h > 0);
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '  ── Driftlock · Duel · 220 normal-vs-normal games ─────────',
        `  leader holds: ${SAMPLE.map((n) => {
          const h = leaderHoldsAt(rs, n);
          return `m${n} ${pct(h.rate)} (n=${h.n})`;
        }).join('  ')}`,
        `  seats: ${seatWinRates(rs).map(pct).join(' / ')}   draws: ${pct(rs.filter((r) => r.winner < 0).length / rs.length)}`,
        `  moves: min ${Math.min(...rs.map((r) => r.moves))} med ${median(rs.map((r) => r.moves))} max ${Math.max(...rs.map((r) => r.moves))}`,
        `  blowouts (margin>0.5): ${pct(rs.filter((r) => r.margin > 0.5).length / rs.length)}`,
        `  banks that took 2+: ${pct(hauls.filter((h) => h >= 2).length / hauls.length)}   max haul: ${Math.max(...hauls)}`,
        '  ──────────────────────────────────────────────────────────',
      ].join('\n'),
    );
    expect(rs.length).toBe(220);
  });
});

describe('balance — the game must not be over before it starts', () => {
  const results = run(['normal', 'normal'], 400);

  it('keeps the midgame a genuine coin flip', () => {
    // The headline number, and the one with a real sample behind it (n≈390 of
    // 400 games have a sole leader by move 8). Measured 51%. If this climbs, an
    // early bank has become a won game and the tide has stopped doing its job.
    const h = leaderHoldsAt(results, 8);
    expect(h.n).toBeGreaterThan(300); // the assertion above is worth nothing without this
    expect(h.rate).toBeLessThan(0.65);
  });

  it('leaves the opening undecided, for the few games that have a leader there', () => {
    // Measured 66% at n≈115. Deliberately a loose bound: only ~29% of games have
    // anyone ahead at move 3 (radius 0 — one stone, worth one point of ~18), so
    // this column is noisy and must not be read as precisely as m8 above.
    const h = leaderHoldsAt(results, 3);
    expect(h.n).toBeGreaterThan(60);
    expect(h.rate).toBeLessThan(0.76);
  });

  it('still resolves decisively by the end', () => {
    // The opposite failure, and just as bad: a "fix" that flattens the game into
    // a coin flip means nothing a player does matters. Late leads MUST hold.
    // Measured m12 74%, m16 78%.
    expect(leaderHoldsAt(results, 12).rate).toBeGreaterThan(0.65);
    expect(leaderHoldsAt(results, 16).rate).toBeGreaterThan(0.68);
  });

  it('rarely ends in a blowout', () => {
    // Measured 0%. Tide-weighted stones mean a late reply is worth 3 early ones.
    expect(results.filter((r) => r.margin > 0.5).length / results.length).toBeLessThan(0.12);
  });

  it('terminates, and nowhere near the filibuster backstop', () => {
    // maxMoves is a guard against two players refusing to move, not a game
    // length. Measured median 20 against a cap of 120. If real games start
    // reaching the cap, stalling has become viable and the design has a hole.
    expect(median(results.map((r) => r.moves))).toBeLessThan(MODES.duel.maxMoves / 3);
    for (const r of results) expect(r.moves).toBeLessThanOrEqual(MODES.duel.maxMoves);
  });

  it('almost never draws', () => {
    // Honest number, not a guarantee. Points can tie, and a stalled game can hit
    // the cap. Measured 0.7%. The plan originally promised "no draws ever" off a
    // first-to-a-majority rule that the sim then made me delete.
    expect(results.filter((r) => r.winner < 0).length / results.length).toBeLessThan(0.05);
  });
});

describe('balance — seat fairness', () => {
  // Sample sizes are deliberate. Hexbloom's seat bug measured 51/49 at 220 games
  // — perfectly fair-looking — and only separated from the noise around 600. A
  // seat test too small to see the bug it guards is worse than no test: it
  // reports a fairness nobody ever verified.
  it('gives neither seat a meaningful edge', () => {
    // Measured 47.8 / 51.5 over 600.
    const rates = seatWinRates(run(['normal', 'normal'], 600));
    for (const r of rates) expect(r).toBeGreaterThan(0.42);
    for (const r of rates) expect(r).toBeLessThan(0.58);
  });

  it('gives neither seat an edge against a stronger bot either', () => {
    const rates = seatWinRates(run(['hard', 'hard'], 100));
    for (const r of rates) expect(r).toBeGreaterThan(0.36);
    for (const r of rates) expect(r).toBeLessThan(0.64);
  });

  it('PINS tideEvery ODD — and MEASURES that even is catastrophic', () => {
    for (const m of Object.values(MODES)) expect(m.tideEvery % 2).toBe(1);

    // The counterfactual, which is the only thing that makes the line above more
    // than folklore. A rise lands on whoever is on move; an even period puts
    // EVERY rise on seat 0's turn, so seat 0 harvests the whole game.
    // Measured: 93.8% first-player wins at tideEvery 6, against 47.8% at 7.
    // If this ever stops being lopsided, the rule has stopped being load-bearing
    // and should be re-derived from the sim rather than kept out of habit.
    const even: GameOpts = { ...MODES.duel, tideEvery: 6 };
    const rates = seatWinRates(run(['normal', 'normal'], 300, even));
    expect(Math.max(...rates)).toBeGreaterThan(0.8);
  });

  it('PINS the rise count EVEN — and MEASURES that an odd count is unfair', () => {
    // Each seat must be on move for exactly half the rises. floor(size/2) rises:
    // 5x5 → 2 (fair), 9x9 → 4 (fair), 7x7 → 3 (NOT fair). This is why there is
    // no 7x7 mode — it is the wrong shape, not a badly tuned one.
    for (const m of Object.values(MODES)) {
      expect(m.tideMax % 2).toBe(0);
      // And the cross must reach the edge, or lines never go live, stones hide in
      // them forever and the game never ends (measured: 19-35% draws at a short
      // tideMax). These two requirements together are the whole constraint.
      expect(m.tideMax).toBe(Math.floor(m.size / 2));
    }

    // The counterfactual: a 7x7 (3 rises) measured seat 0 at 33%.
    const odd: GameOpts = { size: 7, stones: 13, tideEvery: 7, tideMax: 3, maxMoves: 220 };
    const rates = seatWinRates(run(['normal', 'normal'], 200, odd));
    expect(Math.min(...rates)).toBeLessThan(0.42);
  });
});

describe('balance — the fix must not cost the game its joy', () => {
  it('keeps a skill gradient — hard beats normal handily', () => {
    // A perfectly balanced game where choices don't matter is a slot machine.
    // Seat-balanced, so this measures skill and not turn order.
    let hardWins = 0;
    let games = 0;
    for (let i = 0; i < 24; i++) {
      for (const hardSeat of [0, 1]) {
        const rand = makeRand(i * 31 + 5);
        let s = generateBoard(i * 1013 + 7, MODES.duel);
        let guard = 0;
        while (!s.finished && guard++ < MODES.duel.maxMoves + 5) {
          const p = s.turn;
          const res = applyMove(s, p, chooseAiMove(s, p, p === hardSeat ? 'hard' : 'normal', rand));
          if (res.illegal) break;
          s = res.state;
        }
        games++;
        if (s.winner === hardSeat) hardWins++;
      }
    }
    expect(hardWins / games).toBeGreaterThan(0.55);
  });

  it('keeps the lead changing hands — the game is a rally, not a procession', () => {
    // This replaces the metric I originally wanted here ("big tide hauls"), which
    // the sim proved does not exist at any setting: the Well is empty after every
    // move, so 2+ stone banks measure ~1% and no parameter changes that. Guarding
    // a verb the game doesn't have would have been theatre. What Driftlock
    // actually has is lead changes, so that is what gets guarded.
    let flips = 0;
    let counted = 0;
    for (const r of run(['normal', 'normal'], 200)) {
      const early = r.leadAt[8];
      if (early === undefined || early === -1 || r.winner < 0) continue;
      counted++;
      if (early !== r.winner) flips++;
    }
    expect(counted).toBeGreaterThan(120);
    expect(flips / counted).toBeGreaterThan(0.3); // measured ~0.49
  });
});

describe('balance — the other modes are also games', () => {
  // Principle 14: measure before shipping a bigger mode. Deepwell is 9x9 — 36
  // legal moves a ply against Duel's 20 — so it gets a smaller sample rather than
  // a shrug. A mode nobody simulated is a mode nobody balanced.
  it('Blitz is fair and short', () => {
    const rs = run(['normal', 'normal'], 400, MODES.blitz);
    const rates = seatWinRates(rs);
    for (const r of rates) expect(r).toBeGreaterThan(0.4); // measured 45.7 / 54.3
    expect(median(rs.map((r) => r.moves))).toBeLessThan(median(run(['normal', 'normal'], 100).map((r) => r.moves)));
    for (const r of rs) expect(r.moves).toBeLessThanOrEqual(MODES.blitz.maxMoves);
  });

  it('Deepwell is fair, long, and actually terminates', () => {
    // 4 rises — the even-rise rule's independent confirmation. Measured seat 50.8%
    // and a median of 56 moves, on a board where 7x7 measured 33%.
    const rs = run(['normal', 'normal'], 120, MODES.deepwell);
    const rates = seatWinRates(rs);
    for (const r of rates) expect(r).toBeGreaterThan(0.4);
    expect(median(rs.map((r) => r.moves))).toBeGreaterThan(35);
    for (const r of rs) expect(r.moves).toBeLessThanOrEqual(MODES.deepwell.maxMoves);
    expect(rs.filter((r) => r.winner < 0).length / rs.length).toBeLessThan(0.06);
  });
});
