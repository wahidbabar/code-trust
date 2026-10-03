// Pins the exported interface to the one in docs/tasks/T03-analyzer-history.md, which T05 is
// written against. The expected types are copied here, not imported, so the comparison is not of
// a module with itself. tsc enforces it in the package typecheck.
import type { CommitSha, IsoTimestamp } from '@code-trust/shared';
import { expectTypeOf, test } from 'vitest';
import {
  type GitIdentity,
  type HistoryCommit,
  type HistoryResult,
  type LeftOutRule,
  type LineGroup,
  type WalkOptions,
  walkHistory,
} from '../index.ts';

interface ExpectedGitIdentity {
  name: string;
  email: string;
}

interface ExpectedHistoryCommit {
  sha: CommitSha;
  authoredAt: IsoTimestamp;
  committedAt: IsoTimestamp;
  landedAt: IsoTimestamp;
  author: ExpectedGitIdentity;
  committer: ExpectedGitIdentity;
  message: string;
}

interface ExpectedLineGroup {
  introducedBy: CommitSha;
  removedBy: CommitSha | null;
  lineCount: number;
}

interface ExpectedHistoryResult {
  headSha: CommitSha;
  headCommittedAt: IsoTimestamp;
  commits: ExpectedHistoryCommit[];
  groups: ExpectedLineGroup[];
}

/** The task's WalkOptions plus the one field it allows: the files-left-out rule. */
interface ExpectedWalkOptions {
  repoDir: string;
  head?: string;
  leftOut?: readonly LeftOutRule[];
}

test('walkHistory, HistoryResult, HistoryCommit and LineGroup match the interface T05 is written against', () => {
  expectTypeOf<GitIdentity>().toEqualTypeOf<ExpectedGitIdentity>();
  expectTypeOf<HistoryCommit>().toEqualTypeOf<ExpectedHistoryCommit>();
  expectTypeOf<LineGroup>().toEqualTypeOf<ExpectedLineGroup>();
  expectTypeOf<HistoryResult>().toEqualTypeOf<ExpectedHistoryResult>();
  expectTypeOf<WalkOptions>().toEqualTypeOf<ExpectedWalkOptions>();
  expectTypeOf(walkHistory).toEqualTypeOf<(options: ExpectedWalkOptions) => Promise<ExpectedHistoryResult>>();
  // Callers written against the task's original options still compile.
  expectTypeOf<{ repoDir: string; head?: string }>().toExtend<Parameters<typeof walkHistory>[0]>();
});
