# Architecture

## Three repos, not a monorepo

```
haestore/          root   — docs, brand assets, local infrastructure
├── front-end/     repo Haestore-FE — Next.js 15, deployed to Cloudflare Workers
└── back-end/      repo Haestore-BE — Express 5, deployed as a Docker container
```

The root repo `.gitignore`s `front-end/` and `back-end/`, so the three histories stay
independent and each application deploys on its own.

A `packages/shared` workspace was considered and rejected: a `file:../shared`
dependency stops `front-end/` from building standalone, which Cloudflare requires.

## Keeping types in sync across the boundary

The backend owns the contract.

```
Zod schemas  ──zod-to-openapi──▶  back-end/openapi.json
                                        │
                                  openapi-typescript  (npm run sync:types)
                                        ▼
                          front-end/src/lib/api/schema.d.ts   (committed)
```

Both repos build independently, and a response shape cannot drift from the type the
client expects without the generated file changing in a reviewable diff.

## Request paths

There are two, and the distinction is load-bearing.

**Catalog reads** go straight from Next Server Components to Express, server-side,
with tag-based revalidation. No cookie is involved, so no proxy is needed.

**Everything session-bearing** — auth, cart, wishlist, checkout, orders — goes through
a Next `rewrites` proxy (`/api/:path*` → `API_ORIGIN/api/:path*`) so the browser only
ever sees one origin. That is not a convenience:

- it is what makes the `__Host-` cookie prefix legal (it forbids a `Domain` attribute),
- it removes CORS and preflight entirely,
- it avoids `SameSite=None`, which third-party-cookie blocking now breaks,
- and it prevents the classic failure where auth works locally and breaks in
  production because the two halves ended up on different registrable domains.

**One exception:** the Stripe webhook must reach Express directly. Signature
verification needs the exact raw bytes, and a proxy that re-serialises the body
invalidates every signature.

## Data stores, and what each is allowed to own

| Store | Owns | Never owns |
|---|---|---|
| **MongoDB** | Everything durable: catalog, carts, orders, users, tickets | Ephemeral auth state |
| **Redis** | OTP challenges, sessions, rate limits, caches, BullMQ queues | Anything whose loss is a lost sale |
| **Meilisearch** | The storefront read model: listing, filtering, faceting, search | Any source of truth |
| **Cloudinary** | Image bytes and transformations | Product metadata |

The rule that keeps this honest: **Redis must be safe to flush at 3 a.m.** Carts
therefore live in Mongo with a TTL index, not Redis, because a lost cart is a lost
sale. Conversely OTP challenges live in Redis, because Mongo's TTL sweeper runs on a
~60-second cycle and an expired code would remain *matchable* past its stated expiry —
a security boundary must not depend on a background sweeper's schedule.

## Why Meilisearch is the read model

Storefront listing is "filter by category, filter by two or three admin-defined
attributes, sort by price, and return facet counts". In MongoDB that is a compound
multikey filter followed by a **blocking in-memory sort** capped at 32 MB, plus a
`$facet` for counts. Adding a second attribute filter removes index support for the
sort entirely.

That is the shape of the query, not a missing index, so it is not fixable by indexing
harder. Meilisearch computes hits and `facetDistribution` from an inverted index in
the same sub-millisecond request, and typo tolerance and synonyms come free.

Mongo keeps the product detail page (one document read), cart, checkout, admin, and a
degraded no-facet fallback.

The frontend never talks to Meilisearch directly — every query goes through Express so
filter params are validated against `AttributeDefinition` before becoming a filter
expression, and `status = active` is appended server-side so drafts cannot leak.

## Consistency between Mongo and Meilisearch

A **transactional outbox**. Domain writes append an `outbox` row inside the same
transaction as the write itself; a change stream drains that collection into BullMQ.

This is the only arrangement where the index cannot silently diverge: enqueueing after
commit loses the job if the process dies in between, and enqueueing before commit
indexes writes that never happened. An hourly reconciliation sweep compares document
counts and re-pushes anything past the watermark, as a backstop.

Beneath the change stream sits a second backstop on a shorter loop: a sweep every 60
seconds for outbox rows still unprocessed. A change stream can miss work in ways that are
invisible from inside it — the process was down when the row was written, the resume token
has aged off the oplog — so the stream makes indexing fast and the sweep makes it certain.

Reindexing builds into `products_rebuild` and uses Meilisearch's atomic index **swap**.
A naive `deleteAllDocuments()` followed by re-adding shows an empty shop for the
duration of the rebuild.

Implemented in Phase 3; the whole arrangement, including three ways it silently broke
before it worked, is written up in **[SEARCH.md](SEARCH.md)**.

## Where side effects happen

Never inline in a request or a webhook. A mail-provider timeout inside a Stripe webhook
handler means the handler does not return 200, Stripe retries, and a payment gets
re-processed because the *mail server* was slow.

Email, search indexing, and analytics are all outbox rows consumed by BullMQ workers
with retries, backoff, and a dead-letter queue. A dead mail server, a dead Meilisearch,
and a dead analytics sink are all things the shop keeps taking orders through.

## Deployment

| | |
|---|---|
| Frontend | Cloudflare Workers via `@opennextjs/cloudflare`, worker `heastore-web` |
| Backend | Docker container, published on `172.17.0.1:5003:5000` |

Three Cloudflare constraints shaped the frontend design rather than being discovered
late: the adapter does not support Node middleware, so **session gating happens in
Server Components and Route Handlers, never in `middleware.ts`**; image optimization
is delegated to Cloudinary through a custom `next/image` loader rather than running on
Worker CPU; and the compressed Worker size limit (3 MiB free, 10 MiB paid) means the
server bundle stays lean, with fonts and static assets served as Workers static assets
where they do not count toward it.

See [DEPLOYMENT.md](DEPLOYMENT.md).
