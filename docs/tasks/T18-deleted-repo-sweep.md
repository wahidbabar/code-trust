# T18: Deleted repos: a daily sweep that verifies stored repos

Status: planned
Wave: 2
Depends on: T09, T13, T14 (merged to main before this starts)
Owner paths (edit only these):
- `packages/shared/src/queue.ts`, `packages/shared/src/queue.test.ts`, `packages/shared/src/fixtures.ts`, `packages/shared/src/schema-cases.ts`
- `apps/worker/src/**`, `apps/worker/README.md`, `apps/worker/package.json`
- `infra/lib/worker-stack.ts`, `infra/lib/worker-stack.test.ts`
- `apps/ingest/README.md` (only the deleted-repo item in its list of gaps)
- docs/architecture.md (your rows in Decisions)
Read first:
- docs/architecture.md (Flow, Cost rules, and the Decisions rows on the worker's skip and `unavailable` outcome, the dispatcher's `MessageDeduplicationId`, `WorkerStack`, and removal events for every repo)
- `apps/worker/src/job.ts`, `git.ts`, `handler.ts`, `lambda.ts`, `testing.ts` and their tests
- `packages/shared/src/queue.ts` (`JobMessageSchema`)
- `packages/db/src/queries.ts` (`listRepos`, `deleteRepo`)
- `apps/ingest/src/aws.ts` (`sqsFifoBatchSender`) and `apps/ingest/src/dispatcher.ts`, for the FIFO send rules
- `infra/lib/worker-stack.ts` and `apps/worker/README.md` (Deploy)

## Task

The read API is public, so a repo's data must go when the repo stops being public. T14 deletes on the deliveries that name a repo, but GitHub documents that Apps never receive `repository` `deleted`, and no other delivery is documented to name a deleted repo. A public repo that is deleted keeps its data in the API forever. This lane adds a daily sweep: it sends one `verify_repo` job per stored repo through the FIFO jobs queue, and the worker deletes a repo whose remote git says it is gone. The same sweep also catches a repo that turned private while its `privatized` delivery was missed.

## Where

1. **Contract.** `JobMessageSchema` gains `verify_repo`: `{ ...jobFields, type: 'verify_repo', repo: RepoRefSchema }`. `version` stays 1, because the union only grows. Its `deliveryId` is the sweep run's id, a fresh UUID per run, so a job traces back to the run that sent it. Say so in the schema comment. Add a `verifyJobFixture` and schema cases.

2. **Worker.** A `verify_repo` job runs `lsRemoteHead` and nothing else:
   - Readable, or empty: outcome `verified`. Nothing is written or deleted.
   - `unavailable` (the two patterns `classifyGitFailure` already knows): `deleteRepo`, logged as `deleted` with the cause. A repo that is not stored still succeeds.
   - Anything else throws, so SQS retries it, as for analyze jobs.

   Analyze jobs keep T09's rule: `unavailable` is acknowledged and deletes nothing. The next sweep's verify deletes that repo instead.

3. **Sweep.**
   - **Code:** `apps/worker/src/sweep.ts` with injected dependencies, plus a Lambda entry such as `sweep-lambda.ts`.
   - **Database:** it reads the database URL from SSM the way `lambda.ts` does, and lists stored repos with `listRepos`.
   - **Sending:** one `verify_repo` per repo goes to the jobs queue, with:
     - `MessageGroupId` set to the repo id;
     - `MessageDeduplicationId` set to `<runId>:<repo id>`;
     - batches of at most 10;
     - an entry counting as sent only when SQS lists it in `Successful`.
   - **Failure:** a run that could not send every entry throws after trying them all, so the scheduler's retry sends again. A duplicate verify is harmless.
   - **Log line:** one per run, with the run id, the repo count and the counts sent and failed. It holds ids and counts only.

4. **Infra.** `WorkerStack` gets:
   - a `SweepFunction` on arm64 with the pinned runtime and no git layer;
   - its own log group, kept 14 days;
   - an explicit role holding only `ssm:GetParameter` on the database URL parameter, `sqs:SendMessage` on the jobs queue, and writes to its log group;
   - a schedule that invokes it once a day.

   Pick the schedule resource (an EventBridge rule or EventBridge Scheduler) by checking its price: it must cost nothing at 30 invocations a month. Record the choice in the Decisions row.

5. **Docs.**
   - A Decisions row: the verify job, the daily sweep, why it goes through the FIFO queue, and the schedule choice.
   - `apps/worker/README.md`: the verify job, the sweep, and the deploy note below.
   - `apps/ingest/README.md`: the deleted-repo gap now says the daily sweep removes such a repo's data within about a day.

## Done when

- [ ] `pnpm --filter @code-trust/shared test` passes, with schema cases for `verify_repo` (valid, missing `repo`, wrong `type`), and `verifyJobFixture` and every existing job fixture parsing with `JobMessageSchema`.
- [ ] `pnpm --filter @code-trust/worker test` passes against the workspace database with no test skipped. It includes a named test for each case below, and each test says which broken behaviour would make it fail:
  - A verify of a readable repo is `verified`, git ran `ls-remote` and nothing else (no clone), and the repo's rows are unchanged.
  - A verify that gets `NOT_FOUND_STDERR` deletes the repo and all its rows, another repo's rows are untouched, and the handler acknowledges the record.
  - The same with `CREDENTIALS_STDERR`, which is what GitHub answers an anonymous client for a repo that does not exist (checked 2026-10-11: exit 128, `terminal prompts disabled`).
  - A verify that gets `DNS_STDERR`, or times out, throws, deletes nothing, and the handler reports the record as failed.
  - A verify of a repo that is not stored: readable is `verified`, and unavailable is `deleted` with `existed: false`.
  - The sweep, given 3 stored repos, sends 3 `verify_repo` bodies, each parsing with `JobMessageSchema`, each with the repo id as group and `<runId>:<repo id>` as dedupe id, all with the same run id.
  - The sweep, given 25 repos, sends batches `[10, 10, 5]`. Given none, it sends nothing.
  - An entry SQS does not list as `Successful`, or a batch whose send throws, makes the run throw after every batch was attempted.
  - The sweep's log line carries ids and counts, and no owner or name.
  - Every existing worker test is unchanged.
- [ ] `pnpm --filter @code-trust/infra test` covers `SweepFunction`: arm64, a 14-day log group, a daily schedule that targets only it, and a role with exactly the three grants above. `pnpm synth` passes. CodeTrustIngest's template is unchanged, outputs included.
- [ ] The cost-guard subagent reviews the infra diff, and its verdict is shown.
- [ ] `git diff origin/main -- docs/architecture.md` shows the Decisions row.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- Uninstalls that name no repos, and installations that narrow from all repositories to selected ones. Those repos are still public, so a verify finds them readable. A delete-by-installation task, written by the human, covers them.
- Changing what analyze jobs do on `unavailable`.
- Any GitHub API call, or App authentication. The worker still calls no GitHub API.
- Paging `listRepos` for very large tables.
- The webhook, the dispatcher and the API.
- Deploying.

## Notes

- **Why a verify job and not an analyze job:** stored owners and names can be stale after a rename or transfer. GitHub redirects the old URL, so a verify on a stale name finds the repo and does nothing, and a verify never writes. An analyze job on a stale name could write another repo's history under this repo's id if the old name now belongs to someone else.
- **Accepted limit:** if a repo is deleted and its old name is later taken by a different public repo, a verify finds the new repo readable, and the old data stays. Mapping the id to its current name needs the GitHub API.
- **Why through the jobs queue and not inline:** the repo's FIFO group keeps a verify from racing an analysis of the same repo. An inline delete during an analysis would make `setRepoHead` fail and the job retry.
- **A wrong delete heals on the next push,** which analyzes from scratch because nothing is stored. A repo that never gets another push stays deleted. Only the two patterns GitHub uses for "not found" delete; anything else throws.
- **Cost:** each verify runs on the worker function (2048 MB) for about a second. 1,000 repos a day is about 60,000 GB-seconds a month, inside Lambda's always-free 400,000.
- **First run:** after the deploy, the first sweep also removes the data of repos deleted before this lane.
- **Deploy note for the README:** after merge the human deploys `CodeTrustWorker` (build the git layer first, as its Deploy section says). `CodeTrustIngest` does not change.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/shared test and pnpm --filter @code-trust/worker test pass against the workspace database with named tests for the verify_repo contract, every verify outcome in Done when (readable, not found, credentials needed, unclassified failure, repo not stored) and the sweep's grouping, dedupe, batching and failure handling; infra/lib/worker-stack.test.ts covers SweepFunction, its schedule and its role; pnpm synth passes; the cost-guard subagent's verdict is shown; docs/architecture.md has the Decisions row; pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
