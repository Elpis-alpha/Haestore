# Payments

The two providers, and the 2022 defect this phase exists to repair.

Companion document: **[CHECKOUT.md](CHECKOUT.md)**.
Decision: **[ADR-012](decisions/ADR-012-no-payment-sdks.md)** — no server-side SDKs.

---

## The defect being repaired

The 2022 app had this route:

```
POST /api/order/add-paypal
```

It took a payment object from the browser and stored it. **It never contacted PayPal.**
Any authenticated user could `curl` themselves a completed order, for anything in the
shop, for free, and the server would file it as paid.

Nothing in that flow was a bug in the ordinary sense. Every line did what it said. The
design simply trusted the client to report its own payment.

So the rule the whole of this phase is built around:

> **The browser's word is never evidence.** The client may name an identifier. Everything
> that decides an outcome is read from the provider's own response to our own
> server-to-server call.

---

## Stripe

### Creating the intent

`POST /api/checkout/session` creates the order in a transaction, then creates the
PaymentIntent **outside** it. Never hold a transaction open across a third-party HTTP
call — a Stripe timeout becomes a MongoDB transaction timeout, which surfaces as a write
conflict somewhere unrelated.

The idempotency key is **deterministic: `pi:{orderId}`**. A request that timed out after
Stripe had already created the intent returns *that same intent*. With a random key, a
flaky connection produces two intents for one order, and the unique index on
`payment.intentId` then refuses the second — correctly, but after the customer has been
charged.

### The client secret

Returned to the browser, and it is worth being precise about what it is: it authorises
confirming **that one PaymentIntent**, whose amount was fixed server-side inside the same
transaction that reserved the stock. It is not a credential for the order and cannot read
or change one. There is nothing on the payment screen that can alter what is charged.

### Reading the payment back

`amount_received`, **not** `amount`. The former is what Stripe actually took; the latter
is what the intent was created for. They differ on a partial capture, and reading the
wrong one accepts an underpayment.

### Webhook signature verification

Hand-written (ADR-012), and therefore tested as the security boundary it is.

The header is `t=<ts>,v1=<hex>,v1=<hex>`, and the signed payload is `${t}.${rawBody}`.

Four things are deliberate:

- **Verified against the raw bytes.** A body that has been through `express.json()` and
  back out via `JSON.stringify` will not verify — key order and whitespace are not
  preserved. This is why the router mounts above the JSON parser, and there is a
  regression test that round-trips a body and asserts it fails.
- **Every `v1` is checked**, not just the first. Stripe sends more than one while a
  signing secret is being rotated; verifying only the first breaks the rollover in a way
  that looks like a bad secret.
- **`timingSafeEqual`**, and the digests are equal-length by construction.
- **The timestamp tolerance is enforced** (300s). Without it a captured body is replayable
  forever, and editing `t` to look fresh invalidates the digest — also tested.

The refusal is **400, always, with one message**: Stripe treats any non-2xx as a delivery
to retry, and a verifier that reported *which* check failed would be an oracle for anyone
probing the endpoint.

> **Cross-checked against reality.** A delivery was captured from `stripe listen` and the
> implementation verified Stripe's own signature over those exact bytes before anything
> was built on it. The committed fixture keeps the real body; its signature was re-made
> with a throwaway secret so no live signing key sits in the repo. It also carries two
> `v1` values (only the second matching) and a `v0` that must be ignored — so the
> rotation and the ignore-v0 behaviours are both exercised.

---

## PayPal

### Money crosses a string boundary

PayPal speaks `{ currency_code: 'USD', value: '19.99' }` in both directions. That string
is the value the five-point check compares against, so the converter is the single most
dangerous type conversion in the checkout.

**Both directions are string arithmetic — and the reason is strictness, not rounding.**

The rounding argument is the one you expect, and it does not hold up:
`Math.round(parseFloat(s) * 100)` and `(minor / 100).toFixed(2)` were both checked across
every minor-unit value from 0 to 2,000,000 in 2- and 3-decimal currencies, and neither is
ever wrong. (The *unrounded* `parseFloat(s) * 100` is wrong for about 13% of values —
`0.07 * 100` is `7.000000000000001` — so the naive version everyone writes first is
genuinely broken, but `Math.round` rescues it.)

What does not hold up is `parseFloat` as a parser of somebody else's money:

```
parseFloat('1,999.99')  // 1      — stops at the comma
parseFloat('19.99 USD') // 19.99  — ignores the trailing code
parseFloat('1.9e3')     // 1900   — accepts an exponent as a price
```

And the sharp one: `'19.999'` in a USD order. `Math.round(19.999 * 100)` is `2000`, so a
lenient parser silently rounds an over-precise amount **up by a cent** and hands it to the
equality check as though it were exact. Refusing it requires knowing the currency's
exponent, which a hardcoded `100` does not. The exponent comes from `Intl`, so JPY (0
decimals) and KWD (3) work by construction rather than via a second code path.

The plan named `0.10`, `1999.99` and `0.07` as test values; all three are pinned, along
with a lossless round-trip across every minor unit from 0 to 10,000.

### The five checks

Every one is read from **PayPal's own response to our own call**. All five, or the order
is not marked paid.

| # | Check | What it stops |
|---|---|---|
| 1 | Order `status === 'COMPLETED'` | Treating an abandoned approval as a sale |
| 2 | `custom_id` is *our* order id | A real capture for a cheap order presented against an expensive one |
| 3 | Capture `status === 'COMPLETED'` | A `COMPLETED` order whose capture is `PENDING` or `DECLINED` |
| 4 | Exact minor-unit amount | An underpayment |
| 5 | Matching currency | The right number in the wrong currency |

Check 3 is the subtle one and the closest relative of the 2022 bug: an order can be
`COMPLETED` while its capture is not, so reading only the order status ships goods against
money that has not moved. Check 4 reads the **capture's** amount, not the purchase unit's —
a partial capture leaves the unit's requested amount intact.

`verifyCapture` is pure and takes the response as data, so all five branches are unit
tested without a network. It reports *which* check failed, for the operator; that reason
is logged and stored on the order and is **never** returned to the client.

### Creating and capturing

- `custom_id` carries our order id — the thread `verifyCapture` pulls on.
- `invoice_id` carries the order number, which is **PayPal's own duplicate guard**: PayPal
  refuses a second order with an invoice id it has already captured, one layer before our
  checks.
- `PayPal-Request-Id` on the capture makes a retry return the original capture rather than
  taking the money twice.
- The capture route finds the order **by the PayPal order id we stored**, never by an id
  the client names.

### Webhooks

PayPal signs with a certificate chain and expects verification to be a call back to them,
which needs `PAYPAL_WEBHOOK_ID`. **Without it the route refuses rather than trusting an
unverified event.** Nothing in the demo depends on this path.

The one place a provider-supplied field steers a lookup is `PAYMENT.CAPTURE.COMPLETED`,
whose `custom_id` is the only pointer to our order in that payload. That is why the amount
is still verified against the order that comes back: naming an order is not the same as
being owed one, and `markOrderPaid` refuses any amount that is not exactly ours.

---

## The demo does not require the Stripe CLI

This is a deliberate property, not a convenience.

A webhook-only design is only ever exercised where webhooks are reachable — which is never
a developer's laptop behind NAT — so the path that ships is the path nobody ran. Here the
**return page reconciles**: it asks our server to ask the provider what happened, and the
answer funnels into the same `markOrderPaid` the webhook would have called.

Webhook and return page are two deliveries of one idempotent operation. Whichever arrives
first pays the order; the other finds it settled and does nothing.

Verified with webhooks explicitly not running: the payment succeeded at Stripe, the order
stayed `pending_payment` with **zero** `payment_events` recorded, and the reconcile moved
it to `paid`.

---

## Credentials

| Variable | Used for |
|---|---|
| `STRIPE_SECRET_KEY` | Server-to-server API calls |
| `STRIPE_WEBHOOK_SECRET` | Signature verification — from `stripe listen --print-secret` in dev |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | The browser's Payment Element |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | OAuth, orders, captures |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | The browser's PayPal buttons |
| `PAYPAL_ENV` | `sandbox` or `live` |
| `PAYPAL_WEBHOOK_ID` | **Unset.** Required before PayPal webhooks can be verified |

All payment keys are `optional()` in the env schema and guarded by `requireConfigured`, so
the API boots and serves the catalogue with none of them — and an attempt to check out
fails with "Stripe is not configured: set STRIPE_SECRET_KEY" rather than a `TypeError`
several frames deep.

The PayPal access token is cached in process with a 60-second safety margin, never in
Redis: a bearer token for the merchant account does not belong in a store whose stated
contract is that it must be safe to flush and safe to lose.
