# T04: Ingest (GitHub webhook to SQS, IngestStack)

Status: in progress
Wave: 1
Depends on: T01, T02
Owner paths (edit only these):
- `apps/ingest/**`
- `infra/bin/app.ts`
- `infra/lib/ingest-stack.ts`, `infra/lib/ingest-stack.test.ts`
- `infra/lib/config.ts` (new constants only)
- `infra/package.json`
- docs/architecture.md (your rows in Decisions, the "API front door" row in Open decisions, and the front door in Flow if it changes)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Flow, Cost rules, Open decisions)
- `packages/shared/src/queue.ts` and the event fixtures in `packages/shared/src/fixtures.ts`
- `infra/lib/foundation-stack.ts` and `infra/lib/foundation-stack.test.ts` (the patterns to follow)

## Task

Build the front of the pipeline: a webhook Lambda that verifies GitHub's HMAC signature, answers fast, and puts a small `RepoEventMessage` on SQS, plus the `IngestStack` that deploys it. This is the first code that faces the internet and the first stack that can bill per use, so the signature check and the cost rules matter more than features. It also settles the API front door. Once it merges the human can deploy it and register the GitHub App, and real events start to queue up while the worker is still being built.

## Where

- `apps/ingest/src/signature.ts`: verifies `X-Hub-Signature-256` over the raw body.
- `apps/ingest/src/events.ts`: GitHub payload to `RepoEventMessage[]`. Zod schemas for only the fields it reads; GitHub's payloads are large and grow.
- `apps/ingest/src/webhook.ts`: the Lambda handler. The secret loader, the queue sender and the clock are injected, so tests need no AWS.
- `apps/ingest/README.md`: what the human does before and after the first deploy (create the SSM parameter, deploy `CodeTrustIngest`, register the GitHub App with the webhook URL, the secret, and the Push event), ending with a smoke test: an unsigned `POST` to the webhook URL returns 401 from the handler. A 403 means AWS refused the call before the function ran.
- `infra/lib/ingest-stack.ts`: `IngestStack`, added to `infra/bin/app.ts` as `CodeTrustIngest`. Expose the events queue as a public property; the dispatcher (wave 2) consumes it.
- `infra/package.json`: `esbuild` as a devDependency so `NodejsFunction` bundles locally, and `@code-trust/ingest` as a workspace devDependency so `verify:changed` re-runs the infra tests when the handler changes.

What the handler does:

| Request | Response | Enqueued |
| --- | --- | --- |
| Signature missing, malformed or wrong | 401 | nothing |
| Valid signature, `ping`, or any event or action not listed below | 200 | nothing |
| `push` to the default branch of a public repo | 200 | one `push` message, `headSha` from `after` |
| `push` to another ref, a branch deletion, or a private repo | 200 | nothing |
| `installation` with action `created` | 200 | one `repository_added` per public repo in `repositories` |
| `installation_repositories` with action `added` | 200 | one `repository_added` per public repo in `repositories_added` |
| Valid signature, but the body is not JSON, a listed event lacks a field it needs, or `X-GitHub-Delivery` is missing | 400 | nothing |
| The queue send fails, or the secret cannot be loaded | 500 | GitHub records a failed delivery, which a human can redeliver |

The stack:

- One standard SQS queue for events and one dead-letter queue behind it (redrive with a `maxReceiveCount`, DLQ retention 14 days). Both use SQS-managed encryption and enforce SSL.
- One Lambda function: arm64, a current Node runtime, 256 MB or less, a timeout of 10 seconds or less, and its own log group with 14-day retention passed as `logGroup`.
- The front door you decide on (see Notes).
- IAM: `sqs:SendMessage` on the events queue and `ssm:GetParameter` on the one secret parameter. Nothing wider.
- Outputs: the webhook URL and the events queue URL.

## Done when

- [ ] `pnpm --filter @code-trust/ingest test` passes with no AWS credentials and no network, and has a named test for every row of the handler table, plus:
  - GitHub's documented vector verifies: secret `It's a Secret to Everybody`, body `Hello, World!`, header `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`. A changed body, a wrong secret and a `sha1=` header all fail.
  - a base64-encoded event body is verified on the decoded bytes.
  - an installation with 25 public repos enqueues 25 messages in batches of at most 10, and a partial batch failure returns 500.
  - every enqueued body parses with `RepoEventMessageSchema`, and the push case equals `pushEventFixture` apart from `receivedAt`.
  - the secret is loaded once and reused across invocations.
- [ ] `pnpm --filter @code-trust/infra test` passes with assertions on `IngestStack` that load `cdk.json`'s context like the foundation tests do:
  - the resource types are exactly an allowed list written out in the test (the queues and their policy, the function, its role and policy, its log group, and the front door's resources).
  - the function is `arm64`; every `AWS::Logs::LogGroup` has `RetentionInDays: 14`; there is no `Custom::LogRetention`, `AWS::KMS::Key` or `AWS::SecretsManager::Secret`.
  - the events queue redrives to the DLQ, and both queues have `SqsManagedSseEnabled: true`.
  - the function's policy grants `sqs:SendMessage` on the events queue and `ssm:GetParameter` on one parameter, and no `*` resource. The parameter ARN has exactly one slash after `parameter`: a name that starts with `/` must not produce `parameter//`, which IAM never matches.
  - the template has no 12-digit account ID and no ARN literal, as in the foundation test.
- [ ] `pnpm synth` exits 0 with no AWS credentials and synthesizes `CodeTrustFoundation` and `CodeTrustIngest`. `pnpm synth 2>&1 | grep -ci docker` prints 0: esbuild bundles the function locally.
- [ ] `grep -ho '"Type": *"AWS::[^"]*"' infra/cdk.out/CodeTrustIngest.template.json | sort | uniq -c` lists nothing outside the allowed list.
- [ ] `git diff origin/main -- docs/architecture.md` shows Decisions rows for the front door and for private repositories, the "API front door" row gone from Open decisions, and Flow matching the choice.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- The dispatcher Lambda, ECS, Fargate, DynamoDB and anything that reads the queue. Those are wave 2.
- Database access. The webhook never talks to Postgres.
- Deploying, creating the SSM parameter and registering the GitHub App. Write the steps in `apps/ingest/README.md` and link to it from the PR body; the human runs them.
- Uninstall and repository-removed events. They return 200 and enqueue nothing, since `RepoEventMessage` has no type for them. Say so in the PR as a follow-up.
- Deduplicating redelivered events. The queue is at-least-once anyway, so the consumer does that.
- `packages/shared`. If `RepoEventMessage` cannot carry what an event needs, stop and ask.
- `infra/lib/foundation-stack.ts` and its test.

## Notes

- Front door. A Lambda Function URL (auth `NONE`, since the HMAC is the authentication) is free forever and adds no resource that can bill. An API Gateway HTTP API bills per request once the free year ends, and in exchange has route throttling and custom domains. One POST endpoint needs neither, so start from the Function URL and move off it only for a concrete reason. Record the choice. The API on Lambda (wave 2) will follow the same decision. Keep the construct IDs of the function and its URL stable: a new ID means a new URL, and the GitHub App would keep posting to the old one.
- Private repositories are a planning decision for you to record: they are not enqueued. The read API (T06) has no auth, so nothing private may enter the pipeline. `repository.private` on a push and `private` on each entry of an installation payload say which is which.
- Verify the signature on the exact bytes GitHub sent, before any JSON parsing, and compare with `crypto.timingSafeEqual`. Header names arrive lowercased. Never log the secret, the signature or the body.
- The secret is an SSM `SecureString` under the AWS-managed key, read at cold start with decryption. CloudFormation cannot create a `SecureString`, so the human creates it by hand and the stack only passes its name to the function and grants the read. Build the parameter ARN with `Stack.formatArn`. No Secrets Manager, and no Parameters and Secrets extension layer: its ARN carries an account ID.
- Do not set reserved concurrency. A new account's concurrency limit can be too low for that deploy to succeed, and you cannot test a deploy. If a throttle seems needed, say so in the PR.
- Owner and name come from `full_name`, which both payload kinds carry. One installation delivery yields several messages with the same `deliveryId`, so the dedupe key downstream is `deliveryId` plus `repo.id`.
- Use `logGroup` on the function, not `logRetention`: the latter adds a custom-resource Lambda. The cost-guard agent fails log groups without retention, including implicit ones.
- Skip bundling in the assertion tests (`aws:cdk:bundling-stacks` set to an empty list in the test App's context) so they stay fast. `pnpm synth` is what proves the bundle builds.
- The guard hook matches on command text. A Bash command or a commit message that contains the words for a cdk deploy, or an `aws ssm put-parameter` call, is blocked even inside quotes. Write that text into the README with the Write tool, check it by reading the file, and keep it out of commit messages and the PR body: in the PR, point to `apps/ingest/README.md` instead of pasting the commands.
- SQS and Lambda both have an always-free tier of one million requests a month, which normal webhook traffic does not approach. `/ship-lane` runs the cost-guard agent because `infra/` changed, so don't run it yourself first.
- T03 runs in parallel and also appends to the Decisions table. If your PR conflicts with main there or in docs/STATUS.md, rebase and keep both sides' rows. If `pnpm-lock.yaml` conflicts, take main's and run `pnpm install` again.
- If `pnpm install` stops on a dependency build script that needs a ruling in `pnpm-workspace.yaml`, stop and ask. That file is root config.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/ingest test passes with a named test for every row of the handler table and every extra case in Done when, pnpm --filter @code-trust/infra test passes with the IngestStack assertions listed in Done when, pnpm synth exits 0 with no AWS credentials and synthesizes CodeTrustFoundation and CodeTrustIngest without Docker, the resource types in infra/cdk.out/CodeTrustIngest.template.json are all on the allowed list, docs/architecture.md records the front door and private repository decisions, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; then stop and summarize without running the reviewer or cost-guard agents; or stop after 20 turns
```
