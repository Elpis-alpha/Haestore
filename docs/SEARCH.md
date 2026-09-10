# Search

Meilisearch is the storefront read model. Everything a shopper sees on a listing — the
products, their order, the filter panel and its counts — comes from an inverted index
that is derived from MongoDB and never authoritative over it.

Why it is not a MongoDB query is settled in [ADR-003](decisions/ADR-003-meilisearch-read-model.md)
and not repeated here. This document is about how the index is kept **true**, which is the
part that takes real work: an index that is merely fast is a liability the first time it
disagrees with the database.

- **[The document](#the-document)** — what is in the index, and what is deliberately not
- **[Derived settings](#derived-settings)** — how runtime attributes reach a static config
- **[Keeping it true](#keeping-it-true)** — the outbox, the relay, the sweep, reconciliation
- **[Querying](#querying)** — the trust boundary, disjunctive facets, degradation
- **[Rebuilding](#rebuilding)** — swap, never in place
- **[Operating it](#operating-it)** — commands, env, and what the log lines mean
- **[Three ways this silently broke](#three-ways-this-silently-broke)**

---

## The document

`src/search/product-document.ts`. One document per **product**, not per variant.

It is a projection for listing, carrying exactly what a card renders plus what a filter,
sort or facet needs. The variant array, stock figures, validation state and the full image
list stay in Mongo, which serves the product page. The index should never become a second
copy of the catalogue, because the moment something reads a price from it the two are free
to disagree.

Two rules govern it.

**Only `active` products are in the index at all.** A draft is not stored with
`status: 'draft'` and filtered out later — it is *deleted* the moment it stops being
active. `status` is still stored and still filtered server-side, because when the failure
mode is publishing an unfinished product, two independent reasons for it not to appear is
the right number.

**Attribute values live under a single `attr` object**, so a key an admin invented becomes
the filter name `attr.<key>`. `AttributeDefinition.key` matches `^[a-z][a-z0-9_]{1,39}$`,
which contains no dot, so the nesting is unambiguous and needs no escaping.

```jsonc
{
  "id": "…", "title": "Ethiopian Yirgacheffe", "slug": "ethiopian-yirgacheffe",
  "categoryId": "…", "categoryAncestors": ["…", "…"],
  "status": "active",
  "priceMin": 1800, "priceMax": 3200, "currency": "USD", "inStock": true,
  "createdAt": 1767225600000, "publishedAt": 1769904000000,   // epoch ms — Meili sorts numbers
  "image": { "publicId": "…", "alt": "…", "blurDataUrl": "…" },
  "attr":  { "roast": "light", "weight_g": 250, "tags": ["organic"] },
  "attrText": "Ethiopia · Washed"                              // only isSearchable definitions
}
```

Values land in the slot their type dictates. `dimension` is deliberately omitted: three
numbers and a unit have no single ordering to range over and no equality a shopper would
recognise (20×10×5 and 10×20×5 are the same box). Its display value still reaches the
index through `attrText` when the definition is searchable.

A product with no priceable variant is still indexed, at price zero. Dropping it would be
a product that is active, in the shop, and invisible — with nothing anywhere to explain
why.

---

## Derived settings

`src/search/settings.ts`.

Meilisearch requires `filterableAttributes` up front, which looks like a flat
contradiction of admin-defined attributes: you cannot list what does not exist yet. It is
not a contradiction, because the list is **computed, never authored**. Every live
definition marked filterable becomes `attr.<key>`, merged with a fixed base list. Defining
an attribute is therefore a settings change, not a deploy.

```
AttributeDefinition.find({ archivedAt: null })
  → filter by isFilterable AND isFilterableType(type)
  → map to `attr.<key>`
  → merge with status, categoryId, categoryAncestors, priceMin/Max, currency, inStock, ratingAverage
```

`isFilterableType` excludes `text` and `dimension`. Marking a text attribute filterable is
not an error worth reporting — it is a control that cannot work, and **the same guard
drops it from the generated filter panel**. Applying it in only one place is how you get a
panel offering a filter the index refuses to answer, or a control whose every click 400s.

Two details are load-bearing:

- **The output is sorted.** Meilisearch compares submitted settings against current ones
  and does nothing when they match. An unstable ordering would make every sync look like a
  change and re-index the corpus on a schedule.
- **Sorts are a whitelist.** A client sends `sort=price_asc`, never a Meilisearch sort
  expression. Someone who could name the sort field could order by anything in the
  document and read it out through pagination.

### The debounce

`updateSettings` triggers a partial re-index, so six admin saves must produce one task,
not six. A definition write enqueues a settings job **30 seconds out under the fixed job
id `settings-sync`**; re-enqueuing while one is already waiting collides with that id and
is dropped.

There is no timer in this process and no state to lose — which matters, because the
process handling the sixth save is not necessarily the one that handled the first.

---

## Keeping it true

This is the part that earns its complexity.

The obvious way to keep an index current has a bug one line wide:

```ts
await product.save();
await queue.add('index', { id: product.id });   // ← crash here
```

A crash between those two statements leaves a product saved in Mongo and absent from the
index, permanently and silently. Nothing failed, so nothing is logged; the product simply
never appears in the shop again. Reversing the order trades it for the opposite bug.

No arrangement of two systems makes those writes atomic. So only one system is written.

```
   admin write ─┐
                ├─ ONE MongoDB transaction ──▶ committed together, or not at all
  outbox row ───┘
                          │
                          │  change stream (milliseconds)
                          ▼
                     BullMQ queue ──────────▶ worker ──▶ Meilisearch
                          ▲                   (re-reads from Mongo)
                          │
              sweep every 60s (safety net)
```

### The outbox

`src/search/outbox.model.ts`. `appendOutbox(session, …)` takes a session and the argument
is **not optional by accident**: an append outside the transaction would just move the
crash window rather than close it. Every mutating path in `product.service.ts` goes
through one `inWriteTransaction` helper, so there is exactly one place where "the product
changed" and "the index must be told" are paired, and no way to add a write that forgets
the second half.

Four kinds:

| kind | emitted by | what the worker does |
|---|---|---|
| `product` | create / update / recategorise / archive | rebuild that one document, or delete it |
| `category-branch` | category rename or move | reindex every product beneath it |
| `attribute-definition` | a definition edit | re-render denormalised `displayValue`, then reindex |
| `settings` | any definition write | re-derive `filterableAttributes` (debounced) |

`category-branch` is one row for an unbounded number of products on purpose. A row per
product would add tens of thousands of inserts to a transaction that is already rewriting
tens of thousands of documents, and a transaction that large exceeds its lifetime limit
and rolls the rename back.

`attribute-definition` exists because `displayValue` is denormalised onto every product so
the specification table needs no lookup. Renaming the option `medium` from "Medium" to
"Medium roast" leaves every product holding the old string; the backfill re-renders them
using the *same* `toDisplayValue` the write path uses, because a second implementation
would drift and produce two spellings of one attribute across the catalogue.

### The relay, and the sweep beneath it

`src/search/relay.ts`. A change stream on `search_outbox` is the fast path — an insert
reaches the queue within milliseconds, no polling. It is also why the local stack insists
on a replica set: a standalone `mongod` has no change streams, which `scripts/probe-infra.mjs`
asserts rather than assumes.

Underneath sits a **sweep** every 60 seconds for anything unprocessed and older than 30
seconds, and the sweep is what makes the design honest. The stream can miss work in ways
invisible from inside it: the process was down when the row was written, the resume token
has fallen off the oplog, the enqueue itself failed. The stream makes indexing fast; the
sweep makes it certain.

Re-delivery is expected and harmless. **The payload is a hint; Mongo is the truth** — the
worker rebuilds each document from the database, so indexing a product twice produces the
same index, and a job drained long after the product changed again converges on the
current state rather than an old one.

Only one process runs the stream, held by a Redis lease that is contested on a timer.
Trying only at startup means a crashed leader takes the fast path down with it until
someone restarts a process — see [below](#three-ways-this-silently-broke).

### Reconciliation

`src/search/reconcile.ts`, hourly. Compares document counts and re-pushes anything
modified since the last run. It **warns rather than self-heals**: a non-zero drift is
nearly always tasks still settling inside Meilisearch, and a routine that reacted by
rebuilding would rebuild constantly under normal load. A real rebuild is a command an
operator runs knowingly.

---

## Querying

### The trust boundary

`src/search/filter-expression.ts`. Everything above it is a string a stranger typed into a
URL; everything below is a filter DSL the search server will execute. **The frontend never
talks to Meilisearch directly**, and this is why.

The attack is concrete, and was reproduced against a real server before the code was
written. Interpolated raw:

```
attr.glaze = "celadon" OR status = "draft"     → returns the drafts
```

Escaped:

```
attr.glaze = "celadon\" OR status = \"draft"   → returns nothing
```

Both behaviours are asserted — in `filter-expression.test.ts` and, as a claim about the
platform rather than about our code, in `scripts/probe-infra.mjs`.

Three defences stack, each sufficient alone, which is the point when the consequence of
the last one failing is publishing unfinished products:

1. A parameter must name an attribute the **category actually binds** and that is
   filterable. Anything else never reaches the DSL.
2. Discrete values must appear in the **definition's own option list**; numbers must
   survive `Number()` and are clamped to the definition's declared bounds. Nothing is
   interpolated that did not come from our database.
3. Values are escaped and quoted, and `status = "active"` is appended server-side — not a
   default a caller can override, and not a parameter.

A dropped filter is **reported, not hidden**. A bookmarked URL outlives the attribute it
names; rejecting it would 400 a page the shopper reached from their own history, and
dropping it silently would show different results with no explanation. So `ignoredFilters`
says which and why.

### Disjunctive facet counts

`src/search/facets.ts`. The subtle part, and the one that survives manual testing while
being wrong, because the counts are *plausible*.

Checkboxes within one attribute are OR'd. Tick "Dark" under Roast and you expect the panel
to keep offering Light and Medium with the counts you would get by ticking those too. But
the query that produced the results already contains `attr.roast IN ["dark"]`, so the
distribution is computed over dark products only — and Light and Medium do not read `0`,
they **vanish from the response entirely**. The panel appears to lose its own options the
moment you use it.

Measured on Meilisearch 1.11:

```
filter: status = "active"                            → {dark: 1, light: 1, medium: 1}
filter: status = "active" AND attr.roast IN [light]  → {light: 1}
```

The fix is one extra search per **selected** group, each computing that group's
distribution with **its own filter removed and every other filter kept**, at
`hitsPerPage: 0` so it returns counts and no documents. Unselected groups need nothing —
their counts are already correct, because nothing filtered them.

So an unfiltered listing is one query. Cost grows only with how far the shopper has
narrowed, capped at 12 groups, and all of it goes in one `/multi-search` — one round trip
regardless.

Live, with `process=natural` selected:

```
roast     light:1  medium:0  dark:1        ← narrowed by process, not by roast
weight_g  {"min":250,"max":1000}           ← full bounds, so the slider can widen again
process   washed:2  natural:2*  honey:1    ← its own counts, as if nothing were selected
```

The price and range facets get the same treatment for the same reason: a slider whose
bounds collapse to the range already chosen can never be dragged back out.

A declared value that currently matches nothing is emitted as `0`, not omitted. That is
the whole point — the shopper needs to see that Light exists and matches nothing, not
watch it disappear.

### Degradation

One endpoint, `page.degraded` says which engine answered. See
[ADR-009](decisions/ADR-009-one-listing-endpoint-that-degrades.md) for why there is not a
second URL, why pagination is page-based, and how the index-capability gate closes the
window where a freshly defined attribute would otherwise take the panel down.

---

## Rebuilding

`src/search/reindex.ts` · `npm run search:reindex [-- --force]`

The naive rebuild — `deleteAllDocuments()` then re-add — is wrong in a way that only shows
up in production: for however long it takes, the shop is **empty**. Not slow, not stale.
Every listing returns nothing and every category looks discontinued.

So the rebuild happens in `products_rebuild`, which nobody reads, and the two are swapped
atomically. Readers see the old index until the instant they see the new one, and the old
one survives under the rebuild alias as a free rollback.

Two things were established against a real server rather than assumed:

1. **A swap exchanges settings along with documents.** Swapping in an index whose settings
   were never configured leaves the live index with `filterableAttributes: []` and every
   storefront filter returning 400. So settings are applied to the rebuild index *before*
   the swap.
2. **The count guard runs before the swap**, because after is too late.

The guard refuses a rebuild that **found nothing at all** while documents are live — the
shape a wrong `MONGODB_URL`, an unfinished restore or a fresh `mongod` actually takes — and
separately refuses a shrink below 90% once there are at least 50 live documents. The floor
matters: in a four-product shop, archiving one is a 25% drop, and refusing it would teach
an operator that `--force` is the normal way to run a rebuild, which is precisely the habit
the guard exists to prevent.

---

## Operating it

```bash
npm run search:reindex           # rebuild + atomic swap
npm run search:reindex -- --force  # skip the count guard (a decision, not a habit)
npm run search:reconcile         # one reconciliation pass, by hand
npm run probe                    # 15 platform assertions, 4 of them Meilisearch
```

| variable | default | meaning |
|---|---|---|
| `MEILISEARCH_HOST` | `http://127.0.0.1:7700` | |
| `MEILISEARCH_API_KEY` | — | master key in development |
| `MEILISEARCH_INDEX_PREFIX` | `''` | integration tests set `test_` so a run cannot swap away a live index |
| `SEARCH_INDEXING_ENABLED` | `true` | runs the relay and worker in this process |
| `SEARCH_SETTINGS_DEBOUNCE_MS` | `30000` | |

The relay and the worker run **inside the API process**, which is right for a
single-container deployment and wrong for several. Both are switchable, and the relay holds
a Redis lease regardless, so leaving it on everywhere is safe — just wasteful.

Log lines worth recognising:

```
search: took the relay lease                    this process runs the change stream
search: another process holds the relay lease   normal with >1 replica; it retries on a timer
search: settings synced                         filterableAttributes now match the catalogue
search: outbox sweep drained rows the stream missed    the safety net did something — investigate if frequent
search: listing failed, falling back to MongoDB  every one of these is a shopper with no filter panel
search: index and database disagree on document count   usually tasks settling; persistent means reindex
```

---

## Three ways this silently broke

All three were found by running the thing, not by reasoning about it, and all three share a
signature: **nothing threw, nothing logged, and the index simply stopped being true.** They
are recorded because each is easy to reintroduce.

### 1. A colon in a BullMQ job id

Job ids were `product:<id>`. BullMQ namespaces its own Redis keys with colons and **rejects
a custom id containing one** — `Custom Id cannot contain :`, thrown at enqueue time, caught
and logged by the relay. So the outbox filled, the relay reported dispatching, and nothing
was ever indexed. Ids are now joined with `__`.

### 2. Retained completed jobs suppressing the next enqueue

A custom job id is unique across every state BullMQ **retains**, `completed` included, and
`add()` with an existing id creates nothing and reports success. With
`removeOnComplete: { count: 100 }`, the second edit of a product whose job id was still
retained was silently discarded — the outbox row written, the relay reporting it
dispatched, the index never told.

Observed as: one settings sync completed, and every later one was dropped forever, so a
newly defined attribute never reached the index.

`removeOnComplete: true` frees the id on completion, which restores the intended meaning:
an id collides only while the work is still outstanding, which is the debounce that is
wanted and none of the suppression that is not.

### 3. Leader election that only ran once

The relay took the Redis lease at startup and, if another process held it, logged
`sweeping only` and never asked again. A process that crashed seconds after taking the
lease left its key to expire — and the next process, having already given up, never opened
a stream at all. Correctness survived on the 60-second sweep; the fast path was gone until
someone restarted something, with nothing reporting it.

The lease is now contested on the same timer that renews it.

Each has a regression test, and the second has one asserting the queue's *configuration*
rather than its behaviour — because the failure it prevents leaves no trace anywhere else.
