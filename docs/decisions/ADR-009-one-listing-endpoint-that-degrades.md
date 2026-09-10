# ADR-009 — One listing endpoint, which degrades and says so

**Status:** accepted · Phase 3

## Context

Storefront listing is served by Meilisearch (ADR-003), and Meilisearch is a derived store
that can be down, cold, or mid-rebuild while MongoDB is perfectly healthy. Something has
to happen when it is unavailable, and the shape of that fallback is a public API decision
rather than an implementation detail: it changes what the storefront has to know.

MongoDB can answer *most* of the listing query — category, stock, price, sort, pagination
are all covered by the compound index Phase 2 built. What it cannot answer is the part
Phase 3 exists for: attribute filters and facet counts, which need a multikey intersection
stacked on a blocking in-memory sort, which is precisely the query shape ADR-003 exists to
avoid.

So the fallback is not "the same thing, slower". It is genuinely less.

## Decision

**`GET /api/catalog/products` is the only listing endpoint.** It serves from Meilisearch,
falls back to MongoDB on any search failure, and reports which happened:

```jsonc
{
  "data":  [ /* cards, identical in both cases */ ],
  "page":  { "page": 1, "perPage": 24, "total": 137, "totalPages": 6, "degraded": false },
  "facets": [ /* the generated panel — null when degraded */ ],
  "ignoredFilters": [ { "key": "roast", "reason": "…" } ]
}
```

`degraded: true` means MongoDB answered: `facets` is `null`, and every attribute
parameter comes back in `ignoredFilters` with a reason. The storefront hides the filter
panel rather than rendering controls that would not be applied.

Pagination is **page-based** rather than the keyset cursor Phase 2 used.

## Alternatives

### Two endpoints, one per engine

`/products` for search and `/products/basic` for the fallback, with the client choosing.

Tempting because each endpoint is then honest about exactly what it does, and neither has
a conditional in it. Rejected for one reason that outweighs that: **a fallback behind a
separate URL is a fallback nobody ever exercises.** It would be written once, never
requested by the storefront under normal conditions, and would rot until the day it was
needed. Behind the same URL it is on the same code path as every other request, and the
integration suite hits it by simply not building an index.

It also pushes a health decision to the client. The storefront would have to discover that
search is down in order to switch, which means either probing or interpreting a failure —
both of which are the server's job.

### Fail the request when search is down

Return 503 and let the shop go dark.

Genuinely defensible: a filter panel that silently stops filtering is a worse lie than an
error page. It is rejected because the two are not the alternatives on offer — the third
option is to serve the catalogue and *say* the panel is unavailable, which loses nothing
except the filtering itself. A shop that cannot be filtered still sells. A shop that
returns an error page does not.

The lie only exists if the degradation is silent, which is what `degraded` and
`ignoredFilters` are for.

### Keep the keyset cursor

Phase 2's listing paged by cursor, deliberately: `.skip(n)` re-reads and discards every
preceding document, so page 40 costs forty pages of work.

Meilisearch paginates by offset and bounds depth with `maxTotalHits` (1000 by default), so
a cursor would have to be **emulated on top of an offset** — carrying the offset inside an
opaque token and pretending. That is strictly worse than an honest page number: same cost,
less legible URL, and a token that means nothing.

The reason skip is affordable in the fallback is that same bound. Both engines refuse the
same pages, so the deepest reachable page skips at most 1000 documents. Making the two
paths agree about which pages exist was worth more than keeping the cursor.

The plan's canonical URL already said `page=2`.

## Consequences

- The storefront handles one response shape and branches on one boolean.
- The fallback is exercised by every test run that does not build an index, so it cannot
  rot unnoticed.
- Deep pagination is capped at 1000 documents in both engines. Beyond that the answer is
  "narrow your filters", which is also what a shopper should be doing.
- `ignoredFilters` carries real weight: it is the difference between showing unfiltered
  results and *claiming* to have filtered them. Anything that drops a filter — an archived
  attribute, a category that never bound it, an index that has not caught up — must report
  it there.

## The window this made safe

A related failure was found by running the thing rather than reasoning about it, and it is
recorded here because the fix lives on this endpoint.

`filterableAttributes` is derived from the attribute definitions but synced on a **30-second
debounce**, because `updateSettings` triggers a partial re-index. The filter panel, though,
is generated from the definitions *immediately*. For the length of that window the listing
would ask Meilisearch to facet on a field it did not yet have — and Meilisearch rejects the
**entire request** for an unknown facet, not just that facet.

So defining one attribute took the whole filter panel down for every shopper in that
category, and the listing quietly fell back to MongoDB until the debounce elapsed.

The fix is on the read side, in `search/index-capabilities.ts`: the listing asks the index
what it can currently filter on and requests only that, refreshed every ten seconds. An
attribute defined seconds ago has no facet for a few seconds — which nobody notices —
instead of destroying the panel, which everybody does. A filter on it is reported in
`ignoredFilters` rather than failing the request.
