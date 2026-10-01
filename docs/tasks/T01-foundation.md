# T01: Foundation (monorepo, tooling, CI, FoundationStack)

Status: in progress
Wave: 0 (serial)
Depends on: nothing
Owner paths (edit only these): everything except `.claude/`, `.conductor/`, `scripts/conductor/` and other tasks' files
Read first:
- docs/architecture.md (Stack, Packages, Cost rules, Open decisions)
- CLAUDE.md

## Task

Turn this skeleton into a working pnpm monorepo that every later lane builds on: shared TypeScript, lint, format and test setup; one package per row of the Packages table; a `verify` pipeline that the Stop hook and CI both run; and the CDK `FoundationStack` with the account guardrails. No product logic.

## Where

- Root: `package.json` scripts (below), `tsconfig.base.json`, `biome.json`, Vitest config, `pnpm-lock.yaml`.
- One package per row of the Packages table in docs/architecture.md: `packages/shared`, `packages/db`, `packages/analyzer`, `apps/ingest`, `apps/worker`, `apps/api`, `apps/dashboard`. Each gets `package.json`, `tsconfig.json`, `src/index.ts` and one smoke test. No frameworks yet except what `infra` needs.
- `infra/`: CDK app (`bin/`, `lib/foundation-stack.ts`, `lib/config.ts`) and assertion tests.
- `.github/workflows/ci.yml`.
- `README.md`: a Getting started section that matches reality.

Root scripts:

| Script | Does |
| --- | --- |
| `verify` | typecheck, lint and test for every package |
| `verify:changed` | the same for packages changed since `$VERIFY_BASE` (default `origin/main`) plus their dependents. The changed list comes from `git diff` plus untracked files, mapped to packages and passed as `--filter "...<pkg>"`; pnpm's `...[ref]` filter misses untracked files. Falls back to `verify` when the ref doesn't exist or when root config changed (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, Vitest config, the script itself) |
| `typecheck`, `lint`, `format`, `test` | one concern, every package |
| `synth` | `cdk synth` for infra |

## Done when

- [ ] `pnpm install --frozen-lockfile` succeeds from a clean clone.
- [ ] `pnpm verify` exits 0.
- [ ] After committing, touching one file in `packages/analyzer` and running `VERIFY_BASE=HEAD pnpm verify:changed` checks only the analyzer package and its dependents. Show the output. An untracked new file in `packages/analyzer` with a deliberate type error makes the same command fail; show that, then delete the file.
- [ ] `pnpm synth` exits 0 with no AWS credentials and no `ALERT_EMAIL`. Running the CDK app without `ALERT_EMAIL` any other way fails with a clear error.
- [ ] CDK assertion tests prove `FoundationStack` contains: a 5 USD monthly COST budget with email notifications at 50, 80 and 100 percent of ACTUAL spend; one S3 bucket with all public access blocked, SSE-S3, versioning off, SSL enforced, a lifecycle rule expiring `raw/` after 14 days and aborting incomplete multipart uploads after 7 days; the bucket name as a `CfnOutput`. Nothing else that bills (the SSL bucket policy and `AWS::CDK::Metadata` are free and allowed).
- [ ] `.github/workflows/ci.yml` runs `pnpm verify` and `pnpm synth` on pull requests and pushes to main, caches the pnpm store, uses only `actions/*` actions (or `pnpm/action-setup` if corepack fails in CI) and needs no secrets.
- [ ] The README's Getting started commands work as written. Its "Deploy (human only)" section is not run.

## Out of scope

- Deploying anything. The human runs `cdk bootstrap` and `cdk deploy` after merge.
- The GitHub App, product logic and the database schema (T02).
- The harness (`.claude/`, `.conductor/`, `scripts/conductor/`) and other tasks' files.

## Notes

- Use current stable versions. Before picking TypeScript 7 (native compiler, much faster typecheck, which matters for the loops), check that NestJS's decorators (`experimentalDecorators` and `emitDecoratorMetadata`) work with it. If not, use the newest version that does. Record the choice in the Decisions table.
- The repo is public: no real email, account ID or ARN in code. `ALERT_EMAIL` comes from the environment and is required, except that the root `synth` script sets `ALERT_EMAIL_PLACEHOLDER=1`, which makes synth use a placeholder. A deploy never sets that flag. Region comes from `lib/config.ts`.
- Keep `FoundationStack` to those two resources. Later stacks are new files.
- `packageManager` already pins pnpm 11. Keep it unless something breaks.
- CI runs free on public GitHub runners. Don't add paid actions or services.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm verify exits 0, pnpm synth exits 0 with no ALERT_EMAIL, the FoundationStack assertion tests pass, VERIFY_BASE=HEAD pnpm verify:changed is shown checking only the touched package and its dependents, and is shown failing on an untracked file with a type error in packages/analyzer; show each command and its output; nothing under .claude/, .conductor/ or scripts/conductor/ changed; then stop and summarize without running the reviewer or cost-guard agents; or stop after 20 turns
```
