/**
 * host-transfer.test.ts — MULTIPLAYER CONTRACT GATE #2.
 *
 * The host leaving must not freeze or end the game. rhythm-relay shipped broken
 * because its co-op shape didn't reuse a Session, so nobody wired onHostChange —
 * and no test could have noticed, because there was no seam to test.
 *
 * So the takeover lives on the Session as `setHost()`, and this suite drives it
 * with NO network at all: a fake bus stands in for the room. That is legitimate
 * here (unlike for the leave/rejoin invariant, where a fake bus sits above the
 * bug and structurally cannot contain it) because the thing under test is our
 * authority flag, not Trystero's transport.
 *
 * What must hold:
 *   · before promotion a client does NOT mutate shared state on its own;
 *   · after promotion it DOES, and the round can still reach `finished`;
 *   · a vacated seat goes to a bot so the survivor can actually finish.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, type Session } from '../src/session';
import { legalMoves, type GameState, type Move } from '../src/game';
import { MODES } from '../src/modes';
import type { Net, PeerId } from '../src/engine/net';

/** A two-peer bus. Delivers synchronously; good enough for authority tests. */
function makeBus() {
  const peers = new Map<PeerId, Map<string, ((d: unknown, from: PeerId) => void)[]>>();
  let hostId: PeerId = 'A';
  const live = new Set<PeerId>(['A', 'B']);

  function netFor(selfId: PeerId): Net {
    peers.set(selfId, new Map());
    return {
      selfId,
      peers: () => [...live].sort(),
      host: () => hostId,
      isHost: () => hostId === selfId,
      hostSettled: () => true,
      count: () => live.size,
      channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
        const mine = peers.get(selfId)!;
        if (!mine.has(name)) mine.set(name, []);
        mine.get(name)!.push(onReceive as (d: unknown, from: PeerId) => void);
        const send = ((data: T, to?: PeerId | PeerId[]) => {
          const targets = to
            ? Array.isArray(to)
              ? to
              : [to]
            : [...live].filter((p) => p !== selfId);
          for (const t of targets) {
            if (!live.has(t)) continue;
            for (const h of peers.get(t)?.get(name) ?? []) h(data, selfId);
          }
        }) as ((data: T, to?: PeerId | PeerId[]) => void) & { off: () => void };
        send.off = () => {
          const arr = mine.get(name)!;
          arr.splice(arr.indexOf(onReceive as (d: unknown, from: PeerId) => void), 1);
        };
        return send;
      },
      ping: async () => 1,
      leave: async () => {},
    };
  }

  return {
    netFor,
    kill(id: PeerId) {
      live.delete(id);
      peers.delete(id);
    },
    promote(id: PeerId) {
      hostId = id;
    },
  };
}

const PLAYERS = [
  { id: 'A', name: 'Ada' },
  { id: 'B', name: 'Boro' },
];

function firstLegal(s: GameState): Move {
  return legalMoves(s)[0];
}

describe('host transfer', () => {
  let bus: ReturnType<typeof makeBus>;
  let hostSess: Session;
  let clientSess: Session;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = makeBus();
    hostSess = createSession({
      net: bus.netFor('A'),
      mode: MODES.duel,
      seed: 42,
      players: PLAYERS,
      seat: 0,
      isHost: true,
      onChange: () => {},
    });
    clientSess = createSession({
      net: bus.netFor('B'),
      mode: MODES.duel,
      seed: 42,
      players: PLAYERS,
      seat: 1,
      isHost: false,
      onChange: () => {},
    });
  });

  it('starts both peers on an identical board from the shared seed', () => {
    expect([...clientSess.state().cells]).toEqual([...hostSess.state().cells]);
  });

  it('a CLIENT does not move the shared state by itself', () => {
    // Seat 1 is not on move, and even if it were, only the host commits.
    const before = clientSess.state().turnNo;
    clientSess.move(firstLegal(clientSess.state()));
    expect(clientSess.state().turnNo).toBe(before);
    expect(clientSess.isHost()).toBe(false);
  });

  it('the host drives, and the client follows', () => {
    hostSess.move(firstLegal(hostSess.state()));
    expect(hostSess.state().turnNo).toBe(1);
    expect(clientSess.state().turnNo).toBe(1);
    expect([...clientSess.state().cells]).toEqual([...hostSess.state().cells]);
  });

  it('PROMOTES the survivor, which then drives the sim to a real game over', () => {
    // The gate. Kill the host mid-round; the client is promoted and must be able
    // to finish the game rather than sit on a frozen board forever.
    hostSess.move(firstLegal(hostSess.state()));
    expect(clientSess.isHost()).toBe(false);

    bus.kill('A');
    bus.promote('B');
    // THE REAL ORDER net.ts fires these in: onPeerLeave FIRST (while we are still
    // a guest), THEN onHostChange. A test that called setHost first would hide
    // the bug where the vacated seat never gets a bot — which is exactly what
    // shipped past the unit test and was caught by the two-tab smoke test.
    clientSess.onPeerLeave();
    clientSess.setHost(true);

    expect(clientSess.isHost()).toBe(true);
    // Seat 0 is empty, so it goes to a bot — the round stays playable.
    expect(clientSess.players()[0].bot).toBe('normal');

    // Now let it run: the promoted peer's own timers drive the bot seat, and the
    // survivor plays its own. It must actually terminate.
    let guard = 0;
    while (!clientSess.state().finished && guard++ < 400) {
      if (clientSess.canMove()) clientSess.move(firstLegal(clientSess.state()));
      vi.advanceTimersByTime(700);
    }
    expect(clientSess.state().finished).toBe(true);
    expect(clientSess.state().turnNo).toBeGreaterThan(1);
  });

  it('reconciles the vacated seat when promoted AFTER the leave (the real order)', () => {
    // Pinned separately because the bug was purely one of ordering. net.ts calls
    // onPeerLeave before onHostChange; if reconcileSeats only ran from
    // onPeerLeave (guarded on `!host`) the departed seat would never get a bot,
    // and the promoted peer would wait on it forever.
    hostSess.move(firstLegal(hostSess.state()));
    bus.kill('A');
    bus.promote('B');

    clientSess.onPeerLeave(); // fires while B is still a guest — must be a no-op…
    expect(clientSess.players()[0].bot).toBeUndefined();
    clientSess.setHost(true); // …and promotion is what must reconcile the seat
    expect(clientSess.players()[0].bot).toBe('normal');
  });

  it('a promoted peer adopts its last snapshot as canonical, not a fresh board', () => {
    hostSess.move(firstLegal(hostSess.state()));
    hostSess.move(firstLegal(hostSess.state()));
    const seen = [...clientSess.state().cells];
    const turnNo = clientSess.state().turnNo;

    bus.kill('A');
    bus.promote('B');
    clientSess.setHost(true);

    // The position it was rendering IS the position. Regenerating from the seed
    // would silently rewind the round to move 0 on the survivor's screen.
    expect([...clientSess.state().cells]).toEqual(seen);
    expect(clientSess.state().turnNo).toBe(turnNo);
  });

  it('demotion stops the old host driving the sim', () => {
    // Both peers hosting is the failure this guards: net.ts converges two
    // claimants onto one, and the loser must stand down or they fight.
    hostSess.setHost(false);
    const before = hostSess.state().turnNo;
    vi.advanceTimersByTime(5000);
    expect(hostSess.state().turnNo).toBe(before);
  });

  it('a destroyed session stops answering the room', () => {
    hostSess.destroy();
    const before = clientSess.state().turnNo;
    vi.advanceTimersByTime(3000);
    expect(clientSess.state().turnNo).toBe(before);
  });
});

describe('solo needs no network at all', () => {
  it('plays a whole game against a bot with net: null', () => {
    vi.useFakeTimers();
    const sess = createSession({
      net: null,
      mode: MODES.blitz,
      seed: 7,
      players: [
        { id: 'me', name: 'You' },
        { id: 'bot', name: 'Bot', bot: 'normal' },
      ],
      seat: 0,
      isHost: true,
      onChange: () => {},
    });
    let guard = 0;
    while (!sess.state().finished && guard++ < 400) {
      if (sess.canMove()) sess.move(firstLegal(sess.state()));
      vi.advanceTimersByTime(700);
    }
    expect(sess.state().finished).toBe(true);
  });
});
