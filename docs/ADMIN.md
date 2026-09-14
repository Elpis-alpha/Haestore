# The admin console

The room behind the counter: orders, customers, the catalogue and the front page. Phase 8 of
the rebuild — the phase that made the admin API, which had answered 401 to everyone since
Phase 2, into something a person can use.

The claim it had to make good on is the one the project is named for, from the other side:
**an administrator defines a kind of fact the code has never heard of, and it becomes a
field on every product on that shelf and a working filter in the shop — without a deploy.**
That was exercised in a real browser against the running stack. A `varietal` attribute,
named nowhere in either repository, was defined in the attribute builder, bound to Beans,
set on one product, and forty seconds later `/shop/coffee-tea/beans` offered it as a filter
with disjunctive counts (Bourbon 1, Typica 0, Geisha 0 — shown, not hidden) and
`?varietal=bourbon` narrowed the shelf to that product.

---

## One gate, one audit

Every admin route sits under one router, `modules/admin/admin.routes.ts`, which mounts two
things before anything else:

1. **`requireRole('admin')`** — 401 to a stranger, **404** to a signed-in non-admin, so the
   surface is not discoverable by probing. Phase 2 put this on the catalogue router, which
   was right while it was the only admin router and becomes the per-handler mistake at
   five. It moved up.
2. **The audit middleware** — one `admin_audit` row per mutation that succeeded.

The integration suite does not list the routes it guards. **It walks the admin router's own
route table**, fills in the parameters, and asserts 401 and 404 on every one — 40-odd routes
today. A route added next year is covered the moment it is mounted, and the test fails if a
router is mounted underneath that it does not know how to walk, rather than skipping it.

The frontend gives the same answer: `app/admin/layout.tsx` calls `requireAdmin`, which
redirects a signed-out visitor to sign in and renders the ordinary 404 for a signed-in
shopper. Verified with a real shopper session: `/admin`, `/admin/orders` and
`/admin/storefront` are all 404.

### What the audit records

The route as declared (`/api/admin/orders/:id/status`), the target id, the actor, the status
and the request id — **not the body and not a diff.** Enough to answer "who shipped this"
and "what did anyone do on Tuesday", and to go to the record itself for the rest. A
before-and-after copy of every write would be a second catalogue nobody reads.

It is written on the response's `finish` event, only for a status below 400. A refused
request changed nothing, and it is already in the request log under the same id. The cost is
a narrow window — a process that dies between sending the response and inserting the row
loses that row — which is accepted and logged loudly on failure, rather than holding every
admin response open on a second write. No TTL: an audit log that forgets is a log of the
recent past.

---

## Step-up, in a browser

Phase 5 built step-up and mounted it on the two catalogue deletes, with no dialog to answer
it. Phase 8 is where a person meets it.

**Behind step-up:** deleting a category or archiving a product, canceling an order,
recording a refund, changing someone's role, publishing the front page, and putting an old
version back. The rule is *cannot be undone, or is public the moment it happens*. Not ship,
not pack, not saving a draft — routine work behind a code teaches people to type codes
without reading why.

**The API answers 403 `STEP_UP_REQUIRED`, never 401**, and the console is built around that
distinction. `withStepUp` (`lib/admin/step-up.ts`) runs an action; on that one answer it
awaits `confirmIdentity()`, which opens the code dialog and resolves when the code verifies
or the dialog closes; then it runs the action **exactly once more**. The page, the form and
the note the admin had typed are all still there, because nothing navigated.

Once, not until it works: a second demand for a code straight after a verified one means
something is wrong, and looping would pin the admin in front of the dialog. It surfaces as an
ordinary error. Verified live: a session's `authAt` was aged thirteen hours in Redis, a refund
was recorded, the dialog appeared, the code from the outbox was entered, and the refund went
through with the same session id.

---

## Orders

### The buttons come from the server

Each admin order carries `actions`, computed by `adminActionsFor` in `order-status.ts` —
**derived from the status machine's own edges**, not a second table of what may happen
next. The console renders buttons from the list and never re-derives it. A unit test walks
every status and asserts nothing offered is an illegal transition.

It caught my assumption on the first run: the console offered *Mark shipped* on a paid order,
and the machine has no `paid → shipped` edge. An order is packed before it goes out. The
machine is right and the expectation was fixed, not the machine.

### Shipping is where stock leaves

`shipOrder` flips `status` to `shipped` **and** `stockReserved` to false in one guarded write
that returns the document as it was before — so "was the stock still held?" is answered by
the write that took it, not by a read a second click could also pass. `consumeAll` then
brings `onHand` and `reserved` down in the same transaction. Two admins pressing *Mark
shipped* at once ship once; the integration test does exactly that with `Promise.all`.

Verified against the dev database: shipping a two-unit order moved Espresso House Blend from
`onHand 8, reserved 5` to `6, 3`, with `available` untouched at 3.

`consumeAll` had been waiting since Phase 7 for this caller. It is still the only place
`onHand` moves outside an admin's own stock correction.

### Cancel before money moves; record a refund after

The machine allows `paid → canceled`. **The console does not offer it.** Canceling a paid
order would release the stock and keep the money, silently. The narrowing is
`ADMIN_CANCELABLE_FROM = ['pending_payment']`, passed into `transition` as `from` and applied
**in the query filter** alongside the machine's own predecessors — not in an `if` in front of
it.

A paid order that should not ship is **refunded**, and the console records the refund rather
than issuing it — see [ADR-013](decisions/ADR-013-refunds-are-recorded-not-issued.md). The
note is required, the dialog says in bold that no money moves, and any stock still held goes
back on the shelf once, through the same `stockReserved` claim the sweeper uses. A refund
after shipping restocks nothing: whether returned goods are fit to sell is a decision about
the goods.

### The repair button

`POST /api/admin/orders/:id/reconcile` is `reconcileOrderWithProvider` — the return page's
function — with `by: admin:<id>`. Phase 7 built it as the repair path for an order stranded
by a lost webhook and noted it wanted a button. It asks the provider, runs the same checks
and funnels into the same `markOrderPaid`, so pressing it twice, or on an order that is
already paid, does nothing.

An order is flagged **May be stranded** when it has a payment started and has sat in
`pending_payment` for fifteen minutes. The reservation lasts thirty; a quarter of an hour in,
a real payment has long since landed.

---

## Customers

Two things an admin can do to someone's access.

**Sign out everywhere** is `$inc sessionVersion` — Phase 5's nuclear revoke, effective on
their next request whatever Redis holds — followed by removing the sessions from Redis so the
device count is honest immediately. Not behind step-up: the person signs back in. Refused on
the admin's own account, which already has a button for it.

**Granting or removing `admin` ends all of that person's sessions.** Removing does not need it
for the role to lapse — roles are read per request (ADR-010) — but an open console tab should
stop working rather than 404 on its next click. Granting needs it more, for a less obvious
reason: the plan asks for a new session id at every privilege change, as session-fixation
defence, and an admin cannot rotate someone else's cookie. Ending every one of their sessions
is the only rotation available, and a complete one — a session id planted in their browser
before the grant is not an admin session after it.

Two refusals, both explained in place rather than as a failed request: an admin cannot change
their own role, and cannot remove it from an address on `ADMIN_EMAILS`, because the bootstrap
would grant it back at that person's next sign-in.

---

## The catalogue console

### The attribute builder

The form defines the fact; a panel beside it shows the fact as a shopper will meet it — in
the filter panel, as a row of the specification table, as a variant picker, and in the address
bar — and updates as the admin types. It is the one indulgence in the console, and it is
there because every choice on the form is a choice about what a shopper sees.

Key and type are permanent, and the form says why at the point of editing: the key is in
every bookmarked filter link and in the search index, and stored values live in a slot for
their type. The rules the form checks as you type — reserved keys, which types can filter,
which can be an axis — are in `lib/admin/attribute-rules.ts`, tested against the same cases
as the server's, which stays the authority.

### The category editor

The one screen that shows inheritance. Every attribute that applies to a shelf, each saying
whether this shelf set it or which ancestor it came from; local bindings editable in place;
inherited ones can be *hidden here* (suppressed) or *set here* (rebound, which clears the
suppression — the "suppress then rebind" ordering from ADAPTABLE-CATALOG.md, as two buttons).

### The product form

**Generated from the shelf.** A new product starts by choosing its category, because until
then there is nothing to ask. The "What it is" section is one control per attribute type,
built from the category's effective attribute set; nothing in the component names an
attribute. Two translations live in `lib/admin/product-form.ts` so they can be tested as
arithmetic:

- **Empty values are omitted, not sent as null.** The server's compiled schema treats a
  present-but-empty value as the wrong shape.
- **Prices are parsed by string arithmetic.** `parseFloat('19.99') * 100` is
  1998.9999999999998, and `'1,999.99'` would silently be one dollar. `parseMajorUnits`
  refuses anything it would have to guess at.

**The variant grid is planned in the browser**, in the same cartesian order as the server's
`planVariantGrid`, and merged into the rows already on the form: a row at a surviving
position keeps its price and stock, a new one starts from the first row's price and no stock.
Nothing exists until Save, which sends the whole product through `updateProduct` — the one
write pipeline, with its outbox row.

### `_id` and `id`, settled by rule

Phase 7 noted that the product endpoint returns `_id` while the listing returns `id`. Settled
by a rule rather than a rename: **a document returned whole keeps Mongo's `_id`; a projection
shaped by a presenter uses `id`.** Products, categories and attribute definitions are
documents; listing cards, orders, customers and every admin list are presentations.

---

## The storefront composer

The front page is a list of versions. The design is the plan's sentence — *publishing is a
version insert plus a status flip in one transaction, never an in-place edit* — plus the two
things it leaves out.

| Status | Meaning |
|---|---|
| `draft` | The one working copy. Edited in place, because it is not live, guarded by `revision`. |
| `published` | What the storefront serves. Exactly one per handle. |
| `retired` | Every version that has been live and replaced, kept whole. |

**The database enforces "exactly one".** One partial unique index,
`{handle, status}` over documents whose status is `draft` or `published`, allows any number
of retired versions to share a handle and refuses a second live one. The integration suite
inserts a second published version directly and gets E11000.

**Retire first, then promote.** MongoDB checks a unique index on each write, not at commit,
so promoting the draft first would collide with the version it replaces. If the promotion
then matches nothing — the draft was saved again, or someone else published it — throwing
aborts the transaction and the retirement rolls back with it. Two admins publishing the same
draft at once produce one published version, and the front page never passes through a
moment with none.

**Two people editing one draft** is the lost update. The save carries the revision it was
made against; a stale one is a 409 with the current revision, and the composer re-seeds from
the server.

**Rollback republishes the old version as itself**, not a copy, so the history reads as what
happened. Verified live: the front page went from the built-in default, to version 1, to
version 2, and back to version 1.

### A layout names things; the page renders them as they are now

Sections refer to categories and products by id, and either can be hidden or archived after
publishing. References are resolved **at read time** by the same resolver for the storefront
and the preview, and a stale one is skipped on the storefront and named in the preview's
warnings — "1 hand-picked product is not on sale and will not be shown". The alternative,
copying product cards into the version, freezes a price on the front page.

### Links are same-site paths

A published link is in front of every visitor, so `isInternalPath` refuses everything that
leaves the site: `https://`, `javascript:`, protocol-relative `//evil.test`, the backslash
spelling `/\evil.test`, and `/<tab>/evil.test`, which the URL parser strips down to `//`. The
last check resolves the path against a placeholder origin and requires the origin to survive.

### Publishing reaches a cached page

The home page is statically rendered with `revalidate = 300`, and the API cannot reach Next's
cache. After a successful publish the composer calls `refreshFrontPage`, a server action that
revalidates the `storefront` tag and `/` — and checks the caller is an admin, because a server
action is a public endpoint and one that lets anyone discard the cache is a cheap way to make
the shop work. On Cloudflare, tag revalidation depends on the incremental cache Phase 11 has
to configure; without it a publish shows within the five minutes.

---

## Today

The dashboard is written as sentences — "3 orders are paid for and not yet shipped", with the
way to them on the same line — not a large 3 with a label to translate. Each line is a queue
somebody can work down, money and parcels first. A queue with nothing in it says so, in the
muted ink and with no button, because "nothing is stuck" is information and the eye should
skip it.

---

## Defects found by building it

1. **A PATCH reset everything it did not mention — on all three catalogue update schemas.**
   They were `createSchema.partial()`, and in Zod 4 a field's `.default()` still fires inside
   `.optional()`. `PATCH { title }` parsed to `{ title, status: 'draft', attributes: {},
   variantAxes: [], variants: [], images: [] }` — a product quietly unpublished and emptied,
   with a 200. It shipped in Phase 2 and went unnoticed because nothing sent a partial body
   until the console did. The first Phase 8 test that edited an attribute's label found it, as
   a 400 when the reset option list failed validation; on a product it would have succeeded.
   `lib/zod-patch.ts` strips the defaults, and each schema has a test that a one-field PATCH
   parses to one field.
2. **Generating a variant grid bypassed the write pipeline.** The route set the variants and
   called `product.save()`: no outbox row, so the index never learned the new grid; no
   recomputed price range or stock flag; and no `available` maintained from `onHand`, so every
   generated variant was unsellable until someone edited it again. It now goes through
   `updateProduct`, with a regression test for all three.
3. **The attribute builder's address-bar preview could never show the key**, because the prop
   was named `key`, which React reserves and never passes to the component. Found in the
   browser console on the first render.
4. **Two console pages scrolled sideways at 375px** although every wide table was inside an
   `overflow-x-auto` box. The Radix checkboxes in those tables render a hidden, absolutely
   positioned native input, and an overflow box only clips an absolutely positioned
   descendant when it is that descendant's containing block. The scroll boxes are now
   `relative`. Found by measuring every ancestor of the table, after the first fix — giving the
   grid an explicit column — measurably changed nothing.
5. **`/admin` was titled "Today · Hæstore" while every other page read "· Admin".** A layout's
   `title.template` applies to the segments beneath it, not to the page in its own segment.

---

## What is deliberately not here

- **Review moderation and the support inbox.** Neither model exists yet — both are Phase 9 —
  and a console screen with nothing behind it is the disabled-button mistake Phase 4 declined
  to make. They arrive with their models.
- **Issuing refunds, and partial refunds.** ADR-013.
- **Image upload.** A product's photographs are Cloudinary public ids typed into the form. The
  signed direct upload belongs with the Unsplash-to-Cloudinary seeding in Phase 10.
- **Bulk actions.** Nothing in a catalogue of this size needs them yet.
- **A console outside the site chrome.** The site header stays above the console, deliberately:
  walking behind the counter does not take you out of the shop, and the header is the fastest
  way to see what a change did.
