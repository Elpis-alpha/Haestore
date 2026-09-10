# ADR-004 — Passwordless email OTP with opaque Redis sessions

**Status:** Accepted · 2026-09-10

## Context

The 2022 app signed JWTs with `jwt.sign({_id}, secret, {})` — **no expiry, ever** — and
accumulated them in an unbounded `user.tokens[]` array on the user document. Changing
a password did not revoke them. There was no password reset flow at all, so a
forgotten password was unrecoverable.

The project owner chose passwordless email one-time codes.

## Decision

**No passwords anywhere.** No `passwordHash`, no bcrypt, no reset flow. Authentication
is a six-digit code emailed to the address being claimed.

**Sessions are opaque 256-bit ids in Redis**, not JWTs. Cookie `__Host-hae_sid`,
`HttpOnly`, `Secure`, `SameSite=Lax`, 30-day sliding TTL.

## There is no signup/login distinction

This is the design's best property rather than a shortcut. Because requesting a code
does identical work for a known and an unknown address, there is **no branch to
time-attack and no difference to leak** — enumeration resistance is structural, not
bolted on. Compare the old `GET /api/users/user/exists?email=`, which was a
purpose-built enumeration oracle.

The first successful verification creates the account with `emailVerifiedAt` set:
possession of the code *is* proof of the mailbox, so a separate confirm-your-email step
would be redundant.

## Why not JWT access + refresh tokens

The standard remedy for the old app's problem is a short-lived access token plus a
rotating refresh token plus a denylist. The denylist needs a fast shared store — which
is Redis, which is already here. At that point the JWT is a stateless optimisation for
a problem we do not have: a single API with Redis on the same network, where session
lookup is a sub-millisecond `GET`.

Statelessness buys nothing here and costs revocation latency. An opaque session is
genuinely revocable, which is precisely what refresh-token rotation only approximates.

## Why not bcrypt for the code

bcrypt's work factor defends a *large* offline search space. A six-digit code has
10⁶ possibilities; an attacker holding the Redis dump brute-forces it regardless of
hash cost. What actually protects it is a server-side pepper held in env and never in
Redis, so `HMAC-SHA256(pepper, challengeId + email + code)` is both correct and fast.

The real defences are the 10-minute TTL, the 5-attempt cap, and the rate limits.

## Why Redis and not Mongo for the challenge

Mongo's TTL monitor runs on a ~60-second cycle, so a challenge past its stated expiry
remains **queryable and matchable** for up to a minute. Making a security boundary
depend on a background sweeper's schedule is the wrong shape. Redis enforces expiry on
read, and gives atomic `HINCRBY` for attempt counting plus a Lua script for
compare-and-delete, so a code is single-use even under concurrent verification.

## Revocation, three levels

1. One device — `DEL sess:{sid}`.
2. All devices — iterate the `usess:{userId}` set.
3. Nuclear — `$inc User.sessionVersion`, which the auth guard compares on every
   request. This makes an admin demotion take effect immediately without touching
   Redis at all.

## Consequences

- Sign-in requires a working mailbox, and a slow mail path is felt directly. The
  `console` mail driver covers local development, and E2E reads codes from the
  dev outbox it keeps — see [ADR-007](ADR-007-gmail-api-only-no-smtp.md).
- Redis is now on the authentication path. A Redis outage logs everyone out; it does
  not lose data.
- `roles[]` bootstraps from an `ADMIN_EMAILS` allowlist at verification time, so a
  fresh database yields a working admin with no seeded password — replacing the old
  shared `?item_password=` in the query string of every mutating request.
