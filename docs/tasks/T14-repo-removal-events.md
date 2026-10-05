# T14: Repo removal events (private, deleted, uninstalled)

Status: planned
Wave: 2
Depends on: T04, T07 (merged to main before this starts)
Owner paths (edit only these):
- `apps/ingest/src/events.ts`, `apps/ingest/src/events.test.ts` (new, if you split tests out), `apps/ingest/src/webhook.ts`, `apps/ingest/src/webhook.test.ts`, `apps/ingest/src/testing.ts`
- `apps/ingest/README.md`
- docs/architecture.md (your rows in Decisions)
Read first:
- docs/architecture.md (Flow, and the Decisions rows on private repositories and per-repo ordering)
- `apps/ingest/src/events.ts`, `apps/ingest/src/webhook.ts` and their tests as T04 merged them
- `packages/shared/src/queue.ts` as T07 merged it (`repository_removed` and its reasons)
- GitHub's webhook docs for the `repository`, `installation` and `installation_repositories` events

## Task

The read API is public, so data about a repo must go when the repo stops being public or the App loses access to it. The worker already deletes a repo on a `delete_repo` job (T09), and the dispatcher turns a `repository_removed` event into one (T12). This lane makes the webhook emit those events. It also enqueues a backfill when a repo turns public, which is the mirror case. All of it is mapping code with the same two-stage parsing T04 uses, so the risk is in reading GitHub's payloads right, and the proof is one named test per row.

## Where

`apps/ingest/src/events.ts`, extending `toRepoEvents`:

| Event and action | Enqueued |
| --- | --- |
| `repository` `privatized` | one `repository_removed`, `reason: 'privatized'` |
| `repository` `deleted` | one `repository_removed`, `reason: 'deleted'` |
| `repository` `publicized` | one `repository_added` (the existing type) |
| `repository`, any other action (`renamed`, `transferred`, `edited`, ...) | nothing, 200 |
| `installation` `deleted` | one `repository_removed`, `reason: 'uninstalled'`, per repo in the payload |
| `installation_repositories` `removed` | one `repository_removed`, `reason: 'removed_from_installation'`, per repo in `repositories_removed` |
| Existing rows from T04 | unchanged |

Removals are sent for every listed repo, private or not: deleting is always safe, and a repo that turned private while an event was missed must still lose its data. Additions stay public-only. Record this as a Decisions row that amends the private repositories row.

`apps/ingest/README.md`: two steps for the human, in this order. First redeploy `CodeTrustIngest` so the webhook knows the new events (deploying `CodeTrustWorker` also deploys `CodeTrustIngest` as a dependency, so one deploy covers both once T13 has merged). Then subscribe the GitHub App to the **Repository** event, with where to find the setting, so `privatized`, `deleted` and `publicized` arrive (installation events always arrive). In the other order, the old webhook answers 200 to Repository events and drops them.

## Done when

- [ ] `pnpm --filter @code-trust/ingest test` passes with no AWS credentials and no network, every existing ingest test unchanged (T12's too, if it has merged) except the T04 test that asserted these events were ignored (show its diff and why), plus a named test per row of the table above, each with a payload shaped like GitHub's documented example for that event, and each enqueued body parsing with `RepoEventMessageSchema`. Also:
  - `installation` `deleted` with a mix of public and private repos enqueues a removal for each of them.
  - `installation_repositories` `removed` with 25 repos enqueues 25 messages in batches of at most 10.
  - a `repository` delivery missing a field the enqueue path needs is a 400; one with an unhandled action is a 200 even when those fields are missing.
  - the log line for a removal carries the reason and the repo id, and no payload text.
- [ ] `git diff origin/main -- docs/architecture.md` shows the Decisions row on removals for every repo.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- The dispatcher and its mapping (T12), the worker's delete (T09), any infra.
- Renames and transfers. The repo id is stable, and the next analysis's `upsertRepo` updates owner and name.
- `installation` `suspend` and `unsuspend`. Name them in the PR as a follow-up if you think suspension should delete.
- Fixing the ordering limit T12 notes (a push delivered after an uninstall can bring data back).
- `apps/ingest/src/aws.ts`, `env.ts`, `index.ts` and the dispatcher files: T12 owns them and may run at the same time.

## Notes

- Check whether `installation` `deleted` lists the repositories when the installation covered all repositories, not just selected ones. If GitHub's docs or a real example show it does not, stop and ask: deleting by installation would need a new query and message, which belong to other lanes.
- Keep the two-stage parse: route on `action` first, so an action this lane ignores never fails on a field only the enqueue path needs.
- Owner and name come from `full_name`, as T04 does.
- The README edit is text for the human only; the guard hook blocks commands that look like deploys or AWS writes, not words in a file written with the Write tool.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/ingest test passes with no AWS credentials, a named test for every row of the task's event table and every extra case in Done when, only the one T04 test about now-handled events changed, docs/architecture.md has the Decisions row on removals for every repo, apps/ingest/README.md tells the human to redeploy CodeTrustIngest and then subscribe the App to Repository events, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 15 turns
```
