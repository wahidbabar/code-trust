# T09: Worker job runner (clone, analyze, write; delete)

Status: planned
Wave: 2
Depends on: T07, T08 (both merged to main before this starts)
Owner paths (edit only these):
- `apps/worker/**`
- docs/architecture.md (your rows in Decisions)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Flow, Metric definitions: Lifetime and censoring, and the Decisions rows on idempotent writes and `setRepoHead`, the worker on Lambda, per-repo ordering, the Neon region, and the walker's git requirements)
- `packages/analyzer/src/analyze.ts` (`analyzeRepo`, `RepoAnalysis`) and `packages/analyzer/src/history/git.ts` (`gitEnv`: the environment the analyzer gives git)
- `packages/db/README.md` and `packages/db/src/queries.ts` as T08 merged them (write order, prune queries, `@code-trust/db/neon`)
- `packages/shared/src/queue.ts` as T07 merged it (`JobMessage`)

## Task

Build the worker: the code that turns one job from the jobs queue into rows in Postgres. An analyze job clones the repo's default branch, runs `analyzeRepo`, and writes the result in the order the db module prescribes, so a job that dies midway is invisible and a retry converges. A delete job removes everything stored about the repo. This lane also writes the Lambda handler that `WorkerStack` (T13) will deploy, but no infra. The worker is where the metric meets real repositories and a slow cross-region database, so correctness of the write sequence and the number of round trips both matter.

## Where

- `apps/worker/src/job.ts`: `runJob(job: JobMessage, deps): Promise<JobOutcome>`. Deps are injected: the database handle, a clock, the work directory root, the git runner (tests can replace it with a fake that returns a chosen exit code and stderr), and a clone URL builder (tests point it at local repos; production builds `https://github.com/<owner>/<name>.git`, safe because `RepoRefSchema` closes the character set).
- `apps/worker/src/git.ts`: `lsRemoteHead(url)` (one `git ls-remote --symref <url> HEAD` call gives the default branch and its tip) and `cloneMainline(url, branch, dir)`. Run git with a scrubbed environment like the analyzer's (`GIT_TERMINAL_PROMPT=0`, no global or system config) plus a timeout.
- `apps/worker/src/lambda.ts`: the SQS FIFO handler. On the first record it handles, it reads the SSM SecureString named by an env var (the database URL, `/code-trust/database-url` in production) and builds the handle with `createNeonDb(url, { queryTimeoutMs: 30_000 })`, then reuses both; an empty batch calls no AWS. It runs each record's job. A job whose outcome is `analyzed`, `skipped` or `unavailable` is acknowledged; only a thrown job is reported as failed. Export a `createHandler(deps)` as well as `handler`, so tests and T13's bundle smoke run it without AWS. Environment variable names in `apps/worker/src/env.ts`, exported as `@code-trust/worker/env` so T13's stack imports them, as `@code-trust/ingest/env` does.
- `apps/worker/src/cli.ts` and a `run-job` script: runs one analyze job against the workspace database, for local proof.
- `apps/worker/README.md`: what the worker does, the write order, and how to run it locally.
- Replace the placeholder `PACKAGE_NAME` and its smoke test.

Every job starts by emptying the work root. A timeout or an out-of-memory kill skips `finally`, and Lambda keeps `/tmp` for the next invocation.

An analyze job:

1. `lsRemoteHead`. When git says the repository does not exist or needs credentials (a repo that went private or away), return `unavailable`: no writes, no delete, no throw. Network errors and timeouts still throw, so SQS retries them.
2. A `push` job whose remote tip equals the stored repo's `headSha` returns `skipped` without cloning: this collapses a burst of pushes into one analysis. A `backfill` job always analyzes, so re-adding a repo refreshes it after an analyzer change such as T17.
3. Clone the default branch into a fresh directory under the work root: full history, single branch, no tags, no checkout if the analyzer works without one (check with a test). The analyzer refuses shallow and partial clones. A clone that fails as "does not exist" or "needs credentials" is `unavailable` too.
4. `observedAt` is the clock's time right after the fetch. Analyze the commit the clone fetched, never `job.headSha`: the jobs of one repo run in order, and analyzing the current tip is what keeps a late job from moving the head back.
5. Write, in the order `packages/db/README.md` gives: `upsertRepo` (owner and name from the job, `defaultBranch` from step 1, `installationId` from the job), commits, attributions, observations, `deleteCommitsExcept` and `deleteSurvivalObservationsExcept` with the analysis's keys, rollups, and `setRepoHead` last. The skip in step 2 trusts the head, so a write after it that failed would never be retried.
6. Remove the clone directory in a `finally` as well.

A delete job calls `deleteRepo` and succeeds whether or not the repo existed.

## Done when

- [ ] `pnpm --filter @code-trust/worker test` passes against the workspace database with no database test skipped, with named tests (repos built in temp dirs with git, cloned over `file://`):
  - an analyze job on a repo with AI, human and dependabot commits: afterwards `getRepo` has the analyzed head, and `listCommits`, `listAttributions`, `listSurvivalObservations`, `listSurvivalMetrics` and `getSurvivalCurves` equal what `analyzeRepo` returns for the same clone and `observedAt`.
  - a second `push` job with no new commits returns `skipped`, clones nothing, and changes no row.
  - a `backfill` job with no new commits analyzes again: it clones, and the rows equal a clean run with the new `observedAt`.
  - new commits, then a job: the head moves and the rows equal the new analysis.
  - a force-push that drops commits, then a job: the dropped commits and their observations are gone, and the rows equal the new analysis.
  - a job whose `headSha` is older than the remote tip analyzes the tip.
  - a database that fails on a prune, one that fails on the rollup write, and one that fails on `setRepoHead` (a test each): the job throws, `getRepo` still shows the previous head, and a rerun with a working database analyzes again (it does not skip) and converges to the same rows as a clean run.
  - `unavailable`: with a fake git runner whose `ls-remote` fails with GitHub's stderr (`remote: Repository not found.`), the job returns `unavailable` without throwing, writes nothing and deletes nothing (the repo's existing rows are unchanged), and the Lambda handler acknowledges it. Not a missing `file://` path: git's "does not appear to be a git repository" for it is outside the two patterns the classifier may match. The classifier also has a named test for GitHub's "Repository not found" and for "terminal prompts disabled" (both `unavailable`), and one for "Could not resolve host" (throws).
  - a leftover directory in the work root, as a killed job would leave it, is gone once the next job starts.
  - a delete job removes the repo and all its rows; a delete of an unknown repo succeeds; another repo's rows are untouched.
  - the work root is empty after a successful job, a skipped job and a failed one.
  - round trips: an analyze job on a repo of about 50 commits issues at most a fixed number of statements, counted through a Kysely `log` hook and asserted as a number in the test, and the count does not grow with the commit count below 1000 commits per table.
  - the Lambda handler, with fake SSM and a pg handle in place of Neon: parses each record with `JobMessageSchema`; a record that fails to parse, or whose job throws, is reported in `batchItemFailures` together with every record after it (FIFO rule); the SSM parameter is read once across invocations, and a failed read is retried on the next invocation rather than cached.
- [ ] With the workspace database migrated, `pnpm --filter @code-trust/worker run-job https://github.com/wahidbabar/code-trust` (repo id from `gh api repos/wahidbabar/code-trust --jq .id`) exits 0 and prints the head, the commit count and the statement count. Then `pnpm --filter @code-trust/api dev` and `curl -s localhost:$CONDUCTOR_PORT/repos/<id>/survival-curve` show an `ai` and a `human` curve under that head. Show both, then stop the server.
- [ ] A named test bundles `src/lambda.ts` with esbuild as `NodejsFunction` does (CJS, node, `@aws-sdk/*` external), with zero warnings, and `require`s the output without error.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- `infra/**`: the queue, the function, the git layer and their wiring are T11 and T13.
- The dispatcher (T12) and the webhook (T14).
- GitHub API calls, the App's private key, installation tokens. Public repos clone anonymously, and `ls-remote` gives the default branch.
- S3 `raw/` snapshots and the DynamoDB rate-limit budget from the original Flow. Nothing reads them yet; leave them out and say so in the PR.
- Deleting data when the remote says the repo is gone or private. The job returns `unavailable` and writes nothing; T14's removal events are what delete.
- Changing `packages/analyzer`, `packages/db` or `packages/shared`. If one blocks you, stop and ask.

## Notes

- The analyzer's `gitEnv` passes git only `PATH` and `HOME`. On Lambda, git comes from the layer T11 builds, which works under exactly that environment. Your own git calls should use the same rule: do not depend on `LD_LIBRARY_PATH` or `GIT_EXEC_PATH` reaching git.
- Lambda's `HOME` may be unset and only `/tmp` is writable. Point `HOME` at the work root for git calls if git needs it, and take the work root from an env var with `/tmp` as the default.
- Every query crosses from Mumbai to Singapore (tens of milliseconds each), and Neon over HTTP is one request per statement. The query module already batches 1000 rows per statement; do not add per-row reads or writes, and do not read observations back to diff them (that is what the prune queries are for).
- Why `unavailable` acknowledges instead of throwing: a thrown job holds the repo's FIFO group for the jobs queue's visibility timeout (90 minutes in T13) on every attempt, and a privatized repo's `delete_repo` job waits behind it. Classify by git's exit and stderr for "not found" and "authentication or credentials needed" only; anything you cannot classify throws.
- FIFO with `batchSize` 1 is the expected setting (T13 sets it), but handle a batch correctly anyway. A record that fails makes SQS redeliver it until `maxReceiveCount`, then it goes to the DLQ; that is the path for repos too big for 15 minutes or 10 GB, which are out of scope until hardening.
- Log one line per job: job id, repo id, type, outcome, duration, commit count, statement count. Never the database URL or anything from SSM.
- `observedAt` must pass `IsoTimestampSchema` (milliseconds, UTC).
- Use `createPgDb` in tests and the CLI. Only `lambda.ts` imports `@code-trust/db/neon`.
- Other lanes run at the same time (T10 owns `apps/api` and `infra`). If your PR conflicts with main in docs/STATUS.md or the Decisions table, rebase and keep both sides' rows. If `pnpm-lock.yaml` conflicts, take main's and run `pnpm install` again.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/worker test passes against the workspace database with no database test skipped and a named test for every case in the task's Done when list, including the write order with setRepoHead last and its three failure tests, push-only skipping, the unavailable outcome, the work root wiped at the start of a job, the bounded statement count and the Lambda handler's FIFO failure rule, the esbuild CJS bundle of src/lambda.ts has zero warnings and loads, run-job on https://github.com/wahidbabar/code-trust exits 0 and the local API then serves ai and human curves for it, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
