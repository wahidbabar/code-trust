# T08: Database access from Lambda (Neon dialect, bundle-safe entry, prune queries)

Status: in progress
Wave: 2 (serial, before the worker and API-on-Lambda lanes)
Depends on: T02
Owner paths (edit only these):
- `packages/db/**`
- docs/architecture.md (your rows in Decisions, the existing row on idempotent writes and `setRepoHead` where the write order changes, and the "Neon driver on Lambda" row in Open decisions)
- `pnpm-workspace.yaml` (only a `false` ruling under `allowBuilds` for a dependency whose build script just prints a message)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (the Decisions rows on Kysely, on idempotent writes and `setRepoHead`, on Postgres 17, on migrations, and on esbuild bundles being CommonJS)
- `packages/db/README.md`, `src/index.ts`, `src/pg.ts`, `src/queries.ts`, `src/migrate.ts`, `src/migrator.ts`, `src/testing.ts`

## Task

The worker (T09) and the API (T10) run on Lambda and reach Neon in Singapore from Mumbai. This lane gets `packages/db` ready for that before either starts, so neither invents its own driver code. Four things: a Neon serverless dialect next to node-postgres, with a per-query timeout and a smoke script the human runs against Neon; a root entry that a CommonJS Lambda bundle can import without crashing (today `@code-trust/db` re-exports `migrator.ts`, whose top-level `import.meta.url` breaks a CJS bundle); `migrate` must never print the database URL, even when it cannot parse it (today a malformed URL's error shows the password); and two prune queries the worker needs to make the stored rows equal its latest analysis.

## Where

- `src/neon.ts`, exported as `@code-trust/db/neon`: `createNeonDb(connectionString, { queryTimeoutMs }): Kysely<Database>`. Decide HTTP or WebSocket and record it (see Notes). Each query gets its own `AbortSignal.timeout(queryTimeoutMs)`, passed to the driver as `fetchOptions.signal`, so a hung request fails instead of running until Lambda kills the function. The callers pick the value: about 30 seconds for the worker (T09) and 5 seconds for the API (T10). Add `@neondatabase/serverless` (and a Kysely dialect package only if you choose one over a small in-repo driver; say why).
- `src/index.ts`: driver-free and migrator-free. It keeps the types, the query module and the row mappers. `migrateToLatest` and `loadMigrations` move to a new subpath, `@code-trust/db/migrator`. Update the internal imports (`testing.ts`, `migrate.ts`) and any import of them elsewhere in the repo (grep `apps/` and `packages/`; if one exists outside `packages/db`, stop and ask, since that file belongs to another lane).
- `src/migrate.ts`: a `DATABASE_URL` that `new URL()` rejects prints a fixed message naming the problem, never the value, and exits 1. No error object whose message or `input` holds the URL is printed.
- `src/queries.ts`, two keyed deletes, each one statement whatever the input size (array parameters with `unnest`, not one bind per row):
  - `deleteCommitsExcept(db, repoId, keepShas)`: removes the repo's commits not in `keepShas`; their attributions and observations go with them through the cascades.
  - `deleteSurvivalObservationsExcept(db, repoId, keepKeys: SurvivalObservationKey[])`: removes the repo's observation groups whose `(introducedBy, removedBy)` is not in `keepKeys`, with `removedBy` compared null-safely.
- `README.md`: the dialects, the subpaths, and the write order with the prunes in it: `upsertRepo`, commits, attributions, observations, `deleteCommitsExcept`, `deleteSurvivalObservationsExcept`, rollups, then `setRepoHead`, always last. The worker skips a push whose tip is already the stored head, so any write after `setRepoHead` that failed would never be retried. Amend the Decisions row on idempotent writes to name the prunes in this order.
- `src/smoke-neon.ts` and a `smoke:neon` script, for the human to run against Neon with the URL from SSM before `CodeTrustWorker` is deployed. It runs the write path through the Neon dialect: refuse to start if the fixture repo already exists (so it can never delete real data), seed one fixture repo, run both prunes with a keep list that drops a known number of rows, read the rows back, and `deleteRepo` in a `finally`. It prints row counts at each step and the host, nothing else: no URL, no user, no password. The routine takes a `Kysely<Database>` so the tests can run it through the shim. Put the human's command in `README.md` (see Notes).

## Done when

- [ ] `pnpm --filter @code-trust/db test` passes against the workspace database with no database test skipped, including named tests for:
  - the Neon dialect against real Postgres (see Notes for how): `seedFixtures` through a Neon handle, then `listRepos`, `getRepo`, `listCommits`, `listAttributions`, `listSurvivalObservations`, `listSurvivalMetrics` and `getSurvivalCurves` through the Neon handle equal the same reads through a node-postgres handle on the same schema; `setRepoHead` and `deleteRepo` return `true` for an existing repo and `false` for a missing one through the Neon handle; timestamps come back as the same ISO strings and bigint ids as numbers.
  - `deleteCommitsExcept`: keeps exactly the listed commits, removes the others with their attributions and observations, touches no other repo, and an empty list removes all of the repo's commits. Run once through each dialect.
  - `deleteSurvivalObservationsExcept`: keeps exactly the listed keys, including an alive group (`removedBy: null`) next to a removed group of the same commit, touches no other repo. Run once through each dialect, with a keep list of 5000 keys to show the statement does not grow a bind per key.
  - the per-query timeout: through a shim that never answers, a query with `queryTimeoutMs: 500` rejects within 2 seconds; and two sequential queries that each take 300 ms under `queryTimeoutMs: 500` both succeed, where a signal shared across queries would fail the second. The margins are wide on purpose, so a slow CI runner cannot flip either result.
  - the smoke routine through the Neon handle: it prints the expected counts and the host, its output contains no URL, user or password, the repo is gone afterwards, and it refuses to run, deleting nothing, when the fixture repo already exists.
  - `migrate` with `DATABASE_URL='postgres://u:s3cret-pw@[bad'` exits 1 and its stdout and stderr do not contain `s3cret-pw`. A test that can fail: check it fails against today's `migrate.ts`.
- [ ] A named test bundles an entry that imports `@code-trust/db` and `@code-trust/db/neon` with esbuild (`format: 'cjs'`, `platform: 'node'`, the same settings `NodejsFunction` uses), shows zero warnings (no `import.meta` warning), `require`s the output, and calls `createNeonDb('postgres://u:p@example.invalid/db')` without a network call. Show it failing on today's `src/index.ts` before the split.
- [ ] `pnpm --filter @code-trust/db migrate` still applies nothing on the migrated workspace database.
- [ ] `git diff origin/main -- docs/architecture.md` shows a Decisions row for the Neon driver choice, the write-order row naming the prunes before the rollups and `setRepoHead` last, and the "Neon driver on Lambda" row gone from Open decisions.
- [ ] `pnpm verify:changed` exits 0 (the API, ingest, worker and analyzer dependents included).

## Out of scope

- Any Lambda handler, `apps/**`, `infra/**`. T09 and T10 wire the dialect into their functions.
- Reading the real Neon URL. It is in SSM and in the human's hands only; never ask for it, never put a URL other than a local or `example.invalid` one in a test.
- New tables or migrations. If the worker seems to need one, stop and ask.
- `packages/shared`: T07 runs in parallel and owns `queue.ts`.

## Notes

- Driver choice. HTTP (`neon()` from `@neondatabase/serverless`, one HTTPS request per query, nothing to keep alive or close) fits both functions: the query module already avoids interactive transactions (Decisions row on idempotent writes), each Lambda invocation is short-lived, and there is no socket to leak across freezes. The WebSocket `Pool` gives sessions and transactions, which nothing here needs, and must be closed per invocation. Recommendation: HTTP, unless a test shows Kysely cannot report affected rows through it. Record the choice and why.
- Kysely needs a `Dialect` for it. A small in-repo driver around `neon(url, { fullResults: true })` is about 80 lines (`acquireConnection` hands out one stateless connection, `beginTransaction` throws a clear error, `executeQuery` maps `rows` and `rowCount` to `numAffectedRows` as a bigint). A third-party package such as `kysely-neon` saves those lines; check its last release and that it supports HTTP before choosing it.
- Proving the dialect without Neon: inject a `fetch` into the Neon driver (its config has a fetch hook) that answers its SQL-over-HTTP requests by running them on the workspace Postgres through `pg` in the scratch schema, with type parsing off and array rows, and returns the JSON shape the driver expects (read the driver's own source in `node_modules` for the request and response format, `fields` with `dataTypeID` included). The driver then parses real Postgres output with its own type parsers, which is the part that can differ from node-postgres. The shim is test code only, under `src/` with a `testing` name, never imported by `neon.ts`.
- The search path. Neon over HTTP has no session, so `options=-c search_path=...` may not apply. The shim decides the schema in the tests; `createNeonDb` takes no schema option unless you find it is needed.
- `sslmode=verify-full` is in the real URL. The HTTP driver always uses TLS and may ignore the parameter; make sure it does not reject it. node-postgres (`migrate`) honours it.
- The real check against Neon is the human's. The README gives the command, so the URL goes straight from SSM into the environment without being printed: `DATABASE_URL="$(aws ssm get-parameter --region ap-south-1 --name /code-trust/database-url --with-decryption --query Parameter.Value --output text)" pnpm --filter @code-trust/db smoke:neon`. Write it with the Write tool and list it in the PR as a step for the human after merge, before `CodeTrustWorker` is deployed.
- `AbortSignal.timeout()` starts counting when it is created, so a signal built once in `createNeonDb` would expire for every query after the first timeout period. Build it inside the per-query call; the second timeout test above is there to catch that.
- `Number(row.id)` style mapping stays in `rows.ts`; the Neon driver also returns `int8` as a string by default. If it does not, the equality test above catches it.
- Bundle test: esbuild is a root devDependency, so a test under `packages/db` can import it. Mark `@aws-sdk/*` external as `NodejsFunction` does; `pg` may be bundled or external, but the root entry must not pull it in at all (assert the bundle does not contain `require("pg")` when only the root and `/neon` are imported).
- If `pnpm install` stops on a dependency build script: when the script only prints a message, add a `false` ruling for it under `allowBuilds` in `pnpm-workspace.yaml` with a comment saying why. Anything that compiles or downloads: stop and ask.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/db test passes against the workspace database with no database test skipped and named tests for the Neon dialect against real Postgres, both prune queries through both dialects, the per-query timeout with a fresh signal per query, the smoke:neon routine's output and its refusal to touch an existing repo, the migrate URL redaction, and a CommonJS esbuild bundle of @code-trust/db plus @code-trust/db/neon with zero warnings; migrate still applies nothing on the workspace database; docs/architecture.md records the Neon driver decision, names the prunes in the write-order row and drops the driver from Open decisions; and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
