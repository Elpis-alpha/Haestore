# Build progress

The resumable state file. Updated at the end of every phase, so work can stop and
restart without reconstructing context. If you are picking this up cold, read
**Next action** at the bottom first.

Plan of record: `~/.claude/plans/this-was-once-called-lexical-hellman.md`

| # | Phase | Status |
|---|---|---|
| 0 | Foundations | ✅ Complete |
| 1 | Design system | 🟡 Next |
| 2 | Catalog domain | ⬜ Not started |
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
- `docker-compose.yml` with Mongo (replica set `rs0`), Redis, Meilisearch and Mailpit.
  Ports offset to 27018 / 6380 / 7700 / 1025+8025 because this machine already runs
  mongod on 27017 and a Redis container on 6379.
- `scripts/probe-infra.mjs` — **9/9 passing**. Asserts the platform properties the
  design depends on, from the host, against the real containers.
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
  Retired: `ITEM_PASSWORD` (the shared admin secret), `JWT_SECRET` (no JWTs),
  `OVERSEER_*` (Gmail OAuth, replaced by SMTP/Mailpit).
- **`eslint-config-next` is unusable** on ESLint 9 flat config — it pulls in
  `@rushstack/eslint-patch`, which throws. Use `@next/eslint-plugin-next` directly.
- **`npx` swallows signals.** Killing `npx tsx` orphans the Node process and leaves
  port 5000 held, which then looks like a mysterious startup failure. Run the binary
  from `node_modules/.bin` directly when backgrounding.
- **Unsplash keys are sufficient as supplied.** `UNSPLASH_ACCESS_KEY` alone authorizes
  search and download-tracking; the secret key is only for OAuth acting as a user.

---

## Next action

**Phase 1 — the design system.** Build the token set out properly (contrast-verify
every pair against the chocolate ground), the arch/leaf/grain motifs, the primitive
kit on Radix, and a `/styleguide` route that proves it. Load the `frontend-design`
skill before writing the first component.
