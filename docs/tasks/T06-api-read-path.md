# T06: API read path (NestJS REST)

Status: in review
Wave: 1
Depends on: T02
Owner paths (edit only these):
- `apps/api/**`
- docs/architecture.md (your rows in Decisions)
- `pnpm-workspace.yaml` (only a `false` ruling under `allowBuilds` for a dependency whose build script just prints a message)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Flow step 7, Metric definitions: Limits, and the Decisions rows on TypeScript 7 with NestJS decorators, on Kysely, and on write order and `setRepoHead`)
- `packages/shared/src/api.ts` and the response fixtures in `packages/shared/src/fixtures.ts`
- `packages/db/src/queries.ts`, `packages/db/src/testing.ts` and `packages/db/README.md`

## Task

Build the REST API the dashboard will poll: three read endpoints over the tables T02 defined, in NestJS, answering with exactly the response schemas in `@code-trust/shared`. It runs as a local server against the workspace database for now. Lambda, the Neon driver and the `ApiStack` come in wave 2, so the app is built as a factory that takes its database handle, and wave 2 only has to wrap it. The API has no auth, which makes "never send more than the contract" a hard rule: every body is parsed with its schema before it leaves.

## Where

- `apps/api/src/`: a NestJS module with one controller and one service, a `createApp(db)` factory exported from `src/index.ts`, and `main.ts` for the local server. Replace the placeholder `PACKAGE_NAME` and its smoke test.
- `apps/api/tsconfig.json`: `experimentalDecorators` goes here, not in the base config. Leave `emitDecoratorMetadata` off (see Notes).
- `apps/api/biome.json`: a nested config, `{ "root": false, "extends": "//", "javascript": { "parser": { "unsafeParameterDecoratorsEnabled": true } } }`. Biome 2.5 refuses to parse parameter decorators such as `@Param()` and `@Inject()` without it, and the nested file keeps the flag out of the root config.
- `apps/api/package.json`: NestJS and its peers, `zod`, the test client, and two scripts: `dev` (the local server) and `seed` (loads the shared fixtures into the workspace database with `seedFixtures` from `@code-trust/db/testing`).
- Reads go through `@code-trust/db`'s query module: `listRepos`, `getRepo`, `listSurvivalMetrics`, `getSurvivalCurves`. The handle comes from `createPgDb` in `@code-trust/db/pg`, provided under one injection token so wave 2 can pass a Neon one.

The endpoints:

| Route | 200 body | Otherwise |
| --- | --- | --- |
| `GET /health` | `{ "status": "ok" }`, without touching the database | |
| `GET /repos` | `ListReposResponse` | |
| `GET /repos/:repoId` | `RepoSummaryResponse` | 400 when `repoId` fails `GithubIdSchema`, 404 when no such repo |
| `GET /repos/:repoId/survival-curve` | `SurvivalCurveResponse` | 400 and 404 as above, and 404 when the repo has no analyzed head yet |

Rules:

1. Every 200 body is parsed with its shared schema before it is sent. That strips `installationId`, and a body that breaks the contract becomes a 500 instead of going out.
2. A rollup counts only when its `headSha` equals the repo's `headSha`. A worker writes rollups before it moves the head, and a cohort that lost all its lines keeps its old row, so a rollup under another head belongs to an analysis in flight or to a stale one. It is left out of `metrics` and of `curves`.
3. Read only. No route writes, and nothing but `GET` is routed.
4. Error bodies are NestJS's standard shape and never carry SQL, a stack trace or a connection string.

## Done when

- [ ] `pnpm --filter @code-trust/api test` passes against the workspace database, with the output showing the database tests ran and were not skipped. The tests start the app with `createApp` on a scratch schema from `createTestDatabase`, and there is a named test for each of these:
  - after `seedFixtures`, `GET /repos` equals `{ repos: [apiRepoFixture] }`. With a second, never-analyzed repo added, both come back in `listRepos` order and the new one has null head fields.
  - `GET /repos/1296269` equals `repoSummaryResponseFixture`.
  - `GET /repos/1296269/survival-curve` equals `survivalCurveResponseFixture` with `curves` set to `[survivalCurveFixture, youngSurvivalCurveFixture]`.
  - every 200 body passes its shared schema, and the text `installationId` appears in no response.
  - a never-analyzed repo: its summary has `metrics: []`, and its survival curve is a 404.
  - rule 2: after `setRepoHead` moves the seeded repo to another SHA, the summary has `metrics: []` and the curve response has `curves: []` under the new head.
  - `repoId` of `0`, `-1`, `1.5`, `abc` and a number past `Number.MAX_SAFE_INTEGER` each return 400, and an unknown id returns 404, on both repo routes.
  - `POST /repos` and an unknown path return 404 or 405, never 200.
  - a failing database (the handle destroyed before the request) returns 500 with a body that has no SQL, stack or URL in it, and `GET /health` still returns 200.
- [ ] With the workspace database migrated and seeded (`pnpm --filter @code-trust/db migrate`, then `pnpm --filter @code-trust/api seed`), `pnpm --filter @code-trust/api dev` listens on `$CONDUCTOR_PORT`, and `curl -s localhost:$CONDUCTOR_PORT/repos/1296269` and `curl -s localhost:$CONDUCTOR_PORT/repos/1296269/survival-curve` print the fixture summary and curves. Show both outputs, then stop the server.
- [ ] `git diff origin/main -- docs/architecture.md` shows the Decisions row on decorator metadata, and `apps/api/tsconfig.json` does not set `emitDecoratorMetadata`.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- The Lambda handler, Neon's serverless driver, `ApiStack` and anything under `infra/`. Wave 2 plans them, after T04 has settled the front door.
- Auth, pagination, caching headers and CORS. The dashboard lane decides what it needs once its hosting is chosen.
- Writes of any kind, and any endpoint not in the table.
- `packages/shared` and `packages/db`. If a response cannot be built from the existing schemas and queries, stop and ask.

## Notes

- Decorators are the risk in this lane. Read T01's Decisions row first: TypeScript 7 and Vitest 5 both emit decorator metadata, esbuild does not, and so `tsx` does not either. Node's type stripping cannot run decorators at all, so `dev` cannot copy `packages/db`'s `migrate` script. The way through: give every constructor parameter an explicit `@Inject(TOKEN)`, so nothing needs metadata, and leave `emitDecoratorMetadata` off so the Vitest run proves it. Run `dev` with `tsx`, and the `curl` output proves it outside the tests too. This also lets wave 2 bundle the Lambda with `NodejsFunction`'s esbuild instead of a separate `tsc` step. Record it as a Decisions row that supersedes the bundling clause of T01's TypeScript 7 row.
- Rule 2 uses two queries, `listSurvivalMetrics` and `getSurvivalCurves`, joined by cohort in memory, because the curve query does not return `headSha`. That is two reads and no transaction. It is good enough for a polling dashboard; note it in the PR so wave 2 can add a single query if it wants one.
- `seedFixtures` lives in `@code-trust/db/testing`, which is fine for the `seed` script and for tests. Nothing under `src/` that `createApp` reaches may import it or `@code-trust/shared/fixtures`.
- `dev` and `seed` read `DATABASE_URL` from the environment or from `.env.workspace`, the same way `migrate` does. Never `.env`.
- The database tests follow `packages/db`'s pattern: `describe.skipIf(testDatabaseUrl === null)`, which skips on a laptop with Docker stopped and throws in CI. CI already sets `DATABASE_URL` for the whole `pnpm verify`.
- Kysely returns `bigint` columns as strings and the row mappers turn them into numbers. Go through the query module and never select from tables directly.
- Keep `createApp` free of anything that assumes a long-lived process or a listening socket, so the Lambda lane can call it once per cold start.
- If `pnpm install` stops on a dependency build script: when the script only prints a message (an opencollective funding notice, for example), add a `false` ruling for it under `allowBuilds` in `pnpm-workspace.yaml`, with a comment saying why, like esbuild's. Anything that compiles or downloads: stop and ask.
- Another lane may be running in parallel. If your PR conflicts with main in docs/STATUS.md or the Decisions table, rebase and keep both sides' rows. If `pnpm-lock.yaml` conflicts, take main's and run `pnpm install` again.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/api test passes against the workspace database with no database test skipped and a named test for every case in the task's Done when list, pnpm --filter @code-trust/api dev serves on $CONDUCTOR_PORT and curl of /repos/1296269 and /repos/1296269/survival-curve prints the seeded fixture data, docs/architecture.md has the Decisions row on decorator metadata, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
