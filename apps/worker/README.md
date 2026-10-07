# @code-trust/worker

The job runner. It turns one job from the SQS FIFO jobs queue into rows in Postgres. An analyze job clones the repo's default branch, runs `analyzeRepo` and writes the result. A delete job removes everything stored about the repo. `WorkerStack` deploys `src/lambda.ts` as the worker Lambda; this package holds no infra.

| Job | What happens | Outcome | Acknowledged |
| --- | --- | --- | --- |
| `analyze`, git says the repo does not exist or needs credentials | Nothing is written or deleted | `unavailable` | yes |
| `analyze`, the repo has no commits | Nothing is written | `skipped` (`empty`) | yes |
| `analyze` `push`, the remote tip is the stored head | No clone, nothing is written | `skipped` (`head-unchanged`) | yes |
| `analyze` `push` with a new tip, or any `backfill` | Clone, analyze, write | `analyzed` | yes |
| `delete_repo` | `deleteRepo`, whether or not the repo existed | `deleted` | yes |
| A network fault, a git timeout, an analyzer or database error | Whatever was written before the failure stays, under the old head | thrown | no: SQS retries it |

A `backfill` always analyzes, so re-adding a repo refreshes it after an analyzer change. A burst of pushes becomes one analysis: the first job analyzes the tip, and the rest find it stored.

## An analyze job

1. Empty the work root (`WORK_ROOT`, default `/tmp/work`). A timeout or an out-of-memory kill skips every `finally`, and Lambda keeps `/tmp` for the next invocation, so whatever a killed job left goes here.
2. `git ls-remote --symref <url> HEAD` gives the default branch and its tip, with no GitHub API call. Public repos are read anonymously.
3. For a `push`, read the stored repo. If its head is the remote tip, stop.
4. `git clone --template= --single-branch --branch=<branch> --no-tags --no-checkout <url>` into a fresh directory under the work root. The clone has the branch's full history and nothing else: the analyzer refuses shallow and partial clones and reads only objects. The empty `--template` beats the `GIT_TEMPLATE_DIR` that the git layer's wrapper sets, so the clone has no hooks or `info/` files.
5. `observedAt` is the time right after the clone. Analyze the clone's HEAD, never the job's `headSha`: a repo's jobs run in order, and analyzing the current tip is what keeps a late job from moving the head back.
6. Write, in the order `packages/db/README.md` gives:
   1. `upsertRepo`
   2. `upsertCommits`
   3. `upsertAttributions`
   4. `upsertSurvivalObservations`
   5. `deleteCommitsExcept`
   6. `deleteAttributionsExcept`
   7. `deleteSurvivalObservationsExcept`
   8. `upsertSurvivalRollup`, once per cohort with a curve
   9. `setRepoHead`, last

   Only `setRepoHead` moves the head, so a job that dies midway leaves the old one, and the next job analyzes again and converges. Nothing is written after it: the skip in step 3 trusts the head, so a later write that failed would never be retried.
7. Remove the clone, in a `finally`.

### Git

The worker's own git calls get an environment built from scratch, the same rule as the analyzer's: `PATH` from the process, `HOME` at the work root, `LC_ALL=C`, no system or global config (so no credential helper, `insteadOf` or proxy from the machine), no terminal prompts, and a ceiling above the work root. On Lambda, git comes from a layer that works under exactly that. `lambda.ts` also sets the process's `HOME` to the work root, so the analyzer's git gets the same `HOME`.

ls-remote times out after 30 seconds and the clone after 10 minutes. A timeout kills git's whole process group and the job throws.

A job is `unavailable` only when git exits with 128 and its stderr has one of these lines. Anything else throws, so SQS retries what might be a network fault:

- `remote: Repository not found.`: GitHub's answer for a repo that is gone, or private to an anonymous client.
- `fatal: could not read Username for '...': terminal prompts disabled`: the server asked for credentials.

`unavailable` is acknowledged rather than thrown. A thrown job holds the repo's FIFO group for the queue's visibility timeout on every attempt, and a privatized repo's `delete_repo` job would wait behind it. The worker never deletes on `unavailable`; the removal events do.

### Round trips

Every statement crosses from Mumbai to Singapore, and Neon over HTTP is one request per statement. The query module batches 1000 rows per statement, and the prunes are one statement each, so the number of statements does not grow with the repo until a table passes 1000 rows. A first `push` job on a repo with AI, human and dependabot commits sends 11: `getRepo`, `upsertRepo`, one each for commits, attributions and observations, three prunes, two rollups (`ai` and `human`) and `setRepoHead`. A `backfill` sends 10, a skip 1, a delete 1, `unavailable` none. `job.test.ts` asserts the 11 through a Kysely `log` hook.

## The Lambda handler

`src/lambda.ts` exports `handler` and `createHandler(deps)`; `createHandler` runs without AWS for tests and bundle smoke tests.

- The database URL is the SSM SecureString named by `DATABASE_URL_PARAMETER` (`/code-trust/database-url` in production). It is read on the first record that needs the database, and the Neon handle (`createNeonDb`, 30 second query timeout) is reused for the life of the execution environment. A failed read is not cached: the next invocation tries again. An empty batch calls no AWS.
- Records run in order. A record that is not a valid `JobMessage`, or whose job throws, is reported in `batchItemFailures` together with every record after it, which do not run. That is the FIFO rule: a later record may belong to the same repo and must not overtake it. Every returned outcome is acknowledged.

Environment variable names are exported from `@code-trust/worker/env`.

| Variable | What |
| --- | --- |
| `DATABASE_URL_PARAMETER` | Name of the SSM SecureString with the database URL, with its leading slash |
| `WORK_ROOT` | Where jobs clone. Emptied at the start of every job, so nothing else may live there. Default `/tmp/work` |

Each job logs one JSON line: `jobId`, `deliveryId`, `repoId`, `type`, `reason` (`push`, `backfill` or the removal reason), `outcome`, `durationMs`, `commitCount`, `statementCount`, then the outcome's details (`headSha`, `skip`, `stage` or `existed`), or `error` for a thrown job. Log lines never hold the database URL or anything read from SSM.

## Run a job locally

With the workspace database migrated (`pnpm --filter @code-trust/db migrate`):

```sh
pnpm --filter @code-trust/worker run-job https://github.com/wahidbabar/code-trust "$(gh api repos/wahidbabar/code-trust --jq .id)"
```

It runs one `backfill` job against the workspace database (`DATABASE_URL`, or the one in `.env.workspace`) in a temp work root of its own, and prints the head, the commit count and the statement count. `--installation-id` sets the installation id stored with the repo; a local run has none, so it defaults to 1. Then `pnpm --filter @code-trust/api dev` serves the result at `/repos/<id>/survival-curve`.

## Tests

`pnpm --filter @code-trust/worker test` builds git repositories in temp directories and has jobs clone them over `file://`. The database suites run against the workspace database, each test file in its own scratch schema. Without a database they skip on a laptop and fail in CI, as the db package's do. `bundle.test.ts` bundles `src/lambda.ts` the way `NodejsFunction` does and fails on any esbuild warning or on node-postgres in the bundle.

## Not built yet

S3 `raw/` snapshots and the DynamoDB rate-limit budget from the original Flow: nothing reads them yet.
