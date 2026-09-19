# Deployment

How Hæstore goes live: the storefront as a Cloudflare Worker, the API as a container on a
VPS behind nginx, MongoDB hosted elsewhere. Everything here was run end to end on a
development machine in Phase 11 — the production compose file, the seed, the Worker, an
nginx in front of the API, a test-card purchase — except the two steps that need accounts:
`wrangler deploy` and a real domain.

**The shop takes no real money.** Stripe runs in test mode and PayPal in its sandbox, and a
live key stops the API and fails the storefront build ([ADR-016](decisions/ADR-016-test-mode-only.md)).

## The shape

```
browser ──► Cloudflare ──► Worker `heastore-web` (OpenNext)
                             │   pages, and /api/* proxied with the shopper's address stamped
                             ▼
             your nginx, TLS on 443 ──► 172.17.0.1:5003 ──► API container
                                                              │
                             Redis + Meilisearch  (deploy/vps/compose.yml, no published ports)
                             MongoDB              (external replica set, e.g. Atlas)
```

Two origins, by design ([ADR-001](decisions/ADR-001-three-repos-openapi-types.md)): the shop
at, say, `https://shop.example.com` and the API at `https://api.example.com`. The browser
only ever talks to the shop; the Worker proxies `/api/*` to the API, which is what lets the
session cookie be `__Host-` and first-party.

## Before the first deploy

- **A MongoDB replica set.** Checkout needs transactions and the search outbox needs change
  streams; a standalone server has neither, and the API refuses to start on one. A hosted
  cluster such as Atlas is a replica set already. Its **IP access list must include the
  VPS**. Use the connection string it gives you, **without `directConnection=true`** — that
  flag is a workaround for the local development replica set only (ADR-002), and against a
  real cluster it pins the driver to a single member.
- **Stripe, in test mode** — the `sk_test_` and `pk_test_` keys from the dashboard with the
  test-mode toggle on.
- **A PayPal sandbox app** — its client id and secret from the developer dashboard's Sandbox tab.
- **Gmail API credentials** for sign-in codes and receipts —
  [GMAIL-API-MIGRATION-NOTE.md](GMAIL-API-MIGRATION-NOTE.md).
- **Cloudinary** — cloud name, API key and secret, for photographs uploaded in the console.
- **Two hostnames**, one for the shop and one for the API.

## Secrets, and where each one lives

| Value | Where | Notes |
|---|---|---|
| `REDIS_PASSWORD`, `MEILI_MASTER_KEY` | `deploy/vps/.env` | `openssl rand -hex 32` — hex, because the Redis password is spliced into a URL |
| `OTP_PEPPER`, `GUEST_COOKIE_SECRET` | `deploy/vps/.env` | `openssl rand -hex 32` |
| `PROXY_SHARED_SECRET` | `deploy/vps/.env` **and** the Worker's secrets | The same value in both. See "The shopper's address" below |
| Stripe, PayPal, Gmail, Cloudinary | `deploy/vps/.env` | Test-mode Stripe, sandbox PayPal |
| `API_ORIGIN` | the build shell **and** `wrangler.jsonc` `vars` | The same value in both. See "The Worker" |
| `NEXT_PUBLIC_*` | the build shell | Baked into the Worker at build time |

Nothing secret is committed. `deploy/vps/.env` and `front-end/.dev.vars` are gitignored; the
templates are `deploy/vps/.env.example` and `front-end/.env.production.example`.

## The API on the VPS

Clone the root repo and the back-end beside it, as they sit locally (`back-end/` inside the
root checkout), so the compose file's build context `../../back-end` resolves.

```bash
cd deploy/vps
cp .env.example .env         # then fill it in
docker compose up -d --build
curl -fsS http://172.17.0.1:5003/readyz
# {"status":"ready","checks":{"mongo":{…"ok":true…},"redis":{…"ok":true…},"meilisearch":{…"ok":true…}}}
```

What the compose file runs:

- **The API**, built from `back-end/Dockerfile`, published on **`172.17.0.1:5003`** only —
  the docker bridge gateway, reachable from the host's nginx and not from the internet.
- **Redis**, with a password and append-only persistence. Sessions and sign-in challenges
  live here.
- **Meilisearch** in `production` mode, which requires the master key and turns off the
  unauthenticated search preview.
- Neither datastore publishes a port.

A value left empty in `.env` (`KEY=`) is treated as unset, so the template can be copied and
filled in gradually; a feature whose keys are missing says so when it is used.

## What nginx must do for :5003

No nginx configuration ships with the project — the VPS already has one. What the API needs
from it, and what was verified locally with an nginx in front of the API:

```nginx
location / {
    proxy_pass http://172.17.0.1:5003;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
}
client_max_body_size 1m;
```

- **`X-Forwarded-For` and `X-Forwarded-Proto`.** The API trusts exactly one proxy hop
  (`trust proxy 1`), which is nginx.
- **`client_max_body_size` of at least `1m`.** Payment webhooks are read raw, up to 1 MB, for
  their signatures, and JSON bodies are capped at the same size.
- **Leave `Set-Cookie` alone** — no `proxy_cookie_path`, `proxy_cookie_domain` or
  `proxy_hide_header Set-Cookie`. The session cookie is `__Host-` and must arrive unchanged.
- **Pass the `x-haestore-*` request headers through.** nginx does by default; only a header
  allowlist would drop them, and without them every shopper shares one sign-in throttle.
- **TLS on 443, no port in the public URL.** This one is a hard requirement — see the next
  section.
- If the API's hostname is proxied through Cloudflare (the orange cloud) rather than pointed
  straight at the VPS, set its SSL mode to **Full (strict)**.

## The Worker

### Two rules about `API_ORIGIN`

**It has no port.** OpenNext compiles the `/api/*` rewrite's destination host with
path-to-regexp, which reads the `:5003` in `http://host:5003` as a route parameter and
fails every `/api/*` request with a 500 — nothing reaches the API, and nothing appears in its
log. `next dev` and `next start` are unaffected, which is why this surfaced only when the
Worker was first run against an API. The fix is the deployment's natural shape: the Worker
talks to `https://api.example.com`, and nginx forwards to 5003. `cf:build` refuses a
port-bearing or missing `API_ORIGIN` with a message saying so
(`front-end/src/lib/proxy/api-origin.ts`). Checked against `@opennextjs/aws` 4.1.5.

**It is needed twice.** The rewrite is fixed when the Worker is built; server components read
it when they run. Set it in the shell for `cf:build` *and* in `wrangler.jsonc` `vars`, to the
same value.

### First deploy

```bash
cd front-end
npx wrangler login

# Once: the KV namespace behind the page cache. Paste the id it prints into wrangler.jsonc,
# replacing REPLACE_WITH_KV_NAMESPACE_ID, and set "vars": { "API_ORIGIN": … } there too.
npx wrangler kv namespace create NEXT_INC_CACHE_KV

# Once, and whenever it rotates: the same value as the API's PROXY_SHARED_SECRET.
npx wrangler secret put PROXY_SHARED_SECRET

# Every deploy: the build-time values (front-end/.env.production.example lists them).
export API_ORIGIN=https://api.example.com
export NEXT_PUBLIC_SITE_URL=https://shop.example.com
export NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=…
export NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…
export NEXT_PUBLIC_PAYPAL_CLIENT_ID=…
npm run cf:build
npm run cf:deploy
```

Deploy with `npm run cf:deploy`, not a bare `wrangler deploy`: OpenNext's deploy also
populates the KV cache with the pages prerendered at build time. Then attach the shop's
hostname to `heastore-web` under the Worker's *Domains & Routes*.

On the API side, `ALLOWED_ORIGINS` and `WEB_URL` in `deploy/vps/.env` must be the shop's
origin — every non-GET request must present it, and payment providers return shoppers there.

### What the Worker holds

- **`NEXT_INC_CACHE_KV`** — pages and fetches, keyed by build id, so a new deploy never serves
  a page rendered against the previous API's contract.
- **`WORKER_SELF_REFERENCE`** — a binding to itself, which the revalidation queue calls to
  re-render a stale page: products after 60 seconds, the front page after 5 minutes, the
  sitemap after an hour.
- **`PROXY_SHARED_SECRET`** — a secret, never in the file.
- **No tag cache.** Publishing a front page in the console reaches visitors within five
  minutes rather than at once, and the console says so. See "Adding a tag cache" below.

### Security headers

Every page carries a Content-Security-Policy, HSTS (without `includeSubDomains`, which would
bind the rest of the domain), `nosniff`, a referrer policy and a permissions policy
(`front-end/src/lib/security/headers.ts`). The policy allows Stripe.js and its frames, the
PayPal SDK (sandbox included), photographs from Cloudinary and Unsplash, and the console's
direct upload to `api.cloudinary.com`. It was checked in a real browser with zero violations
across the storefront, a test-card purchase to confirmation, the PayPal button, the account
area and the console.

`script-src` carries `'unsafe-inline'`: the App Router streams its payload through inline
scripts, and the alternative — a per-request nonce — would make every page uncacheable. There
is deliberately no `upgrade-insecure-requests`; the site is https throughout and it broke
redirects on local http runs.

## The shopper's address

Every browser call to `/api/*` reaches the API from Cloudflare, not from the shopper, so the
API cannot see who is calling — and its per-address sign-in throttle would put every shopper
in one bucket. The Worker's middleware copies Cloudflare's `cf-connecting-ip` into
`x-haestore-client-ip` beside `x-haestore-proxy-secret`; the API believes the address only
when the secret matches, compared in constant time, and never logs the secret.

Verified locally through the Worker, the rewrite and an nginx: a sign-in request carrying
`cf-connecting-ip: 198.51.100.77` was throttled under `198.51.100.77`, and a request sent
straight to the API with a forged address and a wrong secret was throttled under its real
one.

**If the secret is missing or differs between the two sides**, nothing breaks visibly — the
stamp is ignored and every shopper shares the throttle again. The first symptom would be
sign-in codes withheld for everyone after twenty requests in an hour.

## Seeding the deployment

Redis and Meilisearch publish no port, so the seed cannot run from a checkout elsewhere. It
runs as a one-off container on their network, built from the Dockerfile's `seed` stage:

```bash
cd deploy/vps
docker compose --profile seed run --rm seed --allow-production
# again, from scratch:
docker compose --profile seed run --rm seed --allow-production --reset
```

About twenty seconds; it ends with `seed: the shop is open` and its counts. It refuses a
database that already has a shop in it without `--reset`, and production without
`--allow-production`. With `UNSPLASH_ACCESS_KEY` in `.env`, each photograph's download is
reported to Unsplash as its guidelines require; the record of what was reported lives in the
`unsplash-ledger` volume. See [SEEDING.md](SEEDING.md).

The seeded admin is whoever is in `ADMIN_EMAILS`, given the role at their first sign-in.

## Payments

Test mode only (ADR-016). Neither webhook is needed: the return page after a payment asks the
provider what happened and reaches the same `markOrderPaid`, which is how the end-to-end
suite pays with nothing forwarding webhooks. To register them anyway:

- **Stripe** (test mode) → `https://api.example.com/api/webhooks/stripe`, events
  `payment_intent.succeeded`, `payment_intent.payment_failed` and
  `payment_intent.canceled`; put its signing secret in
  `STRIPE_WEBHOOK_SECRET`.
- **PayPal** (sandbox) → `https://api.example.com/api/webhooks/paypal`; put its id in
  `PAYPAL_WEBHOOK_ID`. Without it the PayPal route refuses events rather than trusting them.

## Checking a deployment

```bash
npm run smoke -- https://shop.example.com https://api.example.com
```

From the root repo. Signed out, because sign-in codes are only readable in development:
the API and its three stores, the front page, the security headers, the sitemap, a product
page with its structured data, `/api/*` reaching Express through the Worker (a JSON 404 with
a `requestId`, not a Next page), and hashed assets cached as immutable.

## Redeploying and rolling back

- **API** — `git pull` in both checkouts, then `docker compose up -d --build`. To roll back,
  check out the previous commit and rebuild. The compose file's volumes keep Redis and
  Meilisearch across both.
- **Worker** — `npm run cf:build && npm run cf:deploy`. To roll back,
  `npx wrangler rollback`. Cache entries are keyed by build id, so a new deploy starts with a
  cold cache (warmed by the prerendered pages it uploads) and a rollback reads its own
  build's entries if KV still holds them.
- **Deploy the API first** when a change touches the contract between them: the old Worker
  keeps working against a new API that only added fields; a new Worker against an old API
  may not.

## Adding a tag cache later

If "within five minutes" for a published front page stops being good enough:

1. `npx wrangler d1 create haestore-tags`, and a `d1_databases` binding named
   `NEXT_TAG_CACHE_D1` in `wrangler.jsonc`.
2. In `open-next.config.ts`, `tagCache: d1NextTagCache` from
   `@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache`.
3. Change the console's "Visitors see it within five minutes" back.

The cost is one D1 read on every cached page view, to buy one instant action.

## Bundle size

**1499.88 KiB gzipped** in a `wrangler deploy --dry-run` at the end of Phase 11
(1507.80 KiB when built against the seeded shop; the prerendered data moves it a few KiB),
against the free plan's 3 MiB. CI builds the Worker on every pull request and reports it.
