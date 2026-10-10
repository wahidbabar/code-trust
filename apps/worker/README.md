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

## Deploy

`WorkerStack` (`CodeTrustWorker` in `infra`) holds the FIFO jobs queue and its DLQ, the dispatcher reading `CodeTrustIngest`'s events queue, and this worker with git from the layer. The moment it exists, both mappings start draining: every event queued since the webhook went live becomes a job.

1. Sign in, then check the account's limits first.

   ```bash
   aws login
   aws lambda get-account-settings --region ap-south-1 --query AccountLimit
   ```

   If `ConcurrentExecutions` is below 1000, request 1000 for "Concurrent executions" (AWS Lambda) in Service Quotas, in `ap-south-1`. Until AWS raises it, keep every function's memory at or below 3008 MB, the new-account cap: the worker uses 2048 MB. The two mappings take at most 2 executions each, so they fit even under a limit of 10, and they leave the rest to the webhook and the API. A throttled webhook loses deliveries, because GitHub does not retry a failed one.

2. Check what the worker reads, before anything else, because the jobs start running at once. The SecureString `/code-trust/database-url` must exist in `ap-south-1` under the AWS-managed key, and `smoke:neon` must have passed as in `packages/db/README.md`. Without them every job fails, holds its repo for 90 minutes, and after three tries lands in the jobs DLQ.

   ```bash
   aws ssm describe-parameters --region ap-south-1 \
     --parameter-filters Key=Name,Values=/code-trust/database-url --query 'Parameters[0].[Type,KeyId]'
   ```

   It must print `SecureString` and `alias/aws/ssm`. It prints the name and type only, never the value.

3. Build the git layer. The build checks the layer's libraries against the current runtime image, so pull that first. `infra/layers/git/README.md` has the details and the layer's own smoke test.

   ```bash
   docker pull public.ecr.aws/lambda/nodejs:24
   pnpm build:git-layer
   ```

4. Deploy, without `-e`. `CodeTrustWorker` reads the events queue's ARN from a `CodeTrustIngest` output (a weak cross-stack reference: an output, not an export), so the CLI deploys `CodeTrustIngest` first, which adds that output and anything else main has changed in it. With `-e` that output may not exist yet, and the deploy fails. The CDK app builds every stack, so `ALERT_EMAIL` is required.

   ```bash
   export ALERT_EMAIL=you@example.com
   cd infra
   pnpm exec cdk deploy CodeTrustWorker
   ```

   Approve the IAM changes it lists: two roles, each with exactly three statements. The worker may consume the jobs queue, read `/code-trust/database-url` and write its own logs; the dispatcher may consume the events queue, send to the jobs queue and write its own logs.

   From now on every deploy without `-e` bundles this stack, so it needs `infra/layers/git/dist/git-layer.zip`: build it first, or deploy another stack alone with `-e`, as the API's README does. Never deploy the cloud assembly that `pnpm synth` leaves in `cdk.out`: it holds the placeholder layer, without git. `CodeTrustIngest` can now replace its events queue without waiting for this stack, but the dispatcher keeps reading the old queue until `CodeTrustWorker` is deployed again.

5. Read the queue URLs into variables. They contain the account ID: keep them out of the repo, issues and PRs.

   ```bash
   output() { aws cloudformation describe-stacks --region ap-south-1 --stack-name "$1" \
     --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
   EVENTS_QUEUE_URL=$(output CodeTrustIngest EventsQueueUrl)
   JOBS_QUEUE_URL=$(output CodeTrustWorker JobsQueueUrl)
   JOBS_DLQ_URL=$(output CodeTrustWorker JobsDeadLetterQueueUrl)
   EVENTS_DLQ_URL=$(aws sqs list-queues --region ap-south-1 \
     --queue-name-prefix CodeTrustIngest-EventsDeadLetterQueue --query 'QueueUrls[0]' --output text)
   ```

6. Watch the queued events drain. The dispatcher takes 10 events at a time, at most two batches at once, so the events queue empties within a minute or two and the jobs queue fills. The worker then runs at most two jobs at once, and one repo's jobs one at a time, in order. For each repo the first `push` job analyzes and the later ones find the head stored and skip; a `backfill` always analyzes. Events older than 14 days have expired: removing a repo from the App's installation and adding it back enqueues a `backfill` for it.

   ```bash
   for url in "$EVENTS_QUEUE_URL" "$JOBS_QUEUE_URL"; do
     aws sqs get-queue-attributes --region ap-south-1 --queue-url "$url" \
       --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --query Attributes
   done
   WORKER_LOGS=$(aws logs describe-log-groups --region ap-south-1 \
     --log-group-name-prefix CodeTrustWorker-WorkerLogs --query 'logGroups[0].logGroupName' --output text)
   aws logs tail "$WORKER_LOGS" --region ap-south-1 --since 1h --follow
   ```

   Each job logs one JSON line with its `outcome`: `analyzed`, `skipped`, `unavailable` or `deleted`. A thrown job logs `error` and is retried once the jobs queue's 90 minute visibility timeout ends, and its repo waits until then. The first job in each execution environment reads SSM, and the first query after Neon has been idle for 5 minutes waits a few seconds for its compute to resume.

7. Read the DLQs. Both should stay empty. A job lands in the jobs DLQ after three failed tries, an event in the events DLQ after five.

   ```bash
   for url in "$EVENTS_DLQ_URL" "$JOBS_DLQ_URL"; do
     aws sqs get-queue-attributes --region ap-south-1 --queue-url "$url" \
       --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text
   done
   aws sqs receive-message --region ap-south-1 --queue-url "$JOBS_DLQ_URL" \
     --max-number-of-messages 10 --visibility-timeout 0 --attribute-names All
   ```

   A job's body names its repo and type, and the worker log has its `error` under the same `jobId`. Once the cause is fixed, a redrive from the SQS console (Start DLQ redrive) sends the messages back to their source queue.

8. Check a repo through the API. `/repos/<id>/survival-curve` answers 404 until the repo has an analyzed head. The URL output ends in `/`, so every call trims it.

   ```bash
   API_URL=$(output CodeTrustApi ApiUrl)
   REPO_ID=$(gh api repos/wahidbabar/code-trust --jq .id)
   curl -s "${API_URL%/}/repos"
   curl -s "${API_URL%/}/repos/$REPO_ID"
   curl -s "${API_URL%/}/repos/$REPO_ID/survival-curve"
   ```

9. A day after the deploy, count the empty receives. Setting `maxConcurrency` turns off the poller scale-down Lambda applies to idle SQS mappings, so each mapping keeps receiving while its queue is empty. Expect about 22,000 a day per queue, about 1.3 million a month for the two, against SQS's 1 million free requests a month: about $0.15 a month. This is the one part of the pipeline that bills while idle. A count far above that means more pollers than the cap allows for.

   ```bash
   for url in "$EVENTS_QUEUE_URL" "$JOBS_QUEUE_URL"; do
     aws cloudwatch get-metric-statistics --region ap-south-1 --namespace AWS/SQS \
       --metric-name NumberOfEmptyReceives --dimensions Name=QueueName,Value="${url##*/}" \
       --start-time "$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --period 86400 --statistics Sum --query 'Datapoints[0].Sum'
   done
   ```

   `date -v-1d` is macOS's; on Linux use `date -u -d '1 day ago' ...`.

## Not built yet

S3 `raw/` snapshots and the DynamoDB rate-limit budget from the original Flow: nothing reads them yet.
