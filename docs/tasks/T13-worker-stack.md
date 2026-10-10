# T13: WorkerStack (FIFO jobs queue, dispatcher and worker on Lambda)

Status: in progress
Wave: 2
Depends on: T09, T10, T11, T12 (all merged to main before this starts)
Owner paths (edit only these):
- `infra/lib/worker-stack.ts`, `infra/lib/worker-stack.test.ts` (new)
- `infra/bin/app.ts`
- `infra/lib/config.ts` (new constants only)
- `infra/package.json`
- `apps/worker/README.md` (a Deploy section)
- docs/architecture.md (your rows in Decisions, and Flow if what you build differs from it)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Flow, Cost rules, and the Decisions rows on the worker on Lambda, per-repo ordering, the events queue's retention and visibility, the webhook's explicit IAM role, esbuild bundles and the git layer)
- `infra/lib/ingest-stack.ts`, `infra/lib/api-stack.ts` and their tests (the patterns to follow), `infra/lib/git-layer.ts`, `infra/scripts/` (the bundle smoke script from T10)
- `apps/worker/src/lambda.ts`, `apps/worker/src/env.ts`, `apps/ingest/src/dispatcher-lambda.ts`, `apps/ingest/src/env.ts`

## Task

Deploy the pipeline's back half. `WorkerStack` adds the SQS FIFO jobs queue and its DLQ, the dispatcher Lambda reading IngestStack's events queue, and the worker Lambda reading the jobs queue with git from T11's layer. After the human deploys it, the events that have waited in the queue since the webhook went live become analyses in Neon, and the API serves them. Everything is pay-per-use: nothing here may bill while idle.

## Where

`infra/lib/worker-stack.ts`, `WorkerStack`, added to `infra/bin/app.ts` as `CodeTrustWorker`, taking IngestStack's `eventsQueue` as a prop:

- Jobs queue: FIFO, content-based deduplication off (the dispatcher sets the dedupe id), SQS-managed encryption, SSL enforced, a FIFO DLQ with `maxReceiveCount` 3, and a visibility timeout of at least six times the worker's timeout (AWS's guidance for Lambda event sources). Retention 14 days on both.
- Worker function: `NodejsFunction` from `apps/worker/src/lambda.ts`, arm64, `NODEJS_24_X`, timeout 15 minutes, memory and ephemeral storage from `config.ts` (start at 2048 MB and 10240 MB `/tmp`; say why in a comment), the `GitLayer`, its own log group with 14-day retention, an explicit role. Event source: the jobs queue, `batchSize` 1, `ReportBatchItemFailures`, `maxConcurrency` `WORKER_MAX_CONCURRENCY` (2).
- Dispatcher function: `NodejsFunction` from `apps/ingest/src/dispatcher-lambda.ts`, arm64, `NODEJS_24_X`, 256 MB or less, a timeout well under the events queue's 30 second visibility timeout, its own log group, an explicit role. Event source: the events queue, `batchSize` 10, `ReportBatchItemFailures`, `maxConcurrency` `DISPATCHER_MAX_CONCURRENCY` (2).
- IAM, explicit roles as in IngestStack: the worker gets `ssm:GetParameter` on `DATABASE_URL_PARAMETER_NAME` (from T10's constants) and consume rights on the jobs queue; the dispatcher gets `sqs:SendMessage` on the jobs queue and consume rights on the events queue. Log writes to their own groups. Nothing else.
- Outputs: the jobs queue URL and the DLQ URLs, described as containing the account ID.
- `infra/lib/config.ts`: the worker's memory, ephemeral storage and timeout, and `WORKER_MAX_CONCURRENCY = 2` and `DISPATCHER_MAX_CONCURRENCY = 2`, with a comment saying why (see Notes).
- `infra/package.json`: `@code-trust/worker` as a workspace devDependency.
- `apps/worker/README.md` Deploy section. It starts with the account's limits: run `aws lambda get-account-settings --region ap-south-1`; if `AccountLimit.ConcurrentExecutions` is below 1000, request 1000 for "Concurrent executions" in Service Quotas, and keep every function's memory at or below 3008 MB until AWS lifts the new-account cap. Then: build the git layer, deploy `CodeTrustWorker` (it imports from `CodeTrustIngest`, so that stack must be deployed first and keeps the export), what to expect when the queued events drain, how to read the DLQs, and how to check a repo through the API afterwards. Every command there that calls the API builds its URL as `"${API_URL%/}/..."`, as T10's README does: the stack's URL output ends in `/`.

## Done when

- [ ] `pnpm --filter @code-trust/infra test` passes with assertions on `WorkerStack` that load `cdk.json`'s context like the other stack tests:
  - the resource types are exactly an allowed list written out in the test (queues and their policies, the two functions, roles and policies, log groups, the layer, event source mappings).
  - both functions are `arm64` on `nodejs24.x`; the worker has the layer, a 900 second timeout, the configured memory (at most 3008 MB, asserted) and ephemeral storage; every log group has `RetentionInDays: 14`; there is no `Custom::LogRetention`, `AWS::KMS::Key`, `AWS::SecretsManager::Secret`, `AWS::EC2::*`, `AWS::ECS::*`, `AWS::ECR::*` or `AWS::DynamoDB::*`.
  - the jobs queue and its DLQ are FIFO with `SqsManagedSseEnabled: true`, content-based deduplication off, redrive with `maxReceiveCount` 3, and a visibility timeout at least six times the worker's timeout.
  - the worker's mapping reads the jobs queue with `BatchSize` 1 and the dispatcher's reads the events queue with `BatchSize` 10, both with `ReportBatchItemFailures`, and `ScalingConfig.MaximumConcurrency` is 2 on each (from the two constants).
  - each role's statements are exactly the actions listed above on exactly those resources, with no `*` resource and no `kms:*`; the parameter ARN has one slash after `parameter`.
  - the template has no 12-digit account ID and no ARN literal.
- [ ] `pnpm synth` exits 0 with no AWS credentials and no git layer zip, synthesizes all four stacks, and `pnpm synth 2>&1 | grep -ci docker` prints 0.
- [ ] `grep -ho '"Type": *"AWS::[^"]*"' infra/cdk.out/CodeTrustWorker.template.json | sort | uniq -c` lists nothing outside the allowed list.
- [ ] T10's smoke script loads both synthesized bundles from `infra/cdk.out` without error: the worker's handler given an empty `Records` array returns `{ batchItemFailures: [] }` without calling AWS, and so does the dispatcher's.
- [ ] `grep -n 'API_URL' apps/worker/README.md` shows every API call written as `"${API_URL%/}/..."`, and `grep -c '\$API_URL/' apps/worker/README.md` prints 0.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- Deploying, building the layer zip for real, and creating the SSM parameter. The human does them from the README.
- Changing `IngestStack`, the handlers in `apps/worker/src` or `apps/ingest/src`, or the git layer. If one needs a change, stop and ask.
- S3 `raw/` writes, DynamoDB, ECS, Fargate, VPCs.
- Reserved concurrency and alarms. Name them in the PR if they seem needed.

## Notes

- Cross-stack reference: passing `eventsQueue` makes CloudFormation export its ARN and URL from `CodeTrustIngest`. Once `CodeTrustWorker` imports them, `CodeTrustIngest` cannot drop or rename the queue until the import is gone. Record that in your Decisions row.
- Lambda's SQS poller for a FIFO queue processes one message group at a time, which is the per-repo ordering the Decisions table promises.
- `maxConcurrency` 2 on both event sources, not the default. A new account can start with 10 concurrent executions shared by all four functions, and the webhook and the API need the rest: a throttled webhook loses GitHub deliveries, because GitHub does not retry a failed delivery. 2 is the lowest value SQS event sources accept. This is a cap on the poller, not reserved concurrency, so it cannot fail a deploy on a low account limit. Record it as a Decisions row, with the README's quota check.
- A worker job that times out or crashes keeps its message invisible for the queue's visibility timeout, and the repo's group waits that long. Six times 15 minutes is 90 minutes: acceptable for a rare failure, and it is what AWS recommends.
- Cost: SQS, Lambda and CloudWatch Logs all bill per use. Ephemeral storage above 512 MB bills per GB-second while the worker runs, about $0.0003 for a full 15 minute run at 10 GB; nothing bills while idle. `/ship-lane` runs the cost-guard agent because `infra/` changed, so do not run it yourself first.
- Skip bundling in the assertion tests (`aws:cdk:bundling-stacks` set to an empty list), as the other stack tests do. `GitLayer` then uses its placeholder on its own (T11), so the tests need no zip and no flag.
- The guard hook matches on command text: keep the words for a cdk deploy out of Bash commands and commit messages, and write the README with the Write tool.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/infra test passes with every WorkerStack assertion in the task's Done when list, pnpm synth exits 0 without credentials, Docker or the layer zip and synthesizes all four stacks, the CodeTrustWorker template's resource types are all on the allowed list, both event sources cap MaximumConcurrency at 2, T10's smoke script loads both synthesized bundles and each returns empty batchItemFailures for an empty event, apps/worker/README.md has the Deploy section starting with the account concurrency and memory check and every API call in it uses "${API_URL%/}", and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; then stop and summarize without running the reviewer or cost-guard agents; or stop after 20 turns
```
