# Architecture

code-trust is a GitHub App that measures how long AI-attributed code survives in real repository history. It ingests repository events, walks git history (blame and diff), classifies changes as AI-attributed or human, and computes survival metrics so a team can see how durable AI-written code actually is.

Why survival: the usual AI coding metric is acceptance, meaning whether someone took the suggestion. That says little about quality. Survival asks whether the code is still there 30, 90 or 180 days later, or whether it was rewritten or deleted.

## Stack

- TypeScript 7 everywhere, ESM, strict.
- pnpm workspaces monorepo.
- AWS CDK v2 (`aws-cdk-lib`) for all infrastructure, in TypeScript.
- Region `ap-south-1`. All compute is arm64 Lambda. Postgres is in Neon's `aws-ap-southeast-1` (Singapore).
- NestJS with REST for the API. GraphQL was considered and dropped.
- Postgres on Neon's free tier, not RDS.
- Defaults set with the agent harness (T01 may change them with a recorded reason): Vitest for tests, Biome for lint and format.

## Flow

```
GitHub App webhook
      │
      ▼
Function URL ──► webhook Lambda (verify HMAC signature, fast 200 ack)
                      │
                      ▼
              events queue: SQS (+ DLQ)
                      │
                      ▼
               dispatcher Lambda
                      │
                      ▼
      jobs queue: SQS FIFO (+ DLQ), MessageGroupId = repo id
                      │
                      ▼
      worker Lambda, arm64, git from a layer
      (clone, blame, diff, compute AI-vs-human survival)
                      │
                      ▼
          Neon Postgres (Singapore) ◄── API Lambda ◄── Function URL ◄── dashboard (GitHub Pages)
```

1. The GitHub App webhook posts to the webhook Lambda's Function URL. Its auth type is `NONE`: the HMAC signature is the authentication.
2. A webhook Lambda verifies the HMAC signature and returns a fast `200`. No heavy work inline.
3. It enqueues events for public repositories only on SQS, with a DLQ for poison messages. Events that mean a repo's data must go (it turned private, was deleted, or the App lost access) are enqueued too.
4. A dispatcher Lambda consumes the events queue and sends one job per event to an SQS FIFO jobs queue, with the repo id as the message group, so a repo's jobs run one at a time and in order.
5. A worker Lambda takes each job. An analyze job clones the repo's default branch, runs blame and diff, and computes AI-vs-human survival. A delete job removes everything stored about the repo.
6. Workers write computed metrics to Neon Postgres. Not built yet: S3 `raw/` snapshots and a DynamoDB rate-limit budget. The wave 2 worker clones public repos anonymously and calls no GitHub API, and nothing reads raw snapshots.
7. A NestJS REST API on Lambda, behind its own Function URL, reads metrics from Neon. The dashboard, a static site on GitHub Pages, polls it; the Function URL's CORS allows only that origin.

Public repository history is the load, so the system gets real traffic without fake users.

## Packages

| Path | Owns |
| --- | --- |
| `packages/shared` | Zod schemas and inferred types for the domain, queue messages and API responses. The contract every lane builds against. |
| `packages/db` | Postgres schema, migrations and typed queries. |
| `packages/analyzer` | Pure library: given a local git repo, attribute changes and compute survival. No AWS. The heart of the product. |
| `apps/ingest` | Webhook Lambda (verify, ack, enqueue) and dispatcher Lambda. |
| `apps/worker` | Job runner around the analyzer: clone, analyze, write results. |
| `apps/api` | NestJS REST API on Lambda. |
| `apps/dashboard` | Polling dashboard, a static site on GitHub Pages. |
| `infra` | CDK app with one stack per concern: `FoundationStack` first, then `IngestStack`, `WorkerStack`, `ApiStack` and so on. |

Lanes own disjoint paths. A change that several lanes need goes into `packages/shared` as a small serial task first.

## Cost rules ($0 idle, non-negotiable)

Nothing may cost money while idle, and normal use stays inside AWS credits and always-free tiers. The Budgets alarm is the tripwire, not the plan.

- No NAT Gateway, ever (about $32 a month, no free tier). Workers that need the internet run in a public subnet with an auto-assigned public IP.
- No always-on compute. Fargate, if used, runs per job through `RunTask` and exits. No ECS services, no EC2.
- No RDS. Postgres is Neon.
- No Secrets Manager ($0.40 per secret per month). Secrets go in SSM Parameter Store as `SecureString` with the AWS-managed key.
- No customer-managed KMS keys ($1 per key per month). Use AWS-managed encryption.
- No load balancers and no interface VPC endpoints. Both bill by the hour.
- Every Lambda function and Fargate task is arm64.
- Every log group has a retention period: 14 days unless a task says otherwise.
- S3 objects under `raw/` expire after 14 days, and incomplete multipart uploads abort after 7 days.
- Every S3 prefix that code writes to has a lifecycle rule, or a row in Decisions saying why its data is kept.
- DynamoDB stays inside the always-free tier (provisioned capacity at or under 25 RCU and 25 WCU) unless a decision below says otherwise.
- Container images, if any: a lifecycle policy keeps at most 2 per repository.
- An AWS Budgets alarm always exists: 5 USD a month, email at 50, 80 and 100 percent of actual spend, counted before credits.
- The repo is public: no account IDs, emails or ARNs in code. Read them from the environment at synth time.

## Metric definitions

Finalized in T02 and encoded in `packages/shared/src/domain.ts`. Change the two together.

### What is measured

- **Mainline.** The default branch's first-parent chain, up to the analyzed head. Only lines that land on the mainline are measured. A line added and removed inside a branch before it merges never counts. That makes squash, rebase and merge-commit repos comparable, and it leaves out the time before a merge, during which a line could not have been seen to die.
- **Line.** A non-blank line of a text file. A line keeps its identity through file renames and whitespace-only edits. Any other edit, or a move, ends it and starts a new line that belongs to the editing commit.
- **Introducing commit.** The commit `git blame` assigns the line to at the mainline commit where it landed. For a direct push, a squash merge or a rebase merge that is the landing commit itself. For a merge commit it is the branch commit that wrote the line. Attribution is read from the introducing commit.

### Lifetime and censoring

- The clock starts at the committer date of the mainline commit that landed the line (`introducedAt`).
- It stops at the committer date of the mainline commit whose diff against its first parent removes the line (`removedBy`, `removedAt`).
- A line still present at the analyzed head is right-censored at `observedAt`, the time the worker fetched that head. It counts as at risk up to then and never as a removal, so it is not counted as a survivor forever either.
- Lifetime in whole days: `T = floor((end - introducedAt) / 86400 seconds)`, where `end` is `removedAt`, or `observedAt` for a censored line. A negative value (clock skew) counts as 0.

### Survival

A Kaplan-Meier estimator on whole days, computed per cohort. It is what makes repos of different ages comparable.

- `n_k`: lines with `T >= k`, the lines at risk on day `k`. A line censored at `T = k` is still at risk on day `k`.
- `d_k`: removed lines with `T = k`.
- `S(0) = 1` and `S(k) = (1 - d_0/n_0) * (1 - d_1/n_1) * ... * (1 - d_(k-1)/n_(k-1))`.
- **Survival at `k` days is `S(k)`**: the estimated share of lines that last at least `k` full days. The headline numbers are `S(30)`, `S(90)` and `S(180)`.
- Where the estimate ends: while `n_k > 0`, `S(k)` is the product above. Once `n_k = 0` there are two cases. If the product has reached 0, every line at risk was removed, and `S` stays 0. Otherwise the longest-lived lines are still alive (censored), and `S(k)` is null: unknown, never extrapolated. So 0 means "all removed" and null means "not observed that long yet", and the two are never confused.
- Every curve point carries `atRisk` (`n_k`) so a thin tail can be shown as thin.

Worked example, 10 lines in one cohort:

| Lines | Fate | `T` |
| --- | --- | --- |
| 2 | removed | 10 |
| 3 | censored | 45 |
| 1 | removed | 60 |
| 4 | censored | 200 |

`n_10 = 10` and `d_10 = 2`, so `S(30) = 0.8`. `n_60 = 5` and `d_60 = 1`, so `S(90) = S(180) = 0.8 * 0.8 = 0.64`. `n_365 = 0`, so `S(365)` is null. Counting "alive out of all lines" at 90 days would give 0.40, because it treats the three lines that were only 45 days old as dead. The same numbers are a fixture in `packages/shared/src/fixtures.ts`.

A second example, a reverted change: 10 lines, all removed at `T = 5`. `n_5 = 10` and `d_5 = 10`, so `S(6) = 0`, and `S(30)`, `S(90)` and `S(180)` are all 0, not null.

### Cohorts

Every commit gets one cohort, and a line takes the cohort of its introducing commit.

- `ai`: the commit has at least one attribution with confidence at or above 0.5 (`AI_CONFIDENCE_THRESHOLD`).
- `automation`: the author is a GitHub App bot account (`name[bot]`) that is not a known AI agent, such as dependabot or renovate. These lines are in neither curve, so dependency bumps don't drag the baseline down. A removal made by an automation commit still ends the lines it removes.
- `human`: everything else. Human lines get the same estimator and are the baseline.

### Attribution signals

The first signals are both read from git alone, and both are exact matches against a list of known AI identities, emitted with confidence 1:

1. `co_author_trailer`: a line of the message that, once trimmed, is a complete `Co-Authored-By: Name <email>` trailer whose email is a known AI tool's, such as `Co-Authored-By: Claude <noreply@anthropic.com>`. It matches on the email alone; the name is never matched.
2. `author_identity`: the commit's author or committer is a known AI agent account, such as `copilot-swe-agent[bot]`. Agent commits often carry no AI trailer, and without this signal they would land in the human baseline.

Not counted yet: commit message markers and PR labels. They are heuristics (and PR labels need the GitHub API), so they wait for the eval gate. Confidence below 1 is reserved for them.

The list of AI identities belongs to the analyzer. The attribution eval gate (hardening) scores attribution against a labeled set of commits. A held-out slice in `eval/holdout/` is never shown to agents.

Attribution evidence holds only the matched AI identity or AI trailer. No table stores a human name or email.

### Limits

- Survival means unchanged, not correct. Code in an abandoned repo survives by default, so the dashboard must show the last activity (`headCommittedAt`) next to every curve.
- Attribution is per commit. A commit with an AI trailer counts all of its lines as AI, including the ones a person typed.
- Lines in one commit tend to die together, so they are not independent samples. No confidence interval is reported yet.

This repo dogfoods the metric: its commits carry Claude Code's default trailer, so its own history is the first test dataset.

## Decisions

| When | Decision | Why |
| --- | --- | --- |
| 2026-07 | NestJS with REST; GraphQL dropped | |
| 2026-07 | Neon Postgres instead of RDS | Survives AWS credit expiry at $0 |
| 2026-07 | No NAT Gateway; workers in a public subnet | NAT costs about $32 a month |
| 2026-07 | `ap-south-1`, arm64 everywhere | |
| 2026-09 | Built by Claude Code agents in Conductor with a hook-enforced harness | See docs/PLAYBOOK.md |
| 2026-09 | Secrets in SSM Parameter Store, not Secrets Manager | Free |
| 2026-09 | Vitest and Biome as defaults | One fast test runner and one lint/format tool for every package |
| 2026-10 | TypeScript 7.0.2 (native compiler), pinned exact | T01 checked NestJS decorators first: a class using `@Injectable()`, constructor injection, `@Inject` and `@Optional` compiles to byte-identical JavaScript under 6.0.3 and 7.0.2 with `experimentalDecorators` and `emitDecoratorMetadata`, and `design:paramtypes` reads back correctly at runtime. Vitest 5 (Vite 8, Rolldown) emits the same metadata, so API tests need no extra transform. Two things for the API lane: `@nestjs/cli` 12 still bundles TypeScript 6 for `nest build`, and esbuild does not emit decorator metadata, so the Lambda bundle must come from `tsc` or another metadata-aware compiler. The decorator flags go in `apps/api/tsconfig.json`, not the base config |
| 2026-10 | Workspace packages export TypeScript source (`exports` points at `src/index.ts`), relative imports use `.ts` extensions | Typecheck and tests need no build step or build order, and files run under Node's type stripping as written |
| 2026-10 | `verify:changed` builds its own changed-package list from `git diff` plus untracked files | pnpm's `...[ref]` filter reads `git diff` only, so a new untracked file would skip verification |
| 2026-10 | `ALERT_EMAIL` is required for every CDK run; only the root `synth` script may use a placeholder, behind `ALERT_EMAIL_PLACEHOLDER=1` | `pnpm synth` must work with no setup for CI and the cost-guard agent, and a deploy must never ship a budget alarm that emails nobody |
| 2026-10 | The budget counts spend before credits and refunds | With the AWS default, credits net usage to zero, so the alarm would stay silent while a runaway resource burned through them |
| 2026-10 | `cdk.json` carries the CDK library's recommended feature flags, and stack tests load the same context | A new app should start on current defaults, since flipping flags after the first deploy can change deployed resources. Tests then assert on what `pnpm synth` produces |
| 2026-10 | No dependency install scripts: `allowBuilds` in `pnpm-workspace.yaml` turns esbuild's off | pnpm 11 fails the install on an unreviewed build script. esbuild's binary arrives as an optional dependency, so its postinstall is not needed |
| 2026-10 | Biome skips the harness (`.claude/`, `.conductor/`, `scripts/conductor/`) | Lanes can't edit those files, so a formatting difference there would block every lane's verify |
| 2026-10 | Query layer: Kysely. T02 ships the node-postgres dialect only (local, CI, migrate); the first lane that runs on Lambda adds Neon's serverless driver as a second dialect | One `Kysely<Database>` type covers every driver, so the query module is written once, where Drizzle types the database object per driver. Zod stays the only model of the shapes: Drizzle's schema-as-code would be a second one, and `drizzle-zod` derives zod from tables, the wrong direction. Kysely has no dependencies, no CLI and no codegen. The cost is a hand-written `Database` interface that can drift from the SQL; tests against real Postgres compare it with the live catalog and with the zod types. Neon code waits because nothing can test it until a Neon project exists |
| 2026-10 | Every write in the query module is one idempotent statement: an upsert that carries absolute values, or a keyed delete. Workers write repo, commits, attributions, observations, then the prunes `deleteCommitsExcept`, `deleteAttributionsExcept` and `deleteSurvivalObservationsExcept`, then rollups, and the repo's head last. Only that last write (`setRepoHead`) moves the head | Neon's HTTP driver has no interactive transactions. A job that dies midway leaves the old head, and a retry converges, so none are needed. The prunes make the stored commits, attributions and observations equal the latest analysis, each in one statement with its keep list as arrays read by `unnest`. Nothing is written after `setRepoHead`, because the worker skips a push whose tip is already the stored head, so a failed later write would never be retried. Rollups do not fully converge: a measured cohort left with no lines gets no rollup, so its old row stays. That row names an older head and the API filters rollups on the repo's head, so it is never shown; removing it is left to hardening |
| 2026-10 | Postgres 17 everywhere: the workspace container, the CI service, and the Neon project when it is created | One major version to reason about. The schema needs 15 or newer for `UNIQUE NULLS NOT DISTINCT` |
| 2026-10 | Migrations are forward-only `.sql` files applied by Kysely's Migrator. `migrate` runs under Node's type stripping with no loader, and reads `DATABASE_URL` from the environment or the workspace's `.env.workspace` only | A reviewer reads the exact DDL in the diff. The Migrator brings the advisory lock, the transaction and the bookkeeping table. The repo's `.env` is never loaded, so only a human with the URL in hand can migrate Neon |
| 2026-10 | Survival is measured on the mainline (the default branch's first-parent chain), and a line's clock starts when it lands there, not at its commit date | Lines that die inside a branch before merging are invisible, so counting branch time would be time in which a line could not be seen to die. Starting at landing also makes squash, rebase and merge-commit repos comparable |
| 2026-10 | `author_identity` counts as an attribution signal from the start, next to `co_author_trailer`. Non-AI bots are a third cohort, `automation`, left out of both curves | Agent commits often carry no AI trailer and would land in the human baseline. Dependency bots would drag the same baseline down |
| 2026-10 | The database stores survival observations per pair of introducing and removing commit, not per line span, and each curve as one JSONB value in its rollup row | About ten times fewer rows on Neon's free tier, and no endpoint needs spans. A curve is always written and read whole, in one upsert, and zod checks it when it is read. Every table is derived from git, so a later change of grain is a migration plus a re-analysis |
| 2026-10 | Every table cascades from `repos`, and attributions and observations also from `commits` | Removing a repo is one `DELETE`. Head columns have no commit key, because the head need not introduce or remove a tracked line |
| 2026-10 | No human name or email is stored. Attribution evidence is exactly one identity on one line, enforced by the zod schema, the query module and a CHECK | The metric needs no personal data. The schema can prove "one identity", not "that identity is an AI": the analyzer lane must test that its matcher only ever emits identities from its AI list |
| 2026-10 | The db tests run against real Postgres in a scratch schema. With no database they skip on a laptop and fail in CI | A lane that only touches `packages/shared` still runs them as a dependent, and Docker being stopped should not block it. In CI a skip would be a green run that proved nothing |
| 2026-10 | The front door is a Lambda Function URL with auth type `NONE`: for the webhook now, and for the API on Lambda in wave 2. The webhook's HMAC signature is its authentication | A Function URL is free and adds nothing that bills while idle. An API Gateway HTTP API bills per request once the free year ends, and its route throttling and custom domains are not needed for one POST endpoint. CDK adds both grants a URL has needed since October 2025, `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` through the URL only; without the second, callers get a 403. The stack ID `CodeTrustIngest` and the construct IDs `WebhookFunction` and `FunctionUrl` never change after the first deploy, because a new ID means a new URL. Lambda refuses requests over about 6 MB, while GitHub sends up to 25 MB: such a push is lost, and the next push catches up |
| 2026-10 | Private repositories never enter the pipeline. A push is enqueued only when `repository.private` is false and `visibility`, when present, is `public`. An installation's repositories are enqueued only when `private` is false | The read API has no auth, so anything queued could end up public. Repositories that turn private later, and the data of uninstalled ones, are wave 2's job |
| 2026-10 | The webhook's IAM role is explicit and holds only `sqs:SendMessage` on the events queue, `ssm:GetParameter` on the secret parameter, and log writes to its own log group | CDK's default role attaches `AWSLambdaBasicExecutionRole`, whose log actions apply to every resource, and CDK's grant helpers add queue and parameter actions the function never calls. There is no `kms:Decrypt`, so the parameter must use the AWS-managed `aws/ssm` key, whose policy allows use through SSM |
| 2026-10 | The events queue and its DLQ both keep messages 14 days, the SQS maximum, with `maxReceiveCount` 5 | Storage is free, and events wait there for the wave 2 consumer. The cost: a standard queue's DLQ counts expiry from the original enqueue, so a message that waited long before failing has little time left in the DLQ, and an expired message skips the DLQ entirely. Wave 2 may shorten the events queue's retention once a consumer runs, and must keep its visibility timeout above the consumer's timeout, or synth fails validation (E3505) |
| 2026-10 | esbuild is a root devDependency. Lambda bundles are CommonJS from `NodejsFunction` on a pinned runtime (`NODEJS_24_X`), with `@aws-sdk/*` and `@smithy/*` taken from the runtime | `NodejsFunction` runs `pnpm exec esbuild` from its project root, which must contain both the entry and the lockfile, so it is the workspace root, where `pnpm exec` sees only the root's binaries. With esbuild only in `infra`, synth fails. `NODEJS_LATEST` would bundle the whole SDK. CommonJS means a handler's import graph may not use `import.meta` or top-level await |
| 2026-10 | The webhook times out after 8 seconds, and its SDK clients make at most 2 attempts, with a 1 second connection timeout and a 1.5 second request timeout that throws | The SDK sets no timeouts by default, so a hung SSM or SQS call would run until Lambda killed the function, and nothing would be logged. With these, a hung call becomes the handler's own logged 500 well inside GitHub's 10 seconds. `throwOnRequestTimeout` is needed because since `@smithy/node-http-handler` 4.4.0 a request timeout alone only logs a warning |
| 2026-10 | Files left out of the metric are a fixed list of git glob pathspecs in `packages/analyzer/src/history/measured-paths.ts`, in four named rules. Lock files: `**/*.lock`, `pnpm-lock.yaml`, `package-lock.json`, `go.sum` and the like. Vendored: `node_modules/`, `vendor/`, `third_party/` and the like. Minified: `*.min.js`, `*.js.map` and the like. Generated: `dist/`, protobuf and Dart codegen, `*.Designer.cs`, snapshots and the like. `.gitattributes` is not read | Lock files churn for reasons unrelated to who wrote them: `pnpm-lock.yaml` alone held about a quarter of this repo's lines. `linguist-generated` changes over history and git reads it from the worktree, so honouring it means reading attributes per commit and ending or starting lines when they change, and no diff reports that. The list is applied as exclude pathspecs, so a rename across the boundary arrives as a plain add or delete with full content. At a merge, a line that blame follows back into a left-out path belongs to the merge, the same as in linear or squash history. `build/`, `out/` and `lib/` stay measured because they are often hand-written. The hardening trial tests the list; the walk CLI's top extensions by alive lines show what it misses |
| 2026-10 | The walker reads history with one streaming first-parent `git log --sparse -p -U0 -w -M50%`, and blames only merge commits, only the lines they add. Rule 3 is decided by ancestry (`merge-base --is-ancestor` against the first parent), not by blame's `boundary` flag. Myers with the indent heuristic is pinned through config for log and blame alike. Renames are found at 50% similarity with a limit of 1000, and copies are never detected. A file is binary by git's content check alone: in-tree attributes are ignored (`--attr-source` is the empty tree), and a repository with a non-empty `info/attributes` or `info/grafts` is refused. Shallow, partial and SHA-256 repositories are refused. Git 2.41 or newer is required | One stream is far cheaper than one diff per commit. `--sparse` keeps commits that touch only left-out files in the stream, so it lines up with the mainline. `boundary` also marks root commits, so it would give an unrelated history's lines to the merge. If log and blame aligned lines differently, merge attribution would drift. Worktree attributes, `info/attributes` (found through `git rev-parse --git-path`, so linked worktrees are covered) and grafts would all make the result depend on more than the commits. 2.41 is the first release with the global `--attr-source`. `core.precomposeUnicode=false` is pinned so paths behave the same on macOS and Linux. Known limits: a rename that also rewrites most of the file's bytes, such as a full re-indent, is a delete plus an add, because git pairs renames on raw bytes and not under `-w`. A file whose name is not valid UTF-8 cannot be passed to blame, because Node passes arguments as UTF-8, so lines a merge adds to it go to the merge, and the walk CLI counts them |
| 2026-10 | The API wires NestJS without decorator metadata. Every constructor parameter has an explicit `@Inject(token)`, route params are parsed by zod pipes, and `emitDecoratorMetadata` stays off in `apps/api/tsconfig.json`. `dev` runs under tsx, and wave 2 bundles the Lambda with `NodejsFunction`'s esbuild. This supersedes the bundling clause of the TypeScript 7 row | esbuild, and so tsx, emits no `design:paramtypes`, and Node's type stripping cannot run decorators at all. Without metadata the API needs no `tsc` build step and no second compiler. With the flag off, the Vitest run is the proof. The cost: Nest features that read design types, such as `ValidationPipe` with class-validator and injection by type, are unavailable, which suits zod. A constructor parameter without `@Inject` is also not an error: Nest injects `undefined` and the app still boots, so a test asserts that each injected property holds the right instance |
| 2026-10 | A `Co-Authored-By` trailer counts on any line of the message that, once trimmed, is one complete trailer (key in any case, at least one space after the colon), not only in git's last paragraph. A mention inside a sentence does not count | A squash merge carries the squashed commits' trailers in the middle of its body: GitHub lists each commit's message under a bullet, and `git merge --squash` indents every message by four spaces. Squash repos are common, and reading only the last paragraph would put their AI commits in the human baseline. The cost: a message that quotes a complete AI trailer on a line of its own counts as AI |
| 2026-10 | Both signals match on the email alone: an exact match against the AI list, without regard to case. A name never matches, and nothing matches by substring or pattern | Tools write many names over one email (Claude Code writes `Claude` and `Claude Opus 5.5 (1M context)`), and a name proves nothing: a person named Claude must not land in `ai`, and `noreply@anthropic.com.example.org` is not Anthropic's. The cost: a tool that marks only the name, such as aider's default `(aider)` suffix, is missed. An AI bot account missing from the list lands in `automation`, out of both curves, so a missing entry costs recall, while a weak entry, such as a trailer a tool writes for any assistance, costs precision. That is why the list leaves out the `Copilot` trailer VS Code adds whenever a Copilot feature touched the change. The list's rules, sources and exclusions are in `packages/analyzer/src/attribution/identities.ts` |
| 2026-10 | Attribution evidence is built from the matched list entry, `Co-Authored-By: <name> <email>` for a trailer and `<name> <email>` for an identity, never copied from the commit | Every stored identity is then on the AI list by construction, so no human name is stored even when a trailer puts a person's name on an AI email, and no evidence exceeds `EVIDENCE_MAX_LENGTH`. The analyzer's property test checks this over seeded random commits. The cost: evidence does not show the commit's exact text, such as the model name in `Claude Opus 5.5 (1M context)` or the key's casing |
| 2026-10 | The worker runs on Lambda (arm64), not Fargate. No VPC. git is packaged for the Lambda runtime as a layer. Repos that need more than 15 minutes or 10 GB are out of scope until the hardening trial | AWS credits end 2026-10-26 and Fargate has no free tier, while Lambda's compute stays inside the always-free tier at this scale. Without a VPC the function reaches GitHub and Neon directly, with no NAT. A job past Lambda's limits fails, is retried, and ends in the jobs DLQ |
| 2026-10 | Per-repo ordering: the dispatcher sends jobs to an SQS FIFO queue with `MessageGroupId` set to the repo id | One repo never has two jobs at once, and a late job cannot move the head back |
| 2026-10 | The dashboard is a static site on GitHub Pages. The API's Function URL allows that origin through its CORS configuration, and no other | Free, with no AWS resource to bill or secure. CORS on the Function URL keeps the rule in the template, where a reviewer sees it |
| 2026-10 | Neon runs Postgres 17 in `aws-ap-southeast-1` (Singapore), migrated to `0001_init`, with the compute pinned to 0.25 CU. The direct (non-pooler) URL is the SSM SecureString `/code-trust/database-url`, with `sslmode=verify-full` | Neon has no Mumbai region. Every query crosses from Mumbai to Singapore, so the worker batches its writes and each API request makes only a few queries. The free plan has 100 CU-hours a month and suspends the compute after 5 idle minutes, so the dashboard polls every 10 minutes and only while its tab is visible |
| 2026-10 | Lambda reaches Neon over HTTP (`neon()` from `@neondatabase/serverless`, one HTTPS request per query) through an in-repo Kysely dialect, `@code-trust/db/neon`. Each query gets a fresh `AbortSignal.timeout(queryTimeoutMs)`, passed to the driver as `fetchOptions.signal`. The root `@code-trust/db` is driver-free and migrator-free; the migrator is the `@code-trust/db/migrator` subpath | HTTP leaves no socket to close per invocation or leak across a freeze, and nothing needs the sessions and transactions of the WebSocket `Pool`. Affected-row counts still come back (`command` and `rowCount`), so `setRepoHead` and the deletes report them. `kysely-neon` calls the driver with fixed options, so a per-query signal could not reach it without wrapping its internals, and the dialect is about 80 lines. The signal is made per query because `AbortSignal.timeout` counts from creation. The migrator's `import.meta.url` is empty in a CommonJS bundle, so the root may not reach it: a bundle test with `NodejsFunction`'s esbuild settings holds the root and `/neon` to zero warnings and no node-postgres. The driver's fetch hook is global, so the test shim (`@code-trust/db/testing-neon`) routes requests by host. Migrations stay on node-postgres, since the Migrator needs a transaction |
| 2026-10 | git on Lambda comes from a layer built from Amazon Linux 2023's own `git-core` (2.50.1), pinned to an exact version-release in `infra/layers/git/packages.txt`, plus any shared library the `nodejs:24` arm64 image lacks: none today, checked on every build with that image's own loader. `/opt/bin/git` is a `sh` wrapper that sets `LD_LIBRARY_PATH=/opt/lib`, `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR`, then `exec`s the real binary. HTTPS uses the runtime's libcurl and CA bundle. `GitLayer` uses a one-file placeholder asset when its stack's `bundlingRequired` is false. When bundling is required and the zip is missing it throws, unless `GIT_LAYER_PLACEHOLDER=1`, which only the root `synth` script sets | The distro's package is new enough, matches the runtime's glibc and needs no build from source. The analyzer gives git only `PATH` and `HOME`, and Amazon Linux's git looks for `git-remote-https` and its templates under `/usr`, so git needs an environment whatever finds its libraries; an RPATH would also mean patching every binary. `pnpm synth` must work with no Docker and no zip, and a deploy must never ship a worker without git. The CDK CLI bundles every stack for `deploy` and `diff` unless `--exclusively` is given, so once a stack uses `GitLayer`, deploying any stack needs the zip, or the other stack is deployed with `--exclusively`. The cost: deploying a cloud assembly that `pnpm synth` produced (`--app cdk.out`) would ship the placeholder, as it would the placeholder alert email |
| 2026-10 | The worker skips a `push` job, before cloning, when the ls-remote tip equals the stored head; a `backfill` always analyzes. It analyzes the commit it cloned, never the job's `headSha`. A job is `unavailable` (acknowledged, nothing written or deleted) only when git exits 128 with GitHub's `remote: Repository not found.` or with `terminal prompts disabled`. An empty repo is `skipped`. Anything else throws. The Lambda handler reports a failed record and every record after it in `batchItemFailures` | The skip collapses a burst of pushes into one analysis, and it is safe because `setRepoHead` is the last write. A backfill analyzes again so that re-adding a repo picks up analyzer changes. Analyzing the cloned tip keeps a late job from moving the head back. A thrown job holds the repo's FIFO group for the visibility timeout on every attempt, so a repo that went private, or has no commits yet, must not throw: the delete job behind it would wait. Anything git does not say plainly may be a network fault, so it throws and SQS retries. The records after a failed one in a FIFO batch may share its group and must not overtake it |
| 2026-10 | The worker clones with `--template= --single-branch --no-tags --no-checkout`, full history, into a work root (`WORK_ROOT`, default `/tmp/work`) that every job empties first. Its git calls get an environment built from scratch: `PATH`, `HOME` at the work root, `LC_ALL=C`, no system or global config, no prompts, a ceiling above the work root, and a timeout that kills git's process group (30 seconds for ls-remote, 10 minutes for the clone). `lambda.ts` sets the process's `HOME` to the work root. Each job's statement count comes from a Kysely plugin | The analyzer reads objects only and refuses shallow and partial clones. An empty `--template` beats the layer's `GIT_TEMPLATE_DIR`, so the clone has no hooks or `info/` files whatever templates git carries. A job killed by a timeout or out of memory skips its `finally` and Lambda keeps `/tmp`, so the next job cleans up, and a directory of the worker's own keeps that wipe away from anything else in `/tmp`. `LC_ALL=C` keeps the messages the classifier reads in English. The clone timeout leaves time to log the failure inside Lambda's 15 minutes. `createNeonDb` and `createPgDb` take no Kysely `log` option, so the count comes from a plugin's `transformResult`, which runs once per executed statement, and the tests check it against a `log` hook |
| 2026-10 | The dispatcher's `MessageDeduplicationId` is `<deliveryId>:<repo id>`, never content-based. A record counts as dispatched only when SQS lists its entry in `Successful`; anything else, and any record that fails to parse, goes back through `ReportBatchItemFailures`, and the handler never throws. Batches of 10 go out one at a time in record order, on the webhook's `AWS_CLIENT_CONFIG` | An installation delivery yields one event per repo under one delivery id, so the delivery id alone would drop every repo after the first, and SQS would report them as sent. The `jobId` is new on every attempt, so content-based dedupe would let a retry of a send that SQS took become a second job. A retry costs nothing, while a job wrongly taken as sent is lost. FIFO keeps a group's order as SQS receives it, so parallel batches could land a repo's delete before an earlier analyze. Each batch takes at most about 5 seconds, so T13 sizes the event source mapping's batch to keep the worst case under the function's timeout, which stays below the events queue's 30 second visibility timeout |

## Open decisions

| Question | Options | Decide in |
| --- | --- | --- |
| Files left out of the metric | The fixed path list is decided (see Decisions). Still open: whether to also honour `.gitattributes` `linguist-generated` and `linguist-vendored`, read per commit, and which paths the list misses | Hardening trial on public repos |

## Build order

0. T01 foundation, then T02 contracts. Serial.
1. Wave 1: analyzer core, ingest (webhook to SQS), API read path.
2. Wave 2: contracts first (T07 queue messages, T08 database access from Lambda), then worker and dispatcher, API on Lambda, dashboard, repo removal, attribution eval gate.
3. Hardening: cost audit, security review, trial on real public repos.
