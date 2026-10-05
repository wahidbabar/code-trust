# T17: Attribution: confirm the unverified candidates, detect bots by email

Status: planned
Wave: 2
Depends on: T16 (merged to main before this starts)
Owner paths (edit only these):
- `packages/analyzer/src/attribution/**`
- `packages/eval/src/**` (only to flip T16's known-failure marker once the gate passes)
- docs/architecture.md (your rows in Decisions, and the Cohorts and Attribution signals text where it changes)
Read first:
- docs/architecture.md (Metric definitions: Cohorts and Attribution signals, and the Decisions rows on email-only matching, evidence from the list, and the eval gate)
- `packages/analyzer/src/attribution/identities.ts` (the rules for the list, `UNVERIFIED`) and `attribute.ts`
- `eval/README.md` and the output of `pnpm --filter @code-trust/eval score` on main

## Task

T16's gate fails today on condition (c): bots whose author name lacks `[bot]` land in `human`. Its recall report shows what the AI list misses. This lane fixes (c) and closes the recall gaps that have a source. Two changes. First, each `UNVERIFIED` candidate (claude[bot] with its numeric id, Devin's bot account, aider's trailer) either moves to `AI_IDENTITIES` with a source that meets the list's rules, or stays with a sharper note of what is still missing. Second, the `automation` cohort recognises a GitHub App bot by its noreply email (`<id>+<name>[bot]@users.noreply.github.com`), not only by an author name ending in `[bot]`, so a bot that writes a friendlier name stays out of the human baseline. The eval gate on the dev set is the proof: (a), (b) and (c) all pass. Every identity moved into the list makes its commits subject to (b), so a move that the matcher does not honour fails the gate. Recall per tool is reported, not gated: a tool's commits with no listed identity stay invisible to email matching whatever this lane does. The human's holdout run is the final check.

## Where

- `packages/analyzer/src/attribution/identities.ts`: moves out of `UNVERIFIED`, each with its source comment.
- `packages/analyzer/src/attribution/attribute.ts`: the bot rule. Precedence stays: `ai` first (an AI bot is `ai`), then `automation`, then `human`.
- Tests next to them, and T16's known-failure marker in `packages/eval` flipped to a passing test once the gate passes.

## Done when

- [ ] `pnpm --filter @code-trust/analyzer test` passes, every existing test unchanged, plus named tests:
  - each identity moved into `AI_IDENTITIES` puts a commit in `ai` as author, as committer and as a trailer where the tool writes one, with evidence built from the list entry.
  - a bot whose author name lacks `[bot]` but whose email is `<id>+renovate[bot]@users.noreply.github.com` is `automation`, and `dependabot[bot]` with its usual identity still is.
  - an email that only resembles the bot pattern (`renovate[bot]@users.noreply.github.com.example.org`, `x+bot@users.noreply.github.com`) is not a bot.
  - the property test from T05 still holds: no human name or email from the input appears in any output.
- [ ] `pnpm --filter @code-trust/eval score` exits 0 on `eval/dev`, with (a), (b) and (c) all passing, and its output shows recall per tool before (on main, where it exits 1 on (c)) and after. Show both.
- [ ] `pnpm --filter @code-trust/eval test` passes with T16's known-failure marker removed.
- [ ] `git diff origin/main -- docs/architecture.md` shows a Decisions row for bot detection by email and updated Cohorts text.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- `eval/dev/` and `eval/holdout/`. If a dev label looks wrong, say so in the PR; do not change data to pass the gate.
- Message markers, PR labels, confidence below 1.
- Re-analyzing stored repos. The next push to each repo re-analyzes it with the new list.

## Notes

- The list's rules apply: a source is the vendor's docs, forum or own repositories, or this repository's commits. A stranger's commit in the dev set shows the identity exists; it does not make it an AI identity.
- claude[bot]: `gh api users/claude%5Bbot%5D --jq .id` gives the bot user's id from GitHub itself, and claude-code-action's source shows the address is built from that id. Both together are a source.
- aider: its own repository's source code is a source for the trailer's exact email. The default `(aider)` name suffix stays unmatched: email matching cannot use it (Decisions row on email-only matching).
- In the PR body, ask the human to score this branch on the holdout before merging and paste the aggregates: in this workspace, `EVAL_HOLDOUT_DIR=<main clone>/eval/holdout pnpm --filter @code-trust/eval score:holdout`. The holdout is gitignored and exists only in the human's main clone. Never run it yourself, and never read that directory.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/analyzer test passes with existing tests unchanged and named tests for every moved identity, bot detection by noreply email and the look-alike emails, pnpm --filter @code-trust/eval score exits 0 on eval/dev with conditions (a), (b) and (c) all passing and recall per tool shown before and after, pnpm --filter @code-trust/eval test passes without T16's known-failure marker, docs/architecture.md has the Decisions row on bot detection by email, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 15 turns
```
