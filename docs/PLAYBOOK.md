# Playbook

How code-trust gets built: Claude Code agents running in Conductor, steered by one human. This file is the human side of the loop.

## The shape of it

- You own two chokepoints: approving each task's plan, and merging PRs. Agents do everything in between.
- Work lives in task files in docs/tasks/, never only in chat. Each one has Task, Where, Done when, Out of scope, Notes and a Goal line.
- Verification is automatic. A Stop hook runs `pnpm verify:changed` and won't let an agent finish while it fails. After 3 retries it hands back to you. CI runs `pnpm verify` on every PR.
- Guardrails are hooks, not requests. Agents can't deploy, push to main, merge, read secrets, or edit golden data, the eval holdout or the harness. Hooks run in every permission mode, so they hold even with prompts turned off.
- Budget: Claude Pro. At most 2 agents work at once, loops have turn caps, and ultracode and agent teams are rare, deliberate experiments.

## Where the AI prompts itself

1. `/plan-wave` reads the architecture and the merged code, then writes the next task files, Goal lines included. Reviewing them is the highest-leverage ten minutes in the project, because every lane inherits their mistakes.
2. `/goal` turns a Goal line into a loop. After every turn a small model checks the condition, and if it isn't met, its reason becomes the agent's next instruction.
3. The Stop hook feeds failing test output back as the next instruction.
4. The reviewer subagent reads the diff cold, without the reasoning that produced it, and its findings become fixes.

## One-time setup

Run these on the Mac, in Terminal.

1. Check the tools Conductor relies on:
   ```bash
   gh auth status                      # must say you're logged in to github.com
   claude --version                    # Claude Code is installed
   echo "${ANTHROPIC_API_KEY:-unset}"  # must print "unset", otherwise Claude Code bills the API instead of your Pro plan
   ```
   If `gh` is missing: `brew install gh && gh auth login`.
2. Make the first commit and the GitHub repo. The trailer marks this commit as AI-written, because it was, which makes it code-trust's first data point:
   ```bash
   cd ~/grind/code-trust
   git add -A
   git commit -m "chore: agent harness for Claude Code and Conductor" --trailer "Co-Authored-By: Claude <noreply@anthropic.com>"
   gh repo create code-trust --public --source=. --remote=origin --push
   ```
3. In Conductor, choose **Open project** and pick `~/grind/code-trust`. Conductor reads `.conductor/settings.toml`, so every new workspace installs dependencies and gets its own database.
4. Start OrbStack before T02. The setup script creates one Postgres container, `code-trust-pg`, and one database per workspace inside it.
5. When you have real values, copy `.env.example` to `.env` at the repo root. Conductor copies `.env` into each new workspace, and agents can't read it.
6. Optional, recommended: TypeScript code intelligence, so Claude sees type errors right after each edit.
   ```bash
   npm install -g typescript-language-server typescript
   ```
   Then in a Claude Code session: `/plugin install typescript-lsp@claude-plugins-official`.
7. Optional, later: run `/install-github-app` in Claude Code inside the repo and choose the subscription token, so `@claude` works on PRs. On Pro, mention it when you want a review instead of reviewing every push.

## Run a lane

1. In Conductor, create a new workspace for code-trust. It gets its own branch and worktree, and the setup script runs.
2. Turn on Plan Mode and send: `Execute @docs/tasks/T01-foundation.md. Plan first.`
3. Read the plan. Push back or edit it. Catching a wrong approach here is far cheaper than after the code exists.
4. Approve, then paste the task's Goal line. The agent loops until the condition holds or the turn cap hits. If Conductor's chat doesn't accept `/goal`, paste the same text without `/goal` and add "keep going until every item holds"; the Stop hook still gates the finish.
5. When it stops, open the diff with ⌘⇧D and skim it, then send `/ship-lane docs/tasks/T01-foundation.md`. That verifies, runs the reviewer subagent, updates status and opens the PR.
6. Watch CI in the Checks tab. Merge when it's green and the diff makes sense, then archive the workspace. Archiving drops its database.
7. If GitHub says the PR has conflicts because another lane merged first, send in that lane's workspace: `Rebase on main and push.` CLAUDE.md has the steps. The guard lets an agent rewrite only its own branch, and only with `--force-with-lease`.
8. If a lane goes sideways, press Esc twice to rewind, or archive it and start fresh with a sharper task file. A clean context with a better prompt beats a long session full of corrections.

## Phases

1. **Wave 0, serial:** T01 foundation, then T02 contracts. One workspace at a time, because everything after depends on them.
2. **Plan wave 1:** in a fresh workspace send `/plan-wave 1`. Review the task files it writes, merge them, then start the first 2 lanes in 2 workspaces.
3. **Wave 1:** analyzer core, ingest, API read path. When a lane merges, start the next. A lane that depends on another (T05 on T03) gets its workspace only after that one has merged, so its branch starts from a main that has the code.
4. **Wave 2:** `/plan-wave 2`, then worker and dispatcher, dashboard, attribution eval gate.
5. **Hardening:** one deliberate ultracode run, for example `ultracode: audit infra/ against the Cost rules in docs/architecture.md, cross-check each finding`, plus a security review and a trial on real public repos. On Pro, turn dynamic workflows on in `/config` first and keep the size small.

## Deploys (human only)

After a PR that touches `infra/` merges, from `~/grind/code-trust` on main:

```bash
cd ~/grind/code-trust
git pull && pnpm install
aws login                                   # temporary session, up to 12 hours
export ALERT_EMAIL=you@example.com          # budget alert inbox, never committed
cd infra
pnpm exec cdk deploy CodeTrustFoundation    # or the stack the PR added
aws logout                                  # agents never find a live AWS session
```

`cdk bootstrap` is a one-time step per account and region, already done for `ap-south-1` on 2026-10-02. The README's Deploy section has the same commands. Agents can't run any of these; the guard hook blocks them. Record each deploy in the Deployed table in docs/STATUS.md.

## Loops: which tool for which job

| Job | Tool | Why |
| --- | --- | --- |
| Finish a task | `/goal` with the task's Goal line | A separate model judges the condition after every turn |
| Don't stop while broken | Stop hook (always on) | Deterministic, and costs nothing while checks pass |
| Babysit a PR's CI | `/loop 15m check CI on this branch's PR and fix failures` | Polls on a timer. Stop it once CI is green |
| Second opinion | reviewer subagent, via `/ship-lane` | Fresh context, not grading its own work |
| Writer and reviewer side by side | a second tab in the same Conductor workspace | Conductor's pattern for shared work on one branch |
| Big audit, rarely | ultracode workflow | Many agents cross-checking each other. Expensive |

## Pro budget rules

- Two active lanes at most. A third one waits.
- Plan Mode for changes touching 3 or more files; skip it for one-line fixes.
- New workspace, or `/clear`, between tasks. After two failed corrections, restart with a better prompt.
- Start long `/goal` runs before a break, not while you're waiting on them.
- Ask for reviews when you want them rather than on every push.

## When something goes wrong

- **A hook blocked something legitimate.** Read the message. For an intended change to goldens or to the harness, create `.context/allow-golden` or `.context/allow-harness` in that workspace yourself. Agents can't create these files.
- **The Stop hook handed back after 3 retries.** The agent is stuck. Read the failure, sharpen the task, or take over.
- **Setup script failed.** Conductor shows the log. Usually OrbStack isn't running or `pnpm install` failed. Start OrbStack and run `bash scripts/conductor/setup.sh` in the workspace's terminal.
- **Postgres still running after archiving.** Expected: `code-trust-pg` is shared by every workspace, and archiving only drops that workspace's database. Stop it when you're not working with the stop button in OrbStack or `docker stop code-trust-pg`; the next workspace setup starts it again. Don't delete the container unless you mean to wipe every local database.
- **Usage limit hit.** Wait for the reset. The task file and the branch hold the state, so a fresh session can pick up where the last one stopped.
