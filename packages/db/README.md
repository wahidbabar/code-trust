# @code-trust/db

Postgres schema, migrations and typed queries. The shapes come from the zod schemas in `@code-trust/shared`; this package stores them and gives them back.

## Layout

| Path | What it is |
| --- | --- |
| `migrations/*.sql` | The schema, as forward-only SQL files applied in file-name order |
| `src/database.ts` | The tables as Kysely types |
| `src/rows.ts` | Row to domain mappers |
| `src/queries.ts` | The query module. Every function takes the database first and speaks the shared types |
| `src/pg.ts` | `createPgDb`, the node-postgres dialect (`@code-trust/db/pg`) |
| `src/testing.ts` | A migrated scratch schema and seed data for tests (`@code-trust/db/testing`) |

`@code-trust/db` itself imports no driver. Pick one from a subpath.

## Migrate

```sh
pnpm --filter @code-trust/db migrate
```

In a Conductor workspace this targets the workspace database from `.env.workspace`. A `DATABASE_URL` already in the environment wins, which is how a human applies migrations elsewhere:

```sh
DATABASE_URL='postgres://...' pnpm --filter @code-trust/db migrate
```

Running it again applies nothing. `.env` is never read.

## Change the schema

1. Add `migrations/NNNN_what_it_does.sql` with the next number. Never edit a file that has been applied.
2. Update `src/database.ts`, and `src/rows.ts` and `src/queries.ts` where they touch the change.
3. Run `pnpm --filter @code-trust/db test`. `schema.test.ts` fails if `database.ts` and the live tables disagree, and `survival.test.ts` fails if they disagree with the zod types.

Postgres 15 or newer is required (`UNIQUE NULLS NOT DISTINCT`). Local, CI and Neon all run 17.

## Tests

The tests run against real Postgres, each test file in its own scratch schema. They use `DATABASE_URL`, or the workspace database from `.env.workspace`. With neither, the database suites skip on a laptop and fail in CI.

## Writing without transactions

Every write in `src/queries.ts` is one idempotent statement, so the module works on drivers that have no interactive transactions, such as Neon over HTTP. Write in this order: `upsertRepo`, commits, attributions and observations, rollups, then `setRepoHead`. Only `setRepoHead` moves a repo's head, so a job that dies midway leaves the old one, and running it again converges.
