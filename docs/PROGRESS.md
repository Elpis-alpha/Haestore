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
| 3 | Search | 🟡 Next |
| 4 | Storefront read path | ⬜ Not started |
| 5 | Auth | ⬜ Not started |
| 6 | Cart & wishlist | ⬜ Not started |
| 7 | Checkout | ⬜ Not started |
| 8 | Admin console | ⬜ Not started |
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

## Next action

**Phase 3 — search.** Meilisearch becomes the storefront read model (ADR-003). Index
products at product grain, derive `filterableAttributes` from
`AttributeDefinition.find({ isFilterable: true })` rather than authoring them, and sync
settings on a 30-second debounce so six admin saves produce one re-index task.

Then the parts that make it trustworthy: a **transactional outbox** written inside the
same transaction as the domain write, drained by a change stream into BullMQ — the only
arrangement where the index cannot silently diverge on a crash between "saved to Mongo"
and "enqueued the job". Rebuilds go into `products_rebuild` and `swapIndexes`, never
`deleteAllDocuments` in place, which would show an empty shop for the duration.

Facet counts are the subtle part: checkboxes within one attribute are OR'd, and their
counts must be computed as if that attribute's own filter were absent, or every
unselected value in a group you have filtered on reads zero. That needs one extra query
per *selected* group at `hitsPerPage: 0`, batched into a single `/multi-search` and
merged server-side.

The frontend never talks to Meilisearch directly: filter params are validated against
`AttributeDefinition` before becoming a filter expression, and `status = active` is
appended server-side so drafts cannot leak.

Docs due: `SEARCH.md`.
