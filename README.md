# Driftlock

**You never move a stone — you move the row it stands on, and whatever slides into the Well is yours.**

🎮 Play: https://driftlock.benrichardson.dev

## What it is

Driftlock is an original abstract board game for one or two players. The board is
a 5×5 grid that wraps at every edge, with nine bone-coloured stones scattered on
it and a violet **Well** at the dead centre. On your turn you shift a row or a
column one step. Everything standing on that line slides with it and wraps around
the far side. You never touch a stone directly — you move the ground underneath it.

Any stone that lands in the Well is banked, and here is the rule the whole game
hangs on: **it scores for whoever made the shift.** Stones belong to nobody. That
means you can never make a move that only helps you — every shift rearranges the
board your opponent is about to play on, and the question is never "can I score"
but "can I score *without* leaving a stone one step from the Well on a line they
are allowed to touch". Which is where the lock comes in: **the line you just
shifted is locked, and your opponent cannot shift it on their turn.** So you can
leave a stone hanging, if the only line that reaches it is the one you just froze.
Setting up a stone that only you can collect is the game's best feeling.

The Well is not a fixed target. It **rises**: it starts as a single cell and grows
along the centre row and column as the game goes on, until at high tide the cross
spans the whole board. Stones are worth more the later they land — one point at
low tide, three at high. An early lead is not a won game. When the board is empty,
the highest score wins.

Play it solo against a bot in three difficulties, or share a room code with a
friend and play it live in the browser with no server in the middle.

## How to play

- **Goal:** have the most points when the last stone is banked.
- **Desktop:** click the arrow handles around the board's edge to shift that row or
  column. Everything is a real button, so Tab and Enter work too. `R` restarts a
  solo game.
- **Mobile:** tap the same handles. There is no dragging and nothing to aim.
- **The lock:** you cannot shift the line your opponent just shifted.
- **The tide:** watch the pip meter — when the tide rises, the Well reaches further
  and every stone gets more valuable.

## Modes

| Mode | Board | Stones | Feel |
|---|---|---|---|
| **Blitz** | 5×5 | 5 | Sparse. Every stone matters and the lock decides everything. |
| **Duel** | 5×5 | 9 | The real game — a crowded board and a long, tight opening. |
| **Deepwell** | 9×9 | 17 | Four tides. Push a stone now, collect it four moves from now. |

The host's pick is what the room plays, and it travels frozen inside the round
start — a mode here changes the board size, so two peers reading their own setting
would be playing different games on the same seed.

## Multiplayer

Live **peer-to-peer** for 2 players. Create a room and share the 4-character code
(or the invite link — but a friend can always just *type* the code). The game runs
directly between the two browsers over WebRTC; there is no game server, and no
state of yours is stored anywhere. A free public signaling relay is used purely to
introduce the two browsers to each other during connection.

If the host leaves, the remaining player is promoted automatically and a bot takes
the empty seat, so the round stays playable and can still finish. Rounds are held
inside one living room — "Play again" never rejoins, so the mesh never dies — and a
running match tally persists across them.

## Balance

Every constant in `src/modes.ts` was measured by `tests/balance.test.ts`, which
plays a few hundred seeded bot-vs-bot games and asserts on the *shape* of the
result rather than on vibes. It overruled the design repeatedly — see the comment
above `tideRadius` in `src/game.ts` for the list of confident stories it killed.
The measured Duel: leader at move 8 wins **51.9%** (a coin flip), rising to 80% by
move 16; seats **49.1 / 50.5**; no blowouts.

Two constants are load-bearing for fairness and are pinned with their
counterfactuals, because a rule without a measurement is folklore:

- **The tide period must be odd.** A rise lands on whoever is on move, so an even
  period puts every rise on the first player's turn — measured **95%** first-player
  wins.
- **The number of rises must be even**, so each seat is on move for half of them.
  That is `floor(size/2)`, which is why there is no 7×7 mode: it wants 3 rises and
  measured a 33/67 seat split. It also has to reach the board's edge, or stones
  hide in lines that never go live and the game never ends.

## Tech

- Vite 6 + vanilla TypeScript
- DOM/CSS rendering — it's a grid of cells and real buttons, so focus, hit targets
  and screen-reader labels come for free, and CSS transforms do the sliding
- Shared engine: P2P netcode (Trystero), one-room rematch protocol, seeded RNG,
  procedural audio, mobile hardening
- Vitest for the rules, the balance sim, P2P-sync determinism, host transfer, and
  the room lifecycle
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts, no service worker. Anonymous,
cookie-less page-view counts via Cloudflare Web Analytics.

## Accessibility

Colour-blind-safe amber/teal, and player identity always carries a **shape** (▲/●)
as well as a colour. Full keyboard play, ≥44px tap targets, `prefers-reduced-motion`
respected (stones snap instead of sliding), and the board is real focusable DOM
rather than a canvas.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## License

MIT
