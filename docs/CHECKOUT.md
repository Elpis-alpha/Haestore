# Checkout

How a bag becomes an order, and how an order becomes paid exactly once.

Companion document: **[PAYMENTS.md](PAYMENTS.md)**, which covers the two providers.
New decision: **[ADR-012](decisions/ADR-012-no-payment-sdks.md)**.

---

## The shape

```
POST /api/checkout/session
  ├─ re-price every line from the catalogue      ┐
  ├─ refuse anything that cannot be fulfilled    │  one transaction
  ├─ reserve stock                               │
  ├─ insert the Order (pending_payment)          │
  └─ flip the cart to `ordered`                  ┘

  … transaction commits …

  └─ create the PaymentIntent / PayPal order     ← outside it, always
```

Everything after that funnels into one function.

```
Stripe webhook ─┐
PayPal capture ─┼──→  markOrderPaid()  ──→  paid + receipt queued
return page    ─┘        (status: 'pending_payment')
```

---

## Four guards, at four different distances

Phase 7's whole problem is that a payment can be reported more than once, out of order,
hours late, and by more than one route. The defence is not one clever check; it is four
independent ones, each of which is sufficient on its own for the failure it is nearest to.

| Guard | Where | Stops |
|---|---|---|
| `Idempotency-Key` | API edge | A double-tapped "Place order" creating two orders |
| `status: 'pending_payment'` in the filter | `markOrderPaid` | One order being paid twice |
| Unique index on `payment.intentId` | The database | One payment attaching to two orders |
| Unique index on `{provider, eventId}` | `PaymentEvent` | Work *around* the payment repeating |

They are deliberately at different distances from the money. The edge guard needs no
adversary and no race in our code — only a slow network and an impatient thumb — and it
is the one that fires most often in practice.

### The idempotency key has three outcomes, and the third is usually missing

- **Same key, same request** → replay the stored response byte for byte.
- **Same key, in flight** → 409. Not a wait: holding the second request open turns a
  double-tap into two hung connections and then a timeout on both.
- **Same key, *different* request** → 422. This is a client bug, and replaying the first
  response would answer a question nobody asked — quite possibly telling somebody their
  order succeeded when the order they just described was never created.

The key is scoped to `{owner, scope, key}` and the **insert is the claim**: a duplicate
key error on the unique index is the answer, rather than a check that could be raced.

> **A bug this caught.** The first draft read the owner from a `req.guestKeyHash` that
> nothing ever set, so every signed-out caller fell through to `anon` and shared one
> owner — meaning one guest's key could replay another guest's order, client secret and
> all. The integration test named "scopes a key to its owner" is what found it.

---

## The order status machine

```
pending_payment → paid → processing → shipped → delivered
       ↓            ↓         ↓           ↓
    canceled  ←—————┴—————————┴———————————┴——→ refunded
```

**Enforced in the query filter, never in an application `if`.**

```ts
findOneAndUpdate({ _id, status: { $in: predecessorsOf(next) } }, { $set: { status: next } })
```

A `null` return *is* the answer: the transition was illegal, which almost always means a
duplicate or late delivery. Log it, return 200, do not retry.

The obvious alternative reads identically and is wrong:

```ts
const order = await Order.findById(id);
if (canTransition(order.status, next)) { order.status = next; await order.save(); }
```

Two webhook deliveries can both pass that `if` before either saves, and retries arrive in
bursts, so the race is not theoretical.

`predecessorsOf('paid')` is `['pending_payment']` and nothing returns to
`pending_payment` — both asserted in `order-status.test.ts`. That pair is the entire
idempotency story of `markOrderPaid`.

---

## Stock reservation

The cart deliberately does not reserve — a reserving cart lets anyone empty the shelves
for free. A reservation is held against a **real order**, for a bounded time.

The guard is the one Phase 0's probe proved against a real replica set:

```ts
findOneAndUpdate(
  { _id, variants: { $elemMatch: { _id: variantId, status: 'active',
                                   'stock.available': { $gte: qty } } } },
  { $inc: { 'variants.$[v].stock.available': -qty,
            'variants.$[v].stock.reserved':  +qty } },
  { arrayFilters: [{ 'v._id': variantId }] },
)
```

**The availability test is part of the write.** Reading stock, deciding in JavaScript and
then writing is the status-machine mistake in a different costume. This is also why
`stock.available` is stored rather than computed from `onHand - reserved`: comparing two
fields of one array element needs `$expr`, and `$expr` is not allowed inside `$elemMatch`.

Reservation moves in exactly three ways:

| Event | `onHand` | `reserved` | `available` |
|---|---|---|---|
| Checkout reserves | — | **+n** | **−n** |
| Canceled / swept | — | **−n** | **+n** |
| Shipped (`consumeAll`) | **−n** | **−n** | — |

`reserveAll` is all-or-nothing with an **explicit rollback**, not just a transaction
abort — it is also called from paths with no ambient transaction, where a partial
reservation would hold stock for an order that was never created: invisible, held
forever, with nothing pointing at it.

### The sweeper

Unpaid orders hold stock for `CHECKOUT_RESERVATION_MINUTES` (30 by default). Past that
the sweeper cancels them and returns the stock.

Two independent reasons it can never touch a paid order: the transition to `canceled`
filters on `pending_payment`, and `markOrderPaid` clears `reservationExpiresAt` so a paid
order leaves the sweeper's query entirely. Both are tested, and the second was verified by
forcing a stale expiry back onto a paid order.

**Releasing is guarded on `stockReserved` flipping true → false in one write**, not
derived from the status — so the sweeper, an admin and a webhook can all reach the same
order and the stock is returned exactly once.

---

## Re-pricing, and what checkout refuses

Checkout re-prices through the cart's own `repriceCart`. The client sends **no amounts,
ever** — there is no field in the request schema to put one in, which is the structural
version of the rule rather than the polite version.

The cart is permissive and checkout is strict, deliberately:

| Line state | Cart | Checkout |
|---|---|---|
| Price changed | shows "was $18, now $20" | charges the live price |
| Quantity above stock | clamps and says so | **refuses** — 409 with the line named |
| Variant unavailable | shows it, flagged | **refuses** |

Phase 6 shipped `isBlocking` on the frontend with nothing consuming it. The cart page's
disabled checkout button and `assertSellable` are the two consumers.

---

## Guest checkout

Guest checkout is a first-class path. An order carries an `email` always and a `user`
only sometimes.

- **A guest gets a `claimToken`**, returned exactly once in the response that created the
  order. Only its HMAC is stored, keyed by `GUEST_COOKIE_SECRET` — the same argument as
  the OTP pepper and the session id.
- **A bare order number authorises nothing** and answers **404**, not 403, so it cannot be
  used to discover which numbers exist. It can be printed on a packing slip.
- **At sign-in, `claimGuestOrders` attaches them**, which is safe precisely *because*
  authentication is an emailed code: possession of the code is a strictly stronger claim
  on the address than the guest token ever was.
- **The claim clears `claimTokenHash`.** Once the order has an owner, the emailed bearer
  link stops working. Verified live.

---

## Order numbers, and a defect a rendered page exposed

`HAE-` plus eight Crockford base32 characters from `crypto.randomInt`. Random rather than
sequential: a counter tells anyone who places two orders how many the shop took in
between, and makes a neighbouring order guessable.

The alphabet omits `O`, `I`, `L` and `U`. **That is only half of the scheme, and the first
draft shipped only that half.**

Looking at a real confirmation page made it obvious: `HAE-CJ0RTHPK` rendered in a humanist
face with an unslashed zero is indistinguishable from `HAE-CJORTHPK`. Excluding `O` stops
the *generator* emitting an ambiguous character; it does nothing for the *reader*, who
types back a number that never existed and is told their order does not exist.

`normaliseOrderNumber` folds the ambiguous characters the way Crockford intends —
`O` → `0`, `I`/`L` → `1` — and strips spaces and hyphens. The fold is safe precisely
because the generator never emits those letters, so it can never collide with a real
number. All five of these now resolve to the same order:

```
HAE-CJ0RTHPK   HAE-CJORTHPK   hae-cjorthpk   HAE CJOR THPK   CJORTHPK
```

---

## The receipt goes through an outbox

An email send inside a webhook handler means a slow mail server makes Stripe retry, and
we re-process a payment because *Gmail* was busy. Enqueuing after the commit instead loses
the receipt if the process dies in between.

So the intent to send is appended **inside the transaction that marks the order paid**.
Either both land or neither does.

Unlike the search outbox this one is **swept, not streamed** — no change stream, no resume
token, no second lease. Nobody notices a receipt three seconds late, and order volume is
orders of magnitude below catalogue-write volume. The sweep is what makes delivery certain,
and today it is also the only path: `enqueueOrderMail` — the post-commit fast path this
section used to describe — exists in `order-jobs.ts` and has no caller, so a receipt goes
out on the next sweep, within `ORDER_SWEEP_INTERVAL_MS` (a minute). Found in Phase 9 while
routing support replies through the same outbox; the sweep's latency is acceptable for mail,
so the fast path was left unwired rather than added under a phase about something else.

---

## What is verified

**Backend: 297 unit + 165 integration** (173 + 124 before this phase).

Two guards were checked **by breaking them** and confirming the suite went red: the
`status: 'pending_payment'` filter in `markOrderPaid`, and the sweeper's status filter.

Against the running stack, with real Stripe and real PayPal sandbox credentials:

- **A full guest purchase completed with zero webhooks delivered.** The payment succeeded
  at Stripe, the order stayed `pending_payment` with **zero** `payment_events` recorded,
  and the return page's reconcile moved it to `paid`. This is ADR-009's argument applied
  to payments: the path that ships is the path that is exercised.
- **The same `payment_intent.succeeded` resent three times, plus a reconcile on top**:
  one `paid` entry in the history, stock unmoved, one order, one receipt, one event row.
- **Stock**: 8 on hand → reserved 2 at checkout → still reserved 2 after payment.
- **The sweeper** canceled an expired unpaid order and returned exactly its 2 units, while
  leaving both paid orders untouched.
- **PayPal** created a real sandbox order carrying `custom_id` = our order id,
  `invoice_id` = the order number and `32.00 USD` from the decimal converter. Capturing an
  order the buyer had not approved was refused, and the order stayed unpaid.
- **Guest order claiming**: an order placed signed-out appeared in `/api/orders` after
  signing in with a code, and the emailed claim link stopped working.
- `cf:build` dry-run: **1155 KiB gzipped** against the 3 MiB limit (1115 at Phase 6 — the
  whole checkout, Stripe Elements included, cost about 40 KiB).

---

## Things worth knowing

- **The webhook router mounts above `express.json()`** — the comment marking that spot has
  been in `app.ts` since Phase 0 and is load-bearing. It also mounts above `originGuard`
  and `attachSession`, because a webhook carries neither an `Origin` header nor a session
  cookie; it is authenticated by its signature and by nothing else.
- **A failed card is not a cancellation.** The shopper can try another card on the same
  intent, and releasing their stock mid-attempt would hand it to somebody else. Only the
  reservation's expiry ends an abandoned checkout. A *denied PayPal capture* is different —
  the approval is spent — so that one does cancel.
- **`GET /api/catalog/products/:slug` returns `_id`; the listing returns `id`.** A
  pre-existing inconsistency, noticed while scripting the live run. **Settled in Phase 8,
  by rule rather than rename:** a document returned whole keeps `_id`, a presenter's
  projection uses `id`. See ADMIN.md.
- **`PAYPAL_WEBHOOK_ID` is unset.** Without it the PayPal webhook route refuses events
  rather than trusting them unverified. Nothing in the demo depends on it — the return
  page reconciles through the same `markOrderPaid` — but it must be set before a real
  deployment takes PayPal money.
