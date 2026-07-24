// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * main.ts — bootstrap and screens. Owns no game rules and no protocol.
 *
 * The shape that matters here is the ROOM LIFECYCLE, because it is where this
 * factory's games keep breaking:
 *
 *   · The Net is created ONCE per room and held until the player goes back to
 *     the menu. A rematch never touches it (see engine/rematch.ts). Leaving and
 *     rejoining to "reset" hands back a dying room object, the mesh never forms,
 *     and both peers sit alone believing they are the host.
 *   · `?room=` is honoured ONCE per page load and cleared on the way out, or a
 *     reload drags the player back into a room they left forever.
 *   · Only the peer that MINTED the code passes claimHost. A typed code or a link
 *     joins as a guest and waits to be told who is in charge.
 */

import './styles/mobile.css';
import './styles/main.css';

import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createSfx } from '@ben-gy/game-engine/sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { resolveName } from '@ben-gy/game-engine/identity';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type Rounds, type RoundPlayer } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  mintCode,
  normalizeRoomCode,
  setRoomInUrl,
} from '@ben-gy/game-engine/lobby';
import { createBoard, type BoardView } from './board';
import { createCountdown, type Countdown } from './countdown';
import { createSession, type Session, type SessionPlayer } from './session';
import { stoneValue, tideRadius, type Difficulty, type GameState, type Move } from './game';
import { DEFAULT_MODE, MODE_LIST, modeOf, type Mode, type ModeId } from './modes';

const APP_ID = 'driftlock';
/**
 * The signaling namespace. NEVER the bare slug: roomAppId folds the engine's
 * protocol revision in, so a player on a stale cached build lands in a room
 * where they simply never see anyone rather than half-connecting and desyncing.
 */
const ROOM_APP_ID = roomAppId(APP_ID);
const MAX_PLAYERS = 2;

/**
 * TURN credentials, fetched once at boot — not lazily on the join path.
 *
 * Trystero builds ONE global pool of peer connections from whichever joinRoom
 * fires first on the page and draws every later room's outbound offers from it,
 * so a config that arrives after the first mesh leaves the initiating half of
 * every pair STUN-only — TURN working in one direction for about half of all
 * pairs, which is far harder to diagnose than having none. Starting the fetch
 * here and awaiting it before createNet means the first mesh already carries it.
 * getTurnConfig never rejects (it fails open to STUN-only), so this can never
 * block or break a join.
 */
const turnReady: Promise<void> = getTurnConfig().then(setTurnConfig);

const app = document.getElementById('app')!;
const store = createStore(APP_ID);
const sfx = createSfx(store.get('muted', false));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

hardenViewport();

let playerName = resolveName(store, () => `Player ${Math.floor(Math.random() * 900 + 100)}`);

// ── room lifecycle state (see the header) ───────────────────────────────────
let net: Net | null = null;
let rounds: Rounds | null = null;
let session: Session | null = null;
let board: BoardView | null = null;
let countdown: Countdown | null = null;
let roomCode = '';
let iMintedIt = false;
/** The deep link is a one-shot. Consumed at boot, never read again. */
let pendingDeepLink: string | null = null;
let mode: ModeId = validMode(store.get<string>('mode', DEFAULT_MODE));
let difficulty: Difficulty = validDifficulty(store.get<string>('difficulty', 'normal'));
/** Rounds won, kept across rematches. The reason to play a second one. */
const tally = new Map<string, number>();

function validMode(id: string): ModeId {
  return modeOf(id).id;
}
function validDifficulty(d: string): Difficulty {
  return d === 'easy' || d === 'hard' ? d : 'normal';
}

{
  const url = new URL(location.href);
  const room = url.searchParams.get('room');
  if (room) pendingDeepLink = normalizeRoomCode(room);
}

// ── helpers ─────────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const FOOTER = `<footer class="site-footer">
  Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
  · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
</footer>`;

function seatMark(seat: number): string {
  return `<span class="seat-mark seat-${seat}" aria-hidden="true">${seat === 0 ? '▲' : '●'}</span>`;
}

/** Every user gesture is a chance to unlock audio; browsers block it until one. */
function unlock(): void {
  try {
    sfx.unlock();
  } catch {
    /* audio is a nicety, never a blocker */
  }
}
document.addEventListener('pointerdown', unlock, { once: true });
document.addEventListener('keydown', unlock, { once: true });

function play(name: Parameters<typeof sfx.play>[0]): void {
  try {
    sfx.play(name);
  } catch {
    /* ignore */
  }
}

/** Tear the round down without touching the room. */
function endSession(): void {
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
  board?.destroy();
  board = null;
}

/** Leave the room entirely. The ONLY place net.leave() is called. */
async function leaveRoom(): Promise<void> {
  endSession();
  rounds?.destroy();
  rounds = null;
  const n = net;
  net = null;
  roomCode = '';
  iMintedIt = false;
  tally.clear();
  clearRoomInUrl(); // or a reload drops us straight back in here
  try {
    await n?.leave();
  } catch {
    /* already gone */
  }
}

window.addEventListener('beforeunload', () => {
  void net?.leave();
});

// ── screens ─────────────────────────────────────────────────────────────────

function screen(html: string, cls = ''): HTMLElement {
  // Every screen shows the footer EXCEPT a live round, which re-adds `playing`.
  document.body.classList.remove('playing');
  app.innerHTML = `<main class="main-content ${cls}">${html}</main>${FOOTER}`;
  return app.querySelector('.main-content')!;
}

function showMenu(): void {
  void leaveRoom();
  const el = screen(`
    <div class="screen">
      <h1 class="title">Driftlock</h1>
      <p class="tagline">You never move a stone. You move the row it stands on.</p>
      <div class="btn-row">
        <button class="btn primary" id="solo">Play solo</button>
        <button class="btn" id="friends">Play with friends</button>
      </div>
      ${modePicker(mode, false)}
      <div class="btn-row">
        <label class="seg" aria-label="Bot difficulty">
          ${(['easy', 'normal', 'hard'] as Difficulty[])
            .map(
              (d) =>
                `<button class="btn ghost diff${d === difficulty ? ' is-on' : ''}" data-diff="${d}">${d}</button>`,
            )
            .join('')}
        </label>
      </div>
      <div class="btn-row">
        <button class="btn ghost" id="howto">How to play</button>
        <button class="btn ghost" id="about">About</button>
        <button class="btn ghost" id="mute">${sfx.muted() ? 'Unmute' : 'Mute'}</button>
      </div>
    </div>`);

  el.querySelector('#solo')?.addEventListener('click', () => startSolo());
  el.querySelector('#friends')?.addEventListener('click', () => showRoomEntry());
  el.querySelector('#howto')?.addEventListener('click', () => showHowTo());
  el.querySelector('#about')?.addEventListener('click', () => showAbout());
  el.querySelector('#mute')?.addEventListener('click', (e) => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    (e.target as HTMLElement).textContent = sfx.muted() ? 'Unmute' : 'Mute';
  });
  wireModePicker(el, (m) => {
    mode = m;
    store.set('mode', m);
    showMenu();
  });
  for (const b of el.querySelectorAll<HTMLElement>('.diff')) {
    b.addEventListener('click', () => {
      difficulty = validDifficulty(b.dataset.diff ?? 'normal');
      store.set('difficulty', difficulty);
      showMenu();
    });
  }

  if (!store.get('seenHowTo', false)) showHowTo();
}

function modePicker(current: ModeId, disabled: boolean): string {
  return `<div class="mode-list" role="group" aria-label="Mode">
    ${MODE_LIST.map(
      (m) => `<button class="mode${m.id === current ? ' is-on' : ''}" data-mode="${m.id}" ${disabled ? 'disabled' : ''}>
        <span class="mode-name">${esc(m.name)}</span>
        <span class="mode-blurb">${esc(m.blurb)}</span>
      </button>`,
    ).join('')}
  </div>`;
}

function wireModePicker(el: HTMLElement, onPick: (m: ModeId) => void): void {
  for (const b of el.querySelectorAll<HTMLElement>('.mode')) {
    b.addEventListener('click', () => {
      const id = b.dataset.mode;
      if (id) onPick(validMode(id));
    });
  }
}

function showHowTo(): void {
  store.set('seenHowTo', true);
  modal(
    'How to play',
    `<p><strong>Shift a row or a column one step</strong> with the arrows around the board.
     Everything standing on that line slides with it, and wraps around the far side.</p>
     <p>Any stone that lands in the <strong>Well</strong> in the middle is yours — stones belong to
     nobody until someone banks them, so it scores for whoever made the shift.</p>
     <p><strong>You can't shift the line your opponent just shifted.</strong> It's locked for one turn.
     So the game is really about leaving them nothing to take.</p>
     <p>The Well <strong>rises</strong> as the game goes on, reaching further along the centre row and
     column — and stones are worth more the later they land. An early lead is not a won game.</p>
     <p>When the board is empty, the highest score wins.</p>`,
  );
}

function showAbout(): void {
  modal(
    'About',
    `<p><strong>Driftlock</strong> is an original abstract board game. No accounts, no cookies,
     no tracking, no third-party fonts. Everything you hear is generated in the browser.</p>
     <p>Playing with friends is <strong>peer-to-peer</strong> — the game runs directly between your
     browsers, with no server of ours in the middle. Connecting uses a free public signaling relay
     purely to introduce the two browsers to each other; nothing about your game is stored anywhere.</p>
     <p>Page views are counted anonymously with Cloudflare Web Analytics, which sets no cookies.</p>
     <p>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.</p>`,
  );
}

function modal(title: string, body: string): void {
  const el = document.createElement('div');
  el.className = 'modal';
  el.innerHTML = `<div class="modal-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>${body}
      <button class="btn primary modal-close">Got it</button>
    </div>`;
  const close = (): void => el.remove();
  el.querySelector('.modal-close')?.addEventListener('click', close);
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  });
  document.body.appendChild(el);
  el.querySelector<HTMLElement>('.modal-close')?.focus();
}

// ── solo ────────────────────────────────────────────────────────────────────

function startSolo(): void {
  endSession();
  const m = modeOf(mode);
  beginRound({
    mode: m,
    seed: (Math.random() * 0xffffffff) >>> 0,
    players: [
      { id: 'you', name: 'You' },
      { id: 'bot', name: `Bot (${difficulty})`, bot: difficulty },
    ],
    seat: 0,
    isHost: true,
    net: null,
  });
}

// ── rooms ───────────────────────────────────────────────────────────────────

function showRoomEntry(): void {
  const el = screen('<div class="screen"><div id="entry"></div></div>');
  createRoomEntry({
    container: el.querySelector('#entry')!,
    onSubmit: (code, created) => void joinRoom(code, created),
    onCancel: () => showMenu(),
    subtitle: 'Start a new room, or enter a code to join a friend. Two players.',
  });
}

async function joinRoom(code: string, created: boolean): Promise<void> {
  await leaveRoom();
  // The boot fetch is almost always already resolved by the time anyone taps a
  // room; this only ever waits when a deep link opens straight into one.
  await turnReady;
  roomCode = normalizeRoomCode(code) || mintCode();
  iMintedIt = created;
  setRoomInUrl(roomCode);

  net = createNet(
    // claimHost ONLY for the peer that minted the code. A guest that claims races
    // the incumbent for a room it holds none of the state for.
    { appId: ROOM_APP_ID, roomId: roomCode, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => session?.setHost(isSelfHost),
      onPeerLeave: () => session?.onPeerLeave(),
      onPeers: () => {},
    },
  );

  rounds = createRounds({
    net,
    playerName,
    minPlayers: 2,
    // The host's mode travels frozen inside the round start. A guest reading its
    // own picker and calling it the host's choice is a confident lie — and since
    // a mode changes the BOARD SIZE here, it would be two different games.
    roundOpts: () => ({ mode }),
    onRound: (info) => {
      const opts = (info.opts ?? {}) as { mode?: unknown };
      startNetRound(info.round, info.seed, info.players, modeOf(opts.mode), info.isHost);
    },
  });

  showLobby();
}

function showLobby(): void {
  endSession();
  if (!net || !rounds) return showMenu();
  const el = screen(`<div class="screen">
      <div id="lobby"></div>
      ${iMintedIt ? '<div id="lobbymode"></div>' : '<p class="res-note" id="guestmode"></p>'}
    </div>`);

  createLobby({
    container: el.querySelector('#lobby')!,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: MAX_PLAYERS,
    onCancel: () => showMenu(),
  });

  const modeHost = el.querySelector<HTMLElement>('#lobbymode');
  if (modeHost) {
    modeHost.innerHTML = modePicker(mode, false);
    wireModePicker(modeHost, (m) => {
      mode = m;
      store.set('mode', m);
      showLobby();
    });
  }

  // A guest renders the HOST's gossiped choice, never its own.
  const guestMode = el.querySelector<HTMLElement>('#guestmode');
  if (guestMode) {
    const paint = (): void => {
      const opts = rounds?.state().hostOpts as { mode?: unknown } | null;
      guestMode.textContent = opts
        ? `The host has picked ${modeOf(opts.mode).name}.`
        : 'Waiting to hear what the host has picked…';
    };
    paint();
    const poll = setInterval(() => {
      if (!document.body.contains(guestMode)) return clearInterval(poll);
      paint();
    }, 600);
  }
}

function startNetRound(
  round: number,
  seed: number,
  players: RoundPlayer[],
  m: Mode,
  isHost: boolean,
): void {
  endSession();
  const seat = players.findIndex((p) => p.id === net?.selfId);
  beginRound({
    mode: m,
    seed,
    players: players.map((p) => ({ id: p.id, name: p.name })),
    seat, // -1 for a peer that joined after the start: a spectator, not a freeze
    isHost,
    net,
    round,
  });
}

// ── the round ───────────────────────────────────────────────────────────────

interface RoundArgs {
  mode: Mode;
  seed: number;
  players: SessionPlayer[];
  seat: number;
  isHost: boolean;
  net: Net | null;
  round?: number;
}

function beginRound(args: RoundArgs): void {
  const el = screen(
    `<div class="screen wide">
       <div class="hud" id="hud"></div>
       <div id="boardhost"></div>
       <p class="res-note" id="msg" role="status" aria-live="polite"></p>
       <div class="btn-row">
         <button class="btn ghost" id="quit">${args.net ? 'Back to lobby' : 'Menu'}</button>
         ${args.net ? '' : '<button class="btn ghost" id="restart">Restart</button>'}
         <button class="btn ghost" id="help">How to play</button>
       </div>
     </div>`,
    'in-game',
  );
  document.body.classList.add('playing'); // hide the footer while the round is live

  const msg = el.querySelector<HTMLElement>('#msg')!;
  const hud = el.querySelector<HTMLElement>('#hud')!;

  board = createBoard(
    el.querySelector<HTMLElement>('#boardhost')!,
    args.mode.size,
    {
      onShift: (mv) => tryMove(mv),
      onPreview: (mv) => session && board?.preview(session.state(), mv),
    },
    reducedMotion,
  );

  let busy = false;
  const queue: (() => Promise<void>)[] = [];

  session = createSession({
    net: args.net,
    mode: args.mode,
    seed: args.seed,
    players: args.players,
    seat: args.seat,
    isHost: args.isHost,
    onSeatVacated: (_seat, name) => {
      msg.textContent = `${name} left — a bot took their seat so you can finish.`;
      play('hit');
    },
    onChange: (s, anim) => {
      if (anim) {
        // Serialise animations: two moves landing inside one slide would race the
        // stone elements and leave the board showing a position that never was.
        queue.push(async () => {
          await board?.animate(anim.mv, anim.moved, anim.banked, s);
          if (anim.banked.length) play(anim.banked.length > 1 ? 'powerup' : 'coin');
          else play('blip');
          paint(s);
        });
        void drain();
      } else {
        board?.render(s);
        paint(s);
      }
    },
  });

  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    while (queue.length) await queue.shift()!();
    busy = false;
    const s = session?.state();
    if (s?.finished) showResults(s);
  }

  function tryMove(mv: Move): void {
    if (!session?.canMove() || busy) return;
    play('select');
    session.move(mv);
  }

  function paint(s: GameState): void {
    const radius = tideRadius(s.turnNo, s.opts, s.size);
    const nextIn = s.opts.tideEvery - (s.turnNo % s.opts.tideEvery);
    const rising = radius < s.opts.tideMax;
    hud.innerHTML = `
      ${args.players
        .map((p, i) => {
          const bot = session?.players()[i]?.bot;
          return `<div class="hud-player seat-${i}${s.turn === i && !s.finished ? ' is-turn' : ''}">
            ${seatMark(i)}
            <span class="hud-name">${esc(p.name)}${bot && !p.bot ? ' (bot)' : ''}${i === args.seat ? ' (you)' : ''}</span>
            <span class="hud-score">${s.scores[i]}</span>
          </div>`;
        })
        .join('')}
      <div class="hud-tide">
        <span class="hud-worth">Stones worth ×${stoneValue(radius)}</span>
        <span class="tide-pips" aria-label="Tide ${radius} of ${s.opts.tideMax}">${Array.from(
          { length: s.opts.tideMax },
          (_, i) => `<span class="pip${i < radius ? ' on' : ''}"></span>`,
        ).join('')}</span>
        <span class="hud-next">${rising ? `tide rises in ${nextIn}` : 'high tide'}</span>
      </div>`;

    board?.setInteractive(!!session?.canMove());
    if (s.finished) msg.textContent = '';
    else if (args.seat < 0) msg.textContent = 'Watching this round — you can play the next one.';
    else if (session?.canMove()) msg.textContent = '';
    else msg.textContent = `Waiting for ${esc(args.players[s.turn]?.name ?? 'the other player')}…`;
  }

  el.querySelector('#quit')?.addEventListener('click', () => {
    if (args.net) {
      rounds?.finish();
      showLobby();
    } else showMenu();
  });
  el.querySelector('#restart')?.addEventListener('click', () => startSolo());
  el.querySelector('#help')?.addEventListener('click', () => showHowTo());

  // Keyboard: the handles are real buttons, so Tab/Enter already work. R restarts.
  const onKey = (e: KeyboardEvent): void => {
    if (!document.body.contains(el)) return document.removeEventListener('keydown', onKey);
    if (e.key.toLowerCase() === 'r' && !args.net) startSolo();
  };
  document.addEventListener('keydown', onKey);

  board.render(session.state());
  paint(session.state());

  // Count everyone in. Nobody moves until GO, so whoever happened to be looking
  // at the screen when the round fired gets no free read of the position.
  board.setInteractive(false);
  countdown = createCountdown({
    root: el,
    sfx,
    reducedMotion,
    onDone: () => {
      countdown = null;
      if (session) paint(session.state());
    },
  });
}

// ── results ─────────────────────────────────────────────────────────────────

function showResults(s: GameState): void {
  const sess = session;
  if (!sess) return;
  const ps = sess.players();
  const you = seatOf(sess);
  play(s.winner < 0 ? 'blip' : s.winner === you ? 'win' : 'lose');
  if (s.winner >= 0) {
    const key = ps[s.winner]?.id ?? String(s.winner);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  const el = document.createElement('div');
  el.className = 'modal';
  el.innerHTML = `<div class="modal-panel results" role="dialog" aria-modal="true">
      <h2 class="res-title">${
        s.winner < 0 ? 'A draw' : s.winner === you ? 'You win' : `${esc(ps[s.winner]?.name ?? 'They')} win${ps[s.winner]?.name ? 's' : ''}`
      }</h2>
      <div class="res-table">
        ${ps
          .map(
            (p, i) => `<div class="res-row${i === you ? ' is-you' : ''}">
              <span class="res-cell">${seatMark(i)} ${esc(p.name)}</span>
              <span class="res-cell"><b>${s.scores[i]}</b> pts</span>
              <span class="res-cell">${s.missed[i]} walked past</span>
              <span class="res-cell">${tally.get(p.id) ?? 0} won</span>
            </div>`,
          )
          .join('')}
      </div>
      <p class="res-note">${summaryNote(s, you)}</p>
      <div class="btn-row" id="resactions"></div>
      <p class="res-wait" id="reswait"></p>
    </div>`;
  document.body.appendChild(el);

  const actions = el.querySelector<HTMLElement>('#resactions')!;
  const wait = el.querySelector<HTMLElement>('#reswait')!;

  if (net && rounds) {
    rounds.finish();
    actions.innerHTML = `
      <button class="btn primary" id="again">Play again</button>
      <button class="btn ghost" id="tolobby">Back to lobby</button>
      <button class="btn ghost" id="tomenu">Menu</button>`;
    el.querySelector('#again')?.addEventListener('click', () => {
      rounds?.vote();
      (el.querySelector('#again') as HTMLButtonElement).disabled = true;
    });
    el.querySelector('#tolobby')?.addEventListener('click', () => {
      el.remove();
      showLobby(); // does NOT leave the room
    });
    el.querySelector('#tomenu')?.addEventListener('click', () => {
      el.remove();
      showMenu();
    });

    // The waiting state must always say what it is waiting for and when it ends.
    const poll = setInterval(() => {
      if (!document.body.contains(el)) return clearInterval(poll);
      const st = rounds?.state();
      if (!st) return;
      if (st.phase === 'playing') {
        el.remove();
        return clearInterval(poll);
      }
      const others = st.present.length - 1;
      const yes = st.votes.length;
      wait.textContent = st.startsInMs
        ? `Starting in ${Math.ceil(st.startsInMs / 1000)}s…`
        : st.voted
          ? others > 0
            ? `Waiting for ${others} other player${others === 1 ? '' : 's'} to accept…`
            : 'Waiting for another player to join…'
          : yes > 0
            ? `${yes} ready. Hit Play again to join them.`
            : '';
    }, 300);
  } else {
    actions.innerHTML = `
      <button class="btn primary" id="again">Play again</button>
      <button class="btn ghost" id="tomenu">Menu</button>`;
    el.querySelector('#again')?.addEventListener('click', () => {
      el.remove();
      startSolo();
    });
    el.querySelector('#tomenu')?.addEventListener('click', () => {
      el.remove();
      showMenu();
    });
  }
}

function seatOf(sess: Session): number {
  const id = net?.selfId ?? 'you';
  const i = sess.players().findIndex((p) => p.id === id);
  return i >= 0 ? i : 0;
}

/**
 * What everyone missed. Driftlock has a knowable perfect answer on every turn —
 * a bank was either on offer or it wasn't — so the summary can say more than a
 * score. A summary that only reflects you back at yourself wastes the one moment
 * players compare themselves.
 */
function summaryNote(s: GameState, you: number): string {
  const them = 1 - you;
  const mine = s.missed[you];
  const theirs = s.missed[them];
  const bits: string[] = [];
  if (mine || theirs) {
    bits.push(
      `You walked past ${mine} free stone${mine === 1 ? '' : 's'}; they walked past ${theirs}.`,
    );
  }
  if (s.turnNo >= s.opts.maxMoves) bits.push('Move limit reached — neither of you would commit.');
  bits.push(`${s.turnNo} moves.`);
  return bits.join(' ');
}

// ── boot ────────────────────────────────────────────────────────────────────

// A deep link is honoured ONCE, then forgotten: from here on "Play with friends"
// always offers create-or-join rather than teleporting into a stale room.
if (pendingDeepLink) {
  const code = pendingDeepLink;
  pendingDeepLink = null;
  void joinRoom(code, false); // arriving by link is joining, never claiming
} else {
  showMenu();
}
