# Architecture

code-trust is a GitHub App that measures how long AI-attributed code survives in real repository history. It ingests repository events, walks git history (blame and diff), classifies changes as AI-attributed or human, and computes survival metrics so a team can see how durable AI-written code actually is.

Why survival: the usual AI coding metric is acceptance, meaning whether someone took the suggestion. That says little about quality. Survival asks whether the code is still there 30, 90 or 180 days later, or whether it was rewritten or deleted.

## Stack

- TypeScript 7 everywhere, ESM, strict.
- pnpm workspaces monorepo.
- AWS CDK v2 (`aws-cdk-lib`) for all infrastructure, in TypeScript.
- Region `ap-south-1`. All compute is arm64 (Lambda `arm64`, Fargate `ARM64`).
- NestJS with REST for the API. GraphQL was considered and dropped.
- Postgres on Neon's free tier, not RDS.
- Defaults set with the agent harness (T01 may change them with a recorded reason): Vitest for tests, Biome for lint and format.

## Flow

```
GitHub App webhook
      │
      ▼
API Gateway ──► webhook Lambda (verify HMAC signature, fast 200 ack)
                      │
                      ▼
                   SQS (+ DLQ)
                      │
                      ▼
              dispatcher Lambda (ECS RunTask)
                      │
                      ▼
      on-demand Fargate ARM64 git workers
      (clone, blame, diff, compute AI-vs-human survival)
        │                 │                     │
        ▼                 ▼                     ▼
   raw diffs/          metrics to        rate-limit budget
   snapshots           Neon Postgres     to DynamoDB
   to S3
```

1. The GitHub App webhook posts to the API front door.
2. A webhook Lambda verifies the HMAC signature and returns a fast `200`. No heavy work inline.
3. It enqueues the event on SQS, with a DLQ for poison messages.
4. A dispatcher Lambda consumes the queue and launches one worker per job.
5. Workers clone the repo, run blame and diff, and compute AI-vs-human survival.
6. Workers write raw diffs and snapshots to S3 under `raw/`, computed metrics to Neon Postgres, and the GitHub rate-limit budget to DynamoDB.
7. A NestJS REST API on Lambda reads metrics from Neon and serves a polling dashboard.

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
| `apps/dashboard` | Polling dashboard, a static site. |
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
- `S(k)` is reported only while `n_k > 0`. Past the longest observed lifetime it is null, never extrapolated. Every curve point carries `atRisk` (`n_k`) so a thin tail can be shown as thin.

Worked example, 10 lines in one cohort:

| Lines | Fate | `T` |
| --- | --- | --- |
| 2 | removed | 10 |
| 3 | censored | 45 |
| 1 | removed | 60 |
| 4 | censored | 200 |

`n_10 = 10` and `d_10 = 2`, so `S(30) = 0.8`. `n_60 = 5` and `d_60 = 1`, so `S(90) = S(180) = 0.8 * 0.8 = 0.64`. `n_365 = 0`, so `S(365)` is null. Counting "alive out of all lines" at 90 days would give 0.40, because it treats the three lines that were only 45 days old as dead. The same numbers are a fixture in `packages/shared/src/fixtures.ts`.

### Cohorts

Every commit gets one cohort, and a line takes the cohort of its introducing commit.

- `ai`: the commit has at least one attribution with confidence at or above 0.5 (`AI_CONFIDENCE_THRESHOLD`).
- `automation`: the author is a GitHub App bot account (`name[bot]`) that is not a known AI agent, such as dependabot or renovate. These lines are in neither curve, so dependency bumps don't drag the baseline down. A removal made by an automation commit still ends the lines it removes.
- `human`: everything else. Human lines get the same estimator and are the baseline.

### Attribution signals

The first signals are both read from git alone, and both are exact matches against a list of known AI identities, emitted with confidence 1:

1. `co_author_trailer`: a `Co-Authored-By` trailer whose name or email is a known AI tool, such as `Co-Authored-By: Claude <noreply@anthropic.com>`.
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
| 2026-10 | Every write in the query module is one idempotent statement: an upsert that carries absolute values, or a keyed delete. Workers write repo, commits, attributions and observations, rollups, then the repo's head last | Neon's HTTP driver has no interactive transactions. A job that dies midway leaves the old head, and a retry converges, so none are needed |
| 2026-10 | Postgres 17 everywhere: the workspace container, the CI service, and the Neon project when it is created | One major version to reason about. The schema needs 15 or newer for `UNIQUE NULLS NOT DISTINCT` |
| 2026-10 | Migrations are forward-only `.sql` files applied by Kysely's Migrator. `migrate` runs under Node's type stripping with no loader, and reads `DATABASE_URL` from the environment or the workspace's `.env.workspace` only | A reviewer reads the exact DDL in the diff. The Migrator brings the advisory lock, the transaction and the bookkeeping table. The repo's `.env` is never loaded, so only a human with the URL in hand can migrate Neon |
| 2026-10 | Survival is measured on the mainline (the default branch's first-parent chain), and a line's clock starts when it lands there, not at its commit date | Lines that die inside a branch before merging are invisible, so counting branch time would be time in which a line could not be seen to die. Starting at landing also makes squash, rebase and merge-commit repos comparable |
| 2026-10 | `author_identity` counts as an attribution signal from the start, next to `co_author_trailer`. Non-AI bots are a third cohort, `automation`, left out of both curves | Agent commits often carry no AI trailer and would land in the human baseline. Dependency bots would drag the same baseline down |
| 2026-10 | The database stores survival observations per pair of introducing and removing commit, not per line span, and each curve as one JSONB value in its rollup row | About ten times fewer rows on Neon's free tier, and no endpoint needs spans. A curve is always written and read whole, in one upsert, and zod checks it when it is read. Every table is derived from git, so a later change of grain is a migration plus a re-analysis |
| 2026-10 | Every table cascades from `repos`, and attributions and observations also from `commits` | Removing a repo is one `DELETE`. Head columns have no commit key, because the head need not introduce or remove a tracked line |
| 2026-10 | No human name or email is stored. Attribution evidence is exactly one identity on one line, enforced by the zod schema, the query module and a CHECK | The metric needs no personal data. The schema can prove "one identity", not "that identity is an AI": the analyzer lane must test that its matcher only ever emits identities from its AI list |
| 2026-10 | The db tests run against real Postgres in a scratch schema. With no database they skip on a laptop and fail in CI | A lane that only touches `packages/shared` still runs them as a dependent, and Docker being stopped should not block it. In CI a skip would be a green run that proved nothing |

## Open decisions

| Question | Options | Decide in |
| --- | --- | --- |
| API front door | API Gateway HTTP API (current plan; bills per request once credits end, cents at this scale) or Lambda Function URL (free, fewer features) | Ingest lane |
| Worker runtime | Fargate `RunTask` (current plan; no free tier, cents per job) or Lambda (always-free compute, 15 minute and 10 GB limits) | Worker lane, with real repo sizes |
| Files left out of the metric | Generated, vendored and lock files churn for reasons unrelated to who wrote them. Options: a fixed path list, `.gitattributes` `linguist-generated`, or both | Analyzer lane, with real repos |
| Neon driver on Lambda | Over HTTP (`kysely-neon`, one request per query, no connection to keep alive) or a WebSocket `Pool` (sessions and transactions) | The first lane that runs on Lambda |
| Dashboard hosting | S3 plus CloudFront, or a free static host | Dashboard lane |

## Build order

0. T01 foundation, then T02 contracts. Serial.
1. Wave 1: analyzer core, ingest (webhook to SQS), API read path.
2. Wave 2: worker and dispatcher, dashboard, attribution eval gate.
3. Hardening: cost audit, security review, trial on real public repos.
