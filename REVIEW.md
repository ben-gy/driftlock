# Driftlock — Build Review

This file exists only to create a reviewable PR. All code is already deployed on `main`.

**Merge to acknowledge the build.** Closing without merging is also fine.

## Links
- **Play:** https://driftlock.benrichardson.dev
- **GitHub Pages:** https://ben-gy.github.io/driftlock/ *(redirects to the custom domain)*

## What it is
An original 2-player abstract board game. You never touch a stone — you shift the
whole row or column it stands on, everything on that line slides and wraps, and any
stone that lands in the central **Well** banks for whoever made the shift (stones
are neutral). The line you just shifted is locked for your opponent's next turn.
The Well rises as the game goes on and late stones are worth more, so an early lead
is not a won game. Solo vs bots, live P2P for 2, and async seed-share.

## The balance sim ran the design
`tests/balance.test.ts` was written before any tuning and overruled the design
three times (see the tide comment in `src/game.ts`): the "pinpoint opening" was
actually a tempo race (leader@3 won 76%), the "multi-stone haul" is structurally
impossible (0% at every setting), and 7×7 is unfair by construction (33/67 seats).
Final measured Duel: leader@move-8 **51.9%**, seats **49.1/50.5**, 0% blowouts.

## Bugs the two-tab smoke test caught (all fixed, all with regression tests)
- **Stones piled in the corner** for a peer whose tab was backgrounded when the
  round started (hidden tab → `clientWidth` 0). Fixed with a deferred reflow.
- **Host transfer left the vacated seat botless**, so the promoted peer waited on
  the departed host forever. net.ts fires `onPeerLeave` before `onHostChange`;
  the reconcile now runs on promotion too. The two host/board fixes are
  mutation-tested.
- Three mobile/CSS fixes (clipped tide meter, floating modal button, invisible
  difficulty selection, handles announced-as-enabled during the countdown).
