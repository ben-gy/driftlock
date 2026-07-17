/**
 * modes.ts — the shapes a round can take.
 *
 * Every constant here was MEASURED, not chosen. tests/balance.test.ts is the
 * referee; the sweeps behind these numbers are summarised in game.ts's tide
 * comment. Three of them are load-bearing for fairness rather than for flavour,
 * and the balance suite fails if you move them:
 *
 *   size      must be 5 or 9 — NOT 7. See tideMax.
 *   tideEvery must be ODD. An even period measured a 95% first-player win rate.
 *   tideMax   must be EVEN, and must equal floor(size/2).
 *
 * The spread is density and length, which is what actually changes how this game
 * plays: 5 stones on a 5x5 is a sparse duel where every stone is precious and the
 * lock decides everything; 9 stones is a scrum; a 9x9 is a different sport, where
 * a stone you push now arrives four moves later.
 *
 * The host picks; the choice travels frozen inside the round start (see
 * engine/rematch.ts). A mode here changes the BOARD SIZE, so two peers reading
 * their own local setting would not merely disagree about the rules — they would
 * be playing different-sized boards on the same seed.
 */

export type ModeId = 'blitz' | 'duel' | 'deepwell';

export interface Mode {
  id: ModeId;
  name: string;
  /** Board edge. Odd (a torus with no centre cell has no Well) AND floor(size/2)
   *  must be even, so 5 or 9. See tideMax. */
  size: number;
  /** Stones on the board. Density is the main strategic dial. */
  stones: number;
  /** The tide rises one step every this many MOVES. MUST be odd. */
  tideEvery: number;
  /**
   * How many times the tide can rise. MUST be even (so each seat is on move for
   * exactly half the rises) AND must equal floor(size/2) (so the Well's cross
   * eventually spans the board and the game can actually end). Those two
   * requirements together are why 7x7 does not exist here: it wants 3.
   */
  tideMax: number;
  /**
   * Filibuster backstop, not a game length. Two players who both refuse to leave
   * a stone scoreable can shuffle forever; it is never a winning plan (the score
   * is only counted once the board empties, so a leader who stalls just hands the
   * trailer free turns) but it must still terminate. Real games finish in a
   * quarter of this — balance.test.ts asserts it.
   */
  maxMoves: number;
  /** One line, shown under the name — say what it FEELS like, not the numbers. */
  blurb: string;
}

export const MODES: Record<ModeId, Mode> = {
  blitz: {
    id: 'blitz',
    name: 'Blitz',
    size: 5,
    stones: 5,
    tideEvery: 7,
    tideMax: 2,
    maxMoves: 120,
    blurb: 'Five stones, nowhere to hide. Every one of them matters.',
  },
  duel: {
    id: 'duel',
    name: 'Duel',
    size: 5,
    stones: 9,
    tideEvery: 7,
    tideMax: 2,
    maxMoves: 120,
    blurb: 'The real game. A crowded board and a lock that decides everything.',
  },
  deepwell: {
    id: 'deepwell',
    name: 'Deepwell',
    size: 9,
    stones: 17,
    tideEvery: 9,
    tideMax: 4,
    maxMoves: 260,
    blurb: '9×9, four tides. Push a stone now, collect it four moves from now.',
  },
};

export const DEFAULT_MODE: ModeId = 'duel';

export const MODE_LIST: Mode[] = [MODES.blitz, MODES.duel, MODES.deepwell];

/**
 * Resolve a mode id that arrived over the wire or out of storage.
 *
 * Never trust it: an older peer, a corrupted store or a hand-edited message would
 * otherwise hand `undefined` to generateBoard, which reads `.size` off it and
 * builds a board of edge NaN.
 *
 * hasOwn, NOT a plain `MODES[id] || DEFAULT`: MODES is an object literal, so it
 * inherits from Object.prototype and `MODES['constructor']` is the Object
 * function — truthy, so it sails straight through a `||` guard and gets returned
 * AS a Mode with every field undefined. That is the exact NaN board this function
 * exists to prevent, reached by the one input it exists to distrust. Same for
 * 'toString', 'valueOf' and friends. Pinned by tests/modes.test.ts.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id as ModeId];
  return MODES[DEFAULT_MODE];
}
