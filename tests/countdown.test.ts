/**
 * countdown.test.ts — the three seconds before the first legal shift.
 *
 * The sound is the load-bearing part, not the digit: players look at the board,
 * not the overlay, so the pips are what actually starts the round for them. A
 * tick that fires on a different frame from its number feels broken in a way
 * people notice but cannot name — so the count and the sfx are asserted together,
 * per step, rather than just counting calls at the end.
 *
 * cancel() matters as much as the count. A round torn down mid-count (a peer left,
 * a rematch reset) must not fire onDone into a dead screen, and must not leave a
 * full-bleed overlay on top of the board eating every tap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCountdown } from '../src/countdown';
import type { Sfx, SfxName } from '../src/engine/sound';

/** A Sfx that records instead of touching the Web Audio API jsdom does not have. */
function stubSfx(): Sfx & { played: SfxName[] } {
  const played: SfxName[] = [];
  return {
    played,
    unlock: () => {},
    play: (name: SfxName) => {
      played.push(name);
    },
    muted: () => false,
    setMuted: () => {},
  };
}

let root: HTMLElement;
let sfx: ReturnType<typeof stubSfx>;
let onDone: ReturnType<typeof vi.fn>;

const el = (): HTMLElement | null => root.querySelector('.countdown');
const num = (): HTMLElement | null => root.querySelector('.cd-num');

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
  sfx = stubSfx();
  onDone = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  root.remove();
});

describe('createCountdown', () => {
  it('appends its overlay to the root and shows the first tick immediately', () => {
    createCountdown({ root, sfx, onDone });

    // Synchronous: a countdown that only appears after 1s has eaten a third of
    // the beat it exists to provide.
    expect(el()).not.toBeNull();
    expect(num()?.textContent).toBe('3');
    expect(num()?.classList.contains('cd-tick')).toBe(true);
    expect(sfx.played).toEqual(['blip']);
  });

  it('is announced to screen readers', () => {
    createCountdown({ root, sfx, onDone });
    expect(el()?.getAttribute('role')).toBe('status');
    expect(el()?.getAttribute('aria-live')).toBe('assertive');
  });

  it('counts 3 -> 2 -> 1 -> GO, one blip per tick and a higher note on GO', () => {
    createCountdown({ root, sfx, onDone });

    expect(num()?.textContent).toBe('3');
    expect(sfx.played).toEqual(['blip']);

    vi.advanceTimersByTime(1000);
    expect(num()?.textContent).toBe('2');
    expect(sfx.played).toEqual(['blip', 'blip']);

    vi.advanceTimersByTime(1000);
    expect(num()?.textContent).toBe('1');
    expect(sfx.played).toEqual(['blip', 'blip', 'blip']);

    vi.advanceTimersByTime(1000);
    expect(num()?.textContent).toBe('GO');
    expect(num()?.classList.contains('cd-go')).toBe(true);
    expect(sfx.played).toEqual(['blip', 'blip', 'blip', 'win']);

    // GO is the last sound. onDone has not fired yet — the word has to be
    // readable before the board goes live.
    expect(onDone).not.toHaveBeenCalled();
  });

  it('calls onDone after GO, and removes its element when finished', () => {
    createCountdown({ root, sfx, onDone });

    vi.advanceTimersByTime(3000); // 3, 2, 1, GO
    expect(onDone).not.toHaveBeenCalled();
    expect(el()).not.toBeNull();

    vi.advanceTimersByTime(450);
    expect(onDone).toHaveBeenCalledTimes(1);
    // A full-bleed overlay left behind would sit on top of the live board.
    expect(el()).toBeNull();
  });

  it('fires onDone exactly once and then goes quiet', () => {
    createCountdown({ root, sfx, onDone });
    vi.advanceTimersByTime(10_000);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(sfx.played).toEqual(['blip', 'blip', 'blip', 'win']);
  });

  it('honours `from` — a shorter count is still a count', () => {
    createCountdown({ root, sfx, from: 1, onDone });
    expect(num()?.textContent).toBe('1');
    expect(sfx.played).toEqual(['blip']);

    vi.advanceTimersByTime(1000);
    expect(num()?.textContent).toBe('GO');

    vi.advanceTimersByTime(450);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('marks itself reduced so the keyframes can be skipped', () => {
    createCountdown({ root, sfx, reducedMotion: true, onDone });
    expect(el()?.classList.contains('reduced')).toBe(true);
  });
});

describe('cancel', () => {
  it('stops the count early: no onDone, element removed, no further sfx', () => {
    const cd = createCountdown({ root, sfx, onDone });
    vi.advanceTimersByTime(1000); // 3, 2
    expect(sfx.played).toEqual(['blip', 'blip']);

    cd.cancel();

    expect(el()).toBeNull();

    // Nothing may fire into a screen that has been torn down.
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
    expect(sfx.played).toEqual(['blip', 'blip']);
    expect(el()).toBeNull();
  });

  it('cancelling during GO still suppresses onDone', () => {
    const cd = createCountdown({ root, sfx, onDone });
    vi.advanceTimersByTime(3000); // GO is on screen, onDone is 450ms away
    expect(sfx.played).toEqual(['blip', 'blip', 'blip', 'win']);

    cd.cancel();
    vi.advanceTimersByTime(1000);

    expect(onDone).not.toHaveBeenCalled();
    expect(el()).toBeNull();
  });

  it('is idempotent, and safe after a natural finish', () => {
    const cd = createCountdown({ root, sfx, onDone });
    vi.advanceTimersByTime(3450);
    expect(onDone).toHaveBeenCalledTimes(1);

    expect(() => {
      cd.cancel();
      cd.cancel();
    }).not.toThrow();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
