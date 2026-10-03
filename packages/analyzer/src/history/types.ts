// The walker's public interface. T05 (attribution and survival) is written against these names
// and shapes, so they change only by agreement. interface.test.ts pins them.
import type { CommitSha, IsoTimestamp } from '@code-trust/shared';
import type { LeftOutRule } from './measured-paths.ts';

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
  /** The files left out of the metric. Defaults to DEFAULT_LEFT_OUT_RULES. */
  leftOut?: readonly LeftOutRule[];
}
