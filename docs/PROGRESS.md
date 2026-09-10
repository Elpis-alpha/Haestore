# Build progress

The resumable state file. Updated at the end of every phase, so work can stop and
restart without reconstructing context. If you are picking this up cold, read
**Next action** at the bottom first.

Plan of record: `~/.claude/plans/this-was-once-called-lexical-hellman.md`

| # | Phase | Status |
|---|---|---|
| 0 | Foundations | ✅ Complete |
| 1 | Design system | ✅ Complete |
| 2 | Catalog domain | 🟡 Next |
| 3 | Search | ⬜ Not started |
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

## Next action

**Phase 2 — the catalog domain.** The heart of the rebuild, and the thing the old
name promised and never delivered: `Category` with materialized ancestry and
`attributeBindings[]`, `AttributeDefinition` with immutable `key`/`type`,
`Product` with typed attribute values and embedded variants, effective-attribute
resolution down the tree, the runtime Zod validator compiled per category and cached
in Redis, and admin CRUD over all of it.

Start from the plan's section 3 — it already settles the contested parts (typed
attribute arrays over a `Map` or `{key,value}`, `validationMode: 'lenient'` as the
default, `isVariantAxis` as eligibility rather than generation, and `stock.available`
stored rather than computed). Phase 2 also emits `openapi.json` for the first time,
which unblocks `npm run sync:types`.

Docs due: `DATA-MODEL.md` and `ADAPTABLE-CATALOG.md`.
