# T10: API on Lambda (handler, Neon, ApiStack, CORS for the dashboard)

Status: planned
Wave: 2
Depends on: T06, T08 (merged to main before this starts)
Owner paths (edit only these):
- `apps/api/**`
- `infra/lib/api-stack.ts`, `infra/lib/api-stack.test.ts`
- `infra/bin/app.ts`
- `infra/lib/config.ts` (new constants only)
- `infra/package.json`
- `infra/scripts/**` (new; the bundle smoke script)
- docs/architecture.md (your rows in Decisions)
- `pnpm-workspace.yaml` (only a `false` ruling under `allowBuilds` for a dependency whose build script just prints a message)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Flow step 7, Cost rules, and the Decisions rows on the Function URL front door, the webhook's explicit IAM role, esbuild bundles, the API's decorators without metadata, the Neon driver, the Neon region and the dashboard on GitHub Pages)
- `apps/api/README.md`, `apps/api/src/app.ts`, `apps/api/src/local-database.ts`
- `infra/lib/ingest-stack.ts` and `infra/lib/ingest-stack.test.ts` (the patterns to follow) and `apps/ingest/src/lambda.ts`, `apps/ingest/src/aws.ts`
- `packages/db/README.md` as T08 merged it (`@code-trust/db/neon`)

## Task

Put the read API on Lambda behind its own Function URL, reading Neon, so the dashboard has something to poll. T06 built `createApp(db)` for exactly this: this lane wraps it once per cold start with a Neon handle whose URL comes from SSM, and adds `ApiStack`. The API is public with no auth, so the bundle must run the same code the tests ran, CORS must allow only the dashboard's origin, and nothing in the stack may bill while idle.

## Where

- `apps/api/src/lambda.ts`: the Function URL handler. At cold start it reads the SSM SecureString named by an env var, builds `createNeonDb(url, { queryTimeoutMs: 5_000 })`, calls `createApp(db)`, and adapts the Nest app to Function URL events (payload format 2.0). Export a `createHandler(deps)` that takes the URL loader, so tests and the smoke script can run it without AWS. A failed cold start is not cached: the next request tries again.
- `apps/api/src/env.ts`, exported as `@code-trust/api/env`: the env var names `ApiStack` sets.
- `apps/api/src/local-database.ts`: `describeDatabase` must not throw the URL back when `new URL()` rejects it, the same leak T08 fixes in `migrate`.
- `infra/lib/api-stack.ts`: `ApiStack`, added to `infra/bin/app.ts` as `CodeTrustApi`. One `NodejsFunction` (arm64, `NODEJS_24_X`, its own log group with 14-day retention, an explicit role), its Function URL with auth `NONE` and CORS, and outputs for the URL.
- `infra/lib/config.ts`: `DATABASE_URL_PARAMETER_NAME = '/code-trust/database-url'` (T13 reuses it), `DASHBOARD_ORIGIN = 'https://wahidbabar.github.io'`, and the function's memory and timeout.
- `infra/package.json`: `@code-trust/api` as a workspace devDependency, so `verify:changed` re-runs the infra tests when the API changes.
- `infra/scripts/`: a script that finds a function's bundled asset in `infra/cdk.out` (by stack and construct path, through the asset metadata), `require`s it, and calls an exported function with arguments; T13 reuses it for the worker and dispatcher.

## Done when

- [ ] `pnpm --filter @code-trust/api test` passes against the workspace database with no database test skipped, T06's tests unchanged, plus named tests that drive `createHandler` with Function URL events and a pg handle in place of Neon:
  - `GET /repos/1296269` and `GET /repos/1296269/survival-curve` after `seedFixtures` return 200 with bodies equal to `repoSummaryResponseFixture` and the curve fixture, the same as through supertest.
  - a `rawPath` with a query string, a base64-encoded event body, and a `POST` each behave as in T06 (404 or 405 for the `POST`).
  - the URL loader is called once across invocations; a loader that fails once makes that request a 500 with no URL in the body, and the next request succeeds.
  - queries per request, counted through a Kysely `log` hook: `/health` 0, `/repos` 1, `/repos/:id` at most 2, `/repos/:id/survival-curve` at most 3.
  - the response carries no CORS headers of its own (the Function URL adds them; duplicates break browsers).
  - `describeDatabase` with a malformed URL containing `s3cret-pw` returns or throws nothing that contains it.
- [ ] `pnpm --filter @code-trust/infra test` passes with assertions on `ApiStack` that load `cdk.json`'s context like the other stack tests:
  - the resource types are exactly an allowed list written out in the test.
  - the function is `arm64` on `nodejs24.x`; every log group has `RetentionInDays: 14`; there is no `Custom::LogRetention`, `AWS::KMS::Key`, `AWS::SecretsManager::Secret` or `AWS::ApiGateway*`.
  - the Function URL has `AuthType: NONE` and `Cors` with `AllowOrigins` exactly `[DASHBOARD_ORIGIN]` and `AllowMethods` exactly `['GET']`.
  - the role's policy grants `ssm:GetParameter` on one parameter, the `/code-trust/database-url` ARN with exactly one slash after `parameter`, plus writes to its own log group, and no `*` resource and no `kms:*`.
  - the template has no 12-digit account ID and no ARN literal.
- [ ] `pnpm synth` exits 0 with no AWS credentials, synthesizes `CodeTrustFoundation`, `CodeTrustIngest` and `CodeTrustApi`, and `pnpm synth 2>&1 | grep -ci docker` prints 0.
- [ ] The smoke script loads the synthesized `CodeTrustApi` bundle from `infra/cdk.out`, calls its `createHandler` with a loader that returns `postgres://u:p@example.invalid/db`, sends `GET /health`, and prints status 200 and `{"status":"ok"}`. This proves the CommonJS bundle boots Nest with the externals left out.
- [ ] `apps/api/README.md` has a Deploy section for `CodeTrustApi` that ends with two checks for the human, shown with `sed -n` on the file: `curl -s -o /dev/null -w '%{http_code}' "${API_URL%/}/repos"` prints 200 (the first real Neon query through the bundle), and `curl -s -D - -o /dev/null -H 'Origin: https://wahidbabar.github.io' "${API_URL%/}/repos" | grep -ci '^access-control-allow-origin:'` prints exactly 1 (the Function URL's CORS header, and none from Nest). The stack's URL output ends in `/`, hence `${API_URL%/}`.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- Deploying, and creating the SSM parameter (the human already did). Write the deploy steps for `CodeTrustApi` in `apps/api/README.md` and point to them from the PR body.
- Auth, pagination, caching, rate limiting, reserved concurrency, custom domains, API Gateway.
- New routes or response shapes. `packages/shared` and `packages/db` are not yours; if a response cannot be built from them, stop and ask.
- The dashboard (T15), and the worker's stack (T13).

## Notes

- Bundling: `NodejsFunction`'s esbuild with `@nestjs/microservices`, `@nestjs/websockets`, `class-validator` and `class-transformer` marked external (PR #6 notes): Nest `require`s them only when used, and esbuild fails to resolve them otherwise. `@aws-sdk/*` comes from the runtime, as in IngestStack. The bundle is CommonJS, so nothing it imports may use `import.meta` or top-level await; T08 made `@code-trust/db` safe for that, and `apps/api/src/main.ts` and `seed.ts` stay out of the Lambda's import graph.
- The adapter from Function URL events to Nest: pick a maintained one (for example `@codegenie/serverless-express`) or a small in-repo adapter over Nest's Express instance, and record which and why. It must handle payload format 2.0 (`rawPath`, `rawQueryString`, `requestContext.http.method`, `isBase64Encoded`).
- CORS lives on the Function URL, not in Nest, so a CORS change is an infra change a reviewer sees in the template. The dashboard is a GitHub Pages project site, whose origin is `https://wahidbabar.github.io` (the path is not part of an origin). The username is public, so a constant is fine; it is not an account ID.
- Neon's compute suspends after 5 idle minutes, and the first query after that waits for it to resume. Each query has a 5 second timeout through `createNeonDb`; size the function's timeout for a cold start plus a few queries (about 10 to 15 seconds), and keep memory modest (512 MB or less unless the cold start measured by the smoke script says otherwise).
- Keep the stack ID `CodeTrustApi` and the construct IDs of the function and its URL stable after the first deploy: a new ID means a new URL, and the dashboard's `API_URL` would point at the old one.
- The explicit role pattern from IngestStack: no `AWSLambdaBasicExecutionRole`, no grant helpers that add unused actions. No `kms:Decrypt`: the parameter uses the AWS-managed `aws/ssm` key.
- Skip bundling in the assertion tests (`aws:cdk:bundling-stacks` set to an empty list), as the ingest tests do. `pnpm synth` is what builds the bundle the smoke script loads.
- The guard hook matches on command text: keep the words for a cdk deploy and `aws ssm put-parameter` out of Bash commands and commit messages. Write deploy steps into the README with the Write tool.
- T09 runs at the same time and owns `apps/worker`. T13 later edits `infra/bin/app.ts`, `infra/lib/config.ts` and `infra/package.json` after you; keep your additions there minimal and grouped under a comment.
- If `pnpm install` stops on a dependency build script that only prints a message, add a `false` ruling under `allowBuilds` with a comment. Anything that compiles or downloads: stop and ask.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/api test passes against the workspace database with no database test skipped and named tests for every handler case in the task's Done when list including the per-route query counts, pnpm --filter @code-trust/infra test passes with the ApiStack assertions listed in Done when including CORS for the dashboard origin only, pnpm synth exits 0 without credentials or Docker and synthesizes CodeTrustApi, the smoke script gets 200 from /health through the synthesized bundle, apps/api/README.md's Deploy section ends with the two curl checks, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; then stop and summarize without running the reviewer or cost-guard agents; or stop after 20 turns
```
