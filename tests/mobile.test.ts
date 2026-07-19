/**
 * mobile.test.ts — the phone hardening, which is invisible until it is missing.
 *
 * Every assertion here stands for a way a real player has lost, or could lose, a
 * live round on a phone:
 *
 *   --vh      a 100vh layout is cut off by the collapsing URL bar. But a tab that
 *             reports innerHeight 0 must NOT be believed — writing 0px through
 *             collapses every calc(var(--vh) * 100) to a blank page.
 *   gesture*  <meta name="viewport" user-scalable=no> is IGNORED by iOS Safari.
 *             Cancelling the proprietary gesture events is the only defence
 *             against a pinch-zoomed board with no way back out.
 *   touchend  a fast second tap zooms on iOS even with touch-action set.
 *   unharden  listeners on `document` outlive any screen that installed them.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardenViewport, type Unharden } from '@ben-gy/game-engine/mobile';

/** Fire a cancelable event and report whether something refused it. */
function fire(target: EventTarget, type: string): boolean {
  const e = new Event(type, { cancelable: true, bubbles: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

function setInnerHeight(h: number): void {
  Object.defineProperty(window, 'innerHeight', {
    value: h,
    configurable: true,
    writable: true,
  });
}

let unharden: Unharden | undefined;
const realHeight = window.innerHeight;

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.style.removeProperty('--vh');
  setInnerHeight(realHeight || 768);
});

afterEach(() => {
  unharden?.();
  unharden = undefined;
  vi.useRealTimers();
  document.documentElement.style.removeProperty('--vh');
  setInnerHeight(realHeight || 768);
});

describe('hardenViewport — the --vh unit', () => {
  it('writes --vh as one hundredth of the real viewport height', () => {
    setInnerHeight(640);
    unharden = hardenViewport();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('6.4px');
  });

  it('re-measures on resize', () => {
    setInnerHeight(640);
    unharden = hardenViewport();
    setInnerHeight(800);
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('8px');
  });

  it('re-measures on orientationchange and visibilitychange', () => {
    setInnerHeight(640);
    unharden = hardenViewport();

    setInnerHeight(900);
    window.dispatchEvent(new Event('orientationchange'));
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('9px');

    // The first real measurement may only arrive once the tab is shown.
    setInnerHeight(500);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('5px');
  });

  it('REFUSES a 0 innerHeight — 0px would collapse the page to blank', () => {
    // A backgrounded or pre-rendered tab reports 0. Believing it sets --vh: 0px,
    // which makes every `min-height: calc(var(--vh) * 100)` zero and renders a
    // blank page. The 1vh fallback in mobile.css must survive instead.
    setInnerHeight(0);
    unharden = hardenViewport();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('');
  });

  it('does not clobber a good --vh when a later measure reports 0', () => {
    setInnerHeight(640);
    unharden = hardenViewport();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('6.4px');

    setInnerHeight(0);
    window.dispatchEvent(new Event('resize'));
    // The last known-good height stands.
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('6.4px');
  });

  it('can be switched off', () => {
    setInnerHeight(640);
    unharden = hardenViewport({ vhUnit: false });
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('');
  });
});

describe('hardenViewport — pinch zoom', () => {
  it('refuses gesturestart and gesturechange', () => {
    unharden = hardenViewport();
    // Safari-only events, and the only way to refuse a pinch: the viewport meta
    // is ignored by iOS.
    expect(fire(document, 'gesturestart')).toBe(true);
    expect(fire(document, 'gesturechange')).toBe(true);
  });

  it('refuses gestureend too, so the zoom cannot settle', () => {
    unharden = hardenViewport();
    expect(fire(document, 'gestureend')).toBe(true);
  });

  it('leaves gestures alone when switched off', () => {
    unharden = hardenViewport({ pinch: false });
    expect(fire(document, 'gesturestart')).toBe(false);
  });
});

describe('hardenViewport — double-tap zoom', () => {
  it('refuses a second touchend inside the 320ms window', () => {
    unharden = hardenViewport();
    expect(fire(document, 'touchend')).toBe(false); // the first tap is a real tap
    vi.advanceTimersByTime(100);
    expect(fire(document, 'touchend')).toBe(true); // the second would zoom
  });

  it('allows a slow second touchend — two deliberate taps are two taps', () => {
    unharden = hardenViewport();
    expect(fire(document, 'touchend')).toBe(false);
    vi.advanceTimersByTime(400);
    expect(fire(document, 'touchend')).toBe(false);
  });

  it('refuses dblclick', () => {
    unharden = hardenViewport();
    expect(fire(document, 'dblclick')).toBe(true);
  });

  it('leaves taps alone when switched off', () => {
    unharden = hardenViewport({ doubleTap: false });
    expect(fire(document, 'touchend')).toBe(false);
    vi.advanceTimersByTime(50);
    expect(fire(document, 'touchend')).toBe(false);
  });
});

describe('hardenViewport — teardown', () => {
  it('removes every listener it installed', () => {
    const off = hardenViewport();
    expect(fire(document, 'gesturestart')).toBe(true);

    off();

    expect(fire(document, 'gesturestart')).toBe(false);
    expect(fire(document, 'gesturechange')).toBe(false);
    expect(fire(document, 'dblclick')).toBe(false);
    expect(fire(document, 'touchend')).toBe(false);
    vi.advanceTimersByTime(50);
    expect(fire(document, 'touchend')).toBe(false);

    // And --vh stops tracking the viewport.
    document.documentElement.style.removeProperty('--vh');
    setInnerHeight(700);
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('');
  });
});

describe('the [hidden] rule', () => {
  // A class that sets `display` on the same element silently defeats the UA rule
  // in Safari, leaving an invisible blur/dim layer on top that eats every tap.
  // This has shipped once. Both sheets must assert it — mobile.css because it is
  // the baseline, main.css because it is the sheet loaded LAST and therefore the
  // one a game rule would otherwise beat.
  const hiddenRule = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/;

  it.each([
    ['src/styles/mobile.css'],
    ['src/styles/main.css'],
  ])('%s forces display:none on [hidden]', (path) => {
    expect(readFileSync(path, 'utf8')).toMatch(hiddenRule);
  });
});

describe('the board fits ANY board size — the Deepwell overflow guard', () => {
  // Shipped bug: Deepwell (9x9) overflowed the phone, pushing the rightmost
  // columns and every row handle off-screen and unreachable, while the column
  // handles overlapped into a mis-tap lottery. jsdom has no layout engine so it
  // cannot see the overflow itself — but the two CSS invariants that prevent it
  // are pinnable, and reverting either is what caused it. See the note in
  // main.css's .bd-grid. The real safety net is the routine now VISUALLY testing
  // every mode (5x5 AND 9x9); this keeps a careless edit from re-arming it.
  const css = readFileSync('src/styles/main.css', 'utf8');

  it('sizes cell tracks with minmax(0, 1fr) so a 9x9 can shrink to fit', () => {
    // A bare `1fr` is minmax(auto, 1fr): the 40px handles living in each track
    // floor every column at ~40px, so 9 columns cannot fit a 250px grid.
    expect(css).toMatch(/grid-template-columns:\s*repeat\(var\(--n\),\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/grid-template-rows:\s*repeat\(var\(--n\),\s*minmax\(0,\s*1fr\)\)/);
    expect(css, 'a bare 1fr re-arms the Deepwell overflow').not.toMatch(
      /repeat\(var\(--n\),\s*1fr\)\s*0\s*0/,
    );
  });

  it('caps each handle to its cell so N handles never overlap on a dense board', () => {
    expect(css).toMatch(/\.h-top,\s*\.h-bottom\s*\{[^}]*width:\s*min\(var\(--h\),\s*100%\)/);
    expect(css).toMatch(/\.h-left,\s*\.h-right\s*\{[^}]*height:\s*min\(var\(--h\),\s*100%\)/);
  });
});
