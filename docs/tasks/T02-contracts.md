# T02: Contracts (shared schemas, queue messages, database schema, metric definitions)

Status: done
Wave: 0 (serial)
Depends on: T01
Owner paths (edit only these):
- `packages/shared/**`
- `packages/db/**`
- `.github/workflows/ci.yml` (Postgres service for db tests only)
- docs/architecture.md (Metric definitions, Decisions, Open decisions)
Read first:
- docs/architecture.md (Flow, Packages, Metric definitions)

## Task

Define the contracts every later lane builds against, so parallel lanes never invent their own versions. Zod schemas are the single source of truth and TypeScript types are inferred from them. Finalize the metric definitions in docs/architecture.md first, then encode them.

## Where

- `packages/shared/src/domain.ts`: Repo, Commit, Attribution (signal and confidence), LineSpan, SurvivalObservation, SurvivalMetric.
- `packages/shared/src/queue.ts`: messages from webhook to dispatcher and from dispatcher to worker, each with a `version` field.
- `packages/shared/src/api.ts`: responses for the read endpoints the dashboard will call: list repos, repo summary, survival curve.
- `packages/db`: schema and migrations for repos, commits, attributions, survival observations and rollups; a typed query module; a `migrate` script that reads `DATABASE_URL`.

## Done when

- [ ] Every schema has round-trip tests: valid fixtures parse, invalid ones fail with useful errors.
- [ ] `pnpm --filter @code-trust/db migrate` applies cleanly to the workspace database (its URL is in `.env.workspace`), and running it a second time changes nothing.
- [ ] A test proves the database row types and the shared zod types agree for survival data.
- [ ] CI runs the db tests against a Postgres service container.
- [ ] The Metric definitions section of docs/architecture.md states exactly how survival is computed, including censoring, and names the first attribution signals.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- Git analysis logic (analyzer lane), Lambdas, API handlers, infra.

## Notes

- Pick Drizzle or Kysely for the query layer, both with Neon's serverless driver on Lambda, and record why in the Decisions table.
- Keep queue messages small and versioned. Workers fetch what they need rather than receiving whole payloads.
- Timestamps cross boundaries as UTC ISO strings.
- Match the local Postgres major version (17 in `scripts/conductor/setup.sh`) to the Neon project's. If they differ, say so in the PR instead of editing the setup script.

## Goal line

Paste into the workspace after approving the plan:

```
/goal all shared and db schema tests pass, pnpm --filter @code-trust/db migrate succeeds twice in a row against the workspace database, the Metric definitions section in docs/architecture.md is complete, and pnpm verify:changed exits 0; show each command and its output; nothing changed outside the owner paths except this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
