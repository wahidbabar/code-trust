// The two git commands the worker runs itself: ls-remote for the default branch and its tip, and
// the clone the analyzer walks. Both run with an environment built from scratch, the same rule as
// the analyzer's gitEnv: on Lambda, git comes from a layer that works with only PATH and HOME.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { CommitShaSchema, type RepoRef, RepoRefSchema } from '@code-trust/shared';

export const LS_REMOTE_TIMEOUT_MS = 30_000;
/** Leaves Lambda's 15 minutes room to log the failure, which a kill by Lambda would not. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

const STDERR_TAIL_BYTES = 64 * 1024;

export interface GitRunOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs git to completion. Rejects only when git cannot be started or runs out of time. */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitRunResult>;

export class GitTimeoutError extends Error {
  override readonly name = 'GitTimeoutError';
}

export class GitCommandError extends Error {
  override readonly name = 'GitCommandError';
  readonly exitCode: number;
  readonly stderr: string;

  constructor(command: string, result: GitRunResult) {
    // git's first fatal line says what went wrong; the lines after it are often generic advice.
    const stderrLines = result.stderr.trim().split('\n');
    const reason = stderrLines.find((line) => line.startsWith('fatal: ')) ?? stderrLines.at(-1) ?? '';
    super(`git ${command} exited with ${result.exitCode}${reason ? `: ${reason}` : ''}`);
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
  }
}

/**
 * Nothing is inherited but PATH. LC_ALL=C keeps git's messages in English, which the classifier
 * reads. No system or global config means no credential helper, insteadOf or proxy from the
 * machine, and the ceiling keeps git from finding a repository around the work root.
 */
export function workerGitEnv(workRoot: string): Record<string, string> {
  const env: Record<string, string> = {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CEILING_DIRECTORIES: dirname(workRoot),
    // Lambda may have no HOME, and the work root is the one place the worker may write.
    HOME: workRoot,
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return env;
}

export function createGitRunner(): GitRunner {
  return (args, { cwd, env, timeoutMs }) =>
    new Promise((resolve, reject) => {
      // Its own process group, so a timeout also kills the helpers git starts (git-remote-https,
      // index-pack), which would otherwise keep writing into the work root.
      const child = spawn('git', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr = new Tail();
      let failure: Error | undefined;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        failure ??= error;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new GitTimeoutError(`git ${args[0] ?? ''} timed out after ${timeoutMs} ms`));
        else if (failure) reject(new Error(`could not run git ${args[0] ?? ''}: ${failure.message}`));
        else resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderr.text() });
      });
    });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group has already exited.
  }
}

/** Keeps the last STDERR_TAIL_BYTES of a stream. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > STDERR_TAIL_BYTES && this.chunks.length > 1) {
      this.size -= this.chunks.shift()?.length ?? 0;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

// GitHub's answer for a repo that is gone, or private to an anonymous client, as git prints it.
const NOT_FOUND = /^remote: Repository not found\.$/m;
// What git says when the server asks for credentials and GIT_TERMINAL_PROMPT=0 forbids asking.
const CREDENTIALS_NEEDED = /^fatal: could not read (Username|Password) for '[^']*': terminal prompts disabled$/m;

/**
 * `unavailable` when git says the repo does not exist or needs credentials, which is how a repo
 * that went private or away looks to an anonymous client. Anything else is null: the caller
 * throws, so SQS retries what might be a network fault.
 */
export function classifyGitFailure(exitCode: number, stderr: string): 'unavailable' | null {
  if (exitCode !== 128) return null;
  return NOT_FOUND.test(stderr) || CREDENTIALS_NEEDED.test(stderr) ? 'unavailable' : null;
}

export type RemoteHead =
  | { status: 'found'; branch: string; headSha: string }
  /** The repository has no commits, so its HEAD names no tip. */
  | { status: 'empty' }
  | { status: 'unavailable' };

export interface LsRemoteOptions {
  url: string;
  workRoot: string;
  timeoutMs?: number;
}

/** One `ls-remote --symref` gives the default branch and its tip, with no GitHub API call. */
export async function lsRemoteHead(git: GitRunner, options: LsRemoteOptions): Promise<RemoteHead> {
  const { url, workRoot, timeoutMs = LS_REMOTE_TIMEOUT_MS } = options;
  const result = await git(['ls-remote', '--symref', '--end-of-options', url, 'HEAD'], {
    cwd: workRoot,
    env: workerGitEnv(workRoot),
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    if (classifyGitFailure(result.exitCode, result.stderr) === 'unavailable') return { status: 'unavailable' };
    throw new GitCommandError('ls-remote', result);
  }
  return parseLsRemote(result.stdout);
}

export function parseLsRemote(stdout: string): RemoteHead {
  let target: string | undefined;
  let tip: string | undefined;
  for (const line of stdout.split('\n')) {
    target = /^ref: (\S+)\tHEAD$/.exec(line)?.[1] ?? target;
    tip = /^([0-9a-f]+)\tHEAD$/.exec(line)?.[1] ?? tip;
  }
  // An empty repository's HEAD points at a branch that does not exist yet, so git lists nothing.
  if (tip === undefined) return { status: 'empty' };
  if (!CommitShaSchema.safeParse(tip).success) throw new Error(`ls-remote gave HEAD as ${tip}, not a SHA-1 commit`);
  const branch = target?.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : undefined;
  if (branch === undefined) throw new Error(`ls-remote gave HEAD a tip but no default branch (${target ?? 'none'})`);
  return { status: 'found', branch, headSha: tip };
}

export interface CloneOptions {
  url: string;
  branch: string;
  /** An empty directory under the work root. */
  dir: string;
  workRoot: string;
  timeoutMs?: number;
}

/**
 * Clones the default branch's full history, and nothing else: no other branches, no tags, no
 * checkout (the analyzer reads objects only). The analyzer refuses shallow and partial clones, so
 * there is no --depth or --filter. An empty --template beats the GIT_TEMPLATE_DIR the git layer's
 * wrapper sets, so the clone has no hooks or info/ files whatever templates git carries.
 */
export async function cloneMainline(git: GitRunner, options: CloneOptions): Promise<'cloned' | 'unavailable'> {
  const { url, branch, dir, workRoot, timeoutMs = CLONE_TIMEOUT_MS } = options;
  const result = await git(
    [
      'clone',
      '--template=',
      '--single-branch',
      // One argument, so a branch name can never be read as an option.
      `--branch=${branch}`,
      '--no-tags',
      '--no-checkout',
      '--end-of-options',
      url,
      dir,
    ],
    { cwd: workRoot, env: workerGitEnv(workRoot), timeoutMs },
  );
  if (result.exitCode === 0) return 'cloned';
  if (classifyGitFailure(result.exitCode, result.stderr) === 'unavailable') return 'unavailable';
  throw new GitCommandError('clone', result);
}

/** Safe to build from a string: RepoRefSchema closes the owner and name to letters, digits, `.`, `-` and `_`. */
export function githubCloneUrl(repo: RepoRef): string {
  const { owner, name } = RepoRefSchema.parse(repo);
  return `https://github.com/${owner}/${name}.git`;
}
