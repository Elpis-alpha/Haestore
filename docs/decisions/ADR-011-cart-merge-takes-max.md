# ADR-011 — A quantity collision on merge takes MAX, not SUM

**Status:** Accepted · 2026-09-11

## Context

A shopper fills a bag while signed out, then signs in. Their account already has a cart.
Both contain two bags of the same coffee. What should the merged cart hold?

There are only three defensible answers — 4 (SUM), 2 (MAX), or "ask" — and the choice is
not obvious, because it is a guess about intent made on incomplete information. The
evidence available at merge time is identical in both of the cases it has to separate:

- **One person, one device, one intent.** They added coffee, wandered off, came back and
  signed in. The guest cart and the account cart are the *same* shopping trip, recorded
  twice. They want 2.
- **One person, two devices.** Two on the laptop at work, three on the phone on the
  train. Two genuinely separate decisions. They want 5.

Nothing in the data distinguishes them. Timestamps do not: the two-device case and the
came-back-later case have the same shape.

## Decision

**MAX.** A line present in both carts takes the larger of the two quantities, and every
line that changed is named in a `mergeReport` the shopper is shown.

The report is not decoration — it is the other half of the decision. Both numbers are on
screen, so the two-device shopper who wanted 5 can see "quantity raised from 2 to 3" and
type 5. A seven-day tombstone backs an Undo for somebody who did not want the merge at
all.

## Why not SUM

Because the two errors are not symmetric, and the asymmetry is the whole argument.

**Undercounting is a shopper adding one more.** They see 2, they wanted 5, they type 5.
Ten seconds, no money moves, and the mistake is visible at exactly the moment they are
already looking at the bag.

**Overcounting is a shopper paying for four bags of coffee when they wanted two.** The
failure is silent: 4 is a perfectly plausible number, the cart is valid, nothing throws
and nothing logs. It is discovered at the payment screen by an attentive person, and
after delivery by everyone else. Then it is a refund, a return shipment, and a customer
who no longer trusts the totals on the site.

SUM is also wrong *more often*, because the same-device case dominates. Signing in on the
device you were already shopping on is the ordinary path; shopping on two devices in one
session is the exception.

## Why not ask

"You had 2 here and 3 there — which did you mean?" is the most correct answer and the
worst one to ship. It puts a modal dialogue between a person and the thing they were
doing, at the exact moment they have just proved their identity and expect to continue.
It has to be answered per line, so a five-line collision is five questions. And it cannot
be skipped, because there is no default — which is to say it is a MAX or a SUM with extra
steps and a worse mood.

The report is the same information, delivered after the fact, skippable, and costing
nothing to ignore.

## Consequences

- `mergeCarts` in `back-end/src/modules/cart/merge.ts` is a **pure function**, tested
  across every branch — collision, missing variant, price drift, stock clamp, out of
  stock — because a merge that is wrong produces a valid cart and no error.
- The merge always adopts the **current** price and never the snapshot, so a drift is
  reported rather than honoured.
- An out-of-stock line moves to `savedForLater` rather than being deleted: somebody put
  it there on purpose and the shop may restock.
- The claim step (`active → merging` in one guarded `findOneAndUpdate`) makes a replayed
  merge a no-op. Without it, MAX is not idempotent under a double delivery — two merges
  of the same guest cart would each raise the quantity again.

## What would change this

Real order data. If returns and support tickets showed that under-counting after a merge
was costing more than the theoretical over-counting, the answer would be to make the
report louder — a pre-filled "did you mean 5?" — rather than to switch to SUM. The
asymmetry between a visible error and a silent one does not change with volume.
