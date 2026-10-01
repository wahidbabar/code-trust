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
- DynamoDB stays inside the always-free tier (provisioned capacity at or under 25 RCU and 25 WCU) unless a decision below says otherwise.
- Container images, if any: a lifecycle policy keeps at most 2 per repository.
- An AWS Budgets alarm always exists: 5 USD a month, email at 50, 80 and 100 percent of actual spend, counted before credits.
- The repo is public: no account IDs, emails or ARNs in code. Read them from the environment at synth time.

## Metric definitions (finalized in T02)

- AI-attributed line: a line whose introducing commit carries an AI attribution signal. First signal: `Co-Authored-By` trailers that name an AI tool, such as `Co-Authored-By: Claude <noreply@anthropic.com>`. Signals to evaluate next: bot authors, PR labels, commit message markers.
- Survival at t: the share of AI-attributed lines still present (by blame) t days after they were introduced.
- Lines still alive at the last observation are right-censored rather than counted as survivors forever. A Kaplan-Meier estimator handles that, and it makes repos of different ages comparable.
- Human-written lines get the same metrics as the baseline.
- The attribution eval gate (hardening) scores attribution against a labeled set of commits. A held-out slice in `eval/holdout/` is never shown to agents.

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

## Open decisions

| Question | Options | Decide in |
| --- | --- | --- |
| API front door | API Gateway HTTP API (current plan; bills per request once credits end, cents at this scale) or Lambda Function URL (free, fewer features) | Ingest lane |
| Worker runtime | Fargate `RunTask` (current plan; no free tier, cents per job) or Lambda (always-free compute, 15 minute and 10 GB limits) | Worker lane, with real repo sizes |
| Query layer | Drizzle or Kysely, with Neon's serverless driver | T02 |
| Dashboard hosting | S3 plus CloudFront, or a free static host | Dashboard lane |

## Build order

0. T01 foundation, then T02 contracts. Serial.
1. Wave 1: analyzer core, ingest (webhook to SQS), API read path.
2. Wave 2: worker and dispatcher, dashboard, attribution eval gate.
3. Hardening: cost audit, security review, trial on real public repos.
