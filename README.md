# code-trust

A GitHub App that measures how long AI-attributed code survives in real repository history: of the lines an AI wrote, how many are still there 30, 90 or 180 days later.

> Status: pre-foundation. The repo holds the plan and the agent harness. The monorepo, infra and product code arrive through the tasks in [docs/tasks](docs/tasks), tracked in [docs/STATUS.md](docs/STATUS.md).

## How this repo is built

Claude Code agents running in [Conductor](https://www.conductor.build) do the implementation, one git worktree per task. Hooks verify every change before an agent may finish and block deploys, secret reads and pushes to main. A human approves plans and merges pull requests. The whole loop is in [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

## Layout (planned)

| Path | What it is |
| --- | --- |
| `packages/shared` | Contracts: zod schemas and types |
| `packages/db` | Postgres schema and migrations (Neon) |
| `packages/analyzer` | Git history analysis and survival metrics |
| `apps/ingest` | Webhook and dispatcher Lambdas |
| `apps/worker` | Analysis job runner |
| `apps/api` | NestJS REST API on Lambda |
| `apps/dashboard` | Polling dashboard |
| `infra` | AWS CDK v2 app |

## Docs

- [Architecture, cost rules and decisions](docs/architecture.md)
- [Playbook: how agents build this](docs/PLAYBOOK.md)
- [Status](docs/STATUS.md)
