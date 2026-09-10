# ADR-002 — MongoDB, with a replica set as a hard requirement

**Status:** Accepted · 2026-09-10

## Context

The rebuild stays on MongoDB (chosen by the project owner). Checkout must decrement
stock and transition an order atomically, and the search index must not diverge from
the database.

## Decision

MongoDB with Mongoose 8, running as a **single-node replica set** (`--replSet rs0`)
even in local development. The connection string always carries
`directConnection=true`.

## Why the replica set is not optional

A standalone `mongod` supports **neither multi-document transactions nor change
streams**. This design needs both:

- checkout writes an order, decrements stock across several products, and appends
  outbox rows — all or nothing;
- the search outbox is drained by a change stream.

Without a replica set, checkout degrades to a sequence of independent writes whose
failure modes include charging a customer for an order that was never recorded.

## The `directConnection=true` trap

After `rs.initiate({members:[{host:'localhost:27017'}]})` the set *advertises* that
address. A driver performing normal topology discovery honours the advertised address.
From the host — where port 27017 is a **different**, pre-existing mongod — that means
connecting to the wrong server or failing DNS.

`directConnection=true` disables discovery and talks to the endpoint given. Transactions
still work, because they require the *server* to be a replica set member, not the
*driver* to be in discovery mode.

## Verification

Proven at scaffold time, from the host, against the real container: transaction commit,
transaction rollback, change-stream delivery, and an `arrayFilters`-guarded stock
decrement that correctly refuses to over-decrement. See `scripts/probe-infra.mjs`.

## Consequences

- Local setup needs a self-initiating healthcheck; three extra lines of Compose.
- `mongodb-memory-server` in tests must also be started as a replica set.
- Every transaction uses `session.withTransaction()`, which retries
  `TransientTransactionError` — a hand-rolled commit without retry is a correctness bug
  under write conflicts.
