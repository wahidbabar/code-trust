# T07: Queue contracts for wave 2 (job messages, repo removal events)

Status: planned
Wave: 2 (serial, before the lanes that read the queues)
Depends on: T02
Owner paths (edit only these):
- `packages/shared/src/queue.ts`, `packages/shared/src/queue.test.ts`
- `packages/shared/src/fixtures.ts` (new queue fixtures only; existing fixtures keep their values)
Read first:
- docs/architecture.md (Flow, and the Decisions rows on private repositories, per-repo ordering and the worker on Lambda)
- `packages/shared/src/queue.ts`, `packages/shared/src/queue.test.ts`, `packages/shared/src/schema-cases.ts`
- `apps/ingest/src/events.ts` (the producer of `RepoEventMessage` today)

## Task

Wave 2 adds three lanes that speak over the two queues: the dispatcher (T12), the worker (T09) and the webhook's removal events (T14). Before they start, the messages they exchange must exist in `@code-trust/shared`, so no lane invents its own. Two things are missing. The webhook needs a way to say "this repo's data must go" (it turned private, was deleted, or the App lost access), and the worker needs a second kind of job, delete, next to analyze. Messages already sitting in the deployed events queue must still parse.

## Where

`packages/shared/src/queue.ts`:

1. `RepoEventMessageSchema` gains a third member, `type: 'repository_removed'`, with the same envelope fields and a `reason`: `z.enum(['privatized', 'deleted', 'uninstalled', 'removed_from_installation'])`. Version stays `1`: the union only grows, so every message the deployed webhook has queued still parses.
2. The dispatcher-to-worker message becomes a union discriminated by `type`:
   - `AnalysisJobMessageSchema`: today's fields plus `type: z.literal('analyze')` and `deliveryId` (the GitHub delivery that caused it, for tracing a job back in logs).
   - `DeleteRepoJobMessageSchema`: `version: 1`, `type: 'delete_repo'`, `jobId`, `requestedAt`, `deliveryId`, `repo: RepoRefSchema`, and the event's `reason`.
   - `JobMessageSchema`: the union of the two, and `type JobMessage`.

   Nothing consumes `AnalysisJobMessage` yet, so changing it in place is safe; say so in a comment only if it explains a field.
3. A `REPO_REMOVED_REASONS` tuple or the enum exported, so T14 and T12 share one list.

`packages/shared/src/fixtures.ts`: `repositoryRemovedEventFixture` and `deleteRepoJobFixture`; `analysisJobFixture` and `backfillJobFixture` gain `type` and `deliveryId`. Use the existing `REPO_ID`, `INSTALLATION_ID` and fixed timestamps.

## Done when

- [ ] `pnpm --filter @code-trust/shared test` passes with `describeSchemas` cases for the new schemas: valid fixtures parse; invalid ones fail at the named path with a useful message, including a removal with an unknown `reason`, a `delete_repo` job without `repo`, an analyze job without `type`, and a job with an unknown `type`.
- [ ] A named test proves backward compatibility: `pushEventFixture` and `repositoryAddedEventFixture`, byte for byte as they are on main today, still parse with `RepoEventMessageSchema`.
- [ ] `pnpm --filter @code-trust/ingest test` passes unchanged (the webhook still produces valid messages).
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- Producing or consuming the new messages: T12 (dispatcher), T09 (worker), T14 (webhook).
- `packages/db`, `apps/**`. T08 runs in parallel and owns `packages/db`.
- Domain or API schemas.

## Notes

- Keep messages small: a removal names the repo and why, nothing else. The worker fetches nothing for a delete.
- The removal reason travels to the job so the worker's log line says why data went, without the worker knowing GitHub's event names.
- A removal is sent for every affected repo, private or not (T14 records that decision): deleting is always safe, and a repo that turned private while an event was missed must still lose its data.
- T08 runs at the same time and touches only `packages/db`. No overlap.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/shared test passes with schema cases for repository_removed events, analyze and delete_repo jobs and the JobMessage union, plus a named test that the event fixtures on main still parse, pnpm --filter @code-trust/ingest test passes unchanged, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 12 turns
```
