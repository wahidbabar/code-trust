# T03: Analyzer history walker (line lifetimes from git)

Status: planned
Wave: 1
Depends on: T02
Owner paths (edit only these):
- `packages/analyzer/**`
- docs/architecture.md (your rows in Decisions, and the "Files left out of the metric" row in Open decisions)
- `pnpm-lock.yaml` (through `pnpm install` only)
Read first:
- docs/architecture.md (Metric definitions: What is measured, Lifetime and censoring, Limits. Open decisions)
- `packages/shared/src/domain.ts` (`CommitSha`, `IsoTimestamp`, `SurvivalObservation`)
- `packages/db/migrations/0001_init.sql` (the keys your output has to fit)

## Task

Build the part of the analyzer that turns a local git repository into line lifetimes: for every measured line, which commit introduced it, and which mainline commit removed it or that it is still alive at the head. This is the measurement itself. Everything else in the product stores, summarizes or displays what this produces, so a wrong lifetime here is wrong everywhere. Attribution and the survival estimator are T05, which builds on the interface below, so that interface is fixed. This lane also settles which files are left out of the metric.

## Where

- `packages/analyzer/src/history/`: the walker. A workable split: `git.ts` (run git, stream its output), `log-parser.ts` (commit records and `-U0` hunks), `tracker.ts` (line records per file), `measured-paths.ts` (the rule for files left out), `walk.ts`, `types.ts`, `cli.ts`, `testing.ts` (scripted repos).
- `packages/analyzer/src/index.ts`: export `walkHistory` and the types below. Keep `PACKAGE_NAME` exported: `apps/worker/src/index.test.ts` imports it, and that file is not yours.
- `packages/analyzer/package.json`: `@code-trust/shared` as a dependency, and a `walk` script.

The exported interface. T05 is written against it, so keep the names and shapes:

```ts
import type { CommitSha, IsoTimestamp } from '@code-trust/shared';

export interface GitIdentity {
  name: string;
  email: string;
}

/** A commit as git records it. Identities and the message stay in memory: attribution reads them, nothing stores them. */
export interface HistoryCommit {
  sha: CommitSha;
  authoredAt: IsoTimestamp;
  committedAt: IsoTimestamp;
  /** Committer date of the mainline commit that brought this commit in. Equals committedAt for a mainline commit. */
  landedAt: IsoTimestamp;
  author: GitIdentity;
  committer: GitIdentity;
  /** The whole commit message, trailers included. */
  message: string;
}

/** Lines that share an introducing commit and a fate. */
export interface LineGroup {
  introducedBy: CommitSha;
  /** The mainline commit that removed the lines. Null while they are alive at the head. */
  removedBy: CommitSha | null;
  lineCount: number;
}

export interface HistoryResult {
  headSha: CommitSha;
  headCommittedAt: IsoTimestamp;
  /** Exactly the commits that `groups` refers to, ordered by landedAt, then sha. */
  commits: HistoryCommit[];
  /** At most one group per (introducedBy, removedBy), in a stable order. */
  groups: LineGroup[];
}

export interface WalkOptions {
  /** A local clone with the full history of the branch to analyze. */
  repoDir: string;
  /** A commit SHA or ref. Defaults to HEAD. */
  head?: string;
}

export function walkHistory(options: WalkOptions): Promise<HistoryResult>;
```

`WalkOptions` may grow an optional field for the files-left-out rule. Nothing else in the interface changes without asking.

The Metric definitions, made operational:

1. The mainline is the first-parent chain from the head back to the root. Each mainline commit `M` is diffed against its first parent `P` (the root against the empty tree), ignoring whitespace changes and following renames. No copy detection and no move detection: a moved line is a removed line plus a new one.
2. A line is a non-blank line of a text file. Empty and whitespace-only lines are never counted. Binary files (git's verdict), symlinks and submodules have no lines.
3. A line the diff adds in `M` is introduced by `M` when `M` has one parent. When `M` is a merge, the introducing commit is the one `git blame -w` names for that line at `M`. If blame names a commit that `M` did not bring in (one outside `P..M`), the line belongs to `M`. So every commit has exactly one `landedAt`: the committer date of the first mainline commit that contains it.
4. A line the diff removes in `M` is removed by `M`, also when `M` is a merge and a branch commit did the deleting.
5. Timestamps are git's author and committer dates as UTC ISO strings with milliseconds (`.000Z`). Report them as git has them, including committer dates that run backwards along the mainline. T05 handles negative lifetimes.
6. A shallow clone is refused with an error that says so. Behind a shallow boundary every old line would look like it was introduced by the boundary commit.

## Done when

- [ ] `pnpm --filter @code-trust/analyzer test` passes. The tests build real repositories in temp directories with fixed author and committer dates, and there is a named test for each of these:
  - linear history: lines added, edited and deleted. An edited line ends, and a new line starts that belongs to the editing commit.
  - a whitespace-only edit (re-indent, trailing spaces, CRLF to LF) keeps the line and its introducing commit.
  - blank and whitespace-only lines are never counted.
  - a pure rename keeps every line. A rename with edits ends only the edited lines.
  - a block moved inside a file, and one moved to another file, ends in the old place and starts new lines that belong to the moving commit.
  - a deleted file ends all of its lines. The same path created again starts new lines.
  - binary files, symlinks and submodules contribute nothing.
  - a `--no-ff` merge of a branch with two commits: each line belongs to the branch commit that wrote it, both commits have the merge's committer date as `landedAt`, and a line added and removed inside the branch appears nowhere.
  - a line changed in the merge commit itself (a conflict resolution) belongs to the merge commit.
  - a squash merge: the lines belong to the squash commit.
  - lines deleted on a branch are removed by the merge commit that lands the deletion.
  - a file with no trailing newline, a file whose content looks like diff output (lines starting with `@@`, `+++` and `diff --git`), and a commit message that contains diff text.
  - paths with spaces and non-ASCII characters.
  - files left out by the rule contribute nothing. A file renamed from a left-out path to a measured one starts fresh lines that belong to the renaming commit, and the reverse ends them.
  - `head` set to an older commit ignores everything after it.
  - a shallow clone, and a directory that is not a git repository, each fail with an error that names the cause.
- [ ] One helper asserts these invariants and runs on every scripted repo above: the alive total (groups with `removedBy` null) equals the number of non-blank lines in measured text files at the head, counted from the blobs without the tracker; no two groups share `(introducedBy, removedBy)`; `commits` is exactly the set of SHAs the groups refer to; every `removedBy` is on the mainline; two runs return deeply equal results.
- [ ] A type test (`expectTypeOf`) pins `walkHistory`, `HistoryResult`, `HistoryCommit` and `LineGroup` to the interface above.
- [ ] `pnpm --filter @code-trust/analyzer walk "$PWD" --check`, run from the repo root, exits 0 on this repository. It prints the head, the number of mainline commits (equal to `git rev-list --count --first-parent HEAD`, shown next to it), alive lines, removed lines and the lines left out per rule. `--check` recounts the alive lines per file from the blobs at the head and exits non-zero on any difference. It also prints the share of alive lines whose introducing commit matches `git blame -w` at the head, and up to 10 lines that differ.
- [ ] `git diff origin/main -- docs/architecture.md` shows a Decisions row for the files left out of the metric, and the Open decisions row gone or narrowed to what is still open.
- [ ] `pnpm verify:changed` exits 0.

## Out of scope

- Attribution, cohorts, the survival estimator and `analyzeRepo` (T05). This lane never decides who wrote a line, only which commit did.
- Cloning, GitHub API calls, the database, AWS. The input is a directory that already exists.
- Incremental walks and caching between runs. Every run walks from the root.
- `packages/shared`, `packages/db`, `apps/**`. If the contract seems wrong or incomplete, stop and ask.
- New golden files. `__golden__/` is protected and the guard hook blocks writes to it, so expected values live inline in the tests.

## Notes

- This repository is the first real dataset: 20 commits, all on a linear mainline, and `pnpm-lock.yaml` is 1487 of its 6458 lines. That lockfile is the case for leaving files out. A fixed path list (lock files, vendored directories, minified and generated output) is enough to decide now. `.gitattributes` `linguist-generated` changes over history, so supporting it means reading attributes per commit. Record what you chose and why. The hardening trial on public repos will test the list.
- Leaving files out with git pathspecs, not with a filter over parsed paths, makes the rename cases fall out for free: git then reports a rename across the boundary as a plain add or delete with full content.
- This repo has no merge commits, so the `walk --check` run proves nothing about rule 3. The scripted merge tests carry that.
- Drive the diff parser by the hunk header counts, never by what a line looks like. File content and commit messages can contain anything, including diff headers. Separate commit records with NUL bytes.
- Run git with a fixed environment so nothing on the machine changes its output: no system or global config, `--no-ext-diff`, `--no-textconv`, no color, `core.quotePath=false`, a pinned diff algorithm and rename limit. In the scripted repos also set `commit.gpgsign=false`, the default branch, and the user per command, with made-up identities on `example.com`. The repo is public: no real names or emails in fixtures.
- CI checks out one commit, so nothing in the test suite may read this repository's own history. `walk --check` is a command you run, not a test.
- One streaming `git log` over the mainline (`--first-parent --diff-merges=first-parent --reverse -p -U0 -w -M`) is far cheaper than one `git diff` per commit. Blame only merge commits, and only the added ranges. `git blame -w P..M` marks lines from outside the range as boundary lines, which is rule 3's fallback.
- Keep the state per line small, an index into a commit table. The hardening trial runs this on repos with tens of thousands of commits.
- The `walk` script can run under Node's type stripping like `packages/db`'s `migrate` script, which rules out enums and parameter properties.
- T04 runs in parallel and also appends to the Decisions table. If your PR conflicts with main there or in docs/STATUS.md, rebase and keep both sides' rows.

## Goal line

Paste into the workspace after approving the plan:

```
/goal pnpm --filter @code-trust/analyzer test passes with a named test for every scenario in the task's Done when list plus the invariant helper and the interface type test, pnpm --filter @code-trust/analyzer walk "$PWD" --check exits 0 on this repository, git diff origin/main -- docs/architecture.md shows the Decisions row for files left out of the metric, and pnpm verify:changed exits 0; show each command and its output; only files under the owner paths changed, plus this task's Status line and its row in docs/STATUS.md; or stop after 20 turns
```
