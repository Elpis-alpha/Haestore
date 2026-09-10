# ADR-008 — Attribute values are a typed array, not a Map or a key/value pair

**Status:** accepted · Phase 2

## Context

A product needs to store values for attributes an administrator defined after the code
shipped. Three shapes were available, and the two rejected ones are the ones that look
simpler.

## Alternatives

### A `Map` of key to value

Reads beautifully: `product.attributes.get('roast')`.

It needs either **one index per key** — unbounded growth as admins define attributes — or
a **wildcard index**. And a wildcard index supports only a **single predicate**, so it can
never be compounded with `status` plus `categoryAncestors` plus a sort. That is the shape
of every listing query, so the one query that matters most is the one it cannot serve.

### `{ key, value }` with a `Mixed` value

The obvious relational translation.

A `Mixed` index only compares **within a BSON type bracket**, so "weight between 250 and
1000 g" cannot be answered by an index at all. It also has no type to validate against,
which makes `{ key: 'roast', value: true }` a legal document — defeating the entire point
of defining attributes.

## Decision

A typed array. One nullable field per kind, and a total mapping from type to slot:

```ts
attributes: [{ key, defId, type,
               valueString?, valueStrings?, valueNumber?, valueBool?, valueDim?,
               unit?, displayValue, order, group? }]
```

## Verification

Asserted against a real MongoDB, permanently, in `scripts/probe-infra.mjs`:

- `{ status, 'attributes.key', 'attributes.valueString' }` **builds**. So does the
  `valueStrings` variant — an array inside an array element is still one multikey path,
  so multiselect works.
- `{ status, categoryAncestors, 'attributes.key' }` is **refused** with
  `CannotIndexParallelArrays`.
- A range query on `valueNumber` inside `$elemMatch` produces an **IXSCAN**.

The third is the claim the design exists to make true, and the second is a finding that
shaped the architecture rather than merely confirming it.

## Consequences

**Good.** Attribute filters and ranges are indexable. Values are type-checked at the
storage layer as well as by the runtime validator. `displayValue` makes the specification
table one document read.

**The cost.** Five nullable fields where a Map would have one. Writing a value means
choosing a slot, which is centralised in one function so the choice is made once.

**The constraint it revealed.** Because a branch filter and an attribute filter cannot
share a compound index, no single Mongo index can serve "products under Coffee & Tea,
medium roast, sorted by price". That is not a tuning problem, it is the shape of the
query — and it is a significant part of why the storefront reads from Meilisearch
(ADR-003) rather than Mongo.
