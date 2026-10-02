# Status

| Task | Title | Wave | Status | Depends on | PR |
| --- | --- | --- | --- | --- | --- |
| T01 | Foundation: monorepo, tooling, CI, FoundationStack | 0 | done | | [#1](https://github.com/wahidbabar/code-trust/pull/1) |
| T02 | Contracts: shared schemas, queue messages, DB schema | 0 | done | T01 | [#2](https://github.com/wahidbabar/code-trust/pull/2) |
| T03 | Analyzer: history walker (line lifetimes from git) | 1 | planned | T02 | |
| T04 | Ingest: GitHub webhook to SQS, IngestStack | 1 | planned | T01, T02 | |
| T05 | Analyzer: attribution, survival estimator, `analyzeRepo` | 1 | planned | T03 | |
| T06 | API read path (NestJS REST, local server) | 1 | planned | T02 | |

## Deployed

| Stack | Region | Deployed | Notes |
| --- | --- | --- | --- |
| CDKToolkit | ap-south-1 | 2026-10-02 | CDK bootstrap, created once by the human |
| CodeTrustFoundation | ap-south-1 | 2026-10-02 | Budget alarm and data bucket from T01 |

## Waves

- Wave 0 (serial): T01, then T02.
- Wave 1: analyzer core (T03, then T05), ingest (T04), API read path (T06). Two lanes at a time: T03 and T04 start first. T05 starts once T03 has merged, since both own `packages/analyzer`. T06 takes whichever slot frees first.
- Wave 2: worker and dispatcher, dashboard, attribution eval gate. Also the API on Lambda (handler, Neon driver, `ApiStack`), which T06 leaves out until T04 has settled the front door. And deleting a repo's data when it turns private or the App is uninstalled, since the read API is public.
- Hardening: cost audit, security review, trial on real public repos.
