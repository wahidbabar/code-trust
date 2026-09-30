# code-trust

A GitHub App that measures how long AI-attributed code survives in real repository history. Architecture, cost rules, metric definitions and decisions are in docs/architecture.md. Read it before touching infra or anything that crosses packages.

## Commands

- `pnpm install`: pnpm workspaces only, never npm or yarn.
- `pnpm verify:changed`: typecheck, lint and tests for packages changed since `origin/main` and their dependents. Run it before you say you're done.
- `pnpm verify`: every package. CI runs this.
- `pnpm --filter <package> test -- <pattern>`: one package or one test while iterating.
- `pnpm synth`: proves infra compiles. Synth is fine; deploying is not.
- Task T01 creates these scripts. Until it merges, only `pnpm install` exists.

## Environment

- You usually run in a Conductor workspace: a git worktree on its own branch, with other agents working in sibling worktrees at the same time.
- Dev servers bind to `$CONDUCTOR_PORT`. This workspace owns `$CONDUCTOR_PORT` through `$CONDUCTOR_PORT+9`.
- This workspace's local Postgres URL is in `.env.workspace`. Conductor setup creates the database in the `code-trust-pg` container.

## Hard rules (hooks in .claude/hooks enforce most of these)

- IMPORTANT: never run `cdk deploy`, `cdk destroy`, `cdk bootstrap` or mutating `aws` commands. The human deploys from main.
- $0 idle cost. Check the Cost rules in docs/architecture.md before adding any AWS resource: no NAT Gateway, RDS, Secrets Manager, customer-managed KMS keys, load balancers or always-on compute; arm64 everywhere; retention on every log group.
- Never read, print or commit secrets: `.env` files other than `.env.example` and `.env.workspace`, `*.pem`, `~/.aws`.
- Don't edit golden test data (`__golden__/`), the eval holdout (`eval/holdout/`), the harness (`.claude/settings.json`, `.claude/hooks/`, `.conductor/`, `scripts/conductor/`) or `pnpm-lock.yaml` by hand. If a task seems to need that, stop and ask.
- Stay inside the owner paths of your task file, plus its Status line and your row in docs/STATUS.md. Needing another lane's paths means stop and ask.
- Never push to main or merge PRs. Push your branch and open a PR.
- Keep Claude Code's default `Co-Authored-By` commit trailer. code-trust uses it as ground truth, so this repo's own history is test data.

## Workflow

- Work comes from a task file in docs/tasks/. No task file, no work: ask for one.
- Plan first when a change touches 3 or more files. The plan lists files, tests, and how you will prove each "Done when" item.
- Prove, don't claim: show the command and its output for each "Done when" item.
- Run targeted tests while iterating and `pnpm verify:changed` once at the end. No repeated full-suite runs.
- Small commits with conventional messages, for example `feat(analyzer): blame walker`.
- An architecture change adds a row to the Decisions table in docs/architecture.md in the same PR.
- Finish with `/ship-lane <task file>`.

## Style

- TypeScript strict, ESM. No `any` without a comment saying why.
- Comments explain why, never what the code already says.
- No em dashes in code, comments, docs or commit messages.
- Tests live next to the code as `*.test.ts` (Vitest). Lint and format with Biome.
