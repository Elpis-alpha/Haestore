# ADR-007 — Gmail over HTTPS is the only mail transport; no SMTP, no Mailpit

**Status:** accepted · Phase 1
**Supersedes:** the SMTP/Mailpit arrangement from Phase 0, and the two-driver
compromise added earlier in Phase 1

## Context

Phase 0 sent mail over SMTP to Mailpit locally, which is the conventional setup:
a catcher on `1025`, a web UI on `8025`, nothing leaving the machine.

That cannot be the production transport. **Most VPS hosts block outbound 25, 465
and 587 as an anti-spam policy.** The failure is not a clean refusal — the
connection hangs until it times out. Combined with a boot sequence that verifies
the mailer before `listen()` and a `restart: unless-stopped` policy, it presents
as a container crash-looping forever while the logs look like they are simply
hanging. `docs/GMAIL-API-MIGRATION-NOTE.md` is the write-up of hitting exactly
this on another deployment.

The first fix here was a `MAIL_DRIVER` switch: SMTP locally, Gmail's HTTPS API in
production.

## Decision

Drop SMTP entirely. `MAIL_DRIVER` is `console` or `gmail-api`.

**Two transports where one is impossible in production is worse than one.** The
local path would have been the only path ever exercised during development, so
every mistake specific to the real transport — a wrong scope on the refresh
token, an unenabled Gmail API, base64url vs base64, a `From:` that does not match
the token's account — would surface for the first time in production, which is
also the environment where the failure mode is a silent hang.

`console` is not a second transport pretending to be mail. It formats the message
and prints it, and keeps the last 50 in memory behind `GET /api/dev/outbox`,
mounted only when `NODE_ENV` is not `production`. It has no network path at all,
so nothing about it can be mistaken for evidence that sending works.

Mailpit is removed from `docker-compose.yml`, its probe from
`scripts/probe-infra.mjs`, and ports `1025`/`8025` are given back.

## Alternatives

**Keep Mailpit, add the Gmail driver alongside** — what this replaces. Rejected
above: it makes the untested path the production one.

**Point Mailpit at Gmail as a relay** — still SMTP on the way out, so still
blocked. Solves nothing.

**A transactional provider (Resend, Postmark, Brevo)** — genuinely better for a
real shop: HTTPS, deliverability handling, a real sending domain. Rejected only
because Gmail credentials already exist and this is a portfolio build; the driver
seam is exactly where such a provider would slot in, and adding one is a new
`MAIL_DRIVER` value rather than a change to any caller.

## Consequences

**Good.** One production transport, exercised deliberately. Two fewer ports, one
fewer container, one fewer healthcheck. A fresh clone with no Google credentials
still boots and can complete a sign-in, because `console` is the default.

**The cost.** There is no mail UI to open. Local sign-in codes are read from the
API log or `/api/dev/outbox`.

**E2E gets easier, not harder.** The Playwright sign-in test reads the code from
`/api/dev/outbox` as JSON rather than scraping Mailpit's interface.

**To watch.** `/api/dev/outbox` must be mounted behind an explicit
`NODE_ENV !== 'production'` check at the router level — not a per-handler guard,
which is the shape that leaks. It exposes message bodies, and message bodies
contain live sign-in codes.
