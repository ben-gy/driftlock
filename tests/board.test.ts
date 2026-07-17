/**
 * board.test.ts — the view, and specifically the bug that a unit test would never
 * have found on its own.
 *
 * A backgrounded tab has no layout: `clientWidth` is 0. If the round starts while
 * the player is on another tab — i.e. any time your friend hits Start and you are
 * reading something else — every stone was positioned from a 0 step, so all nine
 * rendered on top of each other in the corner. And they STAYED there, because the
 * only thing that re-placed them was a window resize event that never came.
 *
 * The board looked perfect in a focused window and in every headless test. It took
 * the two-tab smoke test to see it. This suite is the regression net.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoard } from '../src/board';
import { generateBoard } from '../src/game';
import { MODES } from '../src/modes';

/** jsdom has no ResizeObserver and no layout. Both are faked, deliberately. */
let observers: (() => void)[] = [];
let width = 0;

beforeEach(() => {
  observers = [];
  width = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: () => void) {}
      observe(): void {
        observers.push(() => this.cb());
      }
      disconnect(): void {}
    },
  );
  // jsdom reports clientWidth 0 for everything, which is exactly the hidden-tab
  // case — so `width` is the knob this suite turns.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList?.contains('bd-grid') ? width : 0;
    },
  });
});

const mount = () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
};

const transforms = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLElement>('.bd-stone')].map((el) => el.style.transform);

describe('a board rendered while the tab is hidden', () => {
  it('does not write NaN transforms', () => {
    const root = mount();
    const view = createBoard(root, 5, { onShift: () => {}, onPreview: () => {} }, false);
    view.render(generateBoard(1, MODES.duel));
    for (const t of transforms(root)) expect(t).not.toContain('NaN');
  });

  it('LAYS THE STONES OUT once the grid finally has a size', () => {
    // The regression. Render at width 0 (hidden), then let layout arrive.
    const root = mount();
    const view = createBoard(root, 5, { onShift: () => {}, onPreview: () => {} }, false);
    view.render(generateBoard(1, MODES.duel));

    // Hidden: nothing is positioned, and every stone is stacked at the origin.
    expect(new Set(transforms(root)).size).toBe(1);

    width = 500; // the tab is shown; the grid measures 500px => 100px per cell
    for (const fire of observers) fire();

    const ts = transforms(root);
    expect(ts.length).toBe(MODES.duel.stones);
    // Nine stones on distinct cells must now be at nine distinct offsets. Before
    // the fix every one of these was '' and this expectation read 1.
    expect(new Set(ts).size).toBe(MODES.duel.stones);
    for (const t of ts) {
      expect(t).toMatch(/^translate\(\d+px, \d+px\)$/);
      expect(t).not.toContain('NaN');
    }
  });

  it('places stones on the cell grid it was given', () => {
    width = 500;
    const root = mount();
    const view = createBoard(root, 5, { onShift: () => {}, onPreview: () => {} }, false);
    view.render(generateBoard(3, MODES.duel));
    // Every offset must be a whole multiple of the 100px cell step and inside it.
    for (const t of transforms(root)) {
      const [x, y] = [...t.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
      expect(x % 100).toBe(0);
      expect(y % 100).toBe(0);
      expect(x).toBeLessThan(500);
      expect(y).toBeLessThan(500);
    }
  });

  it('lays them out via the deferred task even with NO observer and NO visibility event', async () => {
    // The case the MCP preview pane exposed: a permanently-hidden tab never fires
    // a visibilitychange and defers ResizeObserver callbacks, yet the grid has a
    // real width. The setTimeout(0) reflow is the trigger that still lands. Here
    // the observer is never fired and no event dispatched — only time passes.
    width = 500;
    const root = mount();
    const view = createBoard(root, 5, { onShift: () => {}, onPreview: () => {} }, false);
    // Force the 0-measure at render time, then restore before the deferred task.
    width = 0;
    view.render(generateBoard(1, MODES.duel));
    expect(new Set(transforms(root)).size).toBe(1); // piled, synchronously
    width = 500;
    await new Promise((r) => setTimeout(r, 5));
    expect(new Set(transforms(root)).size).toBe(MODES.duel.stones); // fixed by the timer
  });

  it('re-places on visibilitychange too', () => {
    const root = mount();
    const view = createBoard(root, 5, { onShift: () => {}, onPreview: () => {} }, false);
    view.render(generateBoard(1, MODES.duel));
    width = 500;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(new Set(transforms(root)).size).toBe(MODES.duel.stones);
  });
});

describe('handles', () => {
  it('are real labelled buttons, four per line', () => {
    width = 500;
    const root = mount();
    createBoard(root, 5, { onShift: () => {}, onPreview: () => {} }, false);
    const handles = root.querySelectorAll('button.bd-handle');
    expect(handles).toHaveLength(5 * 4); // 5 rows + 5 cols, two directions each
    for (const h of handles) expect(h.getAttribute('aria-label')).toMatch(/Shift (row|column) \d (right|left|up|down)/);
  });

  it('disables the locked line, and re-derives on setInteractive', () => {
    // The countdown case: interactivity is switched off AFTER the render, so the
    // handles must be recomputed or they keep announcing themselves as enabled to
    // keyboard and screen-reader users while every press is silently dropped.
    width = 500;
    const root = mount();
    const view = createBoard(root, 5, { onShift: () => {}, onPreview: () => {} }, false);
    const s = generateBoard(1, MODES.duel);
    view.render({ ...s, locked: { axis: 'row', index: 2 } });
    const rowTwo = [...root.querySelectorAll<HTMLButtonElement>('.bd-handle')].filter(
      (b) => b.dataset.axis === 'row' && b.dataset.index === '2',
    );
    expect(rowTwo.length).toBe(2);
    for (const b of rowTwo) expect(b.disabled).toBe(true);

    view.setInteractive(false);
    expect([...root.querySelectorAll<HTMLButtonElement>('.bd-handle')].every((b) => b.disabled)).toBe(true);
    view.setInteractive(true);
    expect([...root.querySelectorAll<HTMLButtonElement>('.bd-handle')].some((b) => !b.disabled)).toBe(true);
  });

  it('reports the move it stands for', () => {
    width = 500;
    const root = mount();
    const seen: unknown[] = [];
    createBoard(root, 5, { onShift: (mv) => seen.push(mv), onPreview: () => {} }, false);
    root.querySelector<HTMLButtonElement>('.bd-handle')!.click();
    expect(seen[0]).toEqual({ axis: 'row', index: 0, dir: 1 });
  });
});
