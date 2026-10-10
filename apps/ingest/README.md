# @code-trust/ingest

The GitHub App webhook. A Lambda function behind a Lambda Function URL verifies GitHub's `X-Hub-Signature-256`, turns the delivery into small `RepoEventMessage`s, puts them on the events queue, and answers well inside GitHub's 10 second limit. `IngestStack` (stack `CodeTrustIngest`) deploys it.

| Request | Response | Enqueued |
| --- | --- | --- |
| Signature missing, malformed or wrong | 401 | nothing |
| `ping`, or any event or action not listed below | 200 | nothing |
| `push` to the default branch of a public repo | 200 | one `push` message |
| `push` to another ref, a branch deletion, or a private repo | 200 | nothing |
| `installation` `created` | 200 | one `repository_added` per public repo |
| `installation_repositories` `added` | 200 | one `repository_added` per public repo |
| Body not JSON, a needed field missing, or no `X-GitHub-Delivery` | 400 | nothing |
| Queue send failed, or the secret could not be loaded | 500 | nothing that GitHub can see; redeliver it |

Private repositories never enter the pipeline: the read API has no auth.

Each request writes one JSON log line with `status`, `outcome` and `reason`, plus the delivery id once the signature checks out. Logs never contain the secret, the signature or the body.

## Before the first deploy

Run these on the Mac, from `~/grind/code-trust` on `main` after the PR has merged. Start with `git pull && pnpm install`.

1. Log in and generate the webhook secret into a variable, so it never lands in shell history:

   ```bash
   aws login
   WEBHOOK_SECRET=$(openssl rand -hex 32)
   ```

   If you already have a secret, type it instead with `read -rs WEBHOOK_SECRET`.

2. Store it as an SSM `SecureString`. Leave out `--key-id`: the parameter must use the AWS-managed `aws/ssm` key, because the function's role has no `kms:Decrypt`. Standard tier is free.

   ```bash
   aws ssm put-parameter --region ap-south-1 \
     --name /code-trust/github-webhook-secret \
     --type SecureString \
     --value "$WEBHOOK_SECRET"
   ```

3. Copy the secret for the GitHub App form in step 6, without a trailing newline. The parameter and the App must match byte for byte, so a stray space or newline makes every delivery a 401.

   ```bash
   printf '%s' "$WEBHOOK_SECRET" | pbcopy
   unset WEBHOOK_SECRET
   ```

## Deploy

4. Deploy the stack. The CDK app builds every stack, so `ALERT_EMAIL` is required even though this deploy only touches `CodeTrustIngest`.

   ```bash
   export ALERT_EMAIL=you@example.com
   cd infra
   pnpm exec cdk deploy CodeTrustIngest
   ```

5. Read the outputs into variables. They also print at the end of the deploy.

   ```bash
   WEBHOOK_URL=$(aws cloudformation describe-stacks --region ap-south-1 --stack-name CodeTrustIngest \
     --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text)
   QUEUE_URL=$(aws cloudformation describe-stacks --region ap-south-1 --stack-name CodeTrustIngest \
     --query "Stacks[0].Outputs[?OutputKey=='EventsQueueUrl'].OutputValue" --output text)
   ```

   Run the smoke test at the end of this file now: it needs no secret and proves the URL reaches the function.

   Keep both URLs out of the repo, issues, PRs and the Deployed table in docs/STATUS.md. The queue URL contains the account ID, and a published webhook URL only invites junk traffic for the signature check to refuse.

## Register the GitHub App

6. On GitHub: Settings, Developer settings, GitHub Apps, New GitHub App.
   - Webhook: Active. Webhook URL: `$WEBHOOK_URL`. Webhook secret: paste from step 3. Keep SSL verification on.
   - Repository permissions: Contents, Read-only. Metadata, Read-only, is added for you.
   - Subscribe to events: Push. `installation` and `installation_repositories` arrive without a subscription.
   - Never switch the App's webhook `content_type` to `form` through the API. Form-encoded bodies get a 400.

7. Check the ping. Under the App's Advanced tab, Recent Deliveries, the `ping` should show 200, which proves the function read the secret from SSM. A 401 means the App and the parameter hold different secrets. A 500 means the function could not read the parameter: look at the log group.

8. Install the App on one public repo, push to its default branch, and check that the delivery shows 200 and the queue holds a message:

   ```bash
   aws sqs get-queue-attributes --region ap-south-1 --queue-url "$QUEUE_URL" \
     --attribute-names ApproximateNumberOfMessages
   ```

   Install it on more repos only when wave 2's consumer is close: see Expiry below.

9. Log out, so agents never find a live AWS session: `aws logout`.

## Operations

- **Failed deliveries.** GitHub never retries on its own, and the handler answers every failure itself, so Lambda's Errors metric stays at 0. Check Recent Deliveries and use Redeliver. Redelivery only reaches back 3 days.
- **Function name.** The commands below need it. It comes from the pinned logical ID:

  ```bash
  FUNCTION=$(aws cloudformation describe-stack-resource --region ap-south-1 --stack-name CodeTrustIngest \
    --logical-resource-id WebhookFunction59DCB58D \
    --query StackResourceDetail.PhysicalResourceId --output text)
  ```

- **Rotating the secret.** Change the parameter (step 2 with `--overwrite`) and the App's secret together. Running instances keep the old secret in memory, so force fresh ones with any configuration update, then redeliver whatever failed in between:

  ```bash
  aws lambda update-function-configuration --region ap-south-1 --function-name "$FUNCTION" \
    --description "code-trust GitHub webhook, secret rotated $(date -u +%Y-%m-%d)"
  ```

- **Off switch.** Reserved concurrency 0 stops every invocation, and the URL answers 429 before the function runs:

  ```bash
  aws lambda put-function-concurrency --region ap-south-1 --function-name "$FUNCTION" \
    --reserved-concurrent-executions 0
  ```

  This setting is outside the template, so it survives later deploys. Remove it to turn the webhook back on:

  ```bash
  aws lambda delete-function-concurrency --region ap-south-1 --function-name "$FUNCTION"
  ```

- **Expiry.** With no consumer, queued messages expire after 14 days, and an expired message is deleted, not moved to the dead-letter queue. Install the App on more repos only when wave 2 is close.
- **Large deliveries.** Lambda refuses requests over about 6 MB before the function runs, while GitHub sends up to 25 MB. A huge push is lost, and the next push to that branch catches up, since an analysis reads the head.

## Smoke test

An unsigned `POST` must get 401 from the handler:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' "$WEBHOOK_URL"
```

- `401`: the function ran and refused the missing signature. This is the expected answer.
- `403`: AWS refused the call before the function ran. The Function URL's resource policy needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`; check the stack's two `AWS::Lambda::Permission` resources.
- `429`: reserved concurrency is 0. See Off switch.
- `502`: the function failed to start. Check its log group.

## Dispatcher

A second Lambda function, `src/dispatcher-lambda.ts`, drains the events queue and sends one job per event to the SQS FIFO jobs queue that `WorkerStack` deploys. Each job's `MessageGroupId` is the repo id, so one repo never has two jobs at once, and its `MessageDeduplicationId` is `<deliveryId>:<repo id>`.

| Event | Job |
| --- | --- |
| `push` | `analyze`, `reason: 'push'`, with the event's `headSha` |
| `repository_added` | `analyze`, `reason: 'backfill'`, `headSha: null` |
| `repository_removed` | `delete_repo`, with the event's `reason` |

- **Environment.** `JOBS_QUEUE_URL` is the jobs queue's URL (`DISPATCHER_ENV` in `@code-trust/ingest/env`). If it is unset the function still starts, and every record fails until it is set.
- **Failures.** The function reports failed records through `ReportBatchItemFailures`, so SQS retries only those. A record fails if its body is not a valid `RepoEventMessage`, if SQS does not list its entry as sent, or if its batch's send throws. Batches of up to 10 go out one at a time, in record order, with the webhook's SDK timeouts. A retry within 5 minutes is deduplicated by the jobs queue.
- **Logs.** One JSON line per record: `messageId`, `outcome` (`dispatched`, `failed` or `invalid`), and `reason` when it did not dispatch. A record that parsed also carries `deliveryId`, `repoId` and `event`, and once its job is built, `job` and `jobId`. `error` holds SQS's error code or the thrown error's name. A record that did not parse carries `fields`, the schema paths it broke. No line ever holds a message body or an error message.
