---
name: ship-lane
description: Finishes the current lane of code-trust by verifying, getting an independent review, updating status, committing and opening a PR. Use when a task's implementation is complete.
disable-model-invocation: true
---

Ship the lane for task file $ARGUMENTS. If no task file was given, find the one this branch implements, and ask if it's ambiguous.

1. If the current branch is `main`, stop and say so.
2. Run `pnpm verify:changed` and fix what fails. Show the output.
3. Walk the task's "Done when" list. For each item show the command you ran and its output.
4. Use the reviewer subagent on this diff with the task file. If `infra/` changed, also use the cost-guard subagent. Fix blocking findings only, then re-run step 2 if you changed code.
5. Set the task file's Status to "in review" and update its row in docs/STATUS.md.
6. Commit with a conventional message. Keep the default `Co-Authored-By` trailer.
7. Push with `git push -u origin HEAD` and open a PR with `gh pr create`. The body has: summary, the Done-when evidence, the reviewer's verdict, and anything left for the human (deploy steps, follow-ups).

Never merge and never deploy.
