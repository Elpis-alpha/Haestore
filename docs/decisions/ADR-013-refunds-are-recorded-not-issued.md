# ADR-013 — The console records refunds; it does not issue them

**Status:** Accepted · 2026-09-14

## Context

Phase 8 put the order state machine behind buttons. The machine has two ways to end a
paid order — `paid → canceled` and `→ refunded` — and both mean money should go back to
the shopper.

The obvious console has one button, "Refund", that calls the provider, waits for the
money to move, and marks the order refunded. It is what every hosted shop does.

What that button would actually need:

- **A fourth kind of Stripe call and a sixth kind of PayPal call** — `POST /v1/refunds`,
  and `POST /v2/payments/captures/{id}/refund`. [ADR-012](ADR-012-no-payment-sdks.md)
  chose `fetch` over the SDKs on the explicit condition that the integration stays at
  three and five operations, and says to reverse itself "the moment either integration
  needs a fourth kind of operation".
- **Its own idempotency story.** A refund is money leaving. A double-click, a retry after a
  timeout or a replayed request must refund once, which means a deterministic provider
  idempotency key, a record of the attempt before the call, and reconciliation for the
  call whose response was lost. That is the checkout's four guards again, pointed the
  other way.
- **Partial refunds**, which the order model has no shape for — `refunded` is one terminal
  status, and "£6 of £32 back for a chipped mug" is not a status.
- **Webhook handling** for `charge.refunded` and PayPal's `PAYMENT.CAPTURE.REFUNDED`, so a
  refund issued from the provider's dashboard is not invisible to the shop.

None of that is hard. All of it is load-bearing, and all of it is the path where a bug
sends money to the wrong place.

## Decision

**The console records a refund; the refund itself is issued in the provider's dashboard.**

- *Record a refund* moves an order to `refunded` through the same guarded transition as
  everything else, **requires a note** — where the money went, a provider reference — and
  is behind step-up because `refunded` is terminal. If the order still holds reserved
  stock (it was paid but never shipped), the stock goes back on the shelf, once, through
  the same `stockReserved` claim the sweeper uses.
- **Cancel is offered only before money has moved.** The machine allows `paid → canceled`,
  and the console narrows it in the query filter (`ADMIN_CANCELABLE_FROM`) rather than in
  an `if`. A paid order that should not ship is refunded, which says what it is; a
  "cancel" that released the stock and kept the money would be the worst button in the
  shop.
- The dialog says, in bold, that the button does not send money back.

## What we give up

- **Two steps where there could be one.** An admin refunds in Stripe, then records it here.
  Forgetting the second step leaves an order marked paid that has been refunded — visible,
  and fixable, but a real gap.
- **No partial refunds**, recorded or otherwise.
- **Provider-side refunds are not detected.** A refund made in the dashboard and never
  recorded here is invisible to the console.

## Why the tempting option is tempting

A single button is genuinely better for the person using it, and the provider calls are
short. The honest reason not to build it now is not the calls; it is that a refund path
deserves the same four-guards treatment the payment path got in Phase 7, and building half
of it inside a phase about admin screens is how a refund gets issued twice.

Reverse this when refunds are a real operation for the shop: build it as its own piece of
work with provider idempotency keys, a refund record, partial amounts, the two webhooks —
and revisit ADR-012 in the same change, because that is exactly the condition it names.
