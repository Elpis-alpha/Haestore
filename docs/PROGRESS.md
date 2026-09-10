# Build progress

The resumable state file. Updated at the end of every phase, so work can stop and
restart without reconstructing context. If you are picking this up cold, read
**Next action** at the bottom first.

Plan of record: `~/.claude/plans/this-was-once-called-lexical-hellman.md`

| # | Phase | Status |
|---|---|---|
| 0 | Foundations | 🟡 In progress |
| 1 | Design system | ⬜ Not started |
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

### Remaining in this phase

- [ ] Backend scaffold: Express 5, TypeScript, Zod-validated env, `/healthz`, pino,
      helmet, rate limiting, global error handler
- [ ] Frontend scaffold: Next.js 15 App Router, Tailwind v4, `@opennextjs/cloudflare`
- [ ] Prettier + ESLint flat config + lint-staged in both app repos
- [ ] `scripts/sync-api-types.mjs` and the CI check that the committed types match
- [ ] CI workflows for both app repos
- [ ] Commit all three repos

---

## Next action

Scaffold `back-end/` — Express 5 + TypeScript with Zod-validated env and a `/healthz`
that reports Mongo, Redis and Meilisearch reachability. The old source is fully pushed
to `Haestore-BE` at `ed82843`, so replacing it in place loses nothing.
