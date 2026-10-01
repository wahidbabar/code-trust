# code-trust

A GitHub App that measures how long AI-attributed code survives in real repository history: of the lines an AI wrote, how many are still there 30, 90 or 180 days later.

> Status: foundation. The monorepo, tooling, CI and the first CDK stack exist. Product code arrives through the tasks in [docs/tasks](docs/tasks), tracked in [docs/STATUS.md](docs/STATUS.md).

## Getting started

You need Node 22.12 or newer and pnpm 11. The exact pnpm version is pinned in `package.json` (`packageManager`), so Corepack picks it up if you use it. No AWS account is needed for anything in this section.

```sh
pnpm install
pnpm verify
```

`pnpm verify` runs typecheck, lint and tests for every package. It is what CI runs.

While you work:

```sh
pnpm verify:changed
pnpm --filter @code-trust/analyzer test
pnpm format
```

- `pnpm verify:changed` checks only the packages changed since `origin/main` (set `VERIFY_BASE` for another ref) and the packages that depend on them. Untracked files count as changes. It runs the full `verify` when a root config file changed.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` run one concern across every package.

To prove the infrastructure compiles:

```sh
pnpm synth
```

`pnpm synth` runs `cdk synth` with a placeholder alert address. It needs no AWS credentials and no `ALERT_EMAIL`, and it deploys nothing.

## Deploy (human only)

Agents never run these; the hooks block them. A human deploys from `main` with AWS credentials for the target account.

```sh
export ALERT_EMAIL=you@your-domain.example
cd infra
pnpm exec cdk bootstrap
pnpm exec cdk deploy CodeTrustFoundation
```

`ALERT_EMAIL` receives the budget alerts and is required: without it the CDK app refuses to run, so a deploy can never ship the placeholder address. The region comes from `infra/lib/config.ts`.

## How this repo is built

Claude Code agents running in [Conductor](https://www.conductor.build) do the implementation, one git worktree per task. Hooks verify every change before an agent may finish and block deploys, secret reads and pushes to main. A human approves plans and merges pull requests. The whole loop is in [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

## Layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Contracts: zod schemas and types |
| `packages/db` | Postgres schema and migrations (Neon) |
| `packages/analyzer` | Git history analysis and survival metrics |
| `apps/ingest` | Webhook and dispatcher Lambdas |
| `apps/worker` | Analysis job runner |
| `apps/api` | NestJS REST API on Lambda |
| `apps/dashboard` | Polling dashboard |
| `infra` | AWS CDK v2 app. `FoundationStack`: budget alarm and data bucket |

Every package is a placeholder until its lane lands. Workspace packages export TypeScript source directly, so nothing needs a build step to typecheck or test.

## Docs

- [Architecture, cost rules and decisions](docs/architecture.md)
- [Playbook: how agents build this](docs/PLAYBOOK.md)
- [Status](docs/STATUS.md)
