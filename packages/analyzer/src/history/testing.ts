// Test support: real git repositories built in temp directories with fixed identities and dates,
// and walkChecked, the walk that asserts the walker's invariants on every scripted repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommitShaSchema, IsoTimestampSchema } from '@code-trust/shared';
import { gitEnv } from './git.ts';
import { countHeadLines } from './head-count.ts';
import { BLANK } from './tracker.ts';
import type { HistoryResult, LineGroup, WalkOptions } from './types.ts';
import { type WalkDetails, walkHistory, walkHistoryDetailed } from './walk.ts';

export interface Identity {
  name: string;
  email: string;
}

// Made up: the repository is public, so fixtures never carry a real person's name or email.
export const AUTHOR: Identity = { name: 'Ada Example', email: 'ada@example.com' };
export const COMMITTER: Identity = { name: 'Grace Example', email: 'grace@example.com' };

/** 2026-01-01T00:00:00Z. The clock moves one day per commit unless a test sets a date. */
export const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
export const DAY = 86_400;

/** A file to write: text or bytes, `null` to delete, or a symlink to `target`. */
export type FileContent = string | Uint8Array | null | { symlink: string };

export interface CommitOptions {
  author?: Identity;
  committer?: Identity;
  /** ISO timestamp or unix seconds. Defaults to one day after the previous commit. */
  authoredAt?: string | number;
  /** Defaults to `authoredAt`. */
  committedAt?: string | number;
  allowEmpty?: boolean;
}

export interface MergeOptions extends CommitOptions {
  message?: string;
  allowUnrelated?: boolean;
  /** A merge strategy, such as `ours`. */
  strategy?: string;
  /** Files written over the merge result before it is committed: how a test resolves a conflict. */
  resolve?: Record<string, FileContent>;
}

// The builder's own git settings. core.excludesFile matters: git reads ~/.config/git/ignore even
// with GIT_CONFIG_GLOBAL=/dev/null, and a developer's ignore list could silently drop node_modules
// or dist fixtures.
const BUILDER_CONFIG = [
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'init.defaultBranch=main',
  'core.autocrlf=false',
  'core.precomposeUnicode=false',
  'core.excludesFile=/dev/null',
  'core.hooksPath=/dev/null',
  'gc.auto=0',
  'maintenance.auto=false',
  'protocol.file.allow=always',
  'merge.conflictStyle=merge',
  'advice.detachedHead=false',
];

const tempDirs = new Set<string>();

/** A fresh temp directory, removed by removeTempDirs(). */
export function makeTempDir(prefix = 'code-trust-'): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  tempDirs.add(dir);
  return dir;
}

/** Removes every temp directory this process created. Call it from afterAll. */
export function removeTempDirs(): void {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

export function toUnixSeconds(value: string | number): number {
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`not a timestamp: ${value}`);
  return Math.floor(ms / 1000);
}

export function isoAt(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export interface RunGitOptions {
  env?: Record<string, string>;
  input?: string | Uint8Array;
  okExitCodes?: readonly number[];
}

/** Runs the builder's git in `cwd` and returns stdout. */
export function builderGit(cwd: string, args: readonly string[], options: RunGitOptions = {}): string {
  try {
    return execFileSync('git', [...BUILDER_CONFIG.flatMap((c) => ['-c', c]), ...args], {
      cwd,
      env: gitEnv(options.env),
      input: options.input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    if (failed.status !== undefined && options.okExitCodes?.includes(failed.status)) return failed.stdout ?? '';
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${failed.stderr ?? String(error)}`);
  }
}

/** A git repository driven by a test script. Every commit has fixed identities and dates. */
export class ScriptedRepo {
  readonly dir: string;
  private clock = BASE_TIME;
  private written = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** A new empty repository on branch main. */
  static create(options: { objectFormat?: 'sha1' | 'sha256' } = {}): ScriptedRepo {
    const dir = makeTempDir('code-trust-repo-');
    const format = options.objectFormat === 'sha256' ? ['--object-format=sha256'] : [];
    builderGit(dir, ['init', '--quiet', '--template=', ...format]);
    return new ScriptedRepo(dir);
  }

  git(args: readonly string[], options: RunGitOptions = {}): string {
    return builderGit(this.dir, args, options);
  }

  /** Writes, replaces or (with null) deletes files in the work tree. Nothing is staged yet. */
  write(files: Record<string, FileContent>): void {
    for (const [path, content] of Object.entries(files)) {
      const target = join(this.dir, path);
      rmSync(target, { recursive: true, force: true });
      if (content === null) {
        this.written.delete(path);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      if (typeof content === 'object' && 'symlink' in content) symlinkSync(content.symlink, target);
      else writeFileSync(target, content);
      this.written.add(path);
    }
  }

  /** `git mv`, so the move is staged as one. */
  move(from: string, to: string): void {
    mkdirSync(dirname(join(this.dir, to)), { recursive: true });
    this.git(['mv', '--', from, to]);
    if (this.written.delete(from)) this.written.add(to);
  }

  /** A submodule entry (a gitlink) pointing at `sha`, without a checkout. */
  gitlink(path: string, sha: string): void {
    // An empty directory reads as a submodule that is not checked out, so `add -A` keeps it.
    mkdirSync(join(this.dir, path), { recursive: true });
    this.git(['update-index', '--add', '--cacheinfo', `160000,${sha},${path}`]);
  }

  /** Stages everything and commits. Returns the new commit's SHA. */
  commit(message: string, options: CommitOptions = {}): string {
    this.git(['add', '-A']);
    const args = ['commit', '--quiet', '--no-verify', '--cleanup=verbatim', '-F', '-'];
    if (options.allowEmpty) args.push('--allow-empty');
    this.git(args, { input: message, env: this.identityEnv(options) });
    this.assertCommitted();
    return this.head();
  }

  /** Switches branch; `create` starts it at `from` (default: the current commit). */
  switch(branch: string, options: { create?: boolean; from?: string } = {}): void {
    const args = options.create ? ['switch', '--quiet', '-c', branch] : ['switch', '--quiet', branch];
    if (options.create && options.from) args.push(options.from);
    this.git(args);
  }

  /**
   * Merges `branches` into the current branch as a merge commit (never a fast-forward) and
   * returns its SHA. A conflict must be settled with `resolve`.
   */
  merge(branches: string | readonly string[], options: MergeOptions = {}): string {
    const names = typeof branches === 'string' ? [branches] : [...branches];
    const args = ['merge', '--no-ff', '--no-commit', '--quiet'];
    if (options.allowUnrelated) args.push('--allow-unrelated-histories');
    if (options.strategy) args.push('-s', options.strategy);
    const output = this.git([...args, ...names], { okExitCodes: [1], env: this.identityEnv(options, false) });
    const conflicted = this.git(['diff', '--name-only', '--diff-filter=U']).trim();
    if (options.resolve) this.write(options.resolve);
    else if (conflicted) throw new Error(`merge of ${names.join(', ')} conflicts in ${conflicted}: ${output}`);
    return this.commit(options.message ?? `Merge ${names.join(', ')}`, options);
  }

  /** `git merge --squash`: stages the branch's changes without committing them. */
  squash(branch: string): void {
    this.git(['merge', '--squash', '--quiet', branch]);
  }

  head(): string {
    return this.sha('HEAD');
  }

  sha(rev: string): string {
    return this.git(['rev-parse', '--verify', `${rev}^{commit}`]).trim();
  }

  /** A clone with only the newest `depth` commits. */
  shallowClone(depth = 1): string {
    const dir = makeTempDir('code-trust-shallow-');
    builderGit(dir, ['clone', '--quiet', `--depth=${depth}`, `file://${this.dir}`, '.']);
    return dir;
  }

  /** A blobless partial clone: history without file contents. */
  partialClone(): string {
    this.git(['config', 'uploadpack.allowFilter', 'true']);
    const dir = makeTempDir('code-trust-partial-');
    builderGit(dir, ['clone', '--quiet', '--no-checkout', '--filter=blob:none', `file://${this.dir}`, '.']);
    return dir;
  }

  bareClone(): string {
    const dir = makeTempDir('code-trust-bare-');
    builderGit(dir, ['clone', '--quiet', '--bare', this.dir, '.']);
    return dir;
  }

  /** A linked worktree, detached at the current commit. */
  addWorktree(): string {
    const dir = join(makeTempDir('code-trust-worktree-'), 'tree');
    this.git(['worktree', 'add', '--quiet', '--detach', dir, 'HEAD']);
    return dir;
  }

  private identityEnv(options: CommitOptions, tick = true): Record<string, string> {
    if (tick) this.clock += DAY;
    const authored = options.authoredAt === undefined ? this.clock : toUnixSeconds(options.authoredAt);
    const committed = options.committedAt === undefined ? authored : toUnixSeconds(options.committedAt);
    const author = options.author ?? AUTHOR;
    const committer = options.committer ?? COMMITTER;
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: `@${authored} +0000`,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: `@${committed} +0000`,
    };
  }

  // Guards against a file silently left out of a commit, by an ignore rule for instance.
  private assertCommitted(): void {
    const tracked = new Set(this.git(['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0'));
    const missing = [...this.written].filter((path) => !tracked.has(path));
    if (missing.length > 0) throw new Error(`files written but not committed: ${missing.join(', ')}`);
    this.written.clear();
  }
}

/**
 * Walks `repo` and asserts the walker's invariants before returning the result. Every scenario
 * test walks through this. Each check is computed without the line tracker:
 *
 * - alive lines, in total and per file, equal the non-blank lines of the measured text files at
 *   the head, counted from the blobs;
 * - no two groups share (introducedBy, removedBy), and every lineCount is a positive integer;
 * - `commits` is exactly the SHAs the groups name, sorted by (landedAt, sha);
 * - every removedBy is on the mainline (`git rev-list --first-parent`);
 * - every landedAt is the committer date of the first mainline commit that contains the commit;
 * - SHAs and timestamps pass the shared schemas;
 * - a second walk is deeply equal.
 */
export async function walkChecked(
  repo: ScriptedRepo | string,
  options: Omit<WalkOptions, 'repoDir'> = {},
): Promise<HistoryResult> {
  const repoDir = typeof repo === 'string' ? repo : repo.dir;
  const details = await walkHistoryDetailed({ repoDir, ...options });
  await assertInvariants(repoDir, details);
  assert.deepStrictEqual(await walkHistory({ repoDir, ...options }), details.result, 'two walks differ');
  return details.result;
}

async function assertInvariants(repoDir: string, details: WalkDetails): Promise<void> {
  const { result } = details;
  const head = await countHeadLines(details.repository.git, result.headSha, details.rules);

  const walkerFiles = new Map<string, number>();
  for (const [path, lines] of details.files) walkerFiles.set(path, lines.filter((owner) => owner !== BLANK).length);
  assert.deepStrictEqual(
    sortedEntries(walkerFiles),
    sortedEntries(head.files),
    'alive lines per file differ from the blobs',
  );
  const alive = result.groups
    .filter((group) => group.removedBy === null)
    .reduce((sum, group) => sum + group.lineCount, 0);
  const blobLines = [...head.files.values()].reduce((sum, lines) => sum + lines, 0);
  assert.equal(alive, blobLines, 'alive lines differ from the non-blank lines at the head');

  const pairs = new Set<string>();
  for (const group of result.groups) {
    const key = `${group.introducedBy} ${group.removedBy}`;
    assert.ok(!pairs.has(key), `two groups for ${key}`);
    pairs.add(key);
    assert.ok(Number.isInteger(group.lineCount) && group.lineCount > 0, `bad lineCount ${group.lineCount}`);
  }

  const referenced = new Set(result.groups.flatMap((group) => [group.introducedBy, group.removedBy ?? []].flat()));
  const listed = result.commits.map((commit) => commit.sha);
  assert.deepStrictEqual(new Set(listed), referenced, 'commits is not exactly the SHAs the groups name');
  assert.equal(listed.length, referenced.size, 'a commit is listed twice');
  const sorted = [...result.commits].sort((a, b) => compare(a.landedAt, b.landedAt) || compare(a.sha, b.sha));
  assert.deepStrictEqual(
    listed,
    sorted.map((commit) => commit.sha),
    'commits are not ordered by landedAt, then sha',
  );

  const mainline = builderGit(repoDir, ['rev-list', '--first-parent', '--reverse', result.headSha]).trim().split('\n');
  assert.equal(mainline.at(-1), result.headSha);
  const onMainline = new Set(mainline);
  for (const group of result.groups) {
    if (group.removedBy !== null)
      assert.ok(onMainline.has(group.removedBy), `${group.removedBy} is not on the mainline`);
  }

  for (const commit of result.commits) {
    const landing = firstContaining(repoDir, mainline, commit.sha);
    const landedAt = isoAt(Number(builderGit(repoDir, ['log', '-1', '--format=%ct', landing]).trim()));
    assert.equal(commit.landedAt, landedAt, `${commit.sha} should land with ${landing}`);
    CommitShaSchema.parse(commit.sha);
    for (const time of [commit.authoredAt, commit.committedAt, commit.landedAt]) IsoTimestampSchema.parse(time);
  }
  CommitShaSchema.parse(result.headSha);
  IsoTimestampSchema.parse(result.headCommittedAt);
}

/** The first mainline commit that has `sha` as an ancestor, by binary search: containment only grows along the mainline. */
function firstContaining(repoDir: string, mainline: readonly string[], sha: string): string {
  let low = 0;
  let high = mainline.length - 1;
  assert.ok(isAncestor(repoDir, sha, mainline[high] as string), `${sha} is not in the head's history`);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (isAncestor(repoDir, sha, mainline[middle] as string)) high = middle;
    else low = middle + 1;
  }
  return mainline[low] as string;
}

function isAncestor(repoDir: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoDir,
      env: gitEnv(),
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

function sortedEntries(map: ReadonlyMap<string, number>): [string, number][] {
  return [...map].sort(([a], [b]) => compare(a, b));
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** A label-based view of the groups, sorted, for writing expected values by hand: `{ c1: sha }` turns SHAs into `c1`. */
export function labelGroups(result: HistoryResult, labels: Readonly<Record<string, string>>): LineGroup[] {
  const names = new Map(Object.entries(labels).map(([label, sha]) => [sha, label]));
  const name = (sha: string): string => names.get(sha) ?? sha;
  return result.groups
    .map((group) => ({
      introducedBy: name(group.introducedBy),
      removedBy: group.removedBy === null ? null : name(group.removedBy),
      lineCount: group.lineCount,
    }))
    .sort((a, b) => compare(a.introducedBy, b.introducedBy) || compare(a.removedBy ?? '~', b.removedBy ?? '~'));
}

/** The same sort as labelGroups, for the expected side. */
export function sortGroups(groups: LineGroup[]): LineGroup[] {
  return [...groups].sort(
    (a, b) => compare(a.introducedBy, b.introducedBy) || compare(a.removedBy ?? '~', b.removedBy ?? '~'),
  );
}

/** `count` distinct non-blank lines, `prefix 1` to `prefix count`, each ending in a newline. */
export function textLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join('');
}
