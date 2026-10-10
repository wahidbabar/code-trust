# @code-trust/api

The read API the dashboard polls. It's a NestJS REST app built by `createApp(db)`, which returns an initialized app that isn't listening yet. The caller owns the database handle: `dev` passes a node-postgres one, and the Lambda handler passes a Neon one.

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

## On Lambda

`ApiStack` (`CodeTrustApi` in `infra`) bundles `src/lambda.ts` with `NodejsFunction`'s esbuild, as CommonJS, and puts it behind its own Function URL with auth `NONE`.

| File | What it is |
| --- | --- |
| `src/handler.ts` | `createHandler(deps)`: the Function URL handler around `createApp` |
| `src/lambda.ts` | The bundled entry: `handler`, which reads the URL from SSM, and `createHandler` for the smoke script |
| `src/aws.ts` | The SSM loader and the SDK client's timeouts |
| `src/env.ts` | The env var names, exported as `@code-trust/api/env` for `ApiStack` |

- **Cold start.** The first request in an execution environment reads the SSM SecureString that `DATABASE_URL_PARAMETER` names, builds `createNeonDb(url, { queryTimeoutMs: 5_000 })` and calls `createApp`. Later requests reuse all three. A start that fails is not kept: that request gets Nest's plain 500 (`{"statusCode":500,"message":"Internal server error"}`), the log gets the error's name and message, and the next request starts again.
- **Events.** `@codegenie/serverless-express` turns a payload format 2.0 event into a request for Nest's Express instance, in memory: `requestContext.http.method`, `rawPath` with `rawQueryString`, the headers and cookies, and a body decoded from base64 when `isBase64Encoded` is set.
- **CORS.** The Function URL adds the CORS headers, allowing `https://wahidbabar.github.io` and `GET` only. Nest never calls `enableCors`, because a second set of headers breaks browsers, and because a CORS change should be a change to the template. The test `no response carries a CORS header of its own` holds Nest to that.
- **Queries.** Neon is in Singapore and the function in Mumbai, so every query is a round trip. `/health` makes none, `/repos` one, `/repos/:repoId` at most two and the survival curve at most three. The test `queries per request` counts them.
- **Logs.** Errors and warnings only, as JSON lines.
- **Bundle smoke.** `pnpm synth`, then `pnpm --filter @code-trust/infra smoke:api`. It loads the synthesized bundle the way the runtime would, sends `GET /health` and prints `status 200` and `{"status":"ok"}`. The stack tests skip bundling, so this is what proves the bundle boots.

## Deploy

1. Check what this stack reads: the SecureString `/code-trust/database-url` exists in `ap-south-1` under the AWS-managed key, and Neon is migrated, with `smoke:neon` passed as in `packages/db/README.md`.

2. Deploy only this stack. `-e` (`--exclusively`) bundles and deploys `CodeTrustApi` alone. It needs no other stack, and so it never needs the git layer zip: without `-e` the CLI bundles every stack, including the worker's once it exists. The CDK app still builds every stack, so `ALERT_EMAIL` is required.

   ```bash
   export ALERT_EMAIL=you@example.com
   cd infra
   pnpm exec cdk deploy -e CodeTrustApi
   ```

3. Read the URL into a variable. It also prints at the end of the deploy, and it ends in `/`. It is not a secret: the dashboard publishes it.

   ```bash
   API_URL=$(aws cloudformation describe-stacks --region ap-south-1 --stack-name CodeTrustApi \
     --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
   ```

   The first request after Neon has been idle for 5 minutes waits for its compute to resume, which can take seconds. The function's real cold start is `Init Duration` on its first `REPORT` line in the log group.

4. Check it. The first command must print `200`: the first real Neon query through the bundle. The second must print exactly `1`: the Function URL's CORS header, and none from Nest.

   ```bash
   curl -s -o /dev/null -w '%{http_code}' "${API_URL%/}/repos"
   curl -s -D - -o /dev/null -H 'Origin: https://wahidbabar.github.io' "${API_URL%/}/repos" | grep -ci '^access-control-allow-origin:'
   ```
