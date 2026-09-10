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
| Mailpit SMTP | `1025` | the API sends here in dev |
| Mailpit web | `8025` | **read OTP sign-in codes here** |
| API | `5000` | `5003` on `172.17.0.1` when run via the `api` profile |
| Web | `3000` | |

All are bound to `127.0.0.1` except the API container, which binds the Docker
bridge gateway `172.17.0.1` so it is reachable from the host and from other
containers but never published to the internet directly.

## Signing in locally

There are no passwords. Request a code, then read it from Mailpit:

1. Go to <http://localhost:3000/sign-in> and enter any email address.
2. Open <http://localhost:8025> and read the six-digit code.
3. Enter it. The first successful code for an unknown address creates the account.

To get an admin account, put the address in `ADMIN_EMAILS` in `back-end/.env`
**before** signing in; the role is granted at verification time.

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

**Emails do not appear** — check `SMTP_HOST=localhost` and `SMTP_PORT=1025` in
`back-end/.env`. Mailpit accepts any credentials.

**Search returns nothing after seeding** — Meilisearch indexes asynchronously.
Run `npm --prefix back-end run search:reindex` and check
<http://localhost:7700/indexes> with the master key.
