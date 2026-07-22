// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * session.ts — one round of Driftlock, solo or across the wire.
 *
 * Host-authoritative star. The host owns the GameState; clients ask, the host
 * decides. The state is tiny (a Uint8Array of cells, two scores, a lock and a
 * move number), so there is no delta encoding here and no need for any: a whole
 * snapshot is a few hundred bytes.
 *
 * The wire is three channels (all <= 12 bytes, per Trystero's limit):
 *   'mv'   client -> host   "I would like to shift this line"
 *   'do'   host -> all      "this move happened, at this move number"
 *   'snap' host -> all      the full state (on join, on request, on keepalive)
 *   'sq'   peer -> host     "I am lost, send me a snapshot"
 *
 * 'do' rather than a snapshot per move is what buys the animation: the rules are
 * deterministic, so every peer replays the same move and slides the same stones.
 * The snapshot is a correction, not the mechanism. A peer whose turnNo does not
 * match the move's `expect` knows it has drifted and asks for one.
 *
 * THE HOST MAY CHANGE UNDER US. net.ts promotes a survivor when the host leaves
 * and calls onHostChange; setHost() below is the takeover, and it is the reason
 * the authority lives behind a flag rather than being baked into two classes.
 * A client that has only ever rendered snapshots must be able to become the thing
 * that produces them, mid-round, without reloading. Proven by
 * tests/host-transfer.test.ts with no network involved at all.
 */

import {
  applyMove,
  chooseAiMove,
  generateBoard,
  moveError,
  type Difficulty,
  type GameState,
  type Move,
  type Pos,
} from './game';
import type { Mode } from './modes';
import type { Net, PeerId } from '@ben-gy/game-engine/net';

export interface SessionPlayer {
  id: PeerId;
  name: string;
  /** Absent for a human seat; set when a bot is driving it. */
  bot?: Difficulty;
}

export interface SessionConfig {
  /** Null for a solo game — the whole session works identically without a net. */
  net: Net | null;
  mode: Mode;
  seed: number;
  players: SessionPlayer[];
  /** Which seat this browser plays. -1 for a spectator. */
  seat: number;
  isHost: boolean;
  /** Fires on every state change. `mv` is set when it came from a real move. */
  onChange: (s: GameState, anim?: { mv: Move; moved: { from: Pos; to: Pos }[]; banked: Pos[]; from: GameState }) => void;
  /** A seat went to a bot because its player left. */
  onSeatVacated?: (seat: number, name: string) => void;
}

export interface Session {
  state(): GameState;
  players(): SessionPlayer[];
  /** This browser attempts a move. Routed to the host if we are not it. */
  move(mv: Move): void;
  /** True when it is our seat's turn AND the round is live. */
  canMove(): boolean;
  isHost(): boolean;
  /** net.ts promoted (or demoted) us. THE host-transfer takeover. */
  setHost(isHost: boolean): void;
  /** A peer left. The host hands their seat to a bot so the round can finish. */
  onPeerLeave(): void;
  destroy(): void;
}

interface Snap {
  cells: number[];
  scores: number[];
  turn: number;
  turnNo: number;
  locked: GameState['locked'];
  finished: boolean;
  winner: number;
  best: number[];
  missed: number[];
  bots: (Difficulty | null)[];
}

export function createSession(cfg: SessionConfig): Session {
  let s: GameState = generateBoard(cfg.seed, cfg.mode);
  let host = cfg.isHost;
  let dead = false;
  const players = cfg.players.map((p) => ({ ...p }));

  const net = cfg.net;
  // Host-only cadence. setInterval, never rAF: a backgrounded host must keep
  // answering, and rAF is paused for hidden tabs — which would strand the
  // opponent on a board that has silently stopped advancing.
  let tick: ReturnType<typeof setInterval> | undefined;

  const snapOf = (): Snap => ({
    cells: [...s.cells],
    scores: s.scores,
    turn: s.turn,
    turnNo: s.turnNo,
    locked: s.locked,
    finished: s.finished,
    winner: s.winner,
    best: s.best,
    missed: s.missed,
    bots: players.map((p) => p.bot ?? null),
  });

  function adopt(snap: Snap): void {
    s = {
      ...s,
      cells: Uint8Array.from(snap.cells),
      scores: snap.scores,
      turn: snap.turn,
      turnNo: snap.turnNo,
      locked: snap.locked,
      finished: snap.finished,
      winner: snap.winner,
      best: snap.best,
      missed: snap.missed,
    };
    snap.bots.forEach((b, i) => {
      if (players[i]) players[i].bot = b ?? undefined;
    });
    cfg.onChange(s);
  }

  const sendMv = net?.channel<{ mv: Move }>('mv', (msg, from) => {
    // Only the host acts on requests, and only from the seat whose turn it is.
    if (!host || dead) return;
    const seat = players.findIndex((p) => p.id === from);
    if (seat < 0) return;
    commit(msg.mv, seat);
  });

  const sendDo = net?.channel<{ mv: Move; expect: number; seat: number }>('do', (msg, from) => {
    if (host || dead) return;
    if (from !== net?.host()) return; // only the elected host may drive the sim
    if (msg.expect !== s.turnNo) {
      // We have drifted (a dropped packet, or we joined mid-round). Do not guess.
      sendSq?.(null);
      return;
    }
    apply(msg.mv, msg.seat);
  });

  const sendSnap = net?.channel<Snap>('snap', (snap, from) => {
    if (host || dead) return;
    if (from !== net?.host()) return;
    if (snap.turnNo < s.turnNo) return; // a stale snapshot must not rewind us
    adopt(snap);
  });

  const sendSq = net?.channel<null>('sq', (_d, from) => {
    if (!host || dead) return;
    sendSnap?.(snapOf(), from);
  });

  /** Apply locally, animate, and report. Used by every peer, host or not. */
  function apply(mv: Move, seat: number): boolean {
    const before = s;
    const res = applyMove(s, seat, mv);
    if (res.illegal) return false;
    s = res.state;
    cfg.onChange(s, { mv, moved: res.moved, banked: res.banked, from: before });
    return true;
  }

  /** Host-only: validate, apply, and tell the room. */
  function commit(mv: Move, seat: number): void {
    if (!host || dead || s.finished) return;
    if (moveError(s, seat, mv)) return;
    const expect = s.turnNo;
    if (!apply(mv, seat)) return;
    sendDo?.({ mv, expect, seat });
  }

  /**
   * Hand any seat whose player is no longer in the room to a bot, so the round
   * stays playable and can still reach a real game over. Host-only and
   * idempotent — safe to call on a peer leaving AND on being promoted, which is
   * exactly what the net.ts call order (onPeerLeave then onHostChange) requires.
   */
  function reconcileSeats(): void {
    if (!host || dead) return;
    const live = new Set([net?.selfId, ...(net?.peers() ?? [])]);
    let changed = false;
    players.forEach((p, i) => {
      if (p.bot || live.has(p.id)) return;
      p.bot = 'normal';
      changed = true;
      cfg.onSeatVacated?.(i, p.name);
    });
    if (changed) {
      sendSnap?.(snapOf());
      cfg.onChange(s);
    }
  }

  function botStep(): void {
    if (!host || dead || s.finished) return;
    const p = players[s.turn];
    if (!p?.bot) return;
    commit(chooseAiMove(s, s.turn, p.bot, Math.random), s.turn);
  }

  function startHostTimers(): void {
    if (tick) return;
    tick = setInterval(() => {
      if (dead) return;
      botStep();
      // Keepalive. Cheap, and it heals a dropped 'do' without anyone noticing.
      if (net && !s.finished) sendSnap?.(snapOf());
    }, 700);
  }

  function stopHostTimers(): void {
    if (tick) clearInterval(tick);
    tick = undefined;
  }

  if (host) startHostTimers();
  else sendSq?.(null); // "I'm here, what's the position?"

  return {
    state: () => s,
    players: () => players,

    canMove() {
      return !dead && !s.finished && cfg.seat >= 0 && s.turn === cfg.seat && !players[cfg.seat]?.bot;
    },

    move(mv) {
      if (!this.canMove()) return;
      if (moveError(s, cfg.seat, mv)) return;
      if (host) commit(mv, cfg.seat);
      // Not the host: ask, and wait to be told. Applying it locally here would
      // feel snappier and would be a lie — the host may refuse it, and then the
      // board has to jump backwards, which is worse than the 50ms.
      else sendMv?.({ mv });
    },

    isHost: () => host,

    setHost(next) {
      if (next === host) return;
      host = next;
      if (host) {
        // THE TAKEOVER. We were rendering someone else's snapshots; now we are
        // the source. Whatever we last heard IS the position — there is nobody
        // left to correct us — so re-broadcast it to settle the room, then
        // resume the host-only cadence (bots, keepalive).
        //
        // Reconcile seats HERE, not only in onPeerLeave. net.ts fires
        // onPeerLeave BEFORE onHostChange, so when the host drops, our
        // onPeerLeave ran while we were still a guest and bailed on the `!host`
        // guard — the departed host's seat was never handed to a bot. Without
        // this line the promoted peer sits forever on "waiting for <the host who
        // left>", which is the exact freeze the host-transfer gate exists to
        // prevent. The two-tab smoke test caught it; a unit test that called
        // setHost before onPeerLeave (the wrong order) did not.
        reconcileSeats();
        sendSnap?.(snapOf());
        startHostTimers();
      } else stopHostTimers();
    },

    onPeerLeave() {
      if (!host || dead) return;
      reconcileSeats();
    },

    destroy() {
      dead = true;
      stopHostTimers();
      // Detach OUR receivers only. The Net outlives this round and will carry the
      // next one; leaking these is how a dead round keeps answering the room.
      sendMv?.off();
      sendDo?.off();
      sendSnap?.off();
      sendSq?.off();
    },
  };
}
