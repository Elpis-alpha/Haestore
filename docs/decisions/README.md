# Architecture decision records

One file per fork that was genuinely contested. Each records what was chosen, what
was rejected, and — most importantly — the reason the rejected option is tempting,
so the decision is not silently reversed later by someone who only sees the upside.

| # | Decision | Status |
|---|---|---|
| [001](ADR-001-three-repos-openapi-types.md) | Three repos, contract-synced via OpenAPI | Accepted |
| [002](ADR-002-mongodb-replica-set.md) | MongoDB, with a replica set as a hard requirement | Accepted |
| [003](ADR-003-meilisearch-read-model.md) | Meilisearch as the storefront read model | Accepted |
| [004](ADR-004-passwordless-otp-sessions.md) | Passwordless OTP + opaque Redis sessions | Accepted |
| [005](ADR-005-embedded-variants.md) | Variants embedded on Product, not a collection | Accepted |
| [006](ADR-006-paper-as-the-primary-action.md) | Paper is the primary action; no terracotta accent | Accepted |
| [007](ADR-007-gmail-api-only-no-smtp.md) | Gmail HTTPS is the only mail transport; no SMTP | Accepted |
| [008](ADR-008-typed-attribute-values.md) | Attribute values as a typed array, not a Map | Accepted |
| [009](ADR-009-one-listing-endpoint-that-degrades.md) | One listing endpoint, which degrades and says so | Accepted |
| [010](ADR-010-roles-are-read-not-carried.md) | Roles read per request, never snapshotted into a session | Accepted |
