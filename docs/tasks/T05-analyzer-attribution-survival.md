# T05: Analyzer attribution, survival estimator and `analyzeRepo`

Status: planned
Wave: 1
Depends on: T03 (merged to main before this starts)
Owner paths (edit only these):
- `packages/analyzer/**`
- docs/architecture.md (your rows in Decisions, and the sentence in Attribution signals that says what a trailer matches on)
- `packages/shared/src/domain.ts` (only the comment on `evidence` in `AttributionSchema`)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Metric definitions: Lifetime and censoring, Survival, Cohorts, Attribution signals, Limits. The Decisions rows on attribution evidence and personal data)
- `packages/shared/src/domain.ts`, `packages/shared/src/fixtures.ts`, and the "worked example" block at the end of `packages/shared/src/domain.test.ts` (the estimator as the doc states it)
- `packages/analyzer/src/history/` as T03 merged it. This file describes T03's interface from its task file; where the merged code differs, the code wins.

## Task

Finish the analyzer. T03 produces line lifetimes per commit; this lane decides which cohort each commit belongs to, computes the Kaplan-Meier survival curve per cohort, and joins the three steps into one `analyzeRepo` call whose output is exactly the shared types the database stores. After this the worker (wave 2) only has to clone, call `analyzeRepo` and write the result. Attribution is where personal data could leak and where a false match puts human code in the AI cohort, so both are tested as rules, not as examples.

## Where

- `packages/analyzer/src/attribution/`: `identities.ts` (the list of known AI identities, each with its tool slug and a comment saying where it was seen) and `attribute.ts`.
- `packages/analyzer/src/survival/`: `estimate.ts`.
- `packages/analyzer/src/analyze.ts` and `packages/analyzer/src/cli.ts`, exported from `src/index.ts`, with an `analyze` script in `package.json`.

The interface. The worker lane is written against `analyzeRepo`, so keep its names and shapes:

```ts
import type {
  Attribution, Cohort, Commit, IsoTimestamp, SurvivalCurvePoint, SurvivalMetric, SurvivalObservation,
} from '@code-trust/shared';
import type { HistoryCommit } from './history/types.ts';

export interface CommitAttribution {
  cohort: Cohort;
  /** Empty unless the cohort is `ai`. At most one entry per (signal, tool). */
  attributions: Pick<Attribution, 'signal' | 'tool' | 'confidence' | 'evidence'>[];
}

/** Pure: reads the identities and the message, and nothing else. */
export function attributeCommit(commit: Pick<HistoryCommit, 'author' | 'committer' | 'message'>): CommitAttribution;

export type SurvivalEstimate = Pick<
  SurvivalMetric,
  'linesTotal' | 'linesRemoved' | 'linesCensored' | 'survival30d' | 'survival90d' | 'survival180d'
> & { points: SurvivalCurvePoint[] };

/** One cohort's observations in, its numbers out. Null when the cohort has no lines. */
export function estimateSurvival(
  observations: readonly Pick<SurvivalObservation, 'lineCount' | 'introducedAt' | 'removedAt'>[],
  observedAt: IsoTimestamp,
): SurvivalEstimate | null;

export interface AnalyzeOptions {
  repoDir: string;
  /** GitHub's repository id. */
  repoId: number;
  /** A commit SHA or ref. Defaults to HEAD. */
  head?: string;
  /** When the caller fetched the head: the censoring time for lines still alive. */
  observedAt: IsoTimestamp;
}

export interface RepoAnalysis {
  /** What `setRepoHead` takes. */
  head: { headSha: string; headCommittedAt: IsoTimestamp; observedAt: IsoTimestamp };
  commits: Commit[];
  attributions: Attribution[];
  observations: SurvivalObservation[];
  /** One per measured cohort that has lines. The shape `upsertSurvivalRollup` takes. */
  rollups: { metric: SurvivalMetric; points: SurvivalCurvePoint[] }[];
}

export function analyzeRepo(options: AnalyzeOptions): Promise<RepoAnalysis>;
```

Rules, from the Metric definitions:

1. Cohort. `ai` when the commit has an attribution with confidence at or above `AI_CONFIDENCE_THRESHOLD`. Otherwise `automation` when the author's name ends in `[bot]`. Otherwise `human`.
2. `co_author_trailer`: a line of the message that, once trimmed, is a complete `Co-Authored-By: Name <email>` trailer (key in any case, at least one space after the colon) whose email is on the list. Leading whitespace is allowed because `git merge --squash` indents every squashed message by four spaces.
3. `author_identity`: the author's or the committer's email is on the list.
4. Both signals match on the email alone: exact, without regard to case, with confidence 1. A name never matches by itself, so a person named Claude cannot land in `ai`, and nothing matches by substring or pattern.
5. Evidence is built from the matched list entry, not copied from the commit: `Co-Authored-By: <entry name> <entry email>` for a trailer, `<entry name> <entry email>` for an identity. Every stored identity is then on the list by construction, and none is too long. Update the comment on `evidence` in `packages/shared/src/domain.ts` to match.
6. Lifetime `T = floor((end - introducedAt) / 86400 s)` with `end` the removal time or `observedAt`, and a negative value counted as 0.
7. Curve points: one at day 0, then one at every day `k` where `S(k)` or `n_k` differs from the day before, while `n_k > 0`. A curve that reaches 0 gets one more point, on the first day where `S(k)` is 0 (nothing is at risk there), and ends on it. Any other curve ends with a point on the last day that has lines at risk. `survival30d`, `survival90d` and `survival180d` are `S` at those days: null when nothing is at risk that day and `S` has not reached 0.
8. In `analyzeRepo`, an observation's `introducedAt` is the introducing commit's `landedAt`, and `removedAt` is the removing commit's `committedAt`. Automation lines keep their observations and get no rollup.

## Done when

- [ ] `pnpm --filter @code-trust/analyzer test` passes, T03's tests included and unchanged, with named tests for:
  - attribution, one per case: an AI trailer in each casing of the key; the trailers this repo's own commits carry (`Claude <noreply@anthropic.com>` and `Claude Opus 5.5 (1M context) <noreply@anthropic.com>`) map to tool `claude`; an AI agent as author; an AI agent as committer only; a commit with both signals yields both attributions; two trailers for the same tool yield one attribution.
  - no false match: a human co-author named `Claude Dupont`, one named exactly `Claude` with their own email, an email that only contains a listed one (`noreply@anthropic.com.example.org`), the words "Co-Authored-By: Claude" inside a sentence of the message body, and GitHub's web committer (`GitHub <noreply@github.com>`) all stay `human`.
  - cohorts: `dependabot[bot]` and `renovate[bot]` are `automation`; a listed AI agent whose name ends in `[bot]` is `ai`; a bot commit with an AI trailer is `ai`.
  - a squash merge message that carries an AI trailer in the middle of its body, between the squashed commits' messages, is `ai`, both as GitHub writes it and as `git merge --squash` writes it (indented by four spaces).
  - evidence: a commit with an AI trailer and a human co-author trailer yields evidence that holds the AI entry only; an AI trailer whose name is a person's, or too long for `EVIDENCE_MAX_LENGTH`, still puts the commit in `ai` with the list entry as evidence.
  - the rule the Decisions table asks this lane to prove: over a seeded random mix of commits with human and AI authors, committers and trailers, every attribution passes `AttributionSchema`, every evidence identity is on the AI list, and no human name or email from the input appears anywhere in the output.
  - survival, against the shared fixtures: `survivalObservationFixtures` at `OBSERVED_AT` gives the counts and horizons of `survivalMetricFixture` and the points of `survivalCurveFixture` (days and `atRisk` exact, survival within 1e-12); `revertedObservationFixtures` gives `revertedSurvivalMetricFixture` and `revertedSurvivalCurveFixture` with survival exactly 0.
  - survival edges: no observations returns null; a removal time before the introduction counts as day 0; a cohort whose every line is alive has survival 1 on every point, ends on its oldest line's day and is null past it; 0 and null are never confused at a horizon.
  - survival as a rule: over seeded random observations, the output passes `SurvivalCurvePointsSchema`, the counts add up, and the curve agrees at every point and every horizon with the day-by-day estimator in `packages/shared/src/domain.test.ts`, copied into the test as the reference.
  - `analyzeRepo` on a scripted repo (T03's `testing.ts`) with AI, human and dependabot commits and a removal some days later: the metrics equal numbers worked out by hand in the test; every array passes its shared schema; every SHA in `observations` and `attributions` is in `commits`; no two observations share `(introducedBy, removedBy)`; rollups exist only for measured cohorts with lines; `head` matches the repo; two runs with the same `observedAt` are deeply equal.
- [ ] `git diff origin/main -- docs/architecture.md` shows Decisions rows for trailers counting anywhere in the message, for matching on the email alone, and for evidence built from the list, and Attribution signals says a trailer matches on its email.
- [ ] `pnpm --filter @code-trust/analyzer analyze "$PWD"`, run from the repo root, exits 0 on this repository and prints, per cohort, the number of commits, the line counts and the three horizons, then the SHA of every commit outside `ai`. The `ai` cohort has lines. For each SHA it lists outside `ai`, `git log -1 --format=%B <sha>` is shown and carries no AI trailer.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- Changing the walker's behavior or its tests. A bug found in T03's code is reported, and fixed here only if it blocks a Done when item.
- Commit message markers and PR labels as signals. They wait for the eval gate (wave 2), as does anything with confidence below 1.
- Storing results, cloning, GitHub API calls, AWS. The worker lane does those.
- Confidence intervals, incremental analysis.
- `packages/shared` apart from the one comment in Owner paths, `packages/db`, `apps/**`. The analyzer depends on `@code-trust/shared` only. If the contract seems wrong, stop and ask.

## Notes

- The identity list is the product's precision. Add an identity only when you can point to a real public commit or the tool's own documentation, and put that source in a comment beside the entry. A missing tool costs recall, which the eval gate will measure. A wrong entry puts human code in the AI cohort, which nothing catches. Entries are keyed by email, and the display name only goes into evidence: Claude Code writes many names (`Claude`, `Claude Opus 5.5 (1M context)`) over one email, and a name alone proves nothing.
- Known from this repo and the shared fixtures: trailer email `noreply@anthropic.com` (tool `claude`), and the agent author `copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>` (tool `copilot`). Candidates to verify before adding: Copilot's co-author trailer, Cursor's agent identity, Devin's and Jules's bot accounts, aider's and OpenHands's trailers.
- Parse trailers from the message text, so `attributeCommit` stays pure. Git itself only reads trailers from the last paragraph, but a squash merge's message carries the squashed commits' trailers in the middle of the body, and squash repos are common. So a complete trailer line counts wherever it sits, and a mention inside a sentence does not. Record that as a Decisions row.
- Floating point: `0.8 * 0.8` is `0.6400000000000001`. Do not round a small positive survival to 0. The schema requires `survival === 0` exactly when `atRisk === 0`, and 0 means every line was removed.
- `SurvivalMetric.observedAt` and `headSha` in each rollup are the same values as in `head`.
- Timestamps in the output must pass `IsoTimestampSchema` (UTC, milliseconds). T03 already emits that format.
- `analyzeRepo` does not import `@code-trust/db`. `RepoAnalysis` matches the db module's `RepoHead` and `SurvivalRollup` by shape, and the worker lane proves the round trip through Postgres.
- By the time this starts, main may have merge commits from pull requests. A merge commit made in GitHub's UI has no AI trailer, so it is `human`, and it owns lines only where a conflict was resolved in it.
- T06 may run in parallel. If your PR conflicts with main in docs/STATUS.md or the Decisions table, rebase and keep both sides' rows.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/analyzer test passes with T03's tests unchanged and a named test for every attribution, survival and analyzeRepo case in the task's Done when list, pnpm --filter @code-trust/analyzer analyze "$PWD" exits 0 on this repository and shows an ai cohort with lines, with git log -1 shown for every commit it lists outside ai, docs/architecture.md has the Decisions rows on where trailers count, email-only matching and evidence built from the list, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
