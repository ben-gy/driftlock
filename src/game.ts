/**
 * game.ts — Driftlock's rules. Pure, deterministic, no DOM, no network.
 *
 * The whole game in four sentences:
 *   1. Shift a row or a column one step; everything on it slides and wraps.
 *   2. Any stone that lands in the Well scores for WHOEVER MADE THE SHIFT.
 *   3. You may not shift the line your opponent just shifted — it is locked.
 *   4. First to a majority of the stones wins.
 *
 * Rule 2 is the load-bearing one, and it is worth saying why it is not the
 * obvious design. The obvious design gives every player their own stones and
 * scores a stone for its owner. That game is broken twice over: banking is then
 * something you do TO yourself, so every player ends on exactly their own stone
 * count and the score is a foregone 4-4; and each player needs a starting
 * position, which is start geometry, which is where Hexbloom's three seats ended
 * up winning 54/33/10. Neutral stones delete both problems at once. There is
 * nothing to own, so there is nothing to seed unfairly, and the score comes from
 * play alone.
 *
 * It also removes the incentive to stall, which a "first to N" game normally has
 * in abundance. Delivering a stone only ever helps the deliverer, so both players
 * always want to push. A leader who shuffles does not run out a clock — the game
 * has no clock, it ends only when someone reaches the target — they just hand the
 * trailer free turns. Stalling is self-defeating rather than forbidden, which is
 * a much better way to build a rule.
 */

import { makeRng, shuffle, type Rng } from '@ben-gy/game-engine/rng';

export type Axis = 'row' | 'col';

export interface LineRef {
  axis: Axis;
  index: number;
}

export interface Move extends LineRef {
  /** +1 shifts right / down, -1 shifts left / up. */
  dir: 1 | -1;
}

export interface Pos {
  r: number;
  c: number;
}

export interface GameOpts {
  size: number;
  stones: number;
  tideEvery: number;
  maxMoves: number;
  /**
   * How far the tide can ever reach. This is a FAIRNESS constant, not a flavour
   * knob — see tideRadius. The number of rises (tideMax) must be EVEN so the two
   * seats get one harvest each.
   */
  tideMax: number;
}

/**
 * What a stone banked at this tide is worth. THE balance mechanism — read the
 * comment on tideRadius before touching it.
 */
export function stoneValue(radius: number): number {
  return radius + 1;
}

export interface GameState {
  readonly size: number;
  readonly opts: GameOpts;
  /** Row-major, 1 = stone, 0 = empty. Stones are identical and unowned. */
  readonly cells: Uint8Array;
  /** Stones banked, by seat. */
  readonly scores: number[];
  /** Seat to move. */
  readonly turn: number;
  /** Moves completed. Drives the tide, so it is the game's real clock. */
  readonly turnNo: number;
  /** The line the last move shifted. Nobody may shift it next turn. */
  readonly locked: LineRef | null;
  readonly finished: boolean;
  /** Winning seat, or -1 for a draw (only reachable via maxMoves). */
  readonly winner: number;
  /** Biggest single haul, by seat — the tide-shift spectacle, for the summary. */
  readonly best: number[];
  /** Turns where a bank was on offer and the mover didn't take it, by seat. */
  readonly missed: number[];
}

export interface MoveResult {
  state: GameState;
  /** Where every stone on the shifted line went. Drives the slide animation. */
  moved: { from: Pos; to: Pos }[];
  /** Cells that banked. Scorer is the seat that made the move. */
  banked: Pos[];
  /** True when the move was rejected; `state` is then the unchanged input. */
  illegal?: boolean;
}

// ── the tide ────────────────────────────────────────────────────────────────

/**
 * How far the Well's cross reaches, as a pure function of the move number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE CHANGING ANY TIDE CONSTANT. Every claim below is a MEASURED
 * number from tests/balance.test.ts and the sweeps behind it, not a story about
 * the mechanics. Almost every story I told myself about this game was wrong, and
 * the sim killed each one in turn:
 *
 *  · "The pinpoint opening makes early leads impossible." WRONG. The first cut
 *    measured whoever led at move 3 winning 76%, seats 60/40, and the game over
 *    by move 19 — a tempo race where tempo never changed hands.
 *
 *  · "The tide's multi-stone haul is the product." WRONG, and unfixable by
 *    tuning: 0% multi-hauls across 36 parameter combinations. The Well is empty
 *    after every move, so at most one stone can enter per shift. Piles never
 *    form. That fantasy is dead and the game is better without the pretence —
 *    what the tide actually does is make more lines live and raise stone value.
 *
 *  · "An early lead is unlosable, so weight late stones." Half right. Weighting
 *    (stoneValue) helped, but the honest curve only appeared once the sample size
 *    was fixed: the alarming "82% decided by move 4" was computed from n=17.
 *    Real shape now: m3 66% (n≈115), m8 51% (n≈390), m12 74%, m16 78%. Near
 *    chance through the midgame, spiking late. That IS the drama.
 *
 * The two constants fairness genuinely rests on, both measured, both surprising:
 *
 *  1. tideEvery MUST BE ODD. A rise lands on whoever is on move, so an even
 *     period puts EVERY rise on seat 0's turn. Measured: even periods → seat 0
 *     wins 89-98%. Odd → 32-55%. This is not a small effect and no amount of
 *     playtesting would find it.
 *
 *  2. THE NUMBER OF RISES MUST BE EVEN, so each seat is on move for half of
 *     them. floor(size/2) rises: 5x5 → 2 (fair, measured 47.8%), 7x7 → 3 (seat 0
 *     measured 33%), 9x9 → 4 (fair, measured 50.8%). That is why 7x7 does not
 *     exist in modes.ts — it is not tunable, it is the wrong shape.
 *
 * And the trap in "fixing" #2 by capping the tide short of the edge: it works on
 * seats (7x7 went 33% → 45%) and it destroys the game, because a cross that
 * never spans the board leaves lines that never go live, so stones hide there
 * forever. Measured: median length 220 = the maxMoves cap, 19-35% draws. The tide
 * MUST reach the edge for the board to empty. Hence tideMax === floor(size/2),
 * and hence only sizes whose floor(size/2) is even are playable at all.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Zero extra state: a pure function of the move number, so there is no field to
 * sync and nothing two peers can disagree about. Hexbloom's fix had the same
 * property, and that is not a coincidence — it is why it was the fix that worked.
 */
export function tideRadius(turnNo: number, opts: GameOpts, size: number): number {
  return Math.min(Math.floor(turnNo / opts.tideEvery), opts.tideMax, Math.floor(size / 2));
}

export function centre(size: number): Pos {
  const m = Math.floor(size / 2);
  return { r: m, c: m };
}

/** Is (r,c) in the Well at this radius? The Well is a cross, never wrapped. */
export function isWell(r: number, c: number, radius: number, size: number): boolean {
  const m = Math.floor(size / 2);
  return (r === m && Math.abs(c - m) <= radius) || (c === m && Math.abs(r - m) <= radius);
}

export function wellCells(radius: number, size: number): Pos[] {
  const out: Pos[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (isWell(r, c, radius, size)) out.push({ r, c });
  }
  return out;
}

// ── board ───────────────────────────────────────────────────────────────────

const idx = (r: number, c: number, size: number): number => r * size + c;

/**
 * Deal a fresh board from a shared seed.
 *
 * Turn-0 fairness looks different here than in a territory game, because there is
 * no territory: nobody starts with anything, so the only thing the opening can
 * hand out unfairly is a free first move. So the rule is simply that **no stone
 * may be bankable on move 1**. At radius 0 that means excluding the Well and its
 * four orthogonal neighbours — the only cells a single shift can deliver from.
 * Pinned over many seeds by tests/game.test.ts.
 */
export function generateBoard(seed: number, opts: GameOpts): GameState {
  const { size } = opts;
  const rng: Rng = makeRng(seed);
  const m = Math.floor(size / 2);

  const candidates: Pos[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // The Well itself, and the four cells one shift away from it. A stone on
      // any of these would let whoever moves first score for free.
      const orthAdjacent = (r === m && Math.abs(c - m) === 1) || (c === m && Math.abs(r - m) === 1);
      if ((r === m && c === m) || orthAdjacent) continue;
      candidates.push({ r, c });
    }
  }

  const cells = new Uint8Array(size * size);
  for (const p of shuffle(rng, candidates).slice(0, opts.stones)) cells[idx(p.r, p.c, size)] = 1;

  return {
    size,
    opts,
    cells,
    scores: [0, 0],
    turn: 0,
    turnNo: 0,
    locked: null,
    finished: false,
    winner: -1,
    best: [0, 0],
    missed: [0, 0],
  };
}

// ── moves ───────────────────────────────────────────────────────────────────

export function sameLine(a: LineRef | null, b: LineRef | null): boolean {
  return !!a && !!b && a.axis === b.axis && a.index === b.index;
}

/** Every stone standing on a line. A line with none of them cannot be shifted. */
function lineStones(s: GameState, axis: Axis, index: number): Pos[] {
  const out: Pos[] = [];
  for (let i = 0; i < s.size; i++) {
    const r = axis === 'row' ? index : i;
    const c = axis === 'row' ? i : index;
    if (s.cells[idx(r, c, s.size)]) out.push({ r, c });
  }
  return out;
}

/**
 * Why a move is illegal, or null if it is fine. Exported so the UI can say the
 * actual reason instead of just refusing to respond.
 */
export function moveError(s: GameState, seat: number, mv: Move): string | null {
  if (s.finished) return 'The game is over.';
  if (seat !== s.turn) return "It isn't your turn.";
  if (mv.index < 0 || mv.index >= s.size) return 'No such line.';
  if (mv.dir !== 1 && mv.dir !== -1) return 'A shift is one step.';
  if (sameLine(s.locked, mv)) return 'That line is locked — it was just shifted.';
  // "You can only shift a line a stone stands on." Without this, a player could
  // burn turns on empty lines forever, which is not a game, it is a filibuster.
  if (!lineStones(s, mv.axis, mv.index).length) return 'Nothing stands on that line.';
  return null;
}

export function legalMoves(s: GameState): Move[] {
  const out: Move[] = [];
  for (const axis of ['row', 'col'] as Axis[]) {
    for (let index = 0; index < s.size; index++) {
      for (const dir of [1, -1] as (1 | -1)[]) {
        const mv = { axis, index, dir };
        if (!moveError(s, s.turn, mv)) out.push(mv);
      }
    }
  }
  return out;
}

/**
 * How many stones this move would bank. Drives the UI preview and both bots, so
 * it MUST agree with applyMove exactly — including the stones this shift does not
 * touch. A stone the tide has just flooded over banks for whoever moves next
 * whatever line they pick, and a preview that ignored those would quietly under-
 * count every harvest. tests/game.test.ts pins the two against each other.
 */
export function bankCount(s: GameState, mv: Move): number {
  const radius = tideRadius(s.turnNo, s.opts, s.size);
  const onLine = (r: number, c: number): boolean =>
    mv.axis === 'row' ? r === mv.index : c === mv.index;
  let n = 0;
  for (let r = 0; r < s.size; r++) {
    for (let c = 0; c < s.size; c++) {
      if (!s.cells[idx(r, c, s.size)]) continue;
      const to = onLine(r, c) ? shiftPos({ r, c }, mv, s.size) : { r, c };
      if (isWell(to.r, to.c, radius, s.size)) n++;
    }
  }
  return n;
}

function shiftPos(p: Pos, mv: Move, size: number): Pos {
  const wrap = (v: number): number => (v + mv.dir + size) % size;
  return mv.axis === 'row' ? { r: p.r, c: wrap(p.c) } : { r: wrap(p.r), c: p.c };
}

/**
 * The best bank available to the seat on move. 0 when there is nothing on offer.
 *
 * The obvious body is `max(bankCount)` over `legalMoves()`, and that is what this
 * was. It is also the single hottest line in the project: `evaluate` calls it at
 * every leaf, so the balance sim ran it hundreds of millions of times, each call
 * allocating ~20 Move objects and rescanning all n^2 cells per move — 375s for
 * one suite. This version walks each line's n cells ONCE and derives both
 * directions from that pass. Same answer (pinned against the naive version in
 * tests/game.test.ts), ~10x less work.
 */
export function bestBankAvailable(s: GameState): number {
  // legalMoves() is empty on a finished game and this fast path would happily
  // report a bank on a board nobody can move. Kept explicit rather than implied.
  if (s.finished) return 0;
  const size = s.size;
  const radius = tideRadius(s.turnNo, s.opts, size);

  // Stones already standing in the Well bank on ANY move, whatever line it
  // shifts — see applyMove. So they are a floor under every candidate, and the
  // per-line loop below only has to account for the ones it disturbs.
  let wellTotal = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (s.cells[idx(r, c, size)] && isWell(r, c, radius, size)) wellTotal++;
  }

  let best = 0;
  for (let a = 0; a < 2; a++) {
    const axis: Axis = a === 0 ? 'row' : 'col';
    for (let index = 0; index < size; index++) {
      if (s.locked && s.locked.axis === axis && s.locked.index === index) continue;
      let onLine = 0;
      let wellOnLine = 0;
      let landsPlus = 0;
      let landsMinus = 0;
      for (let i = 0; i < size; i++) {
        const r = a === 0 ? index : i;
        const c = a === 0 ? i : index;
        if (!s.cells[idx(r, c, size)]) continue;
        onLine++;
        if (isWell(r, c, radius, size)) wellOnLine++;
        const plus = (i + 1) % size;
        const minus = (i - 1 + size) % size;
        if (isWell(a === 0 ? r : plus, a === 0 ? plus : c, radius, size)) landsPlus++;
        if (isWell(a === 0 ? r : minus, a === 0 ? minus : c, radius, size)) landsMinus++;
      }
      if (!onLine) continue; // a line with no stone on it cannot be shifted
      const untouched = wellTotal - wellOnLine;
      best = Math.max(best, untouched + landsPlus, untouched + landsMinus);
    }
  }
  return best;
}

export function applyMove(s: GameState, seat: number, mv: Move): MoveResult {
  if (moveError(s, seat, mv)) return { state: s, moved: [], banked: [], illegal: true };

  const size = s.size;
  const radius = tideRadius(s.turnNo, s.opts, size);
  const cells = new Uint8Array(s.cells);
  const moved: { from: Pos; to: Pos }[] = [];
  const banked: Pos[] = [];

  const stones = lineStones(s, mv.axis, mv.index);
  // Lift the whole line first, then set it down. Doing it in place would let an
  // earlier stone overwrite a later one's origin cell.
  for (const p of stones) cells[idx(p.r, p.c, size)] = 0;
  for (const p of stones) {
    const to = shiftPos(p, mv, size);
    moved.push({ from: p, to });
    cells[idx(to.r, to.c, size)] = 1;
  }

  // EVERY stone standing in the Well banks — not merely the ones this shift
  // pushed in. That distinction is the whole tide.
  //
  // Banking only what moved was the first cut, and it was wrong twice over. It
  // let the rising tide flood OVER a stone and leave it sitting inside the Well,
  // unbanked, which is incoherent the moment you look at the board. And it made a
  // multi-stone haul structurally impossible — the Well is empty after every
  // move, so at most one stone can enter it per shift, and the sim duly measured
  // 0% multi-hauls across all 36 parameter combinations. No tuning could have
  // reached it; it was a rule, not a number.
  //
  // Banking everything in the Well makes the tide's arrival a HARVEST: park
  // stones in the cells about to flood and collect them all at once. The rise
  // schedule is a pure function of the move number and shown in the HUD, so both
  // players can see it coming and play for it — the seat on move when the tide
  // rises takes the harvest, and the other one has had every prior turn to clear
  // the zone. That is also what finally gives TIDE_EVERY's oddness teeth: an odd
  // period alternates which seat is on move for successive rises.
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[idx(r, c, size)] && isWell(r, c, radius, size)) {
        cells[idx(r, c, size)] = 0;
        banked.push({ r, c });
      }
    }
  }

  const scores = s.scores.slice();
  scores[seat] += banked.length * stoneValue(radius);
  const best = s.best.slice();
  best[seat] = Math.max(best[seat], banked.length);

  // "You walked past a free stone." Only counted when one was genuinely on
  // offer — this is the number the summary uses to show what each player missed.
  const missed = s.missed.slice();
  if (banked.length === 0 && bestBankAvailable(s) > 0) missed[seat]++;

  const turnNo = s.turnNo + 1;
  let left = 0;
  for (const v of cells) left += v;
  // The board empties, and then we count. There is no target to race to, which
  // is the point: a race is what made an early lead unlosable.
  const finished = left === 0 || turnNo >= s.opts.maxMoves;
  const winner = !finished || scores[0] === scores[1] ? -1 : scores[0] > scores[1] ? 0 : 1;

  return {
    state: {
      ...s,
      cells,
      scores,
      turn: 1 - seat,
      turnNo,
      locked: { axis: mv.axis, index: mv.index },
      finished,
      winner,
      best,
      missed,
    },
    moved,
    banked,
  };
}

export function stonesLeft(s: GameState): number {
  let n = 0;
  for (const v of s.cells) n += v;
  return n;
}

// ── bots ────────────────────────────────────────────────────────────────────

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * Leaf value, from `me`'s point of view. Banks are the only thing that scores,
 * so they dominate; the tiebreak is "and don't leave them a stone".
 */
function evaluate(s: GameState, me: number): number {
  const opp = 1 - me;
  let v = (s.scores[me] - s.scores[opp]) * 1000;
  // What the player to move can grab right now: good if that's me, bad if not.
  const onOffer = bestBankAvailable(s);
  v += (s.turn === me ? 1 : -1) * onOffer * 60;
  return v;
}

/**
 * Plain minimax over absolute values (always from `me`'s point of view), rather
 * than a sign-flipping negamax. Same result, and it stays readable when the
 * "player to move" and "player we're scoring for" come apart.
 *
 * Alpha-beta is not an optimisation for the game — a bot move is instant either
 * way — it is an optimisation for the SIM, which plays hundreds of thousands of
 * these. Unpruned, balance.test.ts took 375s and would have run on every deploy;
 * pruning keeps `hard` at a full 3 plies (and so keeps the skill gradient the
 * suite asserts) instead of buying the time back by making the bot dumber.
 */
function searchValue(s: GameState, me: number, depth: number, alpha: number, beta: number): number {
  if (s.finished || depth === 0) return evaluate(s, me);
  const moves = legalMoves(s);
  if (!moves.length) return evaluate(s, me);
  const maximizing = s.turn === me;
  let best = maximizing ? -Infinity : Infinity;
  for (const mv of moves) {
    const res = applyMove(s, s.turn, mv);
    if (res.illegal) continue;
    const v = searchValue(res.state, me, depth - 1, alpha, beta);
    if (maximizing) {
      best = Math.max(best, v);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, v);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return Number.isFinite(best) ? best : evaluate(s, me);
}

/**
 * Pick a move. Deterministic given `rand`, so the balance sim never varies.
 *
 * easy   — takes a stone if one is in front of it, otherwise wanders.
 * normal — greedy, but won't hand back more than it takes (1-ply lookahead).
 * hard   — 3-ply. Sees the lock: it will take a smaller bank to freeze the line
 *          that was about to give them a bigger one.
 */
export function chooseAiMove(
  s: GameState,
  seat: number,
  difficulty: Difficulty,
  rand: () => number,
): Move {
  const moves = legalMoves(s);
  if (!moves.length) return { axis: 'row', index: 0, dir: 1 };

  if (difficulty === 'easy') {
    const grabs = moves.filter((m) => bankCount(s, m) > 0);
    const pool = grabs.length && rand() < 0.7 ? grabs : moves;
    return pool[Math.floor(rand() * pool.length)];
  }

  const depth = difficulty === 'hard' ? 3 : 1;
  let best = -Infinity;
  let pool: Move[] = [];
  for (const mv of moves) {
    const res = applyMove(s, seat, mv);
    if (res.illegal) continue;
    // A FULL window per root move, deliberately. Alpha-beta with an open window
    // returns the exact minimax value, so the tie `pool` below stays exact and
    // the bot's choice is bit-identical to the unpruned search the balance
    // numbers were measured with. Carrying alpha across root moves would be
    // faster and would silently corrupt the pool into "first best move wins".
    const v = searchValue(res.state, seat, depth, -Infinity, Infinity);
    if (v > best) {
      best = v;
      pool = [mv];
    } else if (v === best) pool.push(mv);
  }
  if (!pool.length) return moves[Math.floor(rand() * moves.length)];
  return pool[Math.floor(rand() * pool.length)];
}

/** Kept for the sim's readability. */
export function winnerOf(s: GameState): number {
  return s.winner;
}
