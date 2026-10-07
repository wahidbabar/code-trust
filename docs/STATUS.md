# Status

| Task | Title | Wave | Status | Depends on | PR |
| --- | --- | --- | --- | --- | --- |
| T01 | Foundation: monorepo, tooling, CI, FoundationStack | 0 | done | | [#1](https://github.com/wahidbabar/code-trust/pull/1) |
| T02 | Contracts: shared schemas, queue messages, DB schema | 0 | done | T01 | [#2](https://github.com/wahidbabar/code-trust/pull/2) |
| T03 | Analyzer: history walker (line lifetimes from git) | 1 | done | T02 | [#5](https://github.com/wahidbabar/code-trust/pull/5) |
| T04 | Ingest: GitHub webhook to SQS, IngestStack | 1 | done | T01, T02 | [#4](https://github.com/wahidbabar/code-trust/pull/4) |
| T05 | Analyzer: attribution, survival estimator, `analyzeRepo` | 1 | done | T03 | [#7](https://github.com/wahidbabar/code-trust/pull/7) |
| T06 | API read path (NestJS REST, local server) | 1 | done | T02 | [#6](https://github.com/wahidbabar/code-trust/pull/6) |
| T07 | Queue contracts: job messages, repo removal events | 2 (serial) | in review | T02 | [#9](https://github.com/wahidbabar/code-trust/pull/9) |
| T08 | Database access from Lambda: Neon dialect, bundle-safe entry, prune queries | 2 (serial) | in review | T02 | [#10](https://github.com/wahidbabar/code-trust/pull/10) |
| T09 | Worker job runner: clone, analyze, write; delete | 2 | in review | T07, T08 | [#12](https://github.com/wahidbabar/code-trust/pull/12) |
| T10 | API on Lambda: handler, Neon, `ApiStack`, CORS | 2 | planned | T06, T08 | |
| T11 | Git for the Lambda runtime: layer from AL2023 packages | 2 | in review | T01 | [#11](https://github.com/wahidbabar/code-trust/pull/11) |
| T12 | Dispatcher: events queue to the FIFO jobs queue | 2 | planned | T04, T07 | |
| T13 | `WorkerStack`: FIFO jobs queue, dispatcher and worker on Lambda | 2 | planned | T09, T10, T11, T12 | |
| T14 | Repo removal events: private, deleted, uninstalled | 2 | planned | T04, T07 | |
| T15 | Dashboard on GitHub Pages | 2 | planned | T06 | |
| T16 | Attribution eval gate: labeled commits, scorer, holdout format | 2 | planned | T05 | |
| T17 | Attribution: unverified candidates, bots by email | 2 | planned | T16 | |

## Deployed

| Stack | Region | Deployed | Notes |
| --- | --- | --- | --- |
| CDKToolkit | ap-south-1 | 2026-10-02 | CDK bootstrap, created once by the human |
| CodeTrustFoundation | ap-south-1 | 2026-10-02 | Budget alarm and data bucket from T01 |
| CodeTrustIngest | ap-south-1 | 2026-10-03 | Webhook Lambda and events queue from T04 |

## Waves

- Wave 0 (serial): T01, then T02.
- Wave 1: analyzer core (T03, then T05), ingest (T04), API read path (T06). Two lanes at a time: T03 and T04 start first. T05 starts once T03 has merged, since both own `packages/analyzer`. T06 takes whichever slot frees first.
- Wave 2: two lanes at a time, in two slots. Each lane starts from a main that has every task it depends on.
  - Slot A: T08 (database, serial), then T09 (worker runner), T12 (dispatcher), T13 (`WorkerStack`).
  - Slot B: T07 (queue contracts, serial and small), then T11 (git layer, the biggest unknown, needs nothing new), T10 (API on Lambda, once T08 has merged), T14 (removal events), T15 (dashboard), T16 (eval gate), T17 (attribution).
  - T09 and T10 are the two most valuable lanes: T09 starts the moment T08 merges, and T10 takes the next slot that frees. While T08 runs, slot B spends the time on T07 and then T11, which need nothing from T08. T13 starts only after T09, T10, T11 and T12 have all merged. Once slot A finishes T13, it takes the next ready task from slot B's list.
  - Human steps along the way:
    - Now: pin the Neon compute to 0.25 CU. The free plan has 100 CU-hours a month and suspends after 5 idle minutes.
    - After T08: run `smoke:neon` with the URL from SSM (`packages/db/README.md`), before `CodeTrustWorker` is deployed.
    - After T10: deploy `CodeTrustApi`, then run the two curl checks that end the Deploy section of `apps/api/README.md`.
    - After T14: redeploy `CodeTrustIngest`, then subscribe the App to Repository events, in that order. Deploying `CodeTrustWorker` deploys `CodeTrustIngest` as a dependency, so when T14 has merged before `CodeTrustWorker` is deployed, one deploy covers both.
    - After T13: the concurrency and memory check at the top of the Deploy section in `apps/worker/README.md`, then build the git layer and deploy `CodeTrustWorker`.
    - After T15 and the API deploy: enable Pages with source "GitHub Actions" and set the `API_URL` repository variable.
    - After T16: build the holdout in the main clone's `eval/holdout/` from `eval/README.md` (it is gitignored), before T17's PR.
    - On T17's PR: score the branch on the holdout with `EVAL_HOLDOUT_DIR` pointing at the main clone, and paste the aggregates.
- Hardening: cost audit, security review, trial on real public repos.
