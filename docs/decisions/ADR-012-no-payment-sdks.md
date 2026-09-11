# ADR-012 — Payment providers are reached with `fetch`, not their SDKs

**Status:** Accepted · 2026-09-11

## Context

Phase 7 integrates Stripe and PayPal. Both publish official Node SDKs, and reaching for
them is the default move — they are well maintained, widely used, and handle the parts
that are easy to get wrong.

The part that is easy to get wrong is not the HTTP. It is **webhook signature
verification**, which is the boundary between "Stripe told us this order was paid" and
"somebody told us this order was paid". Getting it subtly wrong does not throw; it
accepts a forged event, and the first evidence is a shipped order with no money behind
it.

So the question is narrower than "SDK or not". It is: *is the signature verifier the one
thing that justifies the dependency?*

What this codebase actually needs from each provider:

- **Stripe** — create a PaymentIntent, retrieve a PaymentIntent, verify one webhook
  signature. Three operations.
- **PayPal** — mint an OAuth token, create an order, capture an order, read an order,
  verify a webhook. Five, and the webhook verification is **a call back to PayPal**
  rather than a local computation, so no SDK is doing anything clever there either.

The precedent is [ADR-007](ADR-007-gmail-api-only-no-smtp.md), which reached Gmail with
`fetch` on the grounds that `googleapis` was a lot of dependency tree for two HTTP calls.

## Decision

**No payment SDKs on the server.** Both providers are reached with `fetch` and
`node:crypto`. The Stripe webhook verifier is hand-written, and the cost of that decision
is paid down with tests rather than waved away.

The one exception is **the browser**: `@stripe/stripe-js` and `@stripe/react-stripe-js`
are installed, because the card fields are iframes served by Stripe and that is what
keeps the card number off this origin and the shop out of PCI scope. A compliant card
field is not something to hand-roll. The PayPal buttons load their SDK by `<script>` tag,
which is ten lines and needs no wrapper.

## What this obliges us to do

The verifier is the risk, so it is tested as the risk:

- **It was cross-checked against a real Stripe signature.** A delivery was captured from
  `stripe listen` and the implementation verified Stripe's own signature over those exact
  bytes before anything was built on top of it. The fixture in
  `src/modules/payments/__fixtures__/stripe-webhook.json` keeps the real body; its
  signature was re-made with a throwaway secret so no live signing key sits in the repo.
- **It is tested by the ways it could wrongly accept**, not by the happy path: a tampered
  body, a body re-serialised through `JSON.parse`/`stringify`, a signature from a
  different secret, a stale timestamp, a timestamp edited to look fresh, a malformed
  header, and a correctly signed body that is not JSON. Twenty-two tests.
- **Every `v1` in the header is checked**, because Stripe sends more than one during a
  secret rotation and verifying only the first breaks the rollover in a way that looks
  like a bad secret.
- **The comparison is `timingSafeEqual`** and the tolerance window is enforced, so a
  captured body cannot be replayed indefinitely.
- **It was exercised live**, end to end, against real deliveries forwarded by the Stripe
  CLI — including the same event resent three times.

## What we give up

- **Upstream changes are ours to track.** An SDK would absorb an API change; here the
  pinned `Stripe-Version` header makes that a deliberate upgrade instead of a surprise,
  but somebody has to do it.
- **No typed client.** The response shapes are declared by hand in `stripe.ts` and
  `paypal.ts`. They are small, and every field that decides an outcome passes through
  `verifyCapture` or `markOrderPaid`, both of which are exhaustively unit-tested.
- **If this integration grows** — subscriptions, Connect, disputes, payouts — the
  arithmetic changes and the SDK becomes the right answer. This decision is scoped to a
  shop that takes one-off payments for physical goods.

## Why the tempting option is tempting

An SDK is genuinely less code and genuinely less to get wrong, and "we wrote our own
crypto" is a sentence that should make anyone uneasy. The honest version of this decision
is that we did not write any crypto: HMAC-SHA256 comes from `node:crypto`, and what is
hand-written is the *parsing of a header* and a constant-time compare. That is a small,
fully specified, fully testable surface — and it is now tested against a signature Stripe
actually produced.

Reverse this decision the moment either integration needs a fourth kind of operation.
