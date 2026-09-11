# Build progress

The resumable state file. Updated at the end of every phase, so work can stop and
restart without reconstructing context. If you are picking this up cold, read
**Next action** at the bottom first.

Plan of record: `~/.claude/plans/this-was-once-called-lexical-hellman.md`

| # | Phase | Status |
|---|---|---|
| 0 | Foundations | ✅ Complete |
| 1 | Design system | ✅ Complete |
| 2 | Catalog domain | ✅ Complete |
| 3 | Search | ✅ Complete |
| 4 | Storefront read path | ✅ Complete |
| 5 | Auth | ✅ Complete |
| 6 | Cart & wishlist | ✅ Complete |
| 7 | Checkout | ✅ Complete |
| 8 | Admin console | 🟡 Next |
| 9 | Reviews, support, polish | ⬜ Not started |
| 10 | Seed & docs | ⬜ Not started |
| 11 | Deploy | ⬜ Not started |

---

## Phase 0 — Foundations

**Goal:** three repos, working local infrastructure, shared tooling, CI, health checks.

### Done

- Root repo initialised; `.gitignore` excludes `front-end/` and `back-end/` so the
  three histories stay independent.
- `.editorconfig` at the root — the first line of defence against the old codebase's
  double-blank-line habit returning.
- `docker-compose.yml` with Mongo (replica set `rs0`), Redis and Meilisearch. Ports
  offset to 27018 / 6380 / 7700 because this machine already runs mongod on 27017 and
  a Redis container on 6379. (Mailpit was here too until Phase 1 removed SMTP; see
  ADR-007.)
- `scripts/probe-infra.mjs` — **8/8 passing** (9 until the Mailpit probe went with
  Mailpit). Asserts the platform properties the design depends on, from the host,
  against the real containers.
- Docs: `README`, `ARCHITECTURE`, `LOCAL-DEV`, ADR-001…005.

### Verified, not assumed

The probe proves four things that would otherwise be discovered late and expensively:

1. **Transactions work from the host** with `directConnection=true`. Without that flag
   the driver follows the set's advertised `localhost:27017` and reaches the *other*,
   pre-existing mongod on this machine.
2. **Change streams deliver**, so the search outbox is viable.
3. **Transactions roll back** on throw.
4. **The `arrayFilters` stock guard is genuinely atomic** — a second reservation of 2
   against a remaining 1 is refused, ending at `{available: 1, reserved: 2}`.

That fourth result is what retired the original plan to put variants in their own
collection; see ADR-005.

### Decisions taken during implementation

- Compose gained an `api` profile rather than a second compose file, so
  `docker compose up` stays infrastructure-only for normal development while
  `--profile api` gives a production-like run.
- `mongodb` and `redis` are root devDependencies. The probe is an assertion about
  infrastructure, so it belongs to the infrastructure repo rather than to either app.
- Mongo advertises `localhost:27017` inside the container. Combined with
  `directConnection=true` this works identically from the host, from another
  container, and from inside the container itself.

### Deviations from the plan

None so far.

### Also done

- **Backend rebuilt** (`Haestore-BE` @ `93f1916`): Express 5 + TypeScript. Zod-validated
  env that refuses to boot on a bad config, Mongo connection asserting a replica set at
  startup, Redis and Meilisearch clients, one global error handler with a stable error
  taxonomy, origin guard as the CSRF partner to SameSite=Lax, CORS allowlist, helmet,
  `/healthz` + `/readyz`, and graceful shutdown. `npm run check` passes.
- **Frontend rebuilt** (`Haestore-FE` @ `3056e24`): Next.js 15 App Router, React 19,
  Tailwind v4 with brand tokens, Fraunces + Karla self-hosted via `next/font`,
  Cloudinary image loader, `/api/*` rewrite proxy. `npm run check` passes.
- **Cloudflare path proven**: `cf:build` succeeds and a dry-run deploy reports
  **783 KiB gzipped** against the 3 MiB free-tier limit.
- CI in both repos: format, lint, typecheck, test, build. The frontend also builds
  the Worker on every PR and fails if the committed API types are stale.
- `scripts/sync-api-types.mjs` — generates the frontend's types from the backend's
  OpenAPI document. Fails with an actionable message until Phase 2 emits the spec.

### End-to-end verification

Both apps running together:

```
API /readyz        ready | mongo=ok, redis=ok, meilisearch=ok
Web /              <title>Hæstore — an artisanal general store</title>
Web /api/*  -->    the API's JSON error shape with a requestId,
                   not a Next 404 — the proxy reaches Express
API SIGTERM        exit 0, all stores closed cleanly, port released
```

### Things worth knowing before Phase 1

- **Env keys were renamed.** `back-end/.env.backup-2022` holds the original. Carried
  forward: Cloudinary, Unsplash, Stripe (as `STRIPE_SECRET_KEY`), the from-address.
  Retired: `ITEM_PASSWORD` (the shared admin secret) and `JWT_SECRET` (no JWTs).
  The `OVERSEER_*` Gmail OAuth keys came back in Phase 1 as `MAIL_CLIENT_ID`,
  `MAIL_CLIENT_SECRET`, `MAIL_REFRESH_TOKEN` and `MAIL_REDIRECT_URI` — see
  "Mail transport" below.
- **`eslint-config-next` is unusable** on ESLint 9 flat config — it pulls in
  `@rushstack/eslint-patch`, which throws. Use `@next/eslint-plugin-next` directly.
- **`npx` swallows signals.** Killing `npx tsx` orphans the Node process and leaves
  port 5000 held, which then looks like a mysterious startup failure. Run the binary
  from `node_modules/.bin` directly when backgrounding.
- **Unsplash keys are sufficient as supplied.** `UNSPLASH_ACCESS_KEY` alone authorizes
  search and download-tracking; the secret key is only for OAuth acting as a user.


---

## Phase 1 — Design system

**Goal:** a token set that is verified rather than asserted, the motifs the logo
actually contains, a primitive kit on Radix, and a route that proves all of it.

Full write-up: **[DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)**. Live at `/styleguide`.

### Done

- **Tokens** in `front-end/src/app/globals.css`: the bark and paper ramps built from
  the two given colours, and three dyes (verdigris, madder, weld) that exist only to
  mean something.
- **The surface contract** — `.surface-ground` / `-raised` / `-well` / `-paper`, each
  declaring `--ink`, `--edge`, `--focus`, `--field`, `--good` / `--bad` / `--note`.
  Components read the variables and never ask what they are sitting on.
- **Motifs**: `Mark`, `Wordmark`, `Arch`, `ArchFrame`, `Leaf`, `SlabRule`, `VineRule`,
  `Tag`, and the grain overlay.
- **22 primitives** on Radix, styled from scratch — buttons, badges, the `Field`
  composition, inputs, select, checkbox/radio/switch, dialog, drawer, tooltip, tabs,
  accordion, toast, skeleton, plus `Price`, `Rating` and `QuantityStepper`.
- **`src/lib/money.ts`** — integer minor units, exponent read from `Intl`.
- **`/styleguide`** as a specimen sheet, printing each swatch's measured contrast.
- The root `/` page rebuilt on the new tokens (it was still referencing the old
  `cream-*` names, which Tailwind was silently dropping).

### Verified, not assumed

- **25 tests** across `src/design` and `src/lib`. `tokens.test.ts` parses `globals.css`
  itself, so it asserts the bytes the browser is served rather than a copy — every
  pairing in DESIGN-SYSTEM.md is a test, and any new `.surface-*` must declare the whole
  contract or parsing fails by name.
- **Both drift guards were checked by breaking them** and confirming the suite went red,
  rather than trusting a green run.
- **The surface contract was confirmed in a real browser**, not only in unit tests: the
  same button markup on all four surfaces resolves to cream-on-brown at 10.5–16.8:1 and
  ink-on-cream at 17.8:1, with the focus ring switching from weld to ink on paper.
- **No page-level horizontal scroll at 375px** — only the colour table overflows, inside
  its own `overflow-x-auto` container.
- **Reduced motion checked by rendering at 300ms with the preference forced.**

### Decisions taken during implementation

- **ADR-006 — paper is the primary action.** The plan's `clay ~#C2703D` measured 2.0:1
  against the ground. Deleted rather than re-toned; `moss`/`honey`/`brick` became
  `verdigris`/`weld`/`madder`. This is the one place measurement overruled the plan.
- **Floating things are paper.** Dialogs, drawers, menus and tooltips all take
  `.surface-paper`. The ground is the shop; paper is where you transact.
- **`prefers-reduced-motion` zeroes delay as well as duration** — forcing duration alone
  leaves a staggered entrance holding `opacity: 0` for its full delay.
- **Ratings are ink glyphs, not gold stars** — forced by weld measuring 1.8:1 on cream,
  and a better answer than the workaround.
- **`radix-ui` as one package** rather than ~15 `@radix-ui/react-*` entries. It also
  ships `unstable_OneTimePasswordField`, which is worth using in Phase 5.
- **vitest 2 → 5.** Cleared the critical advisory and five others while the repo still
  had no tests to migrate.

### Deviations from the plan

- The palette, per ADR-006 above. The *roles* the plan fixed are all still filled.
- `--radius-arch` is kept, but the arch is primarily a **stroke**, not a filled dome —
  the plan's description implied the latter and it reads as a tombstone.
- `motion` was **not** installed. Nothing in Phase 1 needed it; CSS keyframes plus
  Radix's data-state attributes cover every transition here. It arrives when the cart
  drawer and View Transitions do.

### Mail transport — SMTP removed entirely (ADR-007)

The Gmail OAuth keys are back, and `MAIL_DRIVER` is now `console` (default) or
`gmail-api`. **There is no SMTP transport and Mailpit is gone** — its service, its
probe, its npm script and ports 1025/8025 with it.

The reasoning is in [ADR-007](decisions/ADR-007-gmail-api-only-no-smtp.md): most VPS
hosts block outbound 25/465/587, so SMTP could never have been the production path, and
keeping it locally would have meant the only path ever exercised in development was the
one that cannot ship. `console` formats and prints instead, with no network path at all,
so it cannot be mistaken for evidence that sending works.

The transport itself is written in Phase 5, when there is a first email to send. Three
things to carry forward:

- The Gmail API must be enabled on the Cloud project owning `MAIL_CLIENT_ID`, or sends
  return 403 `accessNotConfigured`.
- **Mail failure must not be fatal at boot.** A mail outage should not take the API down.
- `GET /api/dev/outbox` must be mounted behind a router-level
  `NODE_ENV !== 'production'` check, not a per-handler guard. It exposes message bodies,
  and message bodies contain live sign-in codes.

### Known, accepted

`npm audit` reports 6 build-time advisories in `front-end/`, down from 11. Two chains,
neither reaching the Worker bundle: `sharp` ← `miniflare` ← `wrangler` (already at the
latest release, so there is no upstream fix yet) and `postcss` ← `next` (fixed only in
Next 16, and a major bump mid-build is not worth it). Revisit at Phase 11.

### Things worth knowing before Phase 2

- **Tailwind v4 reads a CSS variable as `bg-[var(--x)]`, not `bg-[--x]`.** The v3
  shorthand is gone and fails silently. Setting one, `[--opsz:32]`, is unchanged.
- **Unknown utilities fail silently too.** The root page kept `text-cream-50` after the
  rename and simply lost its colour without a build error. Renaming a token means
  grepping for its old name.
- **`font-variation-settings` resets every axis it does not name.** All four are routed
  through custom properties for exactly this reason.
- **Headless anchor navigation does not settle** with `scroll-behavior: smooth`. Capture
  full-height and crop instead of screenshotting `#anchor`.


---

## Phase 2 — Catalog domain

**Goal:** the feature the project is named for. Admin-defined categories, attributes and
variants, with the storefront generated from them.

Full write-ups: **[ADAPTABLE-CATALOG.md](ADAPTABLE-CATALOG.md)** and
**[DATA-MODEL.md](DATA-MODEL.md)**.

### Done

- **Three models**: `AttributeDefinition` (immutable `key`/`type`), `Category`
  (materialised ancestry including self, `attributeBindings[]`, `suppressedKeys[]`,
  `validationMode`), `Product` (typed attribute array, embedded variants, denormalised
  `priceRange`/`inStock`/`categoryAncestors`).
- **Effective attribute resolution** down the tree, nearest ancestor winning, with
  suppression applied before each node's own bindings — the ordering that makes
  "suppress then rebind differently" expressible.
- **Runtime Zod validator** compiled per category from that set, cached in process,
  `z.strictObject` so unknown keys are refused.
- **Variant grids**: eligibility on the category, selection on the product, cartesian
  product as a suggestion, warn at 24, refuse above 100, `dryRun` to see the count first.
- **Services and routes**: full admin CRUD plus the public catalogue, with the filter
  panel generated from admin-defined attributes.
- **`openapi.json`** — 16 paths, 10 schemas, emitted from the same Zod schemas the routes
  validate with. `npm run sync:types` now produces the frontend's `schema.d.ts`, and it
  compiles: the cross-repo contract from ADR-001 is closed end to end.

### Verified, not assumed

**51 tests** — 34 unit, 17 integration against a real in-process MongoDB replica set.

Three MongoDB claims the design rests on are now permanent probes (`npm run probe`,
11/11), because they are claims about the database rather than about our code:

1. A compound index over **two fields of one array element** is accepted — including an
   array *inside* an element, so multiselect works.
2. **Two parallel array paths in one index are refused** (`CannotIndexParallelArrays`).
   This is why `categoryAncestors` is not in the attribute index, and a large part of why
   the storefront reads from Meilisearch.
3. A range query on a typed numeric slot produces an **IXSCAN** — the claim typed value
   slots exist to make true.

The integration suite proves the adaptable claim itself: bind high and it applies down,
suppress and rebind, store a product against attributes invented at runtime, add a
*required* attribute to a category holding live products and watch them stay sellable
while being flagged, rename and reparent a category and see every affected product's
denormalised ancestry move with it.

### Decisions taken during implementation

- **ADR-008 — typed attribute array** over a `Map` (wildcard indexes support only one
  predicate) or `{key, value}` with `Mixed` (a Mixed index only compares within a BSON
  type bracket, so a numeric range is unanswerable).
- **zod 3 → 4.** `zod-to-openapi` 9 requires it, and Phase 2 is entirely zod-driven, so
  the moment to move was before writing thousands of lines against the old API rather
  than after. `z.string().url()` became `z.url()`; nothing else changed.
- **`requireRole` is mounted once per router**, and reads the role only from the
  server-side session — never a body, query or header. Nothing populates the session
  until Phase 5, so **every admin route currently answers 401**. That is the correct
  failure direction, and there is deliberately no development bypass to forget to remove.
- **Test tiers split.** `npm test` is unit-only and sub-second; `npm run test:integration`
  spins up a replica set via `mongodb-memory-server`. A standalone `mongod` has neither
  transactions nor change streams, so testing against one would pass locally and fail on
  the first `withTransaction` in production.
- **`registerModel`** guards against `OverwriteModelError` when a module graph is
  evaluated twice — vitest isolates per file, `tsx watch` re-evaluates on reload.

### Deviations from the plan

None. The plan's section 3 settled the contested parts and all of them survived contact.

### Defects found by the tests being written

- `buildSku` truncated to 24 characters without re-trimming, so a cut landing on a word
  boundary produced `SINGLE-ORIGIN-ETHIOPIAN-` on a shelf label.
- The create path never generated a SKU, although the request schema advertised that it
  would — every product with an omitted SKU failed model validation.

### Things worth knowing before Phase 3

- **`filterableAttributes` is derived, not authored.** `AttributeDefinition.find({ isFilterable: true })`
  is already indexed for exactly this; Phase 3 maps each key to `attr.<key>` and syncs on
  a debounce, because `updateSettings` triggers a partial re-index and six admin saves
  must produce one task rather than six.
- **The degraded listing already returns `page.degraded: true`**, so the storefront can
  tell the Mongo fallback from the search path without guessing.
- **`displayValue` is denormalised at write time.** Changing a definition's option labels
  needs a backfill across products — an admin action that already triggers a reindex, so
  the two belong in the same job.
- **Version counters live in Redis** (`catalog:v:tree`, `catalog:v:defs`). Anything else
  caching per-category data should key on them rather than inventing its own invalidation.

---

## Phase 3 — Search

**Goal:** Meilisearch becomes the storefront read model, kept in sync by a transactional
outbox, with facet counts that survive being used.

Full write-up: **[SEARCH.md](SEARCH.md)**. New decision:
**[ADR-009](decisions/ADR-009-one-listing-endpoint-that-degrades.md)**.

### Done

- **The search document** — one per product, a listing projection rather than a copy of
  the catalogue. Only `active` products are indexed at all; a draft is *deleted* from the
  index rather than stored and filtered out later.
- **Derived settings** — `filterableAttributes` computed from
  `AttributeDefinition.find({ isFilterable: true })`, never authored, debounced 30 s under
  a fixed job id so six admin saves produce one partial re-index.
- **Transactional outbox** — four kinds (`product`, `category-branch`,
  `attribute-definition`, `settings`), appended inside the same transaction as the domain
  write. Every product write now goes through one `inWriteTransaction` helper, so there is
  no way to add a write that forgets to record the reindex intent.
- **Relay** — a change stream drains the outbox into BullMQ within milliseconds, with a
  60-second sweep underneath it for anything the stream never delivered, and a Redis lease
  so only one process runs the stream.
- **Disjunctive facets** — one extra `hitsPerPage: 0` query per *selected* group, batched
  into a single `/multi-search` and merged server-side. Unfiltered listings stay one query.
- **The filter trust boundary** — params validated against the category's effective
  attributes, values checked against the definition's own option list, numbers clamped to
  declared bounds, everything escaped, and `status = "active"` appended server-side.
- **Rebuild with swap** — builds into `products_rebuild`, applies settings *before* the
  swap, guards the count, then swaps atomically and keeps the old index as a rollback.
- **Hourly reconciliation** that warns rather than self-heals.
- **`displayValue` backfill** — the Phase 2 note is closed: editing a definition's option
  labels re-renders the denormalised display values across the catalogue and reindexes what
  it touched, in one job, reusing the same `toDisplayValue` the write path uses.

### Verified, not assumed

**144 tests** — 92 unit, 52 integration against a real in-process replica set *and a real
Meilisearch*. The probe is now **15/15**, four of them Meilisearch claims:

1. A nested `attr.<key>` is accepted as a filterable attribute — the whole document shape
   depends on it.
2. **A facet filtered on collapses its own counts**, with the other values absent rather
   than zero. This is not a bug to route around; it is the reason `facets.ts` exists, and a
   future Meilisearch that changed it would make that file redundant.
3. **An unescaped filter value can reach past its literal** and return drafts — the reason
   `filter-expression.ts` escapes, recorded as a fact about the platform.
4. **`swapIndexes` exchanges settings along with documents**, which is why the rebuild
   applies settings before swapping rather than after.

The end-to-end run is the real proof: a live API, a product written through the services,
and the relay carrying it to the index unaided — then defining an attribute that exists
nowhere in either codebase and watching it become a working filter with its own facet
counts, with **zero degraded requests** across the run.

### Decisions taken during implementation

- **ADR-009 — one listing endpoint that degrades and says so.** `page.degraded` names the
  engine; a fallback behind a second URL is one nobody ever exercises.
- **Pagination moved from keyset to page numbers.** Meilisearch paginates by offset and
  bounds depth with `maxTotalHits`, so a cursor would have to be emulated on top of an
  offset and pretend. The same bound is what makes `.skip()` affordable in the fallback, so
  both engines now refuse the same pages.
- **`isFilterableType` excludes `text` and `dimension`**, and the *same* guard derives the
  index settings and the generated filter panel. Applying it in one place only is how you
  get a panel offering a filter the index refuses to answer.
- **Only active products are indexed**, so a draft cannot leak even if a filter is ever
  built wrong. The server-side `status = "active"` stays anyway.
- **The rebuild guard is two rules, not one.** A proportional 90% test is meaningless in a
  four-product shop, where archiving one item is a 25% drop; refusing it would teach an
  operator that `--force` is the normal way to rebuild. So: refuse a rebuild that found
  *nothing* at any size, and apply the ratio only above 50 live documents.

### Deviations from the plan

- Pagination, as above — the plan's own canonical URL already said `page=2`.
- **`variantKeys` remains deferred**, as ADR-003 specified. The product-grain imperfection
  (a product with (whole-bean, 1 kg) and (ground, 250 g) matching `grind=ground AND
  weight_g=1000`) still stands and is still accepted.

### Three defects the tests and the live run found

All three shared a signature: nothing threw, nothing logged, and the index simply stopped
being true. Each now has a regression test.

1. **A colon in a BullMQ job id.** Ids were `product:<id>`; BullMQ rejects a custom id
   containing `:` because it namespaces its own keys with one. The relay caught and logged
   it, so the visible symptom was not an error — it was an index that never updated. Ids
   now join with `__`.
2. **Retained completed jobs suppressing the next enqueue.** A custom job id is unique
   across every state BullMQ retains, `completed` included, and `add()` with an existing id
   creates nothing and *reports success*. With `removeOnComplete: { count: 100 }` the
   second edit of a product was silently discarded. Now `removeOnComplete: true`, so an id
   collides only while the work is outstanding — the debounce that was wanted, without the
   suppression that was not.
3. **Leader election that only ran once.** The relay took the Redis lease at startup and,
   if it lost, never asked again — so a crashed leader took the fast path down until
   someone restarted a process. It is now contested on the same timer that renews it.

A fourth was caught before it could ship: for the ~30 s the settings debounce is pending, a
newly defined attribute is in the catalogue and not in the index, so the panel would ask to
facet on a field Meilisearch does not have — and Meilisearch rejects the **whole request**
for that. One new attribute took the entire filter panel down for every shopper in that
category. `search/index-capabilities.ts` now asks the index what it can currently answer
and requests only that.

### Things worth knowing before Phase 4

- **The listing response shape changed**, and the frontend types are already synced:
  `data` uses `id` (not `_id`), `page` is `{page, perPage, total, totalPages, degraded}`,
  and there are two new fields, `facets` and `ignoredFilters`.
- **Render `facets` straight from `filterUi`.** `checkbox`/`swatch`/`select` use `values`;
  `range` uses `range`. Nothing in the frontend should name an attribute key.
- **A facet value with `count: 0` must be disabled, not hidden.** The disjunctive pass
  exists precisely so the shopper can see that a value exists and currently matches
  nothing; hiding it undoes the whole thing.
- **`ignoredFilters` is not noise.** It is the difference between showing unfiltered results
  and claiming to have filtered them — surface it.
- **`degraded: true` means hide the panel**, not render it inert.
- **URL canonicalisation is still Phase 4's job**: sort the params and values and drop
  defaults, so two shoppers clicking the same filters in different orders share a cache key
  and produce one indexable URL.
- The dev stack now needs Meilisearch running for the search path; without it the API boots
  degraded rather than failing, which is deliberate.

---

## Phase 4 — Storefront read path

**Goal:** the phase where the design pays off. Home, the shop listing with its generated
facet panel, the product page, View Transitions and the Cloudinary image loader.

Full write-up: **[FRONTEND.md](FRONTEND.md)**.

### Done

- **URL canonicalisation** (`lib/listing/params.ts`) — keys sorted, values sorted, defaults
  dropped, numerics compared as numbers. Every filter change resets the page; sort does not.
  A 308 in `middleware.ts` corrects anything non-canonical.
- **The generated filter panel** — a control per `filterUi` (checkbox, swatch, select,
  range, toggle), assembled from facets the backend derived from admin-defined attributes.
  Nothing in the frontend names an attribute.
- **Zero-count values disabled, never hidden**; `ignoredFilters` surfaced as removable chips
  with their reason; `degraded: true` hides the panel and says why.
- **Refinement as a transition** — results stay on screen, dimmed and `aria-busy`, instead
  of the shelf emptying and refilling on every tick.
- **Home** — an arched doorway hero, the shelves, and what was just put out. Every section
  is real catalogue data or is not rendered.
- **Product page** — bounded arch gallery, variant picker with unreachable combinations
  struck through, stock stated in shopper's words, specification table beside the price,
  related shelf streamed in below.
- **View Transitions** — the product card grows into the product page, verified in a real
  browser rather than assumed.
- Site chrome, `not-found`, `error`, and no horizontal scroll at 375px.

### Verified, not assumed

**62 frontend tests**, 37 of them on the canonicaliser. Both sorting guards and the
redirect-loop guard were checked **by breaking them** and confirming the suite went red.

Against the running stack, with a live API and a real Meilisearch:

- Ticking two boxes produced `?roast=dark,light` and **the disjunctive counts held** —
  Light 2, Medium 1, Dark 2, unchanged while filtered on roast. That is the extra
  `hitsPerPage: 0` query per selected group, visible.
- A bookmark naming an archived attribute rendered a removable chip plus "This category
  does not use that attribute."
- **Meilisearch was actually stopped.** The shelf stayed open, sortable and paginated, the
  panel disappeared, and the page said the filter had not been applied — ADR-009's whole
  argument, exercised rather than described.
- `startViewTransition` was hooked and a card clicked: one transition, carrying
  `product-espresso-house-blend`.
- `cf:build` succeeds; dry-run deploy reports **1062 KiB gzipped** against the 3 MiB limit
  (783 KiB at Phase 0; three real pages and middleware account for the rest).

### Three defects found by running it rather than reading it

1. **Soft 404s across the whole site.** `loading.tsx` wraps a route in a Suspense boundary,
   which lets Next flush the shell and **commit a 200** before the page has decided whether
   the product exists. `not-found.tsx` rendered under a 200 — the one status a crawler is
   told not to trust. Both `loading.tsx` files are gone and must not come back; the product
   page's related row now streams from its own boundary *below* the existence check.
2. **An infinite 308.** The middleware first compared `url.search` against the canonical
   form. `NextURL` normalises a comma to `%2C` and `URLSearchParams.toString()` does not, so
   `?roast=dark,light` was permanently redirected to itself. Both sides now go through one
   encoder, and `respell` has a regression test.
3. **The filter panel threw on every listing.** `Input` reads its id and aria wiring from
   `Field`'s context and throws without it; the range controls used a bare label. It had
   been failing all along and the streaming shell was rendering the error boundary under a
   200 — so fixing defect 1 is what made it visible.

Also fixed on inspection: `500 g g` on the specification table (`displayValue` already
carries the unit), and a product-page layout that put a 600px arch beside a column holding
a title and a price.

### Decisions taken during implementation

- **`push`, not `replace`, for refinements.** The plan said `replace`, which defeats the
  reason it gave — Back is meant to restore the previous filter state, and a replaced entry
  is the one Back cannot return to.
- **Canonicalisation moved to middleware**, because a redirect from a server component is
  too late to be a status code.
- **The range control is two numbers and a bar, not a slider.** Precise where a shopper is
  being precise, and operable by keyboard.
- **`esbuild` declared explicitly.** `@opennextjs/cloudflare` imports it without declaring
  it; `cf:build` had been working on hoisting luck and broke the moment the tree was
  re-laid. Pinned to `^0.28.1`, the range vite also accepts.
- **No cart control and no add-to-bag**, deliberately, with no disabled placeholder —
  the Phase 2 precedent of admin routes answering 401 rather than shipping a bypass.

### Deviations from the plan

- `push` over `replace`, above.
- **`motion` was installed, went unused through the entire phase, and was removed.** Radix
  data-state attributes plus CSS keyframes cover the panel and the drawer; the card-to-page
  move is the browser's own. It arrives when something needs it.
- **No marquee ticker.** `globals.css` rules ambient motion out of this system, and that is
  the more recent and better-argued of the two documents. A moving band over a grain
  overlay is also barely readable.
- The plan's `<Suspense>`-driven skeletons became a dimmed in-place results region, forced
  by the soft-404 finding and better behaviour regardless.

### Things worth knowing before Phase 5

- **Never add a `loading.tsx` to a route that can call `notFound()`.** See above. If a route
  needs streaming, put the boundary below the decision.
- **The header has no cart and no account control yet.** Phase 5 adds the account entry
  point and Phase 6 the bag; both go in `components/site/header.tsx`, which reads its
  category tree with `softly` and must keep doing so.
- **`SearchField` no longer reads `useSearchParams`.** It was removed to drop a Suspense
  boundary while chasing the soft 404 — which turned out not to be the cause, but the
  simpler component is the better one: a fresh search should not inherit the filters of a
  shelf it is leaving. If a sign-in form needs the current URL, read it on the page and pass
  it down rather than reintroducing the boundary in the layout.
- **Axis values have no labels of their own** (see FRONTEND.md's "one gap"). Closing it is a
  backend change and belongs with the Phase 8 variant grid.
- `middleware.ts` matches `/shop` only. Auth guards will want their own matcher entries;
  keep them off `/_next/*`.

---

## Phase 5 — Auth

**Goal:** OTP request and verify, Redis sessions, the `__Host-` cookie, route guards,
step-up, and the account area. The phase that makes Phase 2's admin surface reachable.

Full write-up: **[AUTH.md](AUTH.md)**. New decision:
**[ADR-010](decisions/ADR-010-roles-are-read-not-carried.md)**.

### Done

- **One endpoint for signing in and signing up**, because there is only one operation.
  `POST /auth/otp/request` answers 202 for a known address, an unknown one and a
  throttled one, with the same body shape — a withheld request returns a well-formed
  challenge id that no challenge stands behind.
- **The code**: six digits from `crypto.randomInt`, hashed
  `HMAC-SHA256(pepper, challengeId + email + code)`, compared-and-deleted in one Lua
  script so it is single-use under concurrency. 5 attempts, 5/address/hour, 20/IP/hour,
  60-second resend cooldown, 10-minute life.
- **Sessions** — opaque 256-bit ids, stored under **SHA-256 of the id** so a Redis dump
  yields no usable cookies. 30-day sliding TTL renewed at most once a day, with the
  cookie re-issued exactly when the server-side window moves.
- **`__Host-hae_sid`**, `HttpOnly` / `Secure` / `SameSite=Lax` / `Path=/` / no `Domain`,
  in development as well as production.
- **Revocation at three levels**, including `$inc User.sessionVersion` as the nuclear
  option — no Redis write, effective on the next request.
- **Step-up** on the two admin routes that cannot be undone, answering 403
  `STEP_UP_REQUIRED` so the session survives the re-verification.
- **Mail**, over the Gmail HTTPS API reached with `fetch`. MIME composed in-repo and
  tested. Verified at boot, never fatally. `GET /api/dev/outbox` guarded twice.
- **The account area** — sign-in, account, signed-in devices with per-device revoke and
  sign-out-everywhere, all `noindex`, none with a `loading.tsx`.
- **The admin bootstrap works**: `ADMIN_EMAILS` grants `admin` at verification time, so
  a fresh database yields a working administrator with no seeded password.

### Verified, not assumed

**Backend: 129 unit + 84 integration** (52 before this phase). **Frontend: 69.**
Four guards were checked **by breaking them** and confirming the suite went red — the
`sessionVersion` comparison, device ownership on revoke, the step-up staleness window,
and the code's binding to its own account.

Against the running stack, in a real browser:

- **The `__Host-` cookie is accepted over `http://localhost`.** This was the phase's one
  genuinely risky assumption — the failure mode is silent, because a browser that
  declines the cookie logs nothing and sign-in simply never sticks. It works, so the
  development path is the shipping path.
- **The origin guard was isolated**: the same request, with the same valid session
  cookie, is **200** from our origin and **403** from `https://evil.test`. Only the
  `Origin` header differed.
- **The nuclear revoke was exercised live**: one `$inc` in mongosh, and the very next
  request from a browser still holding a valid cookie was 401 — including the admin
  surface it had reached a moment earlier.
- **A session survived an API restart**, because sessions are in Redis. A deploy does not
  sign everyone out.
- `?next=https://evil.test` landed on `/account`.
- **`/` is still `○ Static`** in the production route table, which is the check on the
  header not reading the session.
- `cf:build` dry-run: **1089 KiB gzipped** against the 3 MiB limit — the whole auth
  surface cost 27 KiB (1062 KiB at Phase 4).
- Every Phase 4 behaviour re-smoked: `/shop/no-such-shelf` and `/product/nope` still
  **404** rather than soft-404, and `?sort=newest&roast=light,dark&page=1` still 308s to
  `/shop?roast=dark,light`.

### Defects found by running it

1. **`z.email().transform(trim)` rejects a pasted address.** The transform runs on the
   way *out*, so `"  a@b.test "` fails validation and the shopper is told their address
   is not an address. Normalisation now runs before validation. Found by the first unit
   test written against the schema.
2. **A successful sign-in that stayed on the sign-in form.** `router.refresh()` followed
   by `router.push()` in the same tick: the refresh starts an RSC request for the current
   route and the push is dropped while it is in flight. The cookie was set and nothing
   moved. Order reversed.
3. **The account page read `data.account` from a response whose field is `data.user`** —
   and it typechecked, because the response type was hand-written next to the fetch. This
   is exactly what ADR-001's generated types exist to prevent; the shape now comes from
   `schema.d.ts` and the rename happens once, visibly, at the boundary.
4. **The code field overflowed a 375px screen** — six 48px boxes and their gaps are
   328px, against 279px of usable width. Measured at 377px against a 375px viewport,
   which breaks the standard Phase 1 set. The boxes now flex and cap at 48px, and the
   card's mobile padding was trimmed to keep them above the 44px touch target.
5. **The account glyph squeezed the mobile search box to 80px** — 32px of it actual text,
   after the icon and the padding. The drawer already carries a search field, so the
   header's copy is now `hidden md:block`; exactly one of the two is ever present.

Also fixed on inspection: `::ffff:127.0.0.1` on the device list, which was two bugs —
one client reaching the API over both spellings of its address got two rate-limit
buckets and twice the per-IP allowance.

### Decisions taken during implementation

- **ADR-010 — roles are read per request, never snapshotted.** A copy of the roles in
  the session is a copy that goes stale, and the staleness window is exactly what an
  admin demotion needs closed. One indexed `_id` lookup per *authenticated* request;
  anonymous storefront traffic is untouched.
- **The session id is hashed before it becomes a Redis key.** The plan said `sess:{sid}`.
  Hashing costs nothing, makes a Redis dump useless, and makes the device list
  publishable — the row id shown to the account page is the digest, so it revokes a
  session without being able to impersonate one.
- **Gmail is reached with `fetch`.** ADR-007 chose the transport; this is the
  implementation. `googleapis` for one POST, plus nodemailer used only as a MIME builder
  and then discarded, is a lot of tree for two HTTP calls. `mail/mime.ts` is 12 tests.
- **A mail failure is a 503, not a comforting 202.** It is identical for every address
  so it leaks nothing, and the challenge is discarded with the failed send.
- **Step-up is mounted on real routes**, not shipped as an unused mechanism — the two
  admin deletes. The Phase 2 precedent of no development bypass, applied forwards.
- **The header does not read the session**, so the storefront keeps its prerender. The
  account link is correct in both states and `/account` sorts it out.

### Deviations from the plan

- The hashed session key, above.
- **No guest cookie yet.** `GUEST_COOKIE_SECRET` is in the environment and `hae_cid` is
  specified in the plan's section 6 — it is set on first add-to-cart, which is Phase 6.
  Adding it now would be a cookie with nothing behind it.
- **No step-up UI**, for the reason above.

### Things worth knowing before Phase 6

- **The guest cookie must not be the session cookie.** `hae_cid` has to *survive* sign-in
  so the cart can be merged; the sid has to *rotate* on it, against fixation. Rotation is
  already implemented and takes a `refreshAuthAt` option — the guest-to-user upgrade is
  another privilege change and must rotate too.
- ~~**The bag is the reason to revisit the header.**~~ **Superseded by Phase 6.** It did
  not need per-request state on the server: the API writes the bag count to a readable
  cookie, so a statically prerendered header shows a correct badge and `/` stays
  `○ Static`. See CART.md, "The two readable cookies".
- **`attachSession` is mounted globally and is not a guard.** It decides who is calling,
  never whether they may. Cart routes can read `req.auth` and treat its absence as "this
  is a guest" rather than as an error.
- **Never add a `loading.tsx` to a route that can `redirect()` or `notFound()`.** Same
  mechanism as Phase 4, and the account area is now a second place it applies.
- The admin `DELETE` routes are still absent from `openapi.json`, step-up included. See
  AUTH.md's "known gap" — they go in with Phase 8, when a frontend has to handle
  `STEP_UP_REQUIRED`.
- `middleware.ts` now has two jobs and dispatches on pathname. Anything added to its
  matcher needs a branch, or it will fall through to the listing canonicaliser.

---

## Phase 6 — Cart & wishlist

**Goal:** guest identity, re-pricing reads, merge with a report, and the drawer with
optimistic updates.

Full write-up: **[CART.md](CART.md)**. New decision:
**[ADR-011](decisions/ADR-011-cart-merge-takes-max.md)**.

### Done

- **The line shape that repairs the 2022 cart** — integer minor units for the unit price,
  and **no stored total at all**. `lineTotal` is computed by multiplication on every read;
  the integration suite asserts the field's absence on the stored document.
- **`lineKey` = `<productId>_<variantId>`**, derived rather than generated, which is what
  lets the merge compare key by key instead of guessing at similarity.
- **Re-pricing on read** — one query for the whole cart, live prices adopted, and a split
  between `quantity` (what was asked for) and `sellableQuantity` (what can be bought), so
  the basket never edits itself while somebody is looking at it and the total never
  includes stock that does not exist.
- **`__Host-hae_cid`**, 128-bit, `HttpOnly`, stored as an HMAC, **set only on the first
  add-to-cart**. A visitor who browses and leaves gets no cookie.
- **The merge**, inside the verify transaction: claim → reassign-or-merge → report →
  clear the cookie. MAX on a collision, current prices adopted, out-of-stock moved to
  `savedForLater`, unavailable lines dropped and named. Seven-day tombstone behind Undo.
- **`/api/cart` and `/api/wishlist`**, 33 paths and 20 schemas in `openapi.json`, with the
  frontend's `schema.d.ts` regenerated.
- **The drawer, the cart page, the wishlist page**, and the add-to-bag and save controls
  the Phase 4 product page deliberately shipped without.

### Verified, not assumed

**Backend: 173 unit + 124 integration** (129 + 84 before this phase). **Frontend: 87**
(69 before).

The three pure cores carry most of it — 20 tests on the merge, 15 on re-pricing, 12 on
the frontend's optimistic layer — because those are the places where being wrong produces
a **valid cart and no error**, which is the failure mode the whole arrangement is built
around.

Against the running stack, in a real browser:

- **A page view set no cookie; the first add-to-cart set both.** Checked from an empty
  jar, which is the only way to observe an absence.
- **The shelf price was moved under a full bag** in mongosh and the cart said "The price
  changed from $19.00 to $22.00", with the summary flagging it.
- **The whole merge end to end**: 2 × Sumatra on the account, 1 × Espresso as a guest,
  sign in → 3 pieces, $74.00, a report naming both changes, `hae_bag=3` in the header.
- **The same guest cookie at a second sign-in reported `mergeReport: false`** and nothing
  moved — the claim guard exercised rather than described.
- **Undo restored the account's own line; a second undo answered 409.**
- **`/` is still `○ Static`**, which is the property the readable-cookie arrangement
  exists to protect.
- `cf:build` dry-run: **1115 KiB gzipped** against the 3 MiB limit (1089 at Phase 5 — the
  whole bag cost 26 KiB).
- No horizontal scroll at 375px on the cart page, the product page, or in the drawer.

### Decisions taken during implementation

- **ADR-011 — MAX, not SUM, on a quantity collision.** The two errors are not symmetric:
  undercounting is a shopper typing a bigger number, overcounting is a shopper paying for
  things they did not order, silently, discovered at the payment screen or after delivery.
- **The header did not have to become dynamic.** Phase 5 predicted it would. Instead the
  API writes the bag count to a readable `hae_bag` cookie, so a statically prerendered
  header renders a correct badge and the drawer fetches the lines when it opens. That
  note in Phase 5 is superseded.
- **`__Host-` on the guest cookie**, which the plan did not ask for. The browser-enforced
  no-`Domain` contract that earned it for the session cookie applies unchanged; a planted
  guest cookie is a smaller prize than a planted session, but it is somebody else's
  shopping.
- **The cart does not reserve stock, and says so in three places.** Reservation is held
  against a real order in Phase 7. A reserving cart lets anyone empty the shelves for
  free and needs a sweeper to give it back.
- **The wishlist requires an account.** A wishlist promises to remember across devices and
  months; a guest cookie can keep neither half. Offering one signed-out would advertise a
  durability the storage cannot provide.
- **The claim is outside the transaction, the rest inside it.** The claim must be visible
  to a concurrent caller immediately, which is exactly what a transaction prevents.
- **A failed merge does not fail the sign-in.** The person proved who they are; the guest
  cart stays unclaimed and the next attempt picks it up.

### Deviations from the plan

- **`__Host-` on `hae_cid`**, as above.
- **`GUEST_COOKIE_SECRET` keys an HMAC rather than being a signature.** The plan said
  "stored hashed"; keying it means the stored digest cannot be recomputed by anyone
  holding only a database dump, which is the same argument as the OTP pepper.
- **Guest orders are a placeholder.** `claimGuestOrders` logs and returns. The Order model
  does not exist until Phase 7, and the hook is in place so it cannot be forgotten.

### Two defects found by running it rather than reading it

Both were in the same three lines, and both were invisible to the test suite because they
were about *requests that should not have been made*.

1. **The cart page asked for a merge report on every visit** — a 401 in the console for
   every signed-out shopper, and a wasted round trip for every signed-in one to be told
   "no" almost always. The `hae_merge` cookie exists because of this: the page now asks
   only when the answer is yes, and a read that finds nothing clears the flag itself.
2. **It asked twice.** The loading skeleton was an early `return`, so the whole tree below
   it unmounted and remounted when the cart read settled — and the report panel's effect
   runs on mount. The skeleton is now a branch inside the tree rather than in front of it.

### Things worth knowing before Phase 7

- **`markOrderPaid` should be the only function that moves money-state**, and the cart's
  claim guard is the shape to copy: one guarded `findOneAndUpdate` whose `null` return
  *is* the idempotency answer. The cart proves the pattern works under a replayed
  delivery; the order state machine needs the same thing under a webhook delivered three
  times, out of order, four hours late.
- **Checkout re-prices from the cart's own `repriceCart`, not from the stored lines.** The
  function already returns `sellableQuantity` and `needsAttention`; a checkout that reads
  `quantity` instead would reserve stock that is not there.
- **A line with `maxQuantity: 0` must block checkout**, not be silently dropped. The
  frontend has `isBlocking` for exactly this and nothing consumes it yet.
- **Reservation is the missing half.** `stock.available` is decremented nowhere in Phase 6;
  the `arrayFilters` guard proven in Phase 0's probe is what Phase 7 reserves with.
- **The webhook route must mount above `express.json()`** — the comment marking the spot
  is already in `app.ts` and is load-bearing.
- **`Cart.status` has an `ordered` value that nothing sets yet.** Checkout sets it, which
  is what releases the partial unique index so the next cart can be created.
- **The backend is still on vitest 2.1.8** while the frontend moved to 5 in Phase 1. Worth
  closing before Phase 11's audit pass, and cheap now that the suites are large enough to
  catch a regression in the runner.

---

## Phase 7 — Checkout

**Goal:** Stripe and PayPal, `markOrderPaid`, the order state machine, stock reservation
and its sweeper, outbox email.

Full write-ups: **[CHECKOUT.md](CHECKOUT.md)** and **[PAYMENTS.md](PAYMENTS.md)**.
New decision: **[ADR-012](decisions/ADR-012-no-payment-sdks.md)**.

### Done

- **The order status machine, enforced in the query filter** — `predecessorsOf(next)` in a
  `$in`, never an application `if`. A `null` return *is* the answer: the transition was
  illegal, log it, return 200, do not retry.
- **`markOrderPaid` is the only function that moves money-state**, called from three
  places — webhook, return-page reconcile, PayPal capture. Its filter is
  `{_id, status: 'pending_payment'}`, which matches exactly once because nothing returns
  to `pending_payment`. It verifies the amount **before** the write and leaves a
  mismatched order unpaid with the discrepancy recorded.
- **Stock reservation** on the `arrayFilters` guard Phase 0's probe proved, with the
  availability test inside the write. All-or-nothing across lines with an explicit
  rollback, and a sweeper that cancels expired unpaid orders and returns the stock.
- **Four independent guards at four distances**: `Idempotency-Key` at the edge, the status
  filter in `markOrderPaid`, a unique index on `payment.intentId`, and a unique index on
  `{provider, eventId}` for webhook dedupe.
- **Stripe** — PaymentIntent with the deterministic key `pi:{orderId}`, created *outside*
  the checkout transaction. Webhook signature verified against the raw bytes, every `v1`
  checked, `timingSafeEqual`, tolerance enforced.
- **PayPal** — the direct repair of the 2022 defect. All five checks from the server's own
  response: order `COMPLETED`, `custom_id` matches, capture `COMPLETED`, exact minor-unit
  amount, matching currency.
- **Guest checkout end to end**, with a `claimToken` returned once and stored only as an
  HMAC; `claimGuestOrders` fills in the Phase 6 placeholder and clears the token on claim.
- **The receipt through an outbox** committed with the payment — swept rather than
  streamed, with the post-commit enqueue as a fast path that is free to fail.
- **Checkout, return and order-history pages**, and the checkout button the cart page
  deliberately shipped without in Phase 6.
- **`openapi.json`** — 39 paths, 23 schemas; `schema.d.ts` regenerated.

### Verified, not assumed

**Backend: 297 unit + 165 integration** (173 + 124 before this phase). **Frontend: 108**
(87 before).

Two guards were checked **by breaking them** and confirming the suite went red — the
`status: 'pending_payment'` filter and the sweeper's status filter.

Against the running stack, with real Stripe test keys and real PayPal sandbox credentials:

- **A full guest purchase completed with zero webhooks delivered.** The payment succeeded
  at Stripe, the order stayed `pending_payment` with **zero** `payment_events` recorded,
  and the return page's reconcile moved it to `paid`. The path that ships is the path that
  is exercised.
- **The same `payment_intent.succeeded` resent three times, plus a reconcile on top** —
  one `paid` entry in the history, stock unmoved, one order, one receipt, one event row.
  This is the test the plan names by itself.
- **The hand-written signature verifier was cross-checked against a real Stripe
  signature** before anything was built on it, and then exercised live against real
  deliveries forwarded by the CLI.
- **The sweeper** canceled an expired unpaid order and returned exactly its 2 units, while
  leaving both paid orders untouched.
- **PayPal** registered a real sandbox order with `custom_id` = our order id, `invoice_id`
  = the order number and `32.00 USD` from the decimal converter; capturing an unapproved
  order was refused and the order stayed unpaid.
- **A guest order appeared in `/api/orders` after signing in**, and its emailed claim link
  stopped working the moment the account owned it.
- The receipt was really sent over the Gmail API, itemised and correct.
- `cf:build` dry-run: **1155 KiB gzipped** against the 3 MiB limit (1115 at Phase 6 — the
  whole checkout, Stripe Elements included, cost about 40 KiB). `/` is still `○ Static`.

### Decisions taken during implementation

- **ADR-012 — no server-side payment SDKs.** Both providers are three to five HTTP calls,
  and PayPal's webhook verification is a call back to them rather than a local
  computation. The one hand-written piece that matters, Stripe's signature verifier, is
  cross-checked against a real signature and tested by every way it could wrongly accept.
  The browser still gets `@stripe/stripe-js`, because a PCI-compliant card field is not
  something to hand-roll.
- **`grandTotal === subtotal`.** The shop charges no delivery and no tax, and the cart and
  checkout now say so as a fact rather than deferring it to a later screen. The totals are
  still a breakdown, and every amount check reads `grandTotal` specifically, so adding a
  shipping line later changes one function rather than five.
- **A failed card is not a cancellation.** The shopper can try another card on the same
  intent; releasing their stock mid-attempt would hand it to somebody else. Only the
  reservation's expiry ends an abandoned checkout. A *denied PayPal capture* does cancel,
  because the approval is spent.
- **Releasing stock is guarded on a `stockReserved` flag**, not derived from the status, so
  the sweeper, an admin and a webhook can all reach the same order and the stock comes
  back exactly once.
- **The order outbox is swept, not streamed.** A second change stream is a second resume
  token, lease and reconnect loop; nobody notices a receipt three seconds late.

### Deviations from the plan

- **Shipping and tax do not exist**, so `grandTotal === subtotal`. The plan never specified
  either, and inventing a tax engine was out of scope. The breakdown is in the schema so
  the check sites are already correct when one arrives.
- **Pagination on `/api/orders` uses `.skip()`**, like the degraded listing, rather than
  the keyset the plan's section 7 asks for generally. An order history is bounded by how
  much one person has bought and is capped at 60 per page.

### Three defects found by running it rather than reading it

1. **Every guest shared one idempotency owner.** The middleware read a `req.guestKeyHash`
   that nothing ever set, so all signed-out callers fell through to `anon` — meaning one
   guest's key could replay another guest's order response, client secret included. Found
   by the integration test written for exactly that property.
2. **Order numbers were unreadable in the one place they are read.** The alphabet omits
   `O`, `I` and `L` so the *generator* cannot emit an ambiguous character — but nothing
   handled the *reader*, who sees `HAE-CJ0RTHPK` in a humanist face with an unslashed zero
   and types `HAE-CJORTHPK`. That lookup 404'd. `normaliseOrderNumber` now folds `O`→`0`
   and `I`/`L`→`1` and strips spacing, which is safe precisely because the generator never
   emits those letters. Found by looking at a rendered confirmation page.
3. **The payment form was dark ink on the dark ground.** Stripe draws its field labels on
   the host background, so a Payment Element mounted straight onto `.surface-ground` put
   "Card number" and "Expiration date" in near-invisible contrast. The payment step is now
   a paper card — which is Phase 1's own rule, *the ground is the shop and paper is where
   you transact* — and the Stripe appearance is toned to the paper tokens. Found in a
   browser; a unit test could not have.

### Things worth knowing before Phase 8

- **`PAYPAL_WEBHOOK_ID` is unset**, so the PayPal webhook route refuses events rather than
  trusting them unverified. The demo does not need it; a real deployment taking PayPal
  money does.
- **`GET /api/catalog/products/:slug` returns `_id` while the listing returns `id`** — a
  pre-existing inconsistency noticed while scripting the live run, not touched in this
  phase. Worth settling with the admin console's product forms.
- **The admin surface still needs the order side**: `transition`, `cancelOrder` and
  `consumeAll` exist and are tested, and nothing calls them yet. `consumeAll` is the one
  place `onHand` moves outside an admin correction, and belongs on the "mark shipped"
  action.
- **`reconcileOrderWithProvider` is the repair path** for an order stuck in
  `pending_payment` because a webhook was lost. Phase 8 should expose it as an admin
  button; it is already idempotent and already runs the same five PayPal checks.
- The admin `DELETE` routes are **still** absent from `openapi.json`, step-up included —
  the Phase 5 note stands, and Phase 8 is where it is paid off.
- **The backend is still on vitest 2.1.8** while the frontend moved to 5. The Phase 6 note
  stands; the suites are now large enough that a runner regression would be caught.


---

## Next action

**Phase 8 — Admin console.** The attribute builder, the storefront composer with
versioning, and the order, customer and review surfaces. Docs due: `ADMIN`.

Three things are already waiting for it:

- **The admin API has been answering 401 since Phase 2** and the `DELETE` routes with
  step-up are still absent from `openapi.json`. Phase 5 deferred that to "when a frontend
  has to handle `STEP_UP_REQUIRED`" — this is that phase.
- **The order side of the state machine is built and unused.** `transition`, `cancelOrder`
  and `consumeAll` are tested and nothing calls them. "Mark shipped" is where `consumeAll`
  belongs, and it is the only place `onHand` moves outside an admin correction.
- **`reconcileOrderWithProvider` wants an admin button.** It is the repair path for an
  order stranded by a lost webhook, it is idempotent, and it already runs the same five
  PayPal checks as the capture.

The storefront composer is the part with a genuine design question in it: publishing is a
version insert plus a status flip in one transaction, never an in-place edit, with a
partial unique index guaranteeing exactly one published version per handle — so rollback
is `publish(handle, n-1)` and the homepage is never half-updated.
