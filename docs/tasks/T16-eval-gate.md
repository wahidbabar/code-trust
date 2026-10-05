# T16: Attribution eval gate (labeled public commits, scorer, holdout format)

Status: planned
Wave: 2
Depends on: T05
Owner paths (edit only these):
- `packages/eval/**` (new workspace package, `@code-trust/eval`)
- `eval/**`, except `eval/holdout/**`, which only the human writes and no agent reads (`eval/.gitignore` is yours, and ignores it)
- docs/architecture.md (your rows in Decisions, and the sentence in Attribution signals about the eval gate)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Metric definitions: Cohorts and Attribution signals, and the Decisions rows on email-only matching, evidence from the list, and personal data)
- `packages/analyzer/src/attribution/identities.ts` (`AI_IDENTITIES`, `LEFT_OUT`, `UNVERIFIED` and the rules for the list) and `packages/analyzer/src/attribution/attribute.ts`

## Task

Attribution is the product's precision, and so far it has been tested only with examples its authors wrote. This lane builds the gate that scores it against labeled real commits: a dev set agents can see, a holdout format the human fills, and a scorer that reports per-cohort precision and recall and fails on the three errors email matching should never make (see The gate). Labels must come from evidence independent of the matcher, or the score only measures the matcher against itself. The dev set must include what the list is known to miss (the `UNVERIFIED` candidates, and bot accounts whose name lacks `[bot]` but whose email is a `[bot]` noreply address), so the gate shows the gaps T17 then closes.

## Where

- `eval/README.md`: the labeled commit format and the labeling rules, written so the human can build `eval/holdout/` from them without asking. This file is the contract for the holdout.
- `eval/dev/*.jsonl`: the dev set. One commit per line: `source` (the commit URL), `author` and `committer` (`{ name, email }`), `message`, `label` (`ai`, `human` or `automation`), `tool` (for `ai`), and `labelEvidence` (a URL and one sentence: why this label, from something other than the commit's identities and trailers, such as the pull request being opened by the agent's account, the tool's docs describing that repo's workflow, or a maintainer saying so).
- `packages/eval/src/`: a zod schema for a labeled commit, a loader, and a scorer that runs `attributeCommit` from `@code-trust/analyzer` on each commit and reports a confusion matrix over the three cohorts, `ai` precision and recall overall and per tool, and the misses grouped by tool.
- Scripts: `score` (the dev set; exits 1 when the gate fails) and `score:holdout` (the same on the directory in `EVAL_HOLDOUT_DIR`, default `eval/holdout`, printing aggregates only, never a commit, an identity or a message; exits 0 with a note when the directory is empty or missing). Agents never run `score:holdout`.
- `eval/.gitignore` ignores `holdout/`. The holdout exists only in the human's main clone: never in a worktree, never in the public repo. The guard hook blocks agents' writes there but not `Read`, `Grep`, `Glob` or `cat`, so keeping it out of worktrees is what keeps it unseen. The human scores another branch with `EVAL_HOLDOUT_DIR` pointing at the main clone's `eval/holdout`.

The gate. `score` fails when any of these holds:

- (a) a `human` or `automation` commit is classified `ai`;
- (b) an `ai`-labeled commit that carries a listed AI identity (on `AI_IDENTITIES`, as author, as committer, or in a complete trailer line) is not classified `ai`;
- (c) an `automation`-labeled commit whose author email is a GitHub App noreply address (`<id>+<name>[bot]@users.noreply.github.com`) is not classified `automation`.

Recall per tool over all `ai`-labeled commits is reported, never gated. A listed tool's commit that carries no listed identity (its trailer turned off, or only a message marker) is invisible to email matching, so no change to the list could fix it. Today's analyzer is expected to fail (c), since it detects bots by name only: that is the known failure T17 fixes.

Privacy. Public commits are public, but this repo stores no human name or email (Decisions). In `eval/`, every identity that is not an AI identity and not a bot account is replaced with `Person N <person-N@example.invalid>`, consistently within a commit, in the author, the committer and every trailer of the message. AI identities and bot accounts stay verbatim, because they are what is being tested.

## Done when

- [ ] `pnpm --filter @code-trust/eval test` passes with named tests:
  - every line of every `eval/dev/*.jsonl` file parses with the labeled commit schema, and the set has at least 80 commits: at least 30 `ai` across at least 5 tools (each tool on `AI_IDENTITIES` with at least 3, and each `UNVERIFIED` candidate with at least 2 where a public commit with independent evidence exists), at least 30 `human` including the hard cases (a person named Claude, the VS Code `Co-authored-by: Copilot` trailer from `LEFT_OUT`, "Made with Cursor", GitHub's web committer on a squash merge), and at least 15 `automation` including at least 3 bot commits whose author name does not end in `[bot]` but whose email is a `[bot]@users.noreply.github.com` address.
  - privacy: every email in `eval/dev/` is on `AI_IDENTITIES`, `LEFT_OUT` or `UNVERIFIED`, ends in `[bot]@users.noreply.github.com`, or ends in `@example.invalid`; scan the messages too.
  - every commit has a non-empty `labelEvidence` with a URL.
  - the scorer on a small hand-made set computes the confusion matrix, precision and recall exactly as worked out in the test, and fails the gate for each of (a), (b) and (c) on a set built to trigger only that one, and passes on a set where the only misses are `ai` commits with no listed identity.
  - `score:holdout` with `EVAL_HOLDOUT_DIR` set to a temp directory of labeled commits reads that directory and prints no identity, message or source from them; with it unset and no `eval/holdout`, it exits 0 with a note.
  - `git check-ignore eval/holdout/x.jsonl` succeeds (run from the test through `git`).
  - the gate on `eval/dev`, marked `test.fails` with a comment naming T17, because (c) fails on today's analyzer. If (a) or (b) fails too, stop and ask: that is a matcher bug, not T17's work.
- [ ] `pnpm --filter @code-trust/eval score` runs on the dev set and prints the matrix, precision and recall per tool, the misses by tool, and which of (a), (b) and (c) failed. Show the output: it exits 1 on (c) alone, and the PR lists the commits behind it.
- [ ] `git diff origin/main -- docs/architecture.md` shows a Decisions row for the gate (conditions (a), (b) and (c), recall reported and not gated, independent labels, pseudonymized humans, a gitignored holdout run by the human only) and the Attribution signals sentence about the holdout updated to match.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- Changing `packages/analyzer`, including `identities.ts`: T17 moves candidates and changes bot detection, with this gate as its proof.
- Reading, listing or writing anything in `eval/holdout/` or any directory `EVAL_HOLDOUT_DIR` points at. The guard hook blocks writes; reading is just as off-limits.
- Message markers and PR labels as signals.
- Running `score:holdout`.

## Notes

- Finding commits: `gh api` (search commits by author email or bot login, list an agent's pull requests) gives real public commits. Prefer repositories of the tool's own vendor or with an explicit statement about the workflow. A stranger's commit can be in the dev set if the label's evidence is independent, but it is never a source for `identities.ts` (that rule is T17's).
- Circularity is the trap. "Authored by copilot-swe-agent[bot], so it is AI" is the matcher's own rule. "The pull request that landed it was opened by copilot-swe-agent[bot] and merged by a person" is independent, and it is exactly the squash case the trailer signal must catch.
- `claude[bot]`'s numeric id: `gh api users/claude%5Bbot%5D --jq .id` gives the bot user's id, which is what claude-code-action builds the noreply address from. Use real commits from repositories that run the action.
- Keep the files small and diffable: one JSON object per line, sorted by `source`.
- The package depends on `@code-trust/analyzer` and `@code-trust/shared` only. `pnpm-workspace.yaml` already includes `packages/*`.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/eval test passes with named tests for the dev set's size and composition, privacy, label evidence, the scorer's arithmetic and conditions (a), (b) and (c) each failing the gate on their own, the holdout read from EVAL_HOLDOUT_DIR and printing no commit data, eval/holdout gitignored, the dev-set gate marked test.fails naming T17 for (c) only, pnpm --filter @code-trust/eval score prints the confusion matrix and per-tool precision and recall on eval/dev, eval/README.md defines the labeled commit format and labeling rules for the holdout, docs/architecture.md has the eval gate Decisions row, nothing under eval/holdout was read or written, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
