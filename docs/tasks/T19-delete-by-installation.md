# T19: Delete by installation: uninstalls and narrowed selections that name no repos

Status: planned
Wave: 2
Depends on: T12, T14 (merged to main before this starts). Not at the same time as T18: both add a job type to the same files.
Owner paths (edit only these):
- `packages/shared/src/queue.ts`, `packages/shared/src/queue.test.ts`, `packages/shared/src/fixtures.ts`, `packages/shared/src/schema-cases.ts`
- `packages/db/src/queries.ts`, `packages/db/src/queries.test.ts`, `packages/db/README.md`
- `apps/ingest/src/events.ts`, `apps/ingest/src/webhook.ts`, `apps/ingest/src/webhook.test.ts`, `apps/ingest/src/testing.ts`, `apps/ingest/src/dispatcher.ts`, `apps/ingest/src/dispatcher.test.ts`, `apps/ingest/README.md`
- `apps/worker/src/job.ts`, `apps/worker/src/job.test.ts`, `apps/worker/src/handler.test.ts`, `apps/worker/src/testing.ts`, `apps/worker/README.md`
- docs/architecture.md (your rows in Decisions)
Read first:
- docs/architecture.md (Flow, and the Decisions rows on per-repo ordering, the dispatcher's `MessageDeduplicationId`, and removal events for every repo)
- `apps/ingest/README.md` (the request table and the list of gaps T14 left)
- `apps/ingest/src/events.ts`, `dispatcher.ts` and their tests
- `packages/shared/src/queue.ts`
- `packages/db/src/queries.ts` (`deleteRepo`) and `packages/db/migrations/0001_init.sql` (`repos.installation_id`, the cascading keys)
- `apps/worker/src/job.ts`
- GitHub's webhook docs for `installation` and `installation_repositories`

## Before this starts (human, about 10 minutes)

The narrowing case cannot be designed from GitHub's docs, so this lane needs facts from real deliveries first. Use a free throwaway organization with two small private repos. Private repos are never analyzed, so nothing reaches the database.

1. Install the code-trust App there with "All repositories".
2. Switch it to "Only select repositories" and pick one of the two.
3. Uninstall it.
4. On GitHub, open the App's settings, Advanced, Recent Deliveries. Record key names and counts only, no bodies, under "Facts from real deliveries" below:
   - `installation` `created`: is there a `repositories` key, and how many entries does it have?
   - The delivery or deliveries for the switch: the event, the action, `repository_selection`, how many entries `repositories_added` and `repositories_removed` have, and whether either one lists the repo you kept.
   - `installation` `deleted`: `installation.repository_selection`, is there a `repositories` key, and how many entries does it have?

### Facts from real deliveries

(Filled in by the human before the lane starts.)

## Task

T14 deletes a repo's data on the deliveries that name the repo. Two deliveries name none, and those repos' data stays in the public API:
- an `installation` `deleted` with no `repositories` list, which an installation on all repositories may send (`no-repository-list` today);
- the delivery for an installation that narrows from all repositories to selected ones, whose `repositories_removed` GitHub documents as empty (`selection-narrowed` today).

Every repo row records the installation that last analyzed it (`repos.installation_id`). So this lane deletes by installation: the webhook sends one installation-level event, the dispatcher turns it into one job, and the worker deletes every repo of that installation, except the ones a narrowed selection keeps.

## Where

1. **Contract.** `packages/shared/src/queue.ts`:
   - `RepoEventMessageSchema` gains `installation_repos_removed`: `version`, `deliveryId`, `receivedAt`, `installationId`, `reason: 'uninstalled' | 'selection_narrowed'` and `keepRepoIds: GithubId[]`. It has no `repo`.
   - `JobMessageSchema` gains `delete_installation_repos`: the job fields, `installationId`, `reason` and `keepRepoIds`.
   - `version` stays 1, because both unions only grow. Add fixtures and schema cases.

2. **Webhook.** `apps/ingest/src/events.ts`:
   - **Uninstall:** every `installation` `deleted` enqueues one `installation_repos_removed` with reason `uninstalled` and `keepRepoIds: []`. When the payload lists repos, T14's per-repo removals still go out beside it, so their deletes keep per-repo order. `no-repository-list` goes away.
   - **Narrowing:** build it from the recorded facts. If the switch arrives as `installation_repositories` `removed` with an empty `repositories_removed`, enqueue one `installation_repos_removed` with reason `selection_narrowed`. Its `keepRepoIds` come from whichever array the facts show lists the kept repos; if no array does, `keepRepoIds` is empty. `selection-narrowed` goes away.
   - **Stop and ask** if the facts show the switch arrives in a form that no field tells apart from an ordinary `added`.
   - **Parsing:** keep the two-stage parse. Repo ids in `keepRepoIds` pass the contract like any other id.
   - **Log line:** it carries `installationId`, the reason and the keep count, and no payload text.

3. **Dispatcher.** `apps/ingest/src/dispatcher.ts` maps `installation_repos_removed` to a `delete_installation_repos` job, with:
   - `MessageGroupId`: `installation-<id>`, which can never collide with a repo id's group;
   - `MessageDeduplicationId`: `<deliveryId>:installation-<id>`.

   Its log line carries `installationId` where a repo event's carries `repoId`.

4. **Database.** `packages/db/src/queries.ts` gets `deleteReposOfInstallation(db, installationId, keepRepoIds)`:
   - It deletes every repo row with that `installation_id` whose id is not kept. The cascading keys remove the rest of each repo's data.
   - It returns the deleted repo ids.
   - It is one statement for a keep list of any size: use an array parameter, not one placeholder per id.
   - Repos with a null `installation_id` are never touched.
   - No migration: the table is small, and the query needs no new index yet.

5. **Worker.** `apps/worker/src/job.ts` runs a `delete_installation_repos` job by calling `deleteReposOfInstallation` and logging outcome `deleted` with the installation id and the count. The job is acknowledged whether or not anything was deleted, and it never runs git.

6. **Docs.**
   - A Decisions row: the installation-level event and job, the `installation-<id>` group, why uninstalls send both kinds of events, and the ordering limit below.
   - `apps/ingest/README.md`: the request table, the dispatcher's event table, the two gaps marked closed, and the rollout below.
   - `apps/worker/README.md` and `packages/db/README.md`: the new job and query.

## Done when

- [ ] `pnpm --filter @code-trust/shared test` passes, with schema cases for both new members (valid; a missing `installationId`; a negative or non-integer id in `keepRepoIds`; an unknown `reason`) and every existing fixture still parsing.
- [ ] `pnpm --filter @code-trust/db test` passes against the workspace database with named tests:
  - only the given installation's repos and their rows go;
  - kept ids stay;
  - other installations' repos and repos with a null `installation_id` stay;
  - an empty keep list deletes all of the installation's repos;
  - a keep list of 5,000 ids works in one statement;
  - a second call deletes nothing and returns no ids.
- [ ] `pnpm --filter @code-trust/ingest test` passes with named tests, each saying which broken behaviour would make it fail:
  - an uninstall with listed repos enqueues the per-repo removals plus one installation-level event;
  - an uninstall without a list enqueues one installation-level event;
  - the narrowing delivery, shaped like the recorded facts, enqueues one installation-level event with the right keep ids;
  - a handled action missing a field it needs is a 400, and an unhandled action is a 200;
  - the log line carries no payload text;
  - the dispatcher's group and dedupe id for the new job;
  - a batch mixing repo events and an installation event keeps each group's order.

  T14's tests for `no-repository-list` and `selection-narrowed` change; show their diff and why. Every other existing test is unchanged.
- [ ] `pnpm --filter @code-trust/worker test` passes with a named test: the job deletes through the query, logs the installation id and the count, never runs git, and is acknowledged.
- [ ] `pnpm synth` passes, with no infra change. The dispatcher already sends to the jobs queue, and the worker already reaches the database.
- [ ] `git diff origin/main -- docs/architecture.md` shows the Decisions row.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- A deleted repo (T18's sweep).
- Fixing the ordering limit. The job runs in its own group, so an analyze job already queued for one of the installation's public repos can run after the delete and bring that repo's data back. This is T12's limit at installation scale. A table of removed installations, checked by `upsertRepo`, would close it for uninstalls, since GitHub never reuses an installation id. That is its own task: name it in the PR.
- `installation` `created` without `repositories`. If the facts show an install on all repositories omits the list, T04's rule answers 400 and nothing is backfilled. Name it in the PR as a follow-up; do not fix it here.
- Any GitHub API call, and any infra change.
- Deploying.

## Notes

- **Why uninstalls send both kinds of events:** the per-repo removals run in each repo's FIFO group, behind that repo's queued jobs. The installation-level event catches every repo the payload did not list.
- **`repos.installation_id` is the installation of the repo's last analysis.** A repo moved to another installation keeps the old id until its next analysis, so an uninstall of the old installation deletes it. Its next push re-analyzes it from scratch.
- **Narrowing keeps only the repos the payload names.** A kept repo the payload does not name loses its data until its next push, which analyzes from scratch. Deleting too much is safe; leaving data public is not.
- **Rollout order for the README:**
  1. Deploy `CodeTrustWorker`, so the dispatcher and the worker understand the new event and job.
  2. Deploy `CodeTrustIngest` alone with `-e`, so the webhook starts sending the event.

  In the other order, the old dispatcher fails to parse the new event, and those records end in the events DLQ after 5 receives.

## Goal line

Paste into the workspace after approving the plan, once "Facts from real deliveries" is filled in:

```
/goal pnpm --filter @code-trust/shared test, pnpm --filter @code-trust/db test (workspace database), pnpm --filter @code-trust/ingest test and pnpm --filter @code-trust/worker test pass with a named test for every case in Done when, including the uninstall and narrowing events built from the recorded facts, the dispatcher's installation-<id> group and dedupe id, deleteReposOfInstallation with kept ids and a 5,000-id keep list in one statement, and the worker's delete_installation_repos job; T14's two changed tests shown with their diff; pnpm synth passes with no infra change; docs/architecture.md has the Decisions row; pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 25 turns
```
