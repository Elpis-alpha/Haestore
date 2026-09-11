# Cart & wishlist

The bag, guest identity, the merge that happens when a guest becomes a person, and the
list of things kept for later. Phase 6 of the rebuild — the first phase where the shop
holds something on a shopper's behalf.

Two sentences carry most of the design:

**Nothing about money is stored that can be computed, and nothing about money is
accepted from the browser.** Every figure in a cart response is read from the catalogue
on the server, on every request.

**Nothing here reserves stock.** Reservation belongs to checkout, held against a real
order for a bounded time. A cart that reserved would let anybody empty the shelves for
free by filling a basket and walking away.

---

## The line shape, and the 2022 bug it repairs

The old cart stored each line's **extended total** in a field called `price`, and
recovered the unit price by dividing by quantity. Three items at $9.99 round-tripped
correctly by luck, and the moment a discount or a currency with a different exponent
arrived it would not have.

A line here stores a `unitPrice` as integer minor units, a `quantity`, and no total at
all. `lineTotal` is computed on read, by multiplication, and is not a field on any
document. The integration suite asserts its absence:

```ts
expect(line).not.toHaveProperty('lineTotal');
expect(line).not.toHaveProperty('total');
```

The stored `unitPrice` is **not** what anybody is charged. Its only job is to let the
difference be named — "the price changed from $19.00 to $22.00" — which is the one thing
a live-only price cannot say.

### `lineKey`

A line is identified by `<productId>_<variantId>`, derived rather than generated. That is
what makes "the same line" mean the same thing in two carts that never met, which is the
premise the merge rests on: it can compare key by key instead of guessing at similarity.

Joined with `_`, not `:`. The key travels in a URL path and is the kind of value that
later becomes a job id somewhere — and a colon in a job id is what silently discarded
every second reindex in Phase 3 until BullMQ's namespacing was understood.

---

## Re-pricing on read

Every read of a cart loads the live variants in **one** query and rebuilds the response
from them. `repricing.ts` is pure and reports rather than edits:

| Field | Meaning |
|---|---|
| `quantity` | What the shopper asked for. Never silently changed. |
| `sellableQuantity` | What can actually be bought right now. The totals use this. |
| `lineTotal` | `unitPrice × sellableQuantity`, computed here. |
| `maxQuantity` | The ceiling for the stepper. Zero means the line cannot be bought. |
| `changes[]` | Every way this line differs from what the shopper last saw. |

The split between `quantity` and `sellableQuantity` is the honest answer to "somebody
took the last two while this bag was open". Overwriting the quantity would mean the
basket edits itself while a person is looking at it; leaving the total to include stock
that does not exist would be a lie at the payment screen. So the ask stays, the total is
truthful, and the difference is named.

A line whose product was archived is **kept visible, priced at zero, and flagged**. A bag
that is one item shorter than the shopper left it, with no explanation, is
indistinguishable from a bug.

### The vocabulary

`LineChange` is one flat union shared by re-pricing and the merge report, because they
say the same things to the same shopper and two enums would drift apart:

`added` · `quantity_raised` · `price_changed` · `clamped` · `saved_for_later` · `dropped`

The backend names *facts* and deliberately does not decide how loudly to say them. The
sentences live in one place on the frontend (`lib/cart/types.ts`), with a test that every
kind in the union has one — so a kind added to the contract cannot reach a shopper as a
blank line under a cart row.

---

## Guest identity

`__Host-hae_cid`, 128 bits, `HttpOnly`, stored as an **HMAC** of the token rather than the
token. Same argument as the OTP pepper and the session key: a database dump yields
digests, and a digest is not a cookie. Keyed rather than a bare SHA-256, so the mapping
cannot be recomputed by anyone holding only the data.

**It is set lazily, on the first add-to-cart, and never on a page view.** Somebody who
browses the shop and leaves gets no cookie at all. That keeps the cart collection bounded
by people who added something rather than by visits, and it keeps a consent banner off
the storefront.

The plan called it `hae_cid`; the `__Host-` prefix is added because the argument that
earned it for the session cookie applies unchanged — a browser-enforced contract of
`Secure`, `Path=/`, and **no `Domain`**, so script on a sibling origin cannot plant one.

### Why it is not the session cookie

They have opposite requirements at exactly one moment. On sign-in the session id must
**rotate**, or an id planted before the privilege change is still valid after it. The
guest token must **survive**, because it is the only thing that can find the cart the
person filled while signed out. One cookie cannot do both.

### The two readable cookies

`hae_bag` (a count) and `hae_merge` (a flag) are written alongside cart responses and are
**not** `HttpOnly`, on purpose — the point is that client script reads them.

They exist to keep the storefront static. `cookies()` in the root layout opts every route
beneath it into dynamic rendering, and that layout wraps `/`, which Phase 5 verified is
`○ Static`. A header that resolved the session server-side would cost the home page and
every shelf their prerender to render one number.

So the bag badge reads `hae_bag` in the browser and the drawer fetches the real cart when
it opens; the cart page asks for a merge report only when `hae_merge` says there is one.
Both are display hints, both are forgeable, and forging either changes a number on your
own screen and no total anywhere.

> Phase 5's note said "the bag is the reason to revisit the header" and expected it to
> become dynamic. It did not have to. That note is superseded.

---

## The merge

Full reasoning in **[ADR-011](decisions/ADR-011-cart-merge-takes-max.md)**. In short: a
quantity collision takes **MAX, not SUM**, because the two errors are not symmetric —
undercounting is a shopper typing a bigger number, overcounting is a shopper paying for
things they did not order, silently.

It runs inside `POST /api/auth/otp/verify`, in five steps:

1. **Claim.** `findOneAndUpdate({ guestKeyHash, status: 'active' }, { status: 'merging' })`.
   This is the entire idempotency story. A replayed sign-in, a second tab, a retry — all
   find nothing to claim and do nothing. Without it MAX is not idempotent under a double
   delivery, because each merge would raise the quantity again.
2. **No account cart → reassign in place.** No line arithmetic runs at all, so there is
   nothing to get wrong, and `addedAt` survives.
3. **Otherwise merge, key by key**, in a transaction. Current prices adopted, quantities
   MAX'd, out-of-stock lines moved to `savedForLater`, unavailable lines dropped and
   named.
4. **Report.** Every change lands in a `mergeReport` with a seven-day tombstone behind an
   Undo.
5. **Clear `hae_cid`, and the session id is new** — `verify` already issues a fresh one,
   which satisfies the guest-to-user rotation more completely than rotating would.

The claim happens **outside** the transaction and the rest inside it. That is deliberate:
the claim must be visible to a concurrent caller immediately, which is exactly what a
transaction would prevent.

`mergeCarts` is a **pure function** over three inputs — the guest lines, the account
lines, and what the shop currently sells — with 20 unit tests across every branch. It is
pure because a merge that is wrong throws nothing and logs nothing; it produces a
perfectly valid cart, and the customer finds out at the payment screen or not at all.

### A failed merge does not fail the sign-in

The person has proved who they are. Refusing them entry because their basket could not be
combined trades a recoverable problem for an unrecoverable one — and the guest cart is
still unclaimed, so the next attempt picks it up.

### Undo means undo

It restores the account's own lines, which does discard what the guest bag contributed.
That is what undoing a merge is, and it is why the *report* is the primary repair: a
shopper who wanted 2 + 3 = 5 can see both numbers and type 5 without discarding anything.
Undo is for somebody who did not want the merge at all. Once, within seven days.

---

## Where the cart lives

**MongoDB, with a TTL index.** ARCHITECTURE.md's rule is that Redis must be safe to flush
at 3 a.m. — a cache, a rate limiter, a queue and a session are all things a shop survives
losing. A cart is not: a lost cart is a lost sale, and it is lost silently, from the
shopper's side, as "this site forgot my basket".

One active cart per owner, enforced by two partial unique indexes rather than by a
service that remembers to check. `status: 'active'` is inside the filter, so a cart
leaves the index when it is ordered or merged and the next one may be created.

Guest carts carry `expiresAt`, matching the cookie's own thirty days, so the cookie and
the cart it names expire together. Claiming a guest cart clears it.

---

## The wishlist requires an account

That is a decision, not a gap. A wishlist promises to remember across devices and across
months. A guest cookie can keep neither half: it is one browser, it expires in thirty
days, and clearing site data destroys it without warning. Offering one to a signed-out
visitor would advertise a durability the storage cannot provide — the same reasoning that
kept a disabled add-to-bag button off the Phase 4 product page.

The signed-out shape of the same need is the bag's own `savedForLater`, which is honest
about its lifetime because it sits beside things that are plainly temporary.

Nothing about price or stock is stored on a wish, which is the **opposite** trade-off
from a cart line. A wishlist is looked at weeks after it is written, so a snapshot would
be wrong by definition, and the only question anyone brings to one — "is it back in
stock, is it cheaper now" — can only be answered live. A cart line snapshots precisely so
a change can be *named*; here there is no earlier figure in the shopper's head.

A wish may name a variant or just a product. "I want the celadon bowl" and "I want the
250 g whole bean" are both real, so the variant is recorded when the shopper chose one
and left null when they did not — rather than forcing a choice at the moment they are
least sure. A product-level wish offers "Choose an option" rather than guessing which
grind to put in the bag.

---

## The frontend

`CartProvider` holds three things and nothing else: what the server last said, what the
shopper has just done and is waiting to hear about, and whether the drawer is open.

**The cart is not fetched on mount.** A visitor with no cart is the common case, and a
request on every page load to be told "nothing" is a request nobody needed. The badge
comes from `hae_bag`; the lines are fetched when something actually needs them — the
drawer opening, or the cart page rendering.

`useOptimistic` rather than set-state-and-roll-back, because React discards the
optimistic value automatically when its transition settles. A hand-rolled rollback leaves
a phantom quantity behind when two requests overlap, which is exactly what a stepper
tapped twice produces.

The local guess (`lib/cart/optimistic.ts`) is pure and tested. It re-computes the
subtotal and the count so the numbers move together — a quantity that changes while the
total sits still reads as broken. It deliberately does **not** guess about stock: showing
the higher number for an instant and correcting beats a stepper that silently refuses and
looks stuck. And it does not guess about *adding* a line at all, because a new line needs
a title, a photograph and a price the client does not have; an optimistic add would be a
grey rectangle.

A generation counter guards against an older response overwriting a newer one. Two quick
taps produce two requests, and they can land out of order.

### Every call goes through the `/api/*` rewrite

Not a preference. The cart's identity is a `__Host-` cookie, which by definition carries
no `Domain` and is therefore single-origin. A request to the API's own hostname would
carry no cart, and the `Set-Cookie` issuing a guest token would land on an origin the
browser is not on.

---

## Verified, not assumed

**Backend: 173 unit + 124 integration.** **Frontend: 87.**

The pure cores carry most of it — 20 tests on the merge, 15 on re-pricing, 12 on the
optimistic layer — because those are the three places where being wrong produces a valid
cart and no error.

Against the running stack, in a real browser:

- **A page view sets no cookie; the first add-to-cart sets both.** Checked from an empty
  jar, which is the only way to see the absence.
- **The shelf price was changed under a full bag** (mongosh, $19 → $22) and the cart page
  said "The price changed from $19.00 to $22.00" with the summary flagging it. The
  drawer showed $19 while the cached product page still showed $16 — re-pricing working,
  and the cached-page lag noted below.
- **The whole merge, end to end**: 2 × Sumatra on the account, 1 × Espresso as a guest,
  sign in → three pieces, $74.00, a report naming both changes, and `hae_bag=3`.
- **The same guest cookie presented at a second sign-in reported `mergeReport: false`**
  and the quantity did not move. The claim guard, exercised.
- **Undo restored the account's own line**, and a second undo answered 409.
- **`/` is still `○ Static`** in the production route table — the property the whole
  readable-cookie arrangement exists to protect.
- `cf:build` dry-run: **1115 KiB gzipped** against the 3 MiB limit. The bag cost 26 KiB.
- No horizontal scroll at 375px on the cart page, the product page, or inside the drawer.

### Two defects found by running it

1. **The cart page asked for a merge report on every visit** — a 401 in the console for
   every signed-out shopper and a wasted round trip for every signed-in one, to be told
   "no" almost always. Fixed by the `hae_merge` cookie, which is also why that cookie
   exists at all.
2. **It asked twice.** The loading skeleton was an early `return`, so everything below it
   unmounted and remounted when the read settled — and the report panel's effect runs on
   mount. The skeleton is now a branch inside the tree rather than in front of it.

---

## Known, and deliberate

- **There is no checkout button.** Phase 7 builds it. The cart page says so in words
  rather than shipping a disabled control — the Phase 4 precedent, and the direct lesson
  of the 2022 app rendering a Pay button before it had a payment intent.
- **A cached product page's price can lag the bag** by up to its 60-second revalidate
  window. The bag is always live, which is the right way round; an admin price change
  goes through the outbox and closes the gap on the next revalidation.
- **`claimGuestOrders` is a no-op that logs.** The Order model arrives in Phase 7; the
  hook is placed now because the moment a guest becomes a person is the moment both their
  cart and their history change hands.
- **Axis values still have no labels of their own** — the Phase 4 gap. Cart lines render
  the raw slug prettified, the same fallback the product page's picker uses. It closes in
  Phase 8 with the variant grid.
