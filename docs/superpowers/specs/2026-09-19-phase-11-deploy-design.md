# Phase 11 — Deploy: design

**Date:** 2026-09-19 · **Status:** approved in conversation, awaiting spec review

## Goal

Make Hæstore *deployable*: every config file, code change and document a first deploy
needs, verified on this machine. **Nothing is deployed by this phase** — the owner runs
the Cloudflare and VPS deploys. **No live payment credentials, ever**: the deployment
is a demonstration in Stripe test mode and the PayPal sandbox.

## Topology

```
browser ──► Cloudflare ──► Worker `heastore-web` (OpenNext)
                              │  /api/* rewrite + server components
                              ▼
                  owner's nginx (existing, TLS) ──► 172.17.0.1:5003 ──► API container
                                                                          │
                              Redis + Meilisearch (VPS compose, no host ports)
                              MongoDB (external replica set, e.g. Atlas)
```

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **KV incremental cache, no tag cache** | OpenNext 1.20.6 keys KV entries by build id, so a deploy never serves a render from the previous API contract (the Phase 9 defect). A tag cache would serve one call site (composer Publish) at the cost of a D1 read on every cached hit. Publish becomes honest instead: "live within 5 minutes". |
| D2 | **Memory queue + `WORKER_SELF_REFERENCE`** for time-based revalidation | Free, no Durable Objects; per-isolate de-dupe is enough at demo traffic. |
| D3 | **CSP via `next.config.ts` `headers()`**, `script-src` with `'unsafe-inline'` | App Router's inline bootstrap needs a nonce or `'unsafe-inline'`; a nonce means middleware on every page render. The CSP still earns its keep through `frame-ancestors`, `object-src`, `base-uri`, `form-action` and origin allowlists. |
| D4 | **Client IP stamped by edge middleware on `/api/*` only**, trusted by the API only with a shared secret | Every browser `/api/*` call reaches the API from the Worker, so `req.ip` is Cloudflare's — the per-IP sign-in throttle (`otp:rl:ip:*`) would bucket every shopper together. Not auth, so the "no auth in middleware" rule stands. |
| D5 | **Live payment keys refused at boot** (ADR-016) | A pasted live key must fail fast, not take real money. |
| D6 | **External MongoDB**; VPS compose runs Redis, Meilisearch and the API only | Owner's choice. Must be a replica set (transactions, change streams). `directConnection=true` is a local-development workaround and must not appear in the production URL. |
| D7 | **No nginx config shipped** | The owner's nginx already proxies to 5003; DEPLOYMENT.md states what it must do. |

## Work, by repository

### front-end (`Haestore-FE`)

- `open-next.config.ts` — `kvIncrementalCache`, `memoryQueue`. Remove the stale "Phase 4" comment.
- `wrangler.jsonc` — `NEXT_INC_CACHE_KV` binding (placeholder id), `WORKER_SELF_REFERENCE`
  service binding to `heastore-web`, runtime `vars` for `API_ORIGIN`; `PROXY_SHARED_SECRET`
  as a Worker secret (documented, never in the file).
- `src/middleware.ts` — matcher `/api/:path*` only. Sets `x-haestore-client-ip` from
  `cf-connecting-ip` (overwriting anything the client sent) and `x-haestore-proxy-secret`
  from the env. No-op when the secret is unset (local dev).
- `next.config.ts` — `headers()`: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`. Allowlists: `js.stripe.com`, `*.stripe.com` frames/connect,
  PayPal sandbox and its asset hosts, `res.cloudinary.com`, `images.unsplash.com`,
  `api.cloudinary.com` (upload). Built from one module so a test can assert it.
- Build-time guard — the build refuses `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` starting `pk_live_`.
- `public/_headers` — `/_next/static/*` immutable.
- Composer Publish copy — says the front page is live within five minutes.
- `.env.example` / a production template — which values are build-time, which runtime,
  and that `API_ORIGIN` is **both**.

### back-end (`Haestore-BE`)

- `src/config/env.ts` — `PROXY_SHARED_SECRET` (optional, min 32); refuse `STRIPE_SECRET_KEY`
  starting `sk_live_`/`rk_live_`; `PAYPAL_ENV` narrowed to `sandbox`. Error names the key.
- `src/modules/auth/client-ip.ts` — trust `x-haestore-client-ip` only when
  `x-haestore-proxy-secret` matches (constant-time compare); otherwise `req.ip`. Normalisation unchanged.
- `src/db/mongo.ts` — the error hint no longer says `directConnection=true` is always required.
- `.env.example` — drop the stale Mailpit header; `directConnection` marked local-only.

### root (`haestore`)

- `deploy/vps/compose.yml` — Redis (`requirepass`, AOF), Meilisearch (`MEILI_ENV=production`,
  master key), API built from `../../back-end` bound to `172.17.0.1:5003:5000`.
  No Mongo; no datastore host ports. A `seed` profile service built from a new `seed`
  Dockerfile stage runs the seed on the compose network.
- `deploy/vps/.env.example` — production API env, test-mode payments only.
- `scripts/smoke-deploy.mjs <web-url> <api-url>` — signed-out checks: `/healthz`,
  `/readyz`, home, a product page, `/sitemap.xml`, CSP header present, `/api/*` through the
  Worker returns the API's JSON error shape.
- `docs/DEPLOYMENT.md` — first-deploy runbook: create the KV namespace, secrets, build-vs-runtime
  env, nginx requirements for 5003, external Mongo requirements, seeding through a one-off
  `seed` compose service (Redis and Meilisearch publish no port, so a checkout cannot reach them), optional test-mode webhooks, redeploy and rollback, adding a tag cache later.
- `docs/decisions/ADR-016-test-mode-only.md`, ADR index, `PROGRESS.md`, README links.

## Verification (local)

1. Unit: the live-key guard (each rejected shape, test keys accepted); `clientIp` with
   matching secret, wrong secret, no secret configured, spoofed header without secret.
   Frontend: the CSP builder contains each required origin; the middleware overwrites a
   client-supplied IP header.
2. Break-it checks, as in earlier phases: remove the secret comparison and the guard, confirm red.
3. `cf:build`, and the gzipped bundle measured against 3 MiB.
4. `cf:preview` against the local API: Playwright sweep for CSP violations across home, shelf,
   product, bag, checkout with Stripe `4242`, the PayPal button rendering, sign-in, account,
   and an admin photograph upload. The API sees the stamped IP.
5. `deploy/vps/compose.yml` run locally against the dev Mongo, then `smoke-deploy.mjs`
   against preview + that API.
6. Both repos' `npm run check`; backend integration suite.

## Out of scope

Running any deploy; live payments; a tag cache; nginx config; CI deploy workflows; backups of
the external database (noted in DEPLOYMENT.md as the owner's).
