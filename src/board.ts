// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * board.ts — the board as DOM, and the animation that makes a shift READ.
 *
 * DOM rather than canvas on purpose: this is a grid of cells with real buttons
 * around the edge. Real buttons mean real focus, real hit targets and real screen
 * reader labels for free, and CSS transforms give the slide for nothing.
 *
 * The one thing that must land: a shift moves the LINE, not the stone. If stones
 * teleported, the game would be illegible — the whole read is "everything on this
 * row went that way, together". So stones are absolutely positioned and animated
 * by transform, and a stone that wraps is faded out at one edge and in at the
 * other rather than flown across the board, which would read as the opposite move.
 */

import { isWell, tideRadius, type GameState, type Move, type Pos } from './game';
import { makeDraggable, type Draggable } from '@ben-gy/game-engine/drag';

export interface BoardCallbacks {
  /** A handle was activated. The screen decides whether it is legal/our turn. */
  onShift: (mv: Move) => void;
  /** Hovering/focusing a handle previews the line. Null clears it. */
  onPreview: (mv: Move | null) => void;
}

export interface BoardView {
  /** Redraw from scratch — new round, or a state we did not animate into. */
  render(s: GameState): void;
  /** Animate a shift, then settle on the new state. Resolves when done. */
  animate(mv: Move, moved: { from: Pos; to: Pos }[], banked: Pos[], to: GameState): Promise<void>;
  /** Highlight the line a move would shift, and where its stones would land. */
  preview(s: GameState, mv: Move | null): void;
  setInteractive(on: boolean): void;
  destroy(): void;
}

const KEY = (p: Pos): string => `${p.r},${p.c}`;

export function createBoard(
  root: HTMLElement,
  size: number,
  cb: BoardCallbacks,
  reducedMotion: boolean,
): BoardView {
  root.innerHTML = '';
  root.className = 'board';
  root.style.setProperty('--n', String(size));

  const grid = document.createElement('div');
  grid.className = 'bd-grid';
  root.appendChild(grid);

  // Cells are the backdrop: the Well, and the tide wash. Stones live above them
  // in their own layer so a stone can slide across cell boundaries.
  const cellEls: HTMLElement[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = document.createElement('div');
      cell.className = 'bd-cell';
      cell.style.gridArea = `${r + 1} / ${c + 1}`;
      grid.appendChild(cell);
      cellEls.push(cell);
    }
  }

  const stoneLayer = document.createElement('div');
  stoneLayer.className = 'bd-stones';
  grid.appendChild(stoneLayer);

  /** Live stone elements, by cell key. Reused across renders so they can slide. */
  let stones = new Map<string, HTMLElement>();
  let interactive = true;
  /** The last state painted, so setInteractive can re-derive the handle states. */
  let last: GameState | null = null;

  // ── handles ───────────────────────────────────────────────────────────────
  // Four per line (two ends x two axes). Each is a real <button>: 44px+, focusable,
  // labelled. This is the entire input surface — no drag, so nothing to fight the
  // browser's gesture handling for.
  const handles: HTMLButtonElement[] = [];
  const mkHandle = (mv: Move, cls: string, label: string, area: string): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `bd-handle ${cls}`;
    b.style.gridArea = area;
    b.setAttribute('aria-label', label);
    b.dataset.axis = mv.axis;
    b.dataset.index = String(mv.index);
    b.dataset.dir = String(mv.dir);
    b.innerHTML = '<span class="bd-arrow" aria-hidden="true"></span>';
    b.addEventListener('click', () => interactive && cb.onShift(mv));
    b.addEventListener('pointerenter', () => interactive && cb.onPreview(mv));
    b.addEventListener('pointerleave', () => cb.onPreview(null));
    b.addEventListener('focus', () => interactive && cb.onPreview(mv));
    b.addEventListener('blur', () => cb.onPreview(null));
    grid.appendChild(b);
    handles.push(b);
  };

  for (let i = 0; i < size; i++) {
    // Grid is 1-indexed and inset by one track on each side for the handles.
    mkHandle({ axis: 'row', index: i, dir: 1 }, 'h-left', `Shift row ${i + 1} right`, `${i + 1} / ${size + 1}`);
    mkHandle({ axis: 'row', index: i, dir: -1 }, 'h-right', `Shift row ${i + 1} left`, `${i + 1} / ${size + 2}`);
    mkHandle({ axis: 'col', index: i, dir: 1 }, 'h-top', `Shift column ${i + 1} down`, `${size + 1} / ${i + 1}`);
    mkHandle({ axis: 'col', index: i, dir: -1 }, 'h-bottom', `Shift column ${i + 1} up`, `${size + 2} / ${i + 1}`);
  }

  // ── drag to shift ───────────────────────────────────────────────────────────
  // The edge handles are the discrete control; this is the direct one. Drag a row
  // left/right (or a column up/down) and it shifts one step in that direction —
  // the same Move an edge handle makes, previewed live as the finger moves and
  // committed past a third of a cell. A transparent surface over the cell area
  // owns the gesture; the handles keep their taps (they sit outside it).
  const dragSurface = document.createElement('div');
  dragSurface.className = 'bd-dragsurface';
  grid.appendChild(dragSurface);

  let dragCell: Pos | null = null;
  let dragAxis: 'row' | 'col' | null = null;
  let dragMv: Move | null = null;

  /** Which cell a client point sits over, or null if outside the board. */
  function cellAt(clientX: number, clientY: number): Pos | null {
    const rect = grid.getBoundingClientRect();
    const step = rect.width / size;
    if (!(step > 0)) return null;
    const c = Math.floor((clientX - rect.left) / step);
    const r = Math.floor((clientY - rect.top) / step);
    if (r < 0 || r >= size || c < 0 || c >= size) return null;
    return { r, c };
  }

  /** A line is draggable if it holds a stone and is not the locked line. */
  function isLegalMove(mv: Move): boolean {
    if (!last) return false;
    if (last.locked && last.locked.axis === mv.axis && last.locked.index === mv.index) return false;
    return lineHasStone(last, mv.axis, mv.index);
  }

  function resetDrag(): void {
    dragCell = null;
    dragAxis = null;
    dragMv = null;
  }

  const drag: Draggable = makeDraggable(dragSurface, {
    onDragStart: resetDrag,
    onDragMove: (dx, dy, e) => {
      if (!interactive) return;
      // The grab cell is fixed at the start point, recovered from the delta.
      if (!dragCell) {
        dragCell = cellAt(e.clientX - dx, e.clientY - dy);
        if (!dragCell) return;
      }
      // Lock the axis once the intent is clear, so a diagonal wobble doesn't flip
      // the previewed line back and forth.
      if (!dragAxis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        dragAxis = Math.abs(dx) >= Math.abs(dy) ? 'row' : 'col';
      }
      const axis = dragAxis;
      const cell = dragCell;
      if (!axis || !cell) return;
      const dir: 1 | -1 = axis === 'row' ? (dx >= 0 ? 1 : -1) : dy >= 0 ? 1 : -1;
      const index = axis === 'row' ? cell.r : cell.c;
      const mv: Move = { axis, index, dir };
      if (isLegalMove(mv)) {
        dragMv = mv;
        cb.onPreview(mv);
      } else {
        dragMv = null;
        cb.onPreview(null);
      }
    },
    onDrop: (dx, dy) => {
      const mv = dragMv;
      const step = cellRect();
      const along = dragAxis === 'row' ? Math.abs(dx) : Math.abs(dy);
      cb.onPreview(null);
      resetDrag();
      // Commit only past a third of a cell — a small tug reads as "not yet".
      if (mv && interactive && step > 0 && along > step / 3) cb.onShift(mv);
    },
    onCancel: () => {
      cb.onPreview(null);
      resetDrag();
    },
  });

  function cellRect(): number {
    // One cell step in px, measured live so it survives any resize. Guarded
    // against a transient 0-size measure: a 0 here would make every transform
    // NaN. Returning 0 is only half the job — see reflow().
    const w = grid.clientWidth;
    return w > 0 ? w / size : 0;
  }

  function placeStone(el: HTMLElement, p: Pos): void {
    const step = cellRect();
    // Refusing to write a NaN transform is not enough: with no transform at all
    // every stone renders at cell 0,0. A BACKGROUNDED tab measures 0 — so a peer
    // whose friend starts the round while they are on another tab came back to
    // all nine stones piled in the corner, permanently, because nothing
    // re-measured. Caught by the two-tab smoke test; invisible to every unit
    // test and to playing it yourself in a focused window.
    //
    // So: remember the intent, and let the ResizeObserver below lay it out for
    // real the moment the element has a size.
    el.dataset.r = String(p.r);
    el.dataset.c = String(p.c);
    if (!step) return;
    el.style.transform = `translate(${p.c * step}px, ${p.r * step}px)`;
  }

  /** Re-place every stone from its remembered cell. Cheap; idempotent. */
  function reflow(): void {
    const step = cellRect();
    if (!step) return; // still unmeasurable — the observer will call again
    for (const el of stoneLayer.querySelectorAll<HTMLElement>('.bd-stone')) {
      const r = Number(el.dataset.r);
      const c = Number(el.dataset.c);
      if (Number.isFinite(r) && Number.isFinite(c)) {
        el.style.transform = `translate(${c * step}px, ${r * step}px)`;
      }
    }
  }

  function mkStone(p: Pos): HTMLElement {
    const el = document.createElement('div');
    el.className = 'bd-stone';
    placeStone(el, p);
    stoneLayer.appendChild(el);
    return el;
  }

  function paintCells(s: GameState): void {
    const radius = tideRadius(s.turnNo, s.opts, s.size);
    // The tide is a pure function of the move number, so the board can always
    // paint the truth without being told about it.
    const nextRadius = tideRadius(s.turnNo + 1, s.opts, s.size);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const cell = cellEls[r * size + c];
        const well = isWell(r, c, radius, size);
        cell.classList.toggle('is-well', well);
        // Cells the tide is about to claim, so the rise is never a surprise.
        cell.classList.toggle('is-rising', !well && isWell(r, c, nextRadius, size));
      }
    }
    root.style.setProperty('--radius', String(radius));
  }

  function paintLocks(s: GameState): void {
    for (const b of handles) {
      const locked = !!s.locked && s.locked.axis === b.dataset.axis && s.locked.index === Number(b.dataset.index);
      b.classList.toggle('is-locked', locked);
      b.disabled = !interactive || locked || !lineHasStone(s, b.dataset.axis as 'row' | 'col', Number(b.dataset.index));
    }
  }

  function lineHasStone(s: GameState, axis: 'row' | 'col', index: number): boolean {
    for (let i = 0; i < s.size; i++) {
      const r = axis === 'row' ? index : i;
      const c = axis === 'row' ? i : index;
      if (s.cells[r * s.size + c]) return true;
    }
    return false;
  }

  /** Reflow on the next task, unconditionally. render() runs synchronously right
   *  after the grid's innerHTML is set, before the browser has laid it out, so the
   *  first placeStone often measures 0 and parks every stone at the origin. A
   *  ResizeObserver or rAF would catch it in a FOREGROUND tab — but both are
   *  throttled or deferred while a tab is hidden, which is exactly the case that
   *  bites (your friend starts the round while you're on another tab). setTimeout
   *  still fires when hidden, so it is the one trigger that always lands. */
  let reflowSoon: ReturnType<typeof setTimeout> | undefined;
  function scheduleReflow(): void {
    if (reflowSoon) return;
    reflowSoon = setTimeout(() => {
      reflowSoon = undefined;
      reflow();
    }, 0);
  }

  function render(s: GameState): void {
    last = s;
    paintCells(s);
    const want = new Map<string, Pos>();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (s.cells[r * size + c]) want.set(KEY({ r, c }), { r, c });
    }
    for (const [k, el] of stones) if (!want.has(k)) el.remove();
    const next = new Map<string, HTMLElement>();
    for (const [k, p] of want) {
      const el = stones.get(k) ?? mkStone(p);
      el.classList.remove('is-ghost');
      placeStone(el, p);
      next.set(k, el);
    }
    stones = next;
    paintLocks(s);
    // If this render measured 0 (grid not laid out yet), lay the stones out once
    // the browser has. Harmless when the synchronous placement already worked.
    scheduleReflow();
  }

  async function animate(
    mv: Move,
    moved: { from: Pos; to: Pos }[],
    banked: Pos[],
    to: GameState,
  ): Promise<void> {
    if (reducedMotion) {
      render(to);
      return;
    }
    const step = cellRect();
    const bankedKeys = new Set(banked.map(KEY));
    const next = new Map<string, HTMLElement>();

    for (const m of moved) {
      const el = stones.get(KEY(m.from));
      if (!el) continue;
      stones.delete(KEY(m.from));
      // A wrap is a teleport, and flying the stone the long way across the board
      // reads as the OPPOSITE move. So fade it out past the edge and fade a fresh
      // one in on the other side — which is what the player perceives anyway.
      const wraps =
        mv.axis === 'row'
          ? Math.abs(m.to.c - m.from.c) > 1
          : Math.abs(m.to.r - m.from.r) > 1;
      if (wraps) {
        const outTo =
          mv.axis === 'row'
            ? { r: m.from.r, c: m.from.c + mv.dir }
            : { r: m.from.r + mv.dir, c: m.from.c };
        el.classList.add('is-wrapping');
        el.style.transform = `translate(${outTo.c * step}px, ${outTo.r * step}px)`;
        setTimeout(() => el.remove(), 220);
        const born = mkStone(
          mv.axis === 'row' ? { r: m.to.r, c: m.to.c - mv.dir } : { r: m.to.r - mv.dir, c: m.to.c },
        );
        born.classList.add('is-arriving');
        void born.offsetWidth; // commit the start transform before animating from it
        born.classList.remove('is-arriving');
        placeStone(born, m.to);
        next.set(KEY(m.to), born);
      } else {
        placeStone(el, m.to);
        next.set(KEY(m.to), el);
      }
    }
    // Stones the shift never touched keep their elements.
    for (const [k, el] of stones) next.set(k, el);
    stones = next;

    await wait(230);

    // Bank last, so the player sees the stone ARRIVE and then be taken.
    for (const p of banked) {
      const el = stones.get(KEY(p));
      if (!el) continue;
      el.classList.add('is-banked');
      stones.delete(KEY(p));
      setTimeout(() => el.remove(), 380);
    }
    if (bankedKeys.size) await wait(180);
    render(to);
  }

  function preview(s: GameState, mv: Move | null): void {
    for (const cell of cellEls) cell.classList.remove('is-lit');
    for (const el of stoneLayer.querySelectorAll('.bd-ghost')) el.remove();
    root.classList.toggle('is-previewing', !!mv);
    if (!mv) return;
    const step = cellRect();
    for (let i = 0; i < size; i++) {
      const r = mv.axis === 'row' ? mv.index : i;
      const c = mv.axis === 'row' ? i : mv.index;
      cellEls[r * size + c].classList.add('is-lit');
      if (!s.cells[r * size + c]) continue;
      const to =
        mv.axis === 'row'
          ? { r, c: (c + mv.dir + size) % size }
          : { r: (r + mv.dir + size) % size, c };
      const ghost = document.createElement('div');
      ghost.className = 'bd-stone bd-ghost';
      ghost.style.transform = `translate(${to.c * step}px, ${to.r * step}px)`;
      stoneLayer.appendChild(ghost);
    }
  }

  // A ResizeObserver rather than a window resize listener. It fires when the grid
  // FIRST gets a real size — which is the case that matters, because a tab that
  // was hidden when the round started has no layout to measure and never emits a
  // window resize on the way back. It also covers orientation, font load and any
  // container change for free, so it strictly replaces the old listener.
  const ro = new ResizeObserver(() => reflow());
  ro.observe(grid);
  // Belt and braces: some engines settle layout for a restored tab without a
  // size change the observer would report.
  const onVisible = (): void => reflow();
  document.addEventListener('visibilitychange', onVisible);

  return {
    render,
    animate,
    preview,
    setInteractive(on) {
      interactive = on;
      root.classList.toggle('is-idle', !on);
      // Re-derive `disabled`, don't just dim. Without this the attribute keeps
      // whatever the last render left, so during the countdown — or on the
      // opponent's turn — every handle still reports itself as enabled to a
      // keyboard or screen-reader user while the click handler silently drops
      // their press. The pointer path was never broken; the announced one was.
      if (last) paintLocks(last);
    },
    destroy() {
      drag.destroy();
      ro.disconnect();
      if (reflowSoon) clearTimeout(reflowSoon);
      document.removeEventListener('visibilitychange', onVisible);
      root.innerHTML = '';
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
