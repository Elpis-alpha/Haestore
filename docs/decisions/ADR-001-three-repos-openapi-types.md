# ADR-001 — Three repos, contract-synced via OpenAPI

**Status:** Accepted · 2026-09-10

## Context

`Haestore-FE` and `Haestore-BE` already exist as separate GitHub repos. The frontend
deploys to Cloudflare Workers, the backend as a Docker container. Both need to agree
on every request and response shape.

## Decision

Keep the two application repos independent, add a third root repo for docs, brand
assets and infrastructure, and `.gitignore` the two applications from it.

The backend owns the contract. Zod schemas generate `openapi.json`; a root script runs
`openapi-typescript` to produce a committed `schema.d.ts` in the frontend.

## Alternatives rejected

**npm workspaces monorepo with `packages/shared`.** The obvious answer, and it gives
real end-to-end type safety with no codegen step. Rejected because a `file:../shared`
dependency makes `front-end/` unbuildable in isolation, and Cloudflare builds the
frontend repo on its own. It would also have meant abandoning two existing histories.

**Duplicating types by hand.** Free today, wrong within a week, and the drift is
silent — the client keeps compiling against a shape the server stopped returning.

**Publishing a private npm package.** Correct at scale, but a version-bump-and-publish
cycle for every field change is heavy friction for a two-service project.

## Consequences

- Both repos build standalone; deployment stays simple.
- `npm run sync:types` must be run after backend contract changes. CI fails if the
  committed `schema.d.ts` differs from freshly generated output, so this cannot be
  forgotten quietly.
- Cross-cutting changes touch two repos and two PRs.
