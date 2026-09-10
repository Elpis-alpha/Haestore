# ADR-010 — Roles are read on every request, never carried in the session

**Status:** Accepted · 2026-09-10

## Context

[ADR-004](ADR-004-passwordless-otp-sessions.md) settled that sessions are opaque ids in
Redis. It did not settle what the session *record* holds.

The obvious contents are everything an authorisation check needs: user id, email,
`roles[]`. Writing them once at sign-in makes every subsequent authenticated request a
single Redis `HGETALL` and nothing else — no database at all on the hot path.

ADR-004 also promised something that arrangement cannot deliver: "an admin demotion
takes effect instantly." A role copied into a session on Monday is still in that
session on Tuesday.

## Decision

**The session record holds `userId`, `authAt`, `createdAt`, `lastSeenAt`,
`sessionVersion`, and the device metadata. It does not hold roles or the email.** Those
are read from the user document on every authenticated request, by
`middleware/session.ts`, as one indexed `_id` lookup.

The session's `sessionVersion` is a snapshot, and that is the point: it is compared
against the live document, so `$inc User.sessionVersion` invalidates every session for
that user without touching Redis at all.

## Why not snapshot and accept the staleness

Because the staleness window is exactly the interval that matters. The reason to remove
someone's admin role is usually that they should not have it *right now* — they have
left, or an account is suspected. A control that takes up to thirty days to apply is not
a control, and "sign them out everywhere as well" turns one operation into two, of which
the second is the one people forget.

Reading live also fixes the mirror-image case that a snapshot design tends to ignore: a
role **granted** applies immediately too, rather than at the recipient's next sign-in.
Granting is the common operation, and "log out and back in again" is a bad answer.

## Why not a version key in Redis

`uver:{userId}`, written by the demotion and read by the guard, would keep the hot path
free of MongoDB. It is a real option and it is what we would reach for if this ever
showed up in a profile.

It is not the first thing to reach for, because it adds a second source of truth for
authorisation that has to be kept in step with the first, and the failure mode of a
missed write is a role that is stale in exactly the situation the key was added to
prevent. Two stores agreeing about who is an admin is a cache-invalidation problem, and
this system does not currently need to have one.

## Consequences

- **One indexed MongoDB read per authenticated request.** Anonymous storefront traffic
  is untouched: no cookie means no lookup, and the overwhelming majority of catalogue
  requests carry no cookie.
- `requireRole` cannot be fooled by an old session, and needs no cache-busting.
- The account page's `lastSeenAt` is written from this same lookup, at most once a day,
  so it costs no extra round trip.
- If the read ever becomes a bottleneck, the fix is the Redis version key above — not a
  longer-lived snapshot, which would give back the property this ADR exists to keep.
