---
name: plan-wave
description: Plans the next wave of parallel lanes for code-trust by writing one task file per lane in docs/tasks/. Use when the user asks to plan a wave or the next tasks.
disable-model-invocation: true
---

Plan wave $ARGUMENTS for code-trust. You write the prompts other agents will run, so precision here pays off in every lane.

1. Read docs/architecture.md, docs/STATUS.md, docs/tasks/_TEMPLATE.md and the finished task files. Then read the merged code the wave builds on, starting with `packages/shared`.
2. Choose the lanes from the Build order in docs/architecture.md. Every lane must:
   - own a set of paths no other lane in the wave touches,
   - depend only on work already merged to main,
   - fit in one session of about 20 turns. Split anything bigger.
3. Contracts first. If two lanes need a type or schema that doesn't exist yet, add a small serial task that creates it before the wave, instead of letting both lanes invent one.
4. Write each lane as `docs/tasks/Tnn-<slug>.md` from the template. Every "Done when" item must be provable by a command. Build the Goal line from those items and end it with "or stop after N turns" (N at most 20).
5. Add the new tasks to docs/STATUS.md as planned, with their dependencies.
6. Reply with a table: task, owner paths, depends on, main risk. Then stop. Don't implement anything.

Budget: Claude Pro. At most 2 lanes run at the same time, so order the wave so the 2 most valuable lanes can start first.
