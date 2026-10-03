// The history walker: turns a local repository into line lifetimes. Every mainline commit is
// diffed against its first parent in one streaming `git log`; the line tracker applies the
// diffs in order; merge commits ask `git blame` which branch commit wrote each line they add.
// docs/tasks/T03-analyzer-history.md states the rules this implements.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { blame, blameArgs, cUnquote, Pool, toRanges } from './blame.ts';
import {
  assertSupportedGitVersion,
  BlobReader,
  displayPath,
  EMPTY_TREE,
  Git,
  GitError,
  literalPathspec,
} from './git.ts';
import { cQuote, MainlineLogParser, mainlineLogArgs, type ParsedCommit, type RawEntry } from './log-parser.ts';
import { DEFAULT_LEFT_OUT_RULES, type LeftOutRule, measuredPathspecs } from './measured-paths.ts';
import { LineTracker, linesFromFlags, type OwnerAt, TrackerError } from './tracker.ts';
import type { GitIdentity, HistoryCommit, HistoryResult, LineGroup, WalkOptions } from './types.ts';

/** How many parsed commits may wait for their merge blames before the stream pauses. */
const LOOKAHEAD = 64;

/** Matches `-l1000` in the log arguments and `diff.renameLimit` in the pinned config. */
const RENAME_LIMIT = 1000;

const EMPTY_LINES = new Int32Array(0);

export interface MainlineCommit {
  sha: string;
  /** Committer date, unix seconds. */
  committedAt: number;
  parents: string[];
}

export interface Repository {
  /** The repository directory, symlinks resolved. */
  dir: string;
  /** git for this repository, with the fixed environment and pinned options. */
  git: Git;
}

/** Everything a walk found, for the CLI and the tests. `result` is what `walkHistory` returns. */
export interface WalkDetails {
  result: HistoryResult;
  repository: Repository;
  rules: readonly LeftOutRule[];
  mainline: MainlineCommit[];
  /** Commit records the diff stream produced. Equals the mainline length on success. */
  streamedCommits: number;
  /** Per measured text file at the head (latin1 path): the commit-table index of each line's introducer, or BLANK. */
  files: ReadonlyMap<string, Int32Array>;
  /** The commit table: index to SHA. */
  commitShas: readonly string[];
  merges: number;
  blameJobs: number;
  /** Wall time spent in merge blames, summed over jobs. */
  blameMs: number;
  /** Mainline commits with more added and deleted files than git's rename limit, so only exact renames were found. */
  renameSkipped: string[];
}

/** Walks the first-parent history of `head` and returns every measured line's introducer and fate. */
export async function walkHistory(options: WalkOptions): Promise<HistoryResult> {
  return (await walkHistoryDetailed(options)).result;
}

export async function walkHistoryDetailed(options: WalkOptions): Promise<WalkDetails> {
  const repository = await openRepository(options.repoDir);
  const headSha = await resolveHead(repository, options.head ?? 'HEAD');
  const mainline = await readMainline(repository.git, headSha);
  const rules = options.leftOut ?? DEFAULT_LEFT_OUT_RULES;
  const walker = new Walker(repository.git, mainline, rules);
  await walker.run(headSha);
  const result = await walker.result(headSha);
  return {
    result,
    repository,
    rules,
    mainline,
    streamedCommits: walker.streamed,
    files: walker.tracker.files,
    commitShas: walker.shas,
    merges: walker.merges,
    blameJobs: walker.blameJobs,
    blameMs: walker.blameMs,
    renameSkipped: walker.renameSkipped,
  };
}

/** Checks that `repoDir` is a repository the walker can measure, and refuses with the reason when it is not. */
export async function openRepository(repoDir: string): Promise<Repository> {
  const requested = resolve(repoDir);
  let dir: string;
  try {
    dir = realpathSync(requested);
  } catch {
    throw new GitError(`${requested} does not exist`, { args: [] });
  }
  if (!statSync(dir).isDirectory()) throw new GitError(`${dir} is not a directory`, { args: [] });
  // Git must not search above the directory: a plain folder inside some other repository would
  // otherwise be walked as that repository.
  const ceiling = dirname(dir);
  const plain = new Git(dir, { ceiling, pinned: false });

  // First and bare, with no global options: an old git would die on --attr-source before the check.
  assertSupportedGitVersion(await plain.text(['version']));

  try {
    await plain.text(['rev-parse', '--git-dir']);
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.stderr)) {
      throw new GitError(`${dir} is not a git repository`, { args: error.args, stderr: error.stderr });
    }
    throw error;
  }
  if ((await plain.text(['rev-parse', '--is-shallow-repository'])) === 'true') {
    throw new GitError(
      `${dir} is a shallow clone: behind the shallow boundary every old line would look like it was introduced by the boundary commit. Fetch the full history first (git fetch --unshallow).`,
      { args: [] },
    );
  }
  const format = await plain.text(['rev-parse', '--show-object-format']);
  if (format !== 'sha1') {
    throw new GitError(`${dir} uses ${format} object names; only SHA-1 repositories are supported`, { args: [] });
  }
  const partial = await plain.text(['config', '--get', 'extensions.partialClone'], { okExitCodes: [1] });
  const promisors = await plain.text(['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'], {
    okExitCodes: [1],
  });
  if (partial !== '' || promisors.split('\n').some((line) => line.endsWith(' true'))) {
    throw new GitError(`${dir} is a partial clone with missing blobs; clone it again without --filter`, { args: [] });
  }
  // Git reads these from the common directory, which in a linked worktree is the main
  // repository's, so the paths come from --git-path. Nothing can switch either of them off.
  await refuseRepositoryFile(
    plain,
    dir,
    'info/attributes',
    'sets attributes that would change which files git calls binary',
  );
  await refuseRepositoryFile(plain, dir, 'info/grafts', 'rewrites commit parents');
  return { dir, git: new Git(dir, { ceiling }) };
}

async function refuseRepositoryFile(git: Git, dir: string, name: string, why: string): Promise<void> {
  const path = resolve(dir, await git.text(['rev-parse', '--git-path', name]));
  if (!existsSync(path)) return;
  const active = readFileSync(path, 'utf8')
    .split('\n')
    .some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  if (active) throw new GitError(`${path} ${why}; empty it or walk a fresh clone`, { args: [] });
}

/** The full SHA of the commit `head` names. */
export async function resolveHead(repository: Repository, head: string): Promise<string> {
  const plain = new Git(repository.dir, { ceiling: dirname(repository.dir), pinned: false });
  const sha = await plain.text(['rev-parse', '--verify', '--quiet', '--end-of-options', `${head}^{commit}`], {
    okExitCodes: [1],
  });
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitError(`${head} is not a commit in ${repository.dir}`, { args: [] });
  return sha;
}

/** The first-parent chain from the root to `headSha`, oldest first. No pathspec, so parents are never rewritten. */
export async function readMainline(git: Git, headSha: string): Promise<MainlineCommit[]> {
  const output = await git.text(['log', headSha, '--first-parent', '--reverse', '--format=%H %ct %P']);
  return output.split('\n').map((line) => {
    const [sha, committedAt, ...parents] = line.split(' ');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !committedAt)
      throw new GitError(`unexpected git log line: ${line}`, { args: [] });
    return { sha, committedAt: Number(committedAt), parents: parents.filter(Boolean) };
  });
}

export function isRegularFile(mode: number): boolean {
  return (mode & 0o170000) === 0o100000;
}

/** Unix seconds as the domain's timestamp form, `2026-10-02T09:30:00.000Z`. */
export function isoFromUnixSeconds(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(iso)) throw new RangeError(`a git date out of range: ${seconds}`);
  return iso;
}

/** True when git found too many added and deleted files to look for inexact renames (diffcore-rename's rule). */
export function renameDetectionSkipped(commit: ParsedCommit, limit = RENAME_LIMIT): boolean {
  let added = 0;
  let deleted = 0;
  for (const entry of commit.entries) {
    if (entry.status === 'A') added++;
    else if (entry.status === 'D') deleted++;
  }
  if (added === 0 || deleted === 0) return false;
  return !((added <= limit || deleted <= limit) && added * deleted <= limit * limit);
}

interface Prepared {
  commit: ParsedCommit;
  position: number;
  /** At a merge: per new path, the SHA owning each added non-blank line. */
  owners: Map<string, Map<number, string>> | null;
}

class Walker {
  readonly tracker = new LineTracker();
  readonly shas: string[] = [];
  /** Per commit-table index: the mainline position of the commit that landed it. */
  private readonly landing: number[] = [];
  private readonly index = new Map<string, number>();
  private readonly pool = new Pool();
  private readonly leftOutPaths = new Map<string, Promise<boolean>>();
  private readonly git: Git;
  private readonly mainline: MainlineCommit[];
  private readonly rules: readonly LeftOutRule[];
  private blobs: BlobReader | null = null;
  streamed = 0;
  merges = 0;
  blameJobs = 0;
  blameMs = 0;
  readonly renameSkipped: string[] = [];

  constructor(git: Git, mainline: MainlineCommit[], rules: readonly LeftOutRule[]) {
    this.git = git;
    this.mainline = mainline;
    this.rules = rules;
  }

  async run(headSha: string): Promise<void> {
    const parser = new MainlineLogParser();
    const queue: Promise<Prepared>[] = [];
    const enqueue = (commit: ParsedCommit): void => {
      const position = this.streamed++;
      const expected = this.mainline[position];
      if (expected?.sha !== commit.sha) {
        throw new GitError(
          `the diff stream gave commit ${commit.sha} where the mainline has ${expected?.sha ?? 'nothing'}`,
          { args: [] },
        );
      }
      const prepared = this.prepare(commit, position);
      // Awaited in order below; this only keeps an early failure from counting as unhandled.
      prepared.catch(() => {});
      queue.push(prepared);
    };
    const next = async (): Promise<void> => {
      const prepared = queue.shift();
      if (prepared) await this.apply(await prepared);
    };

    this.blobs = new BlobReader(this.git);
    try {
      const pathspecs = measuredPathspecs(this.rules);
      for await (const chunk of this.git.stream(mainlineLogArgs(headSha, pathspecs))) {
        for (const commit of parser.push(chunk)) {
          enqueue(commit);
          while (queue.length > LOOKAHEAD) await next();
        }
      }
      for (const commit of parser.end()) enqueue(commit);
      while (queue.length > 0) await next();
      if (this.streamed !== this.mainline.length) {
        throw new GitError(`the diff stream ended after ${this.streamed} of ${this.mainline.length} mainline commits`, {
          args: [],
        });
      }
    } finally {
      await Promise.allSettled(queue);
      await this.blobs.close();
      this.blobs = null;
    }
  }

  /** Starts a merge's blames as soon as it is parsed: they need the diff, not the tracker's state. */
  private async prepare(commit: ParsedCommit, position: number): Promise<Prepared> {
    const merge = this.mainlineAt(position);
    if (merge.parents.length < 2) return { commit, position, owners: null };
    this.merges++;
    const jobs: Promise<[string, Map<number, string>]>[] = [];
    for (const entry of commit.entries) {
      if (!isRegularFile(entry.newMode)) continue;
      const lines = addedNonBlankLines(entry);
      if (lines.length === 0) continue;
      jobs.push(this.blameMerge(position, entry.newPath, lines).then((owners) => [entry.newPath, owners]));
    }
    return { commit, position, owners: new Map(await Promise.all(jobs)) };
  }

  /**
   * Rule 3: a line a merge adds belongs to the commit blame names, if the merge brought that commit
   * in (it is in P..M). Otherwise, or when blame names the merge itself, it belongs to the merge.
   */
  private async blameMerge(position: number, path: string, lines: readonly number[]): Promise<Map<number, string>> {
    const merge = this.mainlineAt(position);
    const parent = merge.parents[0] as string;
    const started = performance.now();
    const answer = await this.pool.run(() =>
      blame(this.git, blameArgs(`${parent}..${merge.sha}`, path, toRanges(lines))),
    );
    this.blameJobs++;
    this.blameMs += performance.now() - started;

    const quotedPath = cQuote(path);
    const broughtIn = new Map<string, Promise<boolean>>();
    const owners = new Map<number, string>();
    for (const line of lines) {
      const blamed = answer.get(line);
      if (!blamed) throw new TrackerError(`git blame gave no answer for ${displayPath(path)}:${line} at ${merge.sha}`);
      let owner = merge.sha;
      if (blamed.sha !== merge.sha) {
        let decided = broughtIn.get(blamed.sha);
        if (!decided) {
          decided = this.isBroughtIn(blamed.sha, parent, position);
          broughtIn.set(blamed.sha, decided);
        }
        // Blame follows renames, also out of a left-out file. Linear or squash history would have
        // started fresh lines there, so the merge that landed the rename owns them.
        if (
          (await decided) &&
          !(blamed.filename !== quotedPath && (await this.isLeftOut(cUnquote(blamed.filename), blamed.sha)))
        ) {
          owner = blamed.sha;
        }
      }
      owners.set(line, owner);
    }
    return owners;
  }

  /** Whether the merge at `position` brought `sha` in: not reachable from its first parent. */
  private async isBroughtIn(sha: string, parent: string, position: number): Promise<boolean> {
    const known = this.index.get(sha);
    // A registered commit landed at an earlier mainline commit, which is an ancestor of the parent.
    if (known !== undefined && (this.landing[known] as number) < position) return false;
    const { exitCode } = await this.pool.run(() =>
      this.git.run(['merge-base', '--is-ancestor', sha, parent], { okExitCodes: [1] }),
    );
    return exitCode === 1;
  }

  /** Whether the left-out rules match `path`. Matched by git, cached per path. */
  private isLeftOut(path: string, sha: string): Promise<boolean> {
    let answer = this.leftOutPaths.get(path);
    if (!answer) {
      const excludes = measuredPathspecs(this.rules).slice(1);
      answer = this.pool
        .run(() =>
          this.git.run([
            'diff-tree',
            '-r',
            '-z',
            '--name-only',
            '--no-renames',
            EMPTY_TREE,
            sha,
            '--',
            literalPathspec(path),
            ...excludes,
          ]),
        )
        .then(({ stdout }) => stdout.length === 0);
      this.leftOutPaths.set(path, answer);
    }
    return answer;
  }

  private async apply({ commit, position, owners }: Prepared): Promise<void> {
    const merge = this.mainlineAt(position);
    const isMerge = merge.parents.length > 1;
    let self = -1;
    const mergeOwner = (): number => {
      if (self < 0) self = this.register(merge.sha, position);
      return self;
    };
    const ownerFor = (path: string): OwnerAt => {
      if (!isMerge) return mergeOwner;
      const byLine = owners?.get(path);
      return (line) => {
        const sha = byLine?.get(line);
        if (sha === undefined)
          throw new TrackerError(`no blame answer for ${displayPath(path)}:${line} at ${merge.sha}`);
        return sha === merge.sha ? mergeOwner() : this.register(sha, position);
      };
    };

    if (renameDetectionSkipped(commit)) this.renameSkipped.push(commit.sha);
    // Every entry reads the parent's state; the changes are applied after, deletions first, so a
    // swap or a rename onto a deleted path works.
    const deletes: string[] = [];
    const writes: [string, Int32Array][] = [];
    for (const entry of commit.entries) {
      if (entry.status !== 'A') deletes.push(entry.oldPath);
      const lines = await this.nextLines(entry, position, ownerFor(entry.newPath));
      if (lines) writes.push([entry.newPath, lines]);
    }
    for (const path of deletes) this.tracker.files.delete(path);
    for (const [path, lines] of writes) this.tracker.files.set(path, lines);
  }

  /** The file's lines after this entry, or null when it is no longer a measured text file. */
  private async nextLines(entry: RawEntry, position: number, ownerAt: OwnerAt): Promise<Int32Array | null> {
    const tracker = this.tracker;
    const label = `${displayPath(entry.newPath)} at ${this.mainlineAt(position).sha}`;
    const old = isRegularFile(entry.oldMode) ? tracker.files.get(entry.oldPath) : undefined;

    if (!isRegularFile(entry.newMode)) {
      // Deleted, or now a symlink or a submodule: no lines.
      if (old) tracker.removeAll(old, position);
      return null;
    }
    if (entry.status === 'T') {
      if (old) tracker.removeAll(old, position);
      const added = entry.sections.find((section) => section.kind === 'new');
      if (added && !added.binary) return tracker.apply(EMPTY_LINES, added.hunks, position, ownerAt, label);
      if (added?.binary) return null;
      return this.fromBlob(entry, position, ownerAt);
    }
    if (entry.sections.length > 1) throw new TrackerError(`${label}: ${entry.sections.length} patches for one file`);
    const section = entry.sections[0];
    const binary = section?.binary ?? false;
    if (old) {
      if (binary) {
        // The old side was text, so git printed "Binary files differ" for the new side.
        tracker.removeAll(old, position);
        return null;
      }
      return section ? tracker.apply(old, section.hunks, position, ownerAt, label) : old;
    }
    if (entry.status === 'A') {
      if (!section) throw new TrackerError(`${label}: a new file without a patch`);
      return binary ? null : tracker.apply(EMPTY_LINES, section.hunks, position, ownerAt, label);
    }
    // Not tracked before: the old side was binary. Only the blob says whether the new side is text.
    if (binary) return this.fromBlob(entry, position, ownerAt);
    if (section && section.hunks.length > 0) throw new TrackerError(`${label}: hunks for a file that was not text`);
    return null;
  }

  /** A whole file from its blob, when a diff showed no lines for it (it was binary before). */
  private async fromBlob(entry: RawEntry, position: number, ownerAt: OwnerAt): Promise<Int32Array | null> {
    if (!this.blobs) throw new TrackerError('the blob reader is closed');
    const blob = await this.blobs.read(entry.newBlob, true);
    if (blob.binary || !blob.nonBlank) return null;
    let owner = ownerAt;
    if (this.mainlineAt(position).parents.length > 1) {
      // A merge's blames were planned from its hunks, and a binary patch has none: blame now.
      const lines: number[] = [];
      blob.nonBlank.forEach((flag, i) => {
        if (flag === 1) lines.push(i + 1);
      });
      const byLine =
        lines.length > 0 ? await this.blameMerge(position, entry.newPath, lines) : new Map<number, string>();
      const sha = this.mainlineAt(position).sha;
      owner = (line) => {
        const blamed = byLine.get(line);
        if (blamed === undefined)
          throw new TrackerError(`no blame answer for ${displayPath(entry.newPath)}:${line} at ${sha}`);
        return this.register(blamed, position);
      };
    }
    return linesFromFlags(blob.nonBlank, owner);
  }

  private register(sha: string, landing: number): number {
    const known = this.index.get(sha);
    if (known !== undefined) {
      if (this.landing[known] !== landing) {
        throw new TrackerError(`commit ${sha} would land at two mainline commits`);
      }
      return known;
    }
    const index = this.shas.length;
    this.shas.push(sha);
    this.landing.push(landing);
    this.index.set(sha, index);
    return index;
  }

  private mainlineAt(position: number): MainlineCommit {
    const commit = this.mainline[position];
    if (!commit) throw new TrackerError(`no mainline commit at position ${position}`);
    return commit;
  }

  async result(headSha: string): Promise<HistoryResult> {
    const head = this.mainline.at(-1);
    if (head?.sha !== headSha) throw new TrackerError(`the mainline does not end at ${headSha}`);

    interface Tally {
      owner: number;
      /** Mainline position, or null while alive. */
      remover: number | null;
      count: number;
    }
    const tallies: Tally[] = [];
    for (const [owner, byRemover] of this.tracker.removals) {
      for (const [remover, count] of byRemover) tallies.push({ owner, remover, count });
    }
    for (const [owner, count] of this.tracker.aliveCounts()) tallies.push({ owner, remover: null, count });

    // landedAt per referenced SHA, in unix seconds.
    const landedAt = new Map<string, number>();
    for (const { owner, remover } of tallies) {
      const sha = this.shas[owner] as string;
      landedAt.set(sha, this.mainlineAt(this.landing[owner] as number).committedAt);
      if (remover !== null) {
        const removing = this.mainlineAt(remover);
        landedAt.set(removing.sha, removing.committedAt);
      }
    }
    const metadata = await readCommits(this.git, [...landedAt.keys()]);
    const commits: HistoryCommit[] = [...landedAt].map(([sha, landed]) => {
      const meta = metadata.get(sha);
      if (!meta) throw new GitError(`git log gave no details for commit ${sha}`, { args: [] });
      return { ...meta, landedAt: isoFromUnixSeconds(landed) };
    });
    commits.sort((a, b) => compareStrings(a.landedAt, b.landedAt) || compareStrings(a.sha, b.sha));

    const order = new Map(commits.map((commit, i) => [commit.sha, i]));
    tallies.sort((a, b) => {
      const byOwner = (order.get(this.shas[a.owner] as string) ?? 0) - (order.get(this.shas[b.owner] as string) ?? 0);
      if (byOwner !== 0) return byOwner;
      if (a.remover === b.remover) return 0;
      if (a.remover === null) return 1;
      if (b.remover === null) return -1;
      return a.remover - b.remover;
    });
    const groups: LineGroup[] = tallies.map(({ owner, remover, count }) => ({
      introducedBy: this.shas[owner] as string,
      removedBy: remover === null ? null : this.mainlineAt(remover).sha,
      lineCount: count,
    }));
    return { headSha, headCommittedAt: isoFromUnixSeconds(head.committedAt), commits, groups };
  }
}

/** New line numbers (1-based) of the non-blank lines an entry's patches add. */
function addedNonBlankLines(entry: RawEntry): number[] {
  const lines: number[] = [];
  for (const section of entry.sections) {
    if (section.kind === 'deleted' || section.binary) continue;
    for (const hunk of section.hunks) {
      hunk.added.forEach((flag, i) => {
        if (flag === 1) lines.push(hunk.newStart + i);
      });
    }
  }
  return lines;
}

const COMMIT_FIELDS = 8;

/** Identities, dates and messages for the given commits, as git records them (no mailmap). */
export async function readCommits(
  git: Git,
  shas: readonly string[],
): Promise<Map<string, Omit<HistoryCommit, 'landedAt'>>> {
  const commits = new Map<string, Omit<HistoryCommit, 'landedAt'>>();
  if (shas.length === 0) return commits;
  const { stdout } = await git.run(
    [
      'log',
      '--no-walk=unsorted',
      '--stdin',
      '-z',
      '--no-use-mailmap',
      '--encoding=UTF-8',
      '--format=%H%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B',
    ],
    { input: `${shas.join('\n')}\n` },
  );
  const fields = stdout.toString('utf8').split('\0');
  // Each record ends with -z's NUL, so the last field is empty. A message cannot hold a NUL.
  if (fields.length !== shas.length * COMMIT_FIELDS + 1 || fields.at(-1) !== '') {
    throw new GitError(`git log gave ${fields.length - 1} fields for ${shas.length} commits`, { args: [] });
  }
  for (let i = 0; i < shas.length; i++) {
    const [sha, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, message] =
      fields.slice(i * COMMIT_FIELDS, (i + 1) * COMMIT_FIELDS) as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
    const author: GitIdentity = { name: authorName, email: authorEmail };
    const committer: GitIdentity = { name: committerName, email: committerEmail };
    commits.set(sha, {
      sha,
      authoredAt: isoFromUnixSeconds(Number(authoredAt)),
      committedAt: isoFromUnixSeconds(Number(committedAt)),
      author,
      committer,
      message,
    });
  }
  return commits;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
