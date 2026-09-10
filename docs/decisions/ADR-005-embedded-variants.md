# ADR-005 — Variants embedded on Product, not a separate collection

**Status:** Accepted · 2026-09-10

## Context

Products have purchasable variants (250 g whole bean, 1 kg ground) with their own SKU,
price, stock and images. The initial design put them in their own collection,
reasoning that atomic stock decrement required it.

## Decision

Variants are **embedded subdocuments** on `Product`, hard-capped at 100.

## The atomicity argument was wrong

A guarded update on a subdocument array is exactly as atomic as one on a separate
collection, because MongoDB's unit of atomicity is the **document**, and one product
document contains every variant a single order line touches:

```js
Product.findOneAndUpdate(
  { _id, variants: { $elemMatch: { _id: variantId, status: 'active',
                                   'stock.available': { $gte: qty } } } },
  { $inc: { 'variants.$[v].stock.available': -qty,
            'variants.$[v].stock.reserved':  +qty } },
  { arrayFilters: [{ 'v._id': variantId }] },
)
```

`null` means insufficient stock. Verified empirically at scaffold time: a second
decrement of 2 against a remaining stock of 1 is refused, leaving
`{ available: 1, reserved: 2 }`. See `scripts/probe-infra.mjs`.

## What actually decided it

- **Every listing card needs a price range and an in-stock flag.** Embedded, they are
  already in the document just fetched. Separate, that is a `$lookup` per product on
  every listing render, or a denormalized cache that needs syncing anyway.
- **The product detail page becomes one read** — product, variants, axis values and
  images in a single round trip.
- **Faceting is unaffected**, because facets come from Meilisearch and the index
  document is product-grain either way.
- **Size is a non-issue**: image *references*, not bytes, so a 100-variant product is
  well under 100 KB against a 16 MB limit.

## Why `stock.available` is stored rather than derived

It could be computed as `onHand - reserved`. Comparing two fields *inside an array
element* requires `$expr`, which is **not permitted inside `$elemMatch`** — forcing an
aggregation-pipeline update whose success must be inferred from `modifiedCount`.
Storing `available` makes the guard a plain predicate, and therefore atomic for free.

The cost is a maintained invariant: `available + reserved === onHand`. A nightly job
asserts it across every variant and alarms on drift, which is how the bug gets found
rather than discovered as negative inventory three weeks later.

## Consequences

- Two concurrent orders for different variants of the same product serialise on one
  document. The lock is held for microseconds and WiredTiger retries transparently.
- A hard cap at 100 variants, warning at 24, with the generated count shown before
  the admin commits — three axes of five values is 125, reachable in two clicks.
- The escape hatch is preserved: `variantId` is a real `ObjectId` on every cart and
  order line, so nothing outside the product service dereferences a variant through
  its parent, and lifting them to a collection later touches one module.
