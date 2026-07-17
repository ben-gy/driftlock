/**
 * modes.test.ts — the referee for the mode table, and for the one input the game
 * is required to distrust.
 *
 * Two unrelated things are pinned here because they fail the same way: a board of
 * edge NaN.
 *
 * The constants (see modes.ts) were measured, not chosen. tideEvery must be odd —
 * an even period measured a 95% first-player win rate. tideMax must be even (so
 * each seat is on move for exactly half the rises) AND equal floor(size/2) (so
 * the Well's cross eventually spans the board and the game can end). Together
 * those forbid 7x7, which wants a tideMax of 3.
 *
 * And modeOf() must survive a hostile id. See the prototype block at the bottom.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODE_LIST, MODES, modeOf, type Mode, type ModeId } from '../src/modes';

const entries = Object.entries(MODES) as [ModeId, Mode][];

describe('the mode table', () => {
  it('has at least one mode', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s: tideEvery is odd', (_id, mode) => {
    // An even tide period hands the first player a 95% win rate.
    expect(mode.tideEvery % 2).toBe(1);
    expect(mode.tideEvery).toBeGreaterThan(0);
  });

  it.each(entries)('%s: tideMax is even and equals floor(size/2)', (_id, mode) => {
    // Even: each seat is on move for exactly half the rises.
    expect(mode.tideMax % 2).toBe(0);
    // Equal to floor(size/2): the Well must eventually span the board, or a
    // stalemate has nowhere to resolve.
    expect(mode.tideMax).toBe(Math.floor(mode.size / 2));
  });

  it.each(entries)('%s: size is odd and floor(size/2) is even — 5 or 9, never 7', (_id, mode) => {
    // Odd: a torus with no centre cell has no Well to bank into.
    expect(mode.size % 2).toBe(1);
    // The two rules above collapse to this. 7 wants a tideMax of 3, which is odd,
    // which is the unfair-tide case — so 7x7 cannot exist.
    expect(Math.floor(mode.size / 2) % 2).toBe(0);
    expect([5, 9]).toContain(mode.size);
  });

  it.each(entries)('%s: stones fit on the board', (_id, mode) => {
    expect(mode.stones).toBeGreaterThan(0);
    expect(mode.stones).toBeLessThanOrEqual(mode.size * mode.size);
  });

  it.each(entries)('%s: maxMoves is a positive backstop', (_id, mode) => {
    expect(mode.maxMoves).toBeGreaterThan(0);
  });

  it.each(entries)('%s: keys its own id, and is presentable', (id, mode) => {
    // A mode whose id does not match its key travels over the wire as the key and
    // comes back as the other mode.
    expect(mode.id).toBe(id);
    expect(mode.name.length).toBeGreaterThan(0);
    expect(mode.blurb.length).toBeGreaterThan(0);
  });
});

describe('MODE_LIST', () => {
  it('matches MODES exactly — no mode is unreachable from the UI', () => {
    expect(MODE_LIST).toHaveLength(entries.length);
    expect([...MODE_LIST].map((m) => m.id).sort()).toEqual(entries.map(([id]) => id).sort());
  });

  it('holds the same objects MODES does, not copies', () => {
    for (const m of MODE_LIST) expect(m).toBe(MODES[m.id]);
  });
});

describe('DEFAULT_MODE', () => {
  it('names a mode that exists', () => {
    expect(Object.hasOwn(MODES, DEFAULT_MODE)).toBe(true);
    expect(MODES[DEFAULT_MODE]).toBeDefined();
  });
});

describe('modeOf', () => {
  it('resolves every valid id', () => {
    for (const [id, mode] of entries) expect(modeOf(id)).toBe(mode);
  });

  it.each([
    ['an unknown id', 'nope'],
    ['the empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 3],
    ['a number that looks like an index', 0],
    ['an object', { id: 'duel' }],
    ['an array', ['duel']],
    ['a boolean', true],
  ])('falls back to the default for %s', (_label, input) => {
    expect(modeOf(input)).toBe(MODES[DEFAULT_MODE]);
  });

  /**
   * THE PROTOTYPE GUARD. This is the reason modeOf uses Object.hasOwn.
   *
   * MODES is an object literal, so it inherits from Object.prototype: reading
   * MODES['constructor'] yields the Object CONSTRUCTOR, and 'toString'/'valueOf'
   * yield functions. All of them are truthy, so a plain `MODES[id] || DEFAULT`
   * returns one AS a Mode — an object with every field undefined. generateBoard
   * then reads `.size` off it and builds a board of edge NaN, from the one input
   * the function exists to distrust (an older peer, a corrupted store, or a
   * hand-edited wire message).
   *
   * '__proto__' is worse still: it resolves to Object.prototype itself.
   */
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', 'isPrototypeOf'])(
    'returns the default for the inherited key %s, not the prototype member',
    (key) => {
      const got = modeOf(key);
      expect(got).toBe(MODES[DEFAULT_MODE]);
      // Belt and braces: whatever came back is a real Mode, not a function with
      // undefined fields waiting to become a NaN board.
      expect(typeof got).toBe('object');
      expect(typeof got.size).toBe('number');
      expect(Number.isNaN(got.size)).toBe(false);
    },
  );
});
