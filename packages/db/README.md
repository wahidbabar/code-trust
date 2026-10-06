# @code-trust/db

Postgres schema, migrations and typed queries. The shapes come from the zod schemas in `@code-trust/shared`; this package stores them and gives them back.

## Layout

| Path | What it is |
| --- | --- |
| `migrations/*.sql` | The schema, as forward-only SQL files applied in file-name order |
| `src/database.ts` | The tables as Kysely types |
| `src/rows.ts` | Row to domain mappers |
| `src/queries.ts` | The query module. Every function takes the database first and speaks the shared types |
| `src/pg.ts` | `createPgDb`, the node-postgres dialect |
| `src/neon.ts` | `createNeonDb`, the Neon dialect for Lambda |
| `src/migrator.ts` | `migrateToLatest` and `loadMigrations` |
| `src/testing.ts` | A migrated scratch schema and seed data for tests |
| `src/testing-neon.ts` | A fetch shim that runs the Neon dialect against the test Postgres |
| `src/smoke-neon.ts` | The `smoke:neon` routine and command |

## Entry points

| Import | What it gives | Where it runs |
| --- | --- | --- |
| `@code-trust/db` | Types, queries and row mappers. No driver, no migrator, no `import.meta` | Everywhere, including CommonJS Lambda bundles |
| `@code-trust/db/neon` | `createNeonDb(url, { queryTimeoutMs })` | Lambda (worker, API) |
| `@code-trust/db/pg` | `createPgDb(url, { schema })` | Local, CI, `migrate` |
| `@code-trust/db/migrator` | `migrateToLatest`, `loadMigrations` | `migrate` and tests. Uses `import.meta`, so never in a Lambda bundle |
| `@code-trust/db/testing` | `createTestDatabase`, `seedFixtures` | Tests |
| `@code-trust/db/testing-neon` | `installNeonShim` | Tests |

`bundle.test.ts` builds the root and `/neon` the way `NodejsFunction` does (esbuild, CommonJS, Node platform) and fails on any warning or on node-postgres in the bundle.

## Dialects

Both dialects give the same `Kysely<Database>`, so the queries are written once.

- **node-postgres** (`/pg`): a connection pool, with `schema` putting a scratch schema first on the search path. Local, CI and `migrate`.
- **Neon over HTTP** (`/neon`): Neon's serverless driver, one HTTPS request per query. There is no connection to open, close or leak across a Lambda freeze, and no interactive transactions: `db.transaction()` throws, and nothing in `queries.ts` needs one. Each query gets its own `AbortSignal.timeout(queryTimeoutMs)`, so a hung request fails with `Neon query timed out after N ms` instead of running until Lambda kills the function. The worker uses about 30 seconds and the API about 5. `createNeonDb` checks the URL itself and never echoes it. `sslmode=verify-full` in the URL is passed to Neon unchanged; the driver always uses HTTPS.

Migrations run on node-postgres only: the Migrator needs a transaction and an advisory lock.

The Neon dialect is tested without a Neon project. `installNeonShim()` sets the driver's (global) fetch hook to a shim that answers its SQL-over-HTTP requests from the test Postgres, as Neon would: raw text rows with each field's type id, which the driver then parses with its own type parsers. Each handle gets a fake host under `example.invalid`, and the shim never forwards a request.

## Migrate

```sh
pnpm --filter @code-trust/db migrate
```

In a Conductor workspace this targets the workspace database from `.env.workspace`. A `DATABASE_URL` already in the environment wins, which is how a human applies migrations elsewhere:

```sh
DATABASE_URL='postgres://...' pnpm --filter @code-trust/db migrate
```

Running it again applies nothing. `.env` is never read. The URL is never printed, not even when it is malformed.

## Change the schema

1. Add `migrations/NNNN_what_it_does.sql` with the next number. Never edit a file that has been applied.
2. Update `src/database.ts`, and `src/rows.ts` and `src/queries.ts` where they touch the change.
3. Run `pnpm --filter @code-trust/db test`. `schema.test.ts` fails if `database.ts` and the live tables disagree, and `survival.test.ts` fails if they disagree with the zod types.

Postgres 15 or newer is required (`UNIQUE NULLS NOT DISTINCT`). Local, CI and Neon all run 17.

## Tests

The tests run against real Postgres, each test file in its own scratch schema. They use `DATABASE_URL`, or the workspace database from `.env.workspace`. With neither, the database suites skip on a laptop and fail in CI.

## Writing without transactions

Every write in `src/queries.ts` is one idempotent statement, so the module works on drivers that have no interactive transactions, such as Neon over HTTP. A worker writes in this order:

1. `upsertRepo`
2. `upsertCommits`
3. `upsertAttributions`
4. `upsertSurvivalObservations`
5. `deleteCommitsExcept`
6. `deleteAttributionsExcept`
7. `deleteSurvivalObservationsExcept`
8. `upsertSurvivalRollup`, once per cohort the analysis has a rollup for
9. `setRepoHead`, always last

Only `setRepoHead` moves a repo's head, so a job that dies midway leaves the old one, and running it again converges. Nothing may be written after it: the worker skips a push whose tip is already the stored head, so a later write that failed would never be retried.

The three prunes remove the repo's rows that the latest analysis no longer has. Each is one statement however long its keep list, because the list travels as array parameters read with `unnest`. An empty list keeps nothing. `deleteCommitsExcept` cascades to the attributions and observations of the commits it removes, so its keep list must name every commit a kept attribution or observation refers to.

One thing does not converge: when a measured cohort has no lines left (after a force-push, or a change to the attribution rules), the analyzer writes no rollup for it, so its old rollup row stays. That row names an older head, and the API filters rollups on the repo's head, so it is never shown. Removing such rows is left to the hardening phase.

## Neon smoke test

Run this after this package changes how it talks to Neon, and before `CodeTrustWorker` is first deployed. It needs AWS credentials that can read the parameter, and it puts the URL straight from SSM into the environment without printing it:

```sh
DATABASE_URL="$(aws ssm get-parameter --region ap-south-1 --name /code-trust/database-url --with-decryption --query Parameter.Value --output text)" pnpm --filter @code-trust/db smoke:neon
```

It writes one fixture repo (id `9007199254740991`, `code-trust-smoke/neon-smoke`) through the Neon dialect, runs the three prunes, reads the rows back and deletes the repo. It prints the host and row counts only:

```
host ep-....aws-ap-southeast-1.aws.neon.tech
seeded: commits 5, attributions 3, observations 4, rollups 2
deleteCommitsExcept: deleted 2; commits 3, attributions 2, observations 3, rollups 2
deleteAttributionsExcept: deleted 1; commits 3, attributions 1, observations 3, rollups 2
deleteSurvivalObservationsExcept: deleted 1; commits 3, attributions 1, observations 2, rollups 2
deleteRepo: commits 0, attributions 0, observations 0, rollups 0
smoke:neon passed
```

If an earlier run was killed before its cleanup, the smoke repo is still there: the next run removes it, says so, and carries on. If any other repo holds that id, it refuses and changes nothing. Any failure exits 1 with the error, user and password redacted.
