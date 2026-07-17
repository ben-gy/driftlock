# Game Plan: Driftlock

> **AMENDED AFTER THE BALANCE SIM.** This plan was written before a line of the
> game existed, and the sim then overruled three of its central claims. Rather
> than quietly rewrite history, the corrections are recorded here — the whole
> point of principle #18 is that the plan's confident story is the thing least to
> be trusted. See the comment above `tideRadius` in `src/game.ts` for the numbers.
>
> 1. **"First to 5 of 9 stones, so no draws."** DELETED. It made the game a race
>    where an early bank predicted the winner 76% of the time and the tide never
>    arrived (median 19 moves). Replaced by: the board empties and the highest
>    score wins, with stones worth more the later they land. Draws are now
>    possible but rare (measured 0.5%), and the plan should not have promised
>    otherwise.
> 2. **"The multi-stone tide haul is the product."** DELETED — it does not exist.
>    Measured 0% multi-hauls across 36 parameter combinations, then ~1% after a
>    rules fix. The Well is empty after every move, so at most one stone can enter
>    per shift; piles cannot form. No tuning could have rescued it. The joy metric
>    in the balance suite guards **lead changes** instead, which the game does have.
> 3. **"Deepwell is 7×7."** DELETED. 7×7 gives 3 tide rises, so one seat is on move
>    for two of them: measured a **33/67** seat split. Not tunable — the wrong
>    shape. Deepwell is 9×9 (4 rises, measured 50.8%).
>
> What survived intact: neutral stones, the shift-scores-the-mover rule, the lock,
> the tide as a pure function of the move number, and the odd tide period — the
> last of which turned out to be far more load-bearing than claimed (an even
> period measures a **95%** first-player win rate).

## Overview
- **Name:** Driftlock
- **Repo name:** driftlock
- **Tagline:** You never move a stone — you move the row it stands on, and whatever slides into the Well is yours.
- **Genre (directory category):** board

## Core Loop
A 5×5 board that wraps at every edge, nine neutral stones scattered on it, and one
Well at the dead centre. On your turn you pick a row or a column and shift it one
step. Everything standing on that line slides with it and wraps around the far
side. **Any stone that lands in the Well is banked — and it scores for whoever
made the shift, not for anyone who "owns" it.** Nobody owns anything. First to
five of the nine stones wins.

That single rule is what makes the game. You can never make a move that only
helps you: every shift rearranges the board your opponent is about to play on. So
the real move is never "can I score" — it's "can I score *without* leaving a stone
one step from the Well on a line they're allowed to touch". Which is where the
lock comes in: **the line you just shifted is locked, and your opponent cannot
shift it on their turn.** So you *can* leave a stone hanging, if the only line
that reaches it is the one you just froze. Setting up a stone that only you can
collect, on a line they can't unwind, is the game's best feeling.

- **Win:** bank 5 of the 9 stones. Five is a majority of nine, so the game cannot
  end in a shared result — someone always gets there.
- **Lose:** they get there first.
- **The tension:** every move you make is also a move you hand them.

### The tide (why the opening stays undecided and the endgame still resolves)
The Well is not a fixed target. It **rises**: it starts as the single centre cell
and every few moves it grows one step further along the centre row and centre
column, until at high tide the cross spans the whole board and *every* line runs
through it.

This is Hexbloom's lesson applied deliberately (factory principle #18): make the
early game small and the late game big. Early, the Well is a pinpoint — one cell,
reachable only by shifting the centre line, so a lucky opening layout cannot bank
anyone a lead. Late, the cross reaches every row and column, several stones can
land at once, and the game resolves hard. It costs **zero extra state**: the Well
is a pure function of the move number, so there is nothing for two peers to
disagree about.

`TIDE_EVERY` must be **odd**. It steps on the move count, and with 2 players an
even period would step on the same player's turn every time and hand them a
structural edge — the exact trap Hexbloom hit. Pinned by a test.

## Controls
- **Desktop:** click the arrow handle at the end of any row/column to shift it.
  Arrow keys move a line selector, Enter/Space shifts, `R` restarts, `Esc` pauses.
- **Mobile:** tap the arrow handles (≥44px). The board is DOM, so the handles are
  real buttons — no virtual D-pad needed, and no drag surface to fight the browser
  for. `patterns/input.ts` is therefore **not** copied; taps and keys are enough.

## Multiplayer
- **Mode:** live P2P (2 players) **and** async-seed (share a seed, same board, vs
  the same bot, compare stones) **and** solo vs bot. Solo-complete: the whole game
  is playable with nobody else on earth.
- **Players:** exactly 2. Deliberate. With neutral stones and a shift-scores-the-
  mover rule there is no start geometry to make unfair, but turn order in a 3-player
  abstract is precisely where Hexbloom's seats went 54/33/10. Two seats, measured.
- **Topology:** host-authoritative. The state is tiny (25 cells, a lock, two
  scores, a move number), so the host just broadcasts the whole thing.
- **Channels (≤12 bytes):** `mv` (client → host: a move `{r,c...}`), `snap`
  (host → all: the full game state), `rs`/`rv`/`rq` (rematch.ts).
- **Room entry:** `createRoomEntry` — **Create a room** or type a code. The invite
  link is a convenience, never the only way in. `?room=` is honoured once and
  cleared on the way out (`clearRoomInUrl`).
- **Late joiner:** a peer arriving mid-round gets the next `snap` and watches as a
  spectator, then plays the rematch. It never sees a frozen board.
- **Peer leaves:** the survivor is told, the round is awarded, and the results
  screen is reachable. Never a silent freeze.
- **If the HOST leaves:** `net.ts` promotes the survivor (incumbency; min-id only
  among survivors). `onHostChange` → `Session.setHost(true)`: the promoted peer
  adopts its last snapshot as canonical, re-broadcasts it, and resumes the
  host-only snapshot keepalive (`setInterval`, not rAF). The game keeps running
  and can still reach game-over. Covered by a unit test *and* the smoke test.

## End of round → rematch (MANDATORY, stated up front)
The room is joined **once** and held until the player goes back to the menu. A
rematch **never touches the Net** — no `leave()`, no re-join. `patterns/rematch.ts`
owns it: "Play again" is a vote plus a new round number; the host broadcasts the
new seed *and the frozen roster* so both peers index players identically.

- **While waiting:** the results screen shows who has accepted and a **visible
  countdown** (`state().startsInMs`). Never a silent "waiting…".
- **If one declines or closes the tab:** quorum + grace starts the round without
  them. They are dropped from the roster, not waited on forever. No deadlock.
- **If the host leaves on the results screen:** the promoted peer inherits no
  tally, `rq` re-polls the room, and it can run the rematch itself.
- **Persists across rounds:** a running **match tally** (rounds won), which is the
  reason to play a second one.
- **Also on the results screen:** back to lobby (which does *not* leave the room),
  and menu (which does).

## Everyone's result, every time (principle #9)
The summary is not a number. It shows, for **both** players: stones banked, the
biggest single haul (a multi-stone tide shift), moves taken, and the running match
tally. Driftlock has a knowable perfect answer, so it also shows **what you
missed**: the game logs, for every move, whether a bank was available and the
mover didn't take it — so the summary can say "you walked past 3 free stones; they
walked past 1". Every peer reaches this screen, including one whose round ended
because the other player vanished.

## Modes (3, genuine spread — the host's pick travels frozen in the round start)
| Mode | Board | Stones | Win | Tide | Why it plays differently |
|---|---|---|---|---|---|
| **Blitz** | 5×5 | 7 | 4 | every 3 | The Well floods almost immediately. Barely any manoeuvring — it's a knife fight over stones that are always nearly scoreable. |
| **Duel** | 5×5 | 9 | 5 | every 7 | The real game. A long pinpoint opening where the lock does the work, then the tide opens it up. |
| **Deepwell** | 7×7 | 13 | 7 | every 9 | Stones start up to 3 steps out and the tide takes forever to reach them. Long-range setup; a stone you push now pays off six moves later. |

`modeOf()` validates any id off the wire with `Object.hasOwn` — an unknown id
falls back to Duel rather than reaching the generator as `undefined` and producing
a board of size NaN. Guests render the host's **gossiped** choice
(`state().hostOpts`), never their own local pick relabelled.

## Countdown
3-2-1-GO with audio between the host's start arriving and the first legal move
(`src/countdown.ts`), counted locally on each peer from the start message and
cancelled on teardown.

## Turn-0 fairness
Stones are neutral, so there is no "starting territory" to equalise — but the
opening still has to be fair, and the check is different here: **the board is
generated so that no stone is one step from the Well at move 0**, i.e. the first
player cannot simply bank on move 1. Deterministic from the shared seed.
Regression-tested over many seeds.

## Balance (build the sim FIRST — it referees, my diagnosis will be wrong)
`tests/balance.test.ts`, written and baselined **before** any tuning:
- **P(leader at move N wins)** — flat and near chance early, spiking only late.
- **Seat win rate** — both seats within a few points of 50. `TIDE_EVERY` odd is
  the constant fairness depends on; it gets its own assertion at a sample size
  large enough to actually see the bug (Hexbloom's seat bug was invisible at 220
  games and obvious at 600).
- **Blowout rate** and **game length** — to catch a "fix" that just stalls forever.
- **Joy, not just the curve:** the multi-stone tide haul is the product. Assert big
  hauls still land, so a balance change can't quietly flatten the verb.

## Juice Plan
- Stones **slide** with an eased transform (FLIP), they don't teleport. The whole
  line moves together — that's the read.
- The wrapping stone fades out one edge and in the other, so wrap is legible.
- A banked stone: flash, scale-pop, particle burst in the scorer's colour, screen
  shake (scaled by haul size), `coin` on 1 and `powerup` on a multi-stone haul.
- The Well **pulses** on the move before the tide rises, and the new cells wash in.
- The locked line is visibly chained/dimmed with a lock glyph; it releases with a
  click (`blip`).
- Hover/focus previews the shift — a ghost of where every stone on that line lands,
  and the Well lights up **green if this shift banks** (never hidden information;
  it's perfect information anyway, and hiding it just taxes arithmetic).
- Sounds: `select` on line pick, `blip` on shift, `coin`/`powerup` on bank, `hit`
  on a wasted move, `win`/`lose` on game end. Mute persisted.
- `prefers-reduced-motion`: no shake, no particles, slides become instant.

## Style Direction
**Vibe:** clean-minimal, slightly cosmic — a tide pool at night.
**Palette (colour-blind-safe, never colour alone):** deep slate ground `#0b1220`,
board `#16213a`. Player 1 **amber** `#f0a04b`, Player 2 **teal** `#2ec4b6` — an
orange/teal pair separable under all three common CB types. Stones are bone
`#e8e6e3` and neutral until banked. Well is a violet `#8a7cff` glow. Scores carry
a **shape** as well as a colour (P1 ▲ / P2 ●) so nothing rests on hue.
**Theme:** dark.
**Reference feel:** the calm of a good abstract like Hive or Yinsh; the tactility
of a well-made sliding-tile toy.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite. No React — there are four screens.
- **Render:** **DOM/CSS**. It's a 5×5 grid of cells with real buttons for the
  handles: crisp text, free accessibility, trivial responsive layout, and CSS
  transforms give the slide for nothing. Canvas would buy nothing here.
- **Engine modules copied from patterns/:** net, rematch, lobby, rng, sound,
  storage, mobile (+ mobile.css), identity. **Not** loop (no continuous sim — it's
  turn-based; animation is CSS transitions) and **not** input (no D-pad; the
  handles are buttons).
- **Persistence:** localStorage via storage.ts — mute, name, mode, how-to-play
  seen, and a solo best (fewest moves to win per mode per difficulty).

## Non-Goals
- 3–4 players. Two seats, measured honestly, beats four seats nobody counted.
- Public room noticeboard. Private rooms only this run; the IP-exposure disclosure
  is a real cost and a 2-player invite game does not need a stranger list.
- A service worker. The bundle is already offline-capable and a stale cache would
  serve an old build.
- Online leaderboards, accounts, or anything with a server.

## How To Play (player-facing copy)
**Shift a row or a column one step — everything on it slides, and wraps around.**
Any stone that lands in the **Well** in the middle is yours. First to 5 of the 9
stones wins.
**You can't shift the line your opponent just shifted** — it's locked for one turn.
The Well **rises** as the game goes on, reaching further along the centre row and
column, so late stones come in fast.
