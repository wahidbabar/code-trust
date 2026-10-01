# Status

| Task | Title | Wave | Status | Depends on | PR |
| --- | --- | --- | --- | --- | --- |
| T01 | Foundation: monorepo, tooling, CI, FoundationStack | 0 | in review | | |
| T02 | Contracts: shared schemas, queue messages, DB schema | 0 | planned | T01 | |
| T03+ | Written by `/plan-wave 1` after T02 merges | 1 | | T02 | |

## Waves

- Wave 0 (serial): T01, then T02.
- Wave 1: analyzer core, ingest (webhook to SQS), API read path. Two lanes at a time.
- Wave 2: worker and dispatcher, dashboard, attribution eval gate.
- Hardening: cost audit, security review, trial on real public repos.
