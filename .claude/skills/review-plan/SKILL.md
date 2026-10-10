---
name: review-plan
description: Reviews a code-trust lane's plan, a finished lane's summary, or a PR, as an independent second opinion before the human approves or merges. Use when the user asks to review a plan, a lane summary or a PR.
disable-model-invocation: true
---

Review $ARGUMENTS for code-trust as an independent reviewer. You did not write it, and you change nothing: no edits, no commits, no pushes, no deploys.

What to review: the plan or lane summary the human pasted. If they pasted nothing, read the newest file in `~/.claude/plans/`. For a PR number, use `gh pr view` and `gh pr diff`, and check it against `origin/main` with `git merge-tree --write-tree origin/main <branch>` (it reports conflicts without touching any checkout).

1. Read CLAUDE.md, docs/architecture.md (Decisions and Cost rules), docs/STATUS.md and the task file being implemented. Then read the merged code it builds on. Check every claim about existing code against the code, and every claim about an outside tool or service (AWS, CDK, Neon, GitHub, Kysely, zod, Nest) against its docs or source. Say which claims you checked and how.
2. Look hardest at:
   - how it meets other lanes and what is already deployed: contracts, write order, queues, retries, the skip and FIFO rules, shared files such as STATUS.md, the Decisions table and the lockfile;
   - failure paths: a retry, a timeout, a partial write, a redelivery, a cold start;
   - whether each Done-when item is proven by a test or command that can actually fail, with timing margins wide enough for CI;
   - the $0 idle cost rules, secrets in logs, errors and responses, the owner paths, and every step the human must do after merge;
   - mistakes in the task file itself: say what is wrong and which file should change.
3. Report findings, not a summary of the plan:
   - Verdict: approve, approve with changes, or rework.
   - Required changes, most important first, each with its reason in one or two sentences.
   - Optional suggestions, marked as optional.
   - A block the human can paste into the lane's session: "Approved as written. Go ahead." or "Approved, with N changes: ...". If an approved change widens the lane's files, give the task's Goal line with that file added to its scope clause.
4. If something needs a decision only the human can make, end with that one question.

Keep it short. No em dashes.
