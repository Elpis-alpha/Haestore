# ADR-003 — Meilisearch as the storefront read model

**Status:** Accepted · 2026-09-10

## Context

The defining feature of Hæstore is admin-defined product attributes with a storefront
filter UI generated from them. The listing query is therefore: filter by category,
filter by two or three attributes chosen at runtime, sort by price or recency, and
return facet counts for every unselected value.

## Decision

Meilisearch serves all storefront listing, filtering, sorting, faceting and search.
MongoDB serves the product detail page, cart, checkout, admin, and a degraded
no-facet fallback.

## Why not MongoDB aggregation

This looks like a missing-index problem and is not, which is why it is written down.

`{status, categoryAncestors, 'attributes.key', 'attributes.valueString'}` gives an
indexed *filter*. Add `.sort({ 'priceRange.min.amount': 1 })` and MongoDB performs a
**blocking in-memory sort**, capped at 32 MB. Add a second attribute filter and you are
intersecting multikey index bounds with no sort support at all, then stacking a
`$facet` on top to count.

No compound index fixes this, because a multikey filter on an unbounded set of runtime
attribute keys cannot also provide sort order. It is the shape of the query.

Meilisearch computes hits and `facetDistribution` from an inverted index in one
sub-millisecond request, and typo tolerance, prefix matching and synonyms come free.

## Dynamic attributes vs. static index settings

Meilisearch requires `filterableAttributes` declared up front, which appears to
conflict with admin-defined attributes. It does not: the list is **derived, not
authored**. `buildSearchSettings()` reads every `AttributeDefinition` with
`isFilterable`, maps each to `attr.<key>`, and merges with a fixed base list.

Definition writes enqueue a **debounced** (30 s) settings-sync job, because
`updateSettings` triggers a partial re-index and six admin saves must produce one task,
not six.

This is also why `AttributeDefinition.key` is immutable — see ADR-005's sibling note:
the key is simultaneously a Meilisearch filter name, a public URL parameter, a stored
value key, and a variant-axis identifier.

## Consequences

- A new infrastructure dependency, and a sync path that must be kept correct — handled
  by a transactional outbox plus an hourly reconciliation sweep.
- Facet counts are **product** counts. With two or more *axis* attributes selected, a
  product can match on values that no single variant combines. Accepted for now;
  the additive fix (`variantKeys`) is specified and deferred.
- Disjunctive counts need one extra query per *selected* group, batched into a single
  `/multi-search`. An unfiltered listing remains a single query.
