# Local development

## Prerequisites

- Node.js >= 20.9 (developed on 24.11)
- Docker with Compose v2

## First run

```bash
git clone <root>            # this repo
git clone git@github.com:Elpis-alpha/Haestore-BE.git back-end
git clone git@github.com:Elpis-alpha/Haestore-FE.git front-end

cp .env.example .env
cp back-end/.env.example back-end/.env        # then fill in the secrets
cp front-end/.env.example front-end/.env.local

npm install
npm run install:all
npm run up                  # infrastructure
npm --prefix back-end run seed
npm run dev                 # api + web
```

## Ports

These are **deliberately offset from the defaults**, because a typical dev machine
already runs mongod on 27017 and something on 6379. Nothing here collides with a
stock local install.

| Service | Host port | Notes |
|---|---|---|
| MongoDB | `27018` | replica set `rs0`, no auth in dev |
| Redis | `6380` | appendonly on, so sessions survive a restart |
| Meilisearch | `7700` | master key from `.env` |
| API | `5000` | `5003` on `172.17.0.1` when run via the `api` profile |
| Web | `3000` | |

All are bound to `127.0.0.1` except the API container, which binds the Docker
bridge gateway `172.17.0.1` so it is reachable from the host and from other
containers but never published to the internet directly.

## Signing in locally

There are no passwords, and by default nothing leaves the machine: `MAIL_DRIVER`
is `console`, so the API prints the message it would have sent.

1. Go to <http://localhost:3000/sign-in> and enter any email address.
2. Read the six-digit code from the API's log, or from
   <http://localhost:5000/api/dev/outbox>, which keeps the last 25 messages and is
   only mounted when `NODE_ENV` is not `production`.
3. Enter it. The first successful code for an unknown address creates the account.

Set `MAIL_DRIVER=gmail-api` to send for real. **There is no SMTP transport** —
see [ADR-007](decisions/ADR-007-gmail-api-only-no-smtp.md).

To get an admin account, put the address in `ADMIN_EMAILS` in `back-end/.env`
**before** signing in; the role is granted at verification time.

## Paying locally

Both providers run in test/sandbox mode. The keys are in `back-end/.env` and the
publishable halves in `front-end/.env.local`.

**Webhooks are optional, and that is the point.** The return page calls
`reconcileOrderWithProvider`, which asks the provider what happened and funnels the answer
into the same `markOrderPaid` a webhook would have called — so a purchase completes end to
end with nothing forwarding events. Run the shop without the Stripe CLI and checkout
works.

To exercise the webhook path as well:

```bash
stripe listen --forward-to localhost:5000/api/webhooks/stripe
```

It prints the signing secret on startup; it should match `STRIPE_WEBHOOK_SECRET` in
`back-end/.env`. Re-read it any time with `stripe listen --print-secret`.

Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 9995` is declined, any future
expiry and any CVC. The full set is in Stripe's docs.

To replay a delivery and watch the idempotency guards hold:

```bash
stripe events resend evt_XXXXXXXX
```

Nothing should move — one `paid` entry in the order's history, stock unchanged, one
receipt. See [CHECKOUT.md](CHECKOUT.md).

**PayPal webhooks do not work locally** unless `PAYPAL_WEBHOOK_ID` is set, because PayPal
verifies by a call back to them that names the registered webhook. Without it the route
refuses events rather than trusting them. The reconcile path covers the demo.

**An unpaid order holds its stock for 30 minutes** (`CHECKOUT_RESERVATION_MINUTES`) and
the sweeper then cancels it and puts the stock back. To watch that without waiting, wind
the hold into the past in mongosh:

```js
db.orders.updateOne({ orderNumber: 'HAE-XXXXXXXX' },
                    { $set: { reservationExpiresAt: new Date(Date.now() - 60000) } })
```

The sweeper runs every `ORDER_SWEEP_INTERVAL_MS` (60s).

## The MongoDB replica set

`mongod` runs with `--replSet rs0` and self-initiates via its healthcheck. This is
**required, not optional** — a standalone `mongod` has neither multi-document
transactions (needed by checkout) nor change streams (needed by the search outbox).

The connection string must carry `directConnection=true`:

```
mongodb://127.0.0.1:27018/haestore?replicaSet=rs0&directConnection=true
```

Without it the driver performs topology discovery, is told by the set that the
primary lives at `localhost:27017`, and — from the host, where 27017 is a
*different* mongod — connects to the wrong server or fails outright. This is the
single most common way to lose an hour on this stack.

Verify the set is healthy:

```bash
docker compose exec mongo mongosh --quiet --eval "rs.status().members.map(m => m.name + ' ' + m.stateStr)"
# [ 'localhost:27017 PRIMARY' ]
```

## Resetting

```bash
npm run reset                     # destroys all volumes, restarts clean
npm --prefix back-end run seed    # then reseed
```

## Common problems

**`MongoServerError: not primary`** — the set has not finished initiating. Wait for
the healthcheck (`docker compose ps` shows `healthy`) and retry.

**Sign-in codes do not appear** — with `MAIL_DRIVER=console` they are in the API's
log and at `/api/dev/outbox`; there is no mail UI to open. With
`MAIL_DRIVER=gmail-api`, a 403 `accessNotConfigured` means the Gmail API is not
enabled on the Google Cloud project that owns `MAIL_CLIENT_ID`.

**Search returns nothing after seeding** — Meilisearch indexes asynchronously.
Run `npm --prefix back-end run search:reindex` and check
<http://localhost:7700/indexes> with the master key.

**A filter I just defined has not appeared** — expected, for up to about 30 seconds.
`filterableAttributes` is synced on a debounce so that six admin saves produce one
partial re-index instead of six. The listing keeps working throughout: the new
attribute simply has no facet yet, and a filter on it comes back in `ignoredFilters`.
Watch for `search: settings synced` in the API log.

**The listing says `page.degraded: true`** — MongoDB answered instead of Meilisearch,
so there are no facets and no attribute filtering. Check `/readyz`, then the API log
for `search: listing failed`, which carries the underlying reason. The shop still
sells in this state; the filter panel is what is missing.

**Products are in Mongo but never reach the index** — look for
`search: took the relay lease` at startup. Exactly one process runs the change stream;
if none holds the lease the 60-second sweep still drains the outbox, just slowly.
`npm --prefix back-end run search:reconcile` prints the drift between the two stores.
