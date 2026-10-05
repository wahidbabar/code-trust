# T12: Dispatcher (events queue to the per-repo FIFO jobs queue)

Status: planned
Wave: 2
Depends on: T04, T07 (merged to main before this starts)
Owner paths (edit only these):
- `apps/ingest/src/dispatcher.ts`, `apps/ingest/src/dispatcher.test.ts`, `apps/ingest/src/dispatcher-lambda.ts`, `apps/ingest/src/dispatcher-lambda.test.ts` (new)
- `apps/ingest/src/aws.ts`, `apps/ingest/src/aws.test.ts`, `apps/ingest/src/env.ts` (additions only; the webhook's code and tests keep working unchanged)
- `apps/ingest/src/index.ts` (new exports only)
- docs/architecture.md (your rows in Decisions)
Read first:
- docs/architecture.md (Flow, and the Decisions rows on per-repo ordering, the events queue's retention and visibility, and esbuild bundles)
- `packages/shared/src/queue.ts` as T07 merged it (`RepoEventMessage`, `JobMessage`)
- `apps/ingest/src/webhook.ts`, `apps/ingest/src/aws.ts`, `apps/ingest/src/lambda.ts` (the patterns to follow: injected senders, client timeouts, batches of 10)

## Task

Build the dispatcher: the Lambda that drains the events queue the webhook fills and turns each event into a job on the SQS FIFO jobs queue, with `MessageGroupId` set to the repo id. FIFO per repo is what guarantees that one repo never has two jobs running at once and that its jobs run in the order they were dispatched. This lane is code only; T13 deploys it in `WorkerStack`. It is small and pure on purpose, so its mapping is fully tested before any infra exists.

## Where

- `apps/ingest/src/dispatcher.ts`: `toJob(event: RepoEventMessage, deps): FifoEntry`, pure apart from an injected id generator and clock. The mapping:

  | Event | Job |
  | --- | --- |
  | `push` | `analyze`, `reason: 'push'`, `headSha` from the event |
  | `repository_added` | `analyze`, `reason: 'backfill'`, `headSha: null` |
  | `repository_removed` | `delete_repo`, with the event's `reason` |

  Every job carries the event's `deliveryId`, `installationId` where the job has one, a fresh `jobId` and `requestedAt`. `MessageGroupId` is the repo id as a decimal string. `MessageDeduplicationId` is `<deliveryId>:<repo id>`, since one installation delivery yields one event per repo with the same delivery id. Every body is parsed with `JobMessageSchema` before it is sent.
- `apps/ingest/src/dispatcher-lambda.ts`: the SQS handler for the standard events queue, with `ReportBatchItemFailures`. It parses each record's body with `RepoEventMessageSchema`, sends the jobs with `SendMessageBatch` in batches of at most 10, and reports as failed exactly the records whose parse or send failed. It builds its clients once per execution environment, with the timeouts `AWS_CLIENT_CONFIG` sets.
- `apps/ingest/src/aws.ts`: a FIFO batch sender that passes `MessageGroupId` and `MessageDeduplicationId` and returns which entries failed (by id), not only how many.
- `apps/ingest/src/env.ts`: `DISPATCHER_ENV` with the jobs queue URL variable, for T13's stack.

## Done when

- [ ] `pnpm --filter @code-trust/ingest test` passes with no AWS credentials and no network, T04's tests unchanged, plus named tests:
  - one per row of the mapping table, each body equal to the matching T07 fixture apart from `jobId` and `requestedAt`, and parsing with `JobMessageSchema`.
  - `MessageGroupId` is the repo id string and `MessageDeduplicationId` is `<deliveryId>:<repo id>`; two events of one installation delivery for two repos get different dedupe ids and different groups.
  - 25 records become 3 `SendMessageBatch` calls of at most 10 entries, with entry ids unique within each call.
  - a record whose body is not JSON, or fails `RepoEventMessageSchema` (for example `version: 2`), is reported in `batchItemFailures` by its `messageId`, and the other records are still sent.
  - a partial `SendMessageBatch` failure reports exactly the failed records; a thrown send reports every record of that batch.
  - log lines carry the delivery id, repo id, event type and outcome, and never a message body.
- [ ] A named test bundles `src/dispatcher-lambda.ts` with esbuild as `NodejsFunction` does (CJS, node, `@aws-sdk/*` external), with zero warnings, and `require`s the output without error.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- `infra/**`: the FIFO queue, the function and the event source mapping are T13.
- The webhook's event handling (`events.ts`, `webhook.ts`): removal events are T14.
- Collapsing or reordering events. Standard SQS does not keep order, and the worker analyzes the current tip whatever the job says, so a push dispatched late cannot move a head back.
- `packages/shared`. If the job contract cannot carry what you need, stop and ask.

## Notes

- FIFO deduplication only lasts 5 minutes. A GitHub redelivery after that becomes a second job, which the worker skips because the head has not moved. That is fine.
- A standard queue can deliver an uninstall and an earlier push out of order, so a push's analyze job may land after the repo's delete job and bring its data back. Note it in the PR as a known limit for hardening; do not try to fix it here.
- The events queue's visibility timeout is SQS's default 30 seconds (IngestStack). T13 sets the dispatcher's timeout below it; keep the handler fast and its SDK timeouts short, as the webhook's are.
- `crypto.randomUUID()` for `jobId`, injected so tests are deterministic.
- T14 also works in `apps/ingest`, after this lane, on other files. If it has already merged, rebase as CLAUDE.md says.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/ingest test passes with no AWS credentials and T04's tests unchanged, with a named test for every row of the dispatcher mapping and every FIFO, batching, failure and logging case in the task's Done when list, the esbuild CJS bundle of src/dispatcher-lambda.ts has zero warnings and loads, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 15 turns
```
