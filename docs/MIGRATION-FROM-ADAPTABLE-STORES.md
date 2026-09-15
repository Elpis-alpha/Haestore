# From Adaptable Stores to Hæstore

*Adaptable Stores* was built in 2022: an Express API with Mongoose, and a Create React App
storefront with Redux. Hæstore replaces it. **Nothing was migrated** — no data, no code, no
schema — and this document says why, what the old app did, and where each of its problems
went.

The old code is still in the history of both application repos: the back-end up to
`ed82843`, the storefront up to `d743c02`. Every quotation below is from those commits.

---

## Why a rebuild, not a migration

**The name was a promise the code moved away from.** `Item.ts` began with a free-form
`category` string and ended with this:

```ts
section: { // Clothes, Shoes, Cosmetics
  type: String,
  required: true,
  enum: { values: ["Cloth", "Shoe", "Cosmetic"], message: `{VALUE} is not supported` },
},
```

Five fields — title, section, description, price, pictures. No variants, no options, no
stock, no attributes. A shop that sold three kinds of thing, fixed at compile time, called
*Adaptable*. There was no adaptable core to carry forward, so building one meant replacing
the model, and replacing the model meant replacing everything that read it.

**The defects were structural.** The worst of them — payments trusted from the browser, an
admin password in every URL — were not bugs in a function but in how the application
decided who could do what. They could not be patched without redesigning the parts they
lived in.

**There was no data worth keeping.** Orders paid for nothing (see below), users behind a
shared verification token, three sections of demo products. The seed replaces it with a shop
whose history was produced by the code that runs it (SEEDING.md).

---

## The defects, and where they went

### A PayPal order anyone could create

```ts
router.post('/api/order/add-paypal', auth, cartAuth, async (req, res) => {
  const { data } = req.body
  // …
  const order = await Order.create({ owner: user._id, items: orderItems, data })
  await order.sendCheckoutMail()
```

The browser posted whatever PayPal had told it, and the server saved it as the payment and
emailed a confirmation. The server never contacted PayPal. Any signed-in user could `curl`
this route with an invented `data` and receive a completed order and a receipt, having paid
nothing.

**Now:** the client sends an order id and nothing else. The server captures with PayPal
itself and checks five things from PayPal's own response before anything is marked paid —
the status, the amount to the minor unit, the currency, the `custom_id` naming the order, and
that the capture is not already attached to another order (a unique index). Every path to
"paid" goes through one idempotent function, `markOrderPaid`. See PAYMENTS.md and
ADR-012.

### Success, whatever happened

Both checkout components ended the same way:

```tsx
if (stripeOrder.error) {
  sendMiniMessage({ content: { text: "Error while making order!" } }, 2000)
} else {
  dispatch(setCartData(stripeOrder.cart))
}
setCheckoutState("final")
```

`setCheckoutState("final")` sat after the `if`, so a failed payment still moved to the
final screen — "Congratulations, your purchase has been made" — two seconds after a toast
saying it had not been. `PaypalCheckout.tsx` had the identical shape.

**Now:** the return page does not decide. It asks the API, which asks the provider, and the
page says "Thank you — your order is confirmed" only for an order the server holds as paid.
Anything else reads "We have not seen your payment yet". The end-to-end suite pays with no
webhook forwarding at all and waits for the confirmation, which only the reconcile path can
produce. See CHECKOUT.md.

### An admin password in the query string

```ts
if (req.query.item_password !== process.env.ITEM_PASSWORD) return errorJson(res, 401)
```

One shared secret, compared in plain text, sent as `?item_password=` on every mutating
request — and therefore in every access log, proxy log and browser history that saw one.
`GET /api/items/verify` answered whether a guessed password was right, with no throttle.

**Now:** there are no passwords at all (ADR-004). Admin is a role on an account, granted from
`ADMIN_EMAILS` at sign-in, read from the database on every request rather than carried in
the session (ADR-010), checked once above every admin route, and audited. Destructive actions
ask for a fresh code (step-up). An integration test walks the admin router's route table and
asserts every route answers 401 to a stranger and 404 to a signed-in customer. See AUTH.md
and ADMIN.md.

### One verification token for everyone

```ts
verify: { type: String, default: v4() }
```

`v4()` is called once, when the module loads, not per document. Every user created during
one process lifetime shared a verification token — and the account deletion link built from
it was a `GET`: `/mail/delete-user/:id/:verify`, which any link preview or mail scanner
fetching the email could follow.

**Now:** a sign-in code is six digits, random per request, stored only as a peppered HMAC
with a ten-minute expiry and a five-attempt limit. Nothing that changes state is a `GET`. See
AUTH.md.

### Tokens that never expired, kept forever

```ts
const token = jsonwebtoken.sign({ _id: user.id.toString() }, secret, {})
user.tokens = user.tokens.concat({ token })
```

No `expiresIn`, so every token was valid until the secret changed, and every sign-in
appended another to an array on the user document that nothing ever pruned.

**Now:** opaque session ids in Redis with a TTL, an HttpOnly `__Host-` cookie, a list of
devices the account can revoke one at a time, and a `sessionVersion` that revokes all of them
in one write. The user document holds no tokens. See ADR-004.

### Search that was a regular expression from the URL

```ts
const filter = typeof req.query.filter === "string" ? new RegExp(req.query.filter, 'i') : undefined
const items = await Item.find({ ...sectionData, ...filterData }).limit(limit).skip(skip).sort(sort)
```

The shopper's text became a regex, unescaped, matched against `title` and `description`
with no index — a full collection scan, and a pattern of the caller's choosing. `limit` was
optional, so leaving it off returned every item, with no projection, image data included.

**Now:** Meilisearch is the read model for the storefront (ADR-003): typo-tolerant search,
facet counts, and filters built from a whitelist of attribute keys, with values escaped.
Every list endpoint has a projection constant, a default page size and a maximum. See
SEARCH.md and DATA-MODEL.md.

### A cart that forgot its prices

```ts
uItem.price = uItem.price + (item.price * qty)
// …
uItem.price = uItem.price - ((uItem.price / uItem.quantity) * qty)
```

A cart line's `price` was the extended total, and removing some of a line recovered the unit
price by dividing — exact only until a price changed between adding and removing.

**Now:** money is integer minor units with a currency, never a float. A cart line stores the
unit price the shopper last saw; the line total is never stored. Every read re-prices from
the catalogue and says what changed. The order is a frozen snapshot of what was charged. See
CART.md and DATA-MODEL.md.

### Images made large on purpose

```ts
const buffer = await sharp(req.file.buffer).resize({ width: 800 }).png({ quality: 20 }).toBuffer()
```

Every upload was re-encoded as PNG — a lossless format, on which `quality` does almost
nothing — and stored as a buffer inside the MongoDB document.

**Now:** the shop's own photographs are uploaded from the browser straight to Cloudinary and
served as AVIF or WebP at the width the page asks for; the seed's photographs are hotlinked
from Unsplash and resized there (ADR-015). No image bytes are in the database.

---

## What changed shape

| 2022 | Hæstore |
|---|---|
| Two repos, JavaScript types by hand | Three repos, API types generated from the back-end's schemas (ADR-001) |
| Express 4, Mongoose, a standalone `mongod` | Express 5, TypeScript, Mongoose 8, a replica set for transactions and change streams (ADR-002) |
| Create React App, Redux | Next.js 15 App Router, React 19, Server Components; state in the URL |
| SMTP through Nodemailer, verified before `listen` | Gmail over HTTPS, an outbox committed with the write that owes the email (ADR-007) |
| Email and password, plus a verification link | A six-digit code to an address; no passwords (ADR-004) |
| `section: "Cloth" \| "Shoe" \| "Cosmetic"` | Admin-defined categories, typed attributes and variants (ADR-005, ADR-008) |
| Stripe Checkout token and a PayPal blob from the browser | Stripe PaymentIntents and PayPal capture, both verified server-side (ADR-012) |
| `/complain`, a form emailed to the admin | Support conversations on an account (ADR-014) |
| No tests; `@testing-library` installed and unused | Unit, integration against a real replica set, and end to end |

## What was kept

- **The card growing into the product page.** The old storefront measured the clicked card
  with `getBoundingClientRect()` and fed it to the modal's `transform-origin`, so the product
  view grew out of the exact card clicked. It was the best idea in the codebase. The browser
  does it natively now, with View Transitions (FRONTEND.md).
- **The mark.** `assets/logo_square.svg` — the H whose crossbar is a leaf and whose top is a
  shopping-bag handle — became the brand the design system is drawn from (DESIGN-SYSTEM.md).
- **Stripe and PayPal**, both, as the two ways to pay.
