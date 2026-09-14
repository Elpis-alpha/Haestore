# Data model

Collections as they exist after Phase 2. Cart, Order, User, Review, Wishlist,
SupportTicket and StorefrontLayout arrive in later phases and are described in the plan.

Companion documents: [ADAPTABLE-CATALOG.md](ADAPTABLE-CATALOG.md) for how the attribute
system behaves, [ADR-005](decisions/ADR-005-embedded-variants.md) for embedded variants,
[ADR-008](decisions/ADR-008-typed-attribute-values.md) for the typed value array.

---

## Money, everywhere

`{ amount: <integer minor units>, currency: 'USD' }`. Never a float, never a formatted
string parsed back, never a bare number whose unit you have to remember.

The 2022 cart stored each line's *extended total* in a field called `price` and
recovered the unit price by dividing by quantity, so three items at $9.99 round-tripped
correctly only by luck. Integers make that unrepresentable. The minor-unit exponent is
read from `Intl` rather than hardcoded, because the exceptions (JPY 0, KWD 3) are the
whole problem and a hand-written table is a list of the ones you remembered.

---

## AttributeDefinition

`key` (unique, **immutable**), `label`, `type`, `unit?`, `options[]`, `isFilterable`,
`isSearchable`, `isVariantAxis`, `filterUi`, `validation{}`, `archivedAt?`

Types: `select`, `multiselect`, `text`, `number`, `boolean`, `color`, `dimension`.

Indexes: `{ key }` unique · `{ archivedAt, label }` for the admin list ·
`{ isFilterable, archivedAt }`, which is exactly what the derived Meilisearch settings
read in Phase 3.

---

## Category

`name`, `slug`, `path` (unique), `parent`, `ancestors[]`, `depth`, `order`,
`attributeBindings[]`, `suppressedKeys[]`, `validationMode`, `status`

**`ancestors` includes self.** "Everything under Coffee & Tea" is
`{ ancestors: coffeeTeaId }` — one equality predicate against one index, no
`$graphLookup`, no recursion at read time. The cost is that a rename or a move rewrites
descendants, which happens in a transaction.

`path` is the same ancestry in human form (`coffee-tea/beans`) and is what the storefront
URL uses. It is the unique key rather than `slug`, so "beans" can exist under more than
one parent without a naming fight.

`attributeBindings[]` carries the definition's `key` denormalised, so resolution can
answer "which keys apply here" without loading every definition first.

Indexes: `{ path }` unique · `{ parent, order }` · `{ ancestors, status }`.

---

## Product

### Attribute values are a typed array

```ts
attributes: [{
  key, defId, type,
  valueString?, valueStrings?, valueNumber?, valueBool?, valueDim?,
  unit?, displayValue, order, group?
}]
```

One nullable field per kind, and a total mapping from type to slot. `displayValue` is
the rendered form, denormalised at write time, so the specification table is a single
document read.

Both obvious alternatives were rejected, and both were verified against a real MongoDB
rather than reasoned about — see `scripts/probe-infra.mjs`, which asserts all three of
these permanently:

- **A compound index over two fields of the same array element is accepted.**
  `{ status, 'attributes.key', 'attributes.valueString' }` builds fine, and so does the
  `valueStrings` version — an array *inside* an array element is still one multikey
  path, so the multiselect case works.
- **Two different array paths in one index are refused**, with
  `CannotIndexParallelArrays`. That is why `categoryAncestors` is not in the attribute
  index, and a large part of why the storefront reads from Meilisearch (ADR-003): a
  branch filter and an attribute filter cannot share an index.
- **A range query on a typed numeric slot uses an IXSCAN.** "Weight between 250 and
  1000 g" is answerable by an index — which a `Mixed`-typed `{ key, value }` pair could
  never be, because a Mixed index only compares within one BSON type bracket.

### Variants are embedded, capped at 100

Atomicity is not the discriminator: a guarded `findOneAndUpdate` with `arrayFilters` on
a subdocument array is exactly as atomic as one on a separate collection, because
MongoDB's unit of atomicity is the document and one product contains every variant an
order line touches. This was verified on a real replica set before the design was
settled (ADR-005).

What decides it is that every listing card needs a price range and a stock flag — free
when embedded, a `$lookup` per product or a denormalised cache you must sync anyway when
separate — and that the product page becomes one read. Every variant has a real
`ObjectId`, so cart and order lines reference variants exactly as they would if this were
later lifted into its own collection.

### Stock

`{ onHand, reserved, available, lowStockThreshold, backorderable }`

**`available` is stored, not computed.** Comparing two fields inside an array element
needs `$expr`, and `$expr` is not allowed inside `$elemMatch`. Deriving it would force
the reservation guard into an aggregation-pipeline update whose success has to be
inferred from `modifiedCount` rather than read from the returned document. Storing it
makes the guard a plain predicate, and therefore atomic for free:

```js
Product.findOneAndUpdate(
  { _id, variants: { $elemMatch: { _id: variantId, status: 'active',
                                   'stock.available': { $gte: qty } } } },
  { $inc: { 'variants.$[v].stock.available': -qty,
            'variants.$[v].stock.reserved':  +qty } },
  { arrayFilters: [{ 'v._id': variantId }], session })
```

`null` means insufficient stock. The probe confirms a second reservation of 2 against a
remaining 1 is refused. The invariant `available + reserved === onHand` is asserted by a
nightly sweep against the stock ledger (Phase 7) and alarms on drift rather than
silently self-healing.

An admin lowering `onHand` below what is already reserved does not cancel those orders:
`available` floors at zero and the discrepancy is left for the sweep.

### Denormalised for listing

`categoryAncestors[]` copied from the category · `priceRange { min, max, currency }` and
`inStock`, computed from **active variants only** — an inactive $2 variant must not drag
a card's "from" price to something nobody can buy.

### Review state

`needsAttention` and `validationIssues[]`, set by lenient validation instead of rejecting
a write. Nothing else changes behaviour because of them; in particular a flagged product
still sells. They are stripped from every public response.

### Indexes

| Index | For |
|---|---|
| `{ slug }` unique | the product page |
| `{ status, categoryAncestors, 'priceRange.min' }` | branch listing, ordered by price |
| `{ status, 'attributes.key', 'attributes.valueString' }` | attribute filter, degraded path |
| `{ status, 'attributes.key', 'attributes.valueNumber' }` | numeric attribute range |
| `{ 'variants.sku' }` unique, partial | SKU uniqueness where one is set |
| `{ needsAttention, updatedAt }` partial | the admin's "needs attention" queue |

---

## StorefrontLayout

`storefront_layouts`. One document per **version** of a composed page, never edited once
published. See ADMIN.md, "The storefront composer".

| Field | |
|---|---|
| `handle` | Which page. Only `home` today. |
| `version` | Monotonic per handle. |
| `status` | `draft`, `published` or `retired`. |
| `sections` | `Mixed` — a discriminated union Mongoose cannot express, validated by Zod on every write. References to products and categories are ids, resolved at read time. |
| `revision` | Bumped on each draft save; a save carrying a stale one is refused. |

| Index | For |
|---|---|
| `{ handle, version }` unique | addressing a version |
| `{ handle, status }` unique, partial on `status ∈ {draft, published}` | **at most one draft and one live version per page**, enforced by the database |

## AdminAudit

`admin_audit`. One row per admin mutation that succeeded: actor, method, the declared route
pattern, target id, status, request id, time. No body and no diff, and no TTL.

Indexes: `{ at }` for the log, `{ targetId, at }` for one record's history,
`{ actor.userId, at }` for one admin's.

## Order, for the console

Phase 8 added one index: `{ status, createdAt }`, for the admin order list filtered by
status and the dashboard's counts.

---

## Rules every list endpoint follows

A **mandatory projection**, a **default page size of 24** and a **maximum of 60**, and
**keyset pagination, never `.skip(n)`**.

The 2022 listing had none of these: it ran with no projection and no limit, so one
request returned every field of every item — image buffers stored in the document
included — for the entire catalogue.

Every sort ends in `_id` so the sort key is total. Without that tiebreak, two products at
the same price have an unstable order and a cursor can skip or repeat one.
