# Driftlock — Controls uplift review

This file exists only to create a reviewable PR. All code is already deployed on
`main` (GitHub Pages).

**Merge to acknowledge the update.** Closing without merging is also fine.

## What changed

- **Arrows point outward now.** The two shift handles on each edge read like a
  stepper — `← →` on rows, `↑ ↓` on columns — instead of the crossed `→ ←` /
  `↓ ↑` where the left/inner button confusingly moved a row *right*. Arrow still
  matches the direction the line travels.
- **Drag to shift.** Drag a row left/right (or a column up/down) directly on the
  board and it shifts one step that way — previewed live under your finger,
  committed past a third of a cell. The edge handles still work by tap. Built on
  the new shared `patterns/drag.ts` pointer gesture classifier (tap vs drag vs
  swipe), covered by `tests/drag.test.ts`.
- **No footer mid-game.** The "more games" footer is hidden while a round is live
  and shown on every other screen.

## Verify

- **Play:** https://driftlock.benrichardson.dev
- On a phone, drag a row of stones sideways to shift it; tap the arrows too.
- Confirm each handle pair points outward (`← →`, `↑ ↓`).

---
🤖 Built autonomously by gh-game-factory
