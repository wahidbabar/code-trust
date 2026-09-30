# Tnn: Title

Status: planned | ready | in progress | in review | done
Wave: 0 (serial) | 1 | 2 | hardening
Depends on: T01, T02
Owner paths (edit only these):
- `packages/example/**`
Read first:
- docs/architecture.md (the sections this task relies on)

## Task

What to build and why it matters, in three to six sentences.

## Where

Files and folders to create or change. Interfaces this task implements or consumes, with their paths.

## Done when

Every item is provable by a command whose output the agent shows.

- [ ] `pnpm --filter example test` passes, including new tests for ...
- [ ] `pnpm verify:changed` exits 0

## Out of scope

- What this task must not do, especially anything another lane owns.

## Notes

Gotchas, decisions already made, links.

## Goal line

Paste into the workspace after approving the plan:

```
/goal <condition built from Done when>; show each command and its output; only files under the owner paths changed; or stop after 20 turns
```
