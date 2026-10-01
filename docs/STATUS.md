# Status

| Task | Title | Wave | Status | Depends on | PR |
| --- | --- | --- | --- | --- | --- |
| T01 | Foundation: monorepo, tooling, CI, FoundationStack | 0 | done | | [#1](https://github.com/wahidbabar/code-trust/pull/1) |
| T02 | Contracts: shared schemas, queue messages, DB schema | 0 | ready | T01 | |
| T03+ | Written by `/plan-wave 1` after T02 merges | 1 | | T02 | |

## Deployed

| Stack | Region | Deployed | Notes |
| --- | --- | --- | --- |
| CDKToolkit | ap-south-1 | 2026-10-02 | CDK bootstrap, created once by the human |
| CodeTrustFoundation | ap-south-1 | 2026-10-02 | Budget alarm and data bucket from T01 |

## Waves

- Wave 0 (serial): T01, then T02.
- Wave 1: analyzer core, ingest (webhook to SQS), API read path. Two lanes at a time.
- Wave 2: worker and dispatcher, dashboard, attribution eval gate.
- Hardening: cost audit, security review, trial on real public repos.
