# @code-trust/api

The read API the dashboard polls. It's a NestJS REST app built by `createApp(db)`, which returns an initialized app that isn't listening yet. The caller owns the database handle: `dev` passes a node-postgres one, and the Lambda lane (wave 2) wraps the same factory with a Neon one.

| Route | 200 body | Otherwise |
| --- | --- | --- |
| `GET /health` | `{ "status": "ok" }`, without touching the database | |
| `GET /repos` | `ListReposResponse` | |
| `GET /repos/:repoId` | `RepoSummaryResponse` | 400 when `repoId` is not a GitHub id, 404 when there is no such repo |
| `GET /repos/:repoId/survival-curve` | `SurvivalCurveResponse` | 400 and 404 as above, and 404 until the repo has an analyzed head |

`repoId` is digits only, with no leading zero, so each repo has exactly one URL.

The API has no auth, so every 200 body is parsed with its schema from `@code-trust/shared` before it is sent. That strips `installationId`, and a body that breaks the contract becomes a plain 500. A rollup counts only when its `headSha` is the repo's head. A worker writes rollups before it moves the head, so a rollup under another head belongs to an analysis that is still running or to a stale one. Nothing but `GET` is routed.

## Run it locally

```sh
pnpm --filter @code-trust/db migrate
pnpm --filter @code-trust/api seed
pnpm --filter @code-trust/api dev
curl -s localhost:$CONDUCTOR_PORT/repos/1296269
```

`seed` writes the shared fixtures, and running it again changes nothing. `dev` listens on `PORT`, else `$CONDUCTOR_PORT`, on loopback only. Both scripts read `DATABASE_URL` from the environment, else from the workspace's `.env.workspace`, never from `.env`.

## Decorators without metadata

Nothing here emits decorator metadata. `emitDecoratorMetadata` is off, esbuild (and so tsx) cannot emit it, and Node's type stripping cannot run decorators at all, which is why `dev` runs under tsx. Every constructor parameter therefore names its provider with `@Inject(...)`. Leave it out and Nest injects `undefined` without an error, and the app still boots. The test `constructor parameters are wired by explicit @Inject, not by metadata` catches that. For the same reason, route parameters are parsed with zod in a pipe, not with `ValidationPipe`.
