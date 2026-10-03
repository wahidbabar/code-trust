// Runs git with a fixed environment, so nothing on the machine (global or system config, hook
// variables, attributes, replace refs, a pager) can change what the walker reads.
import { spawn } from 'node:child_process';

/** The empty tree's id in a SHA-1 repository. Git knows it without storing it. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The global `--attr-source` option arrived in git 2.41; 2.40 only has `check-attr --source`. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 41];

/** Files above this are binary to git's diff whatever they contain. Pinned so the blob check agrees. */
export const BIG_FILE_THRESHOLD = 512 * 1024 * 1024;

/** Git looks for a NUL in this many leading bytes to call a file binary (buffer_is_binary). */
const BINARY_SNIFF_BYTES = 8000;

const STDERR_TAIL_BYTES = 64 * 1024;

// Every key here changes the output of log, diff-tree or blame when a repository's own
// .git/config sets it. Command-line -c beats every config file.
const PINNED_CONFIG = [
  'core.quotePath=false',
  // On macOS, true rewrites NFD paths in argv to NFC, so blaming an NFD-named file would fail
  // there and work on Linux.
  'core.precomposeUnicode=false',
  'core.attributesFile=/dev/null',
  'core.bigFileThreshold=512m',
  'diff.renames=true',
  'diff.renameLimit=1000',
  'diff.algorithm=myers',
  'diff.indentHeuristic=true',
  'diff.suppressBlankEmpty=false',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.relative=false',
  'log.follow=false',
  'log.mailmap=false',
  'log.showSignature=false',
  'color.ui=never',
  'i18n.logOutputEncoding=UTF-8',
];

export interface GitErrorDetails {
  args: readonly string[];
  stderr?: string;
  exitCode?: number | null;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(message: string, details: GitErrorDetails) {
    super(message);
    this.name = 'GitError';
    this.args = details.args;
    this.stderr = details.stderr ?? '';
    this.exitCode = details.exitCode ?? null;
  }
}

/**
 * The environment every git call runs with. Built from scratch: an inherited GIT_DIR or
 * GIT_INDEX_FILE (tests run from a hook, say) would point git at another repository.
 */
export function gitEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    // Git 2.44 and newer: a partial clone must never fetch blobs mid-walk. Older git ignores it,
    // and the walker refuses partial clones anyway.
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return { ...env, ...extra };
}

export interface GitOptions {
  /** Directories git must not search above, so a plain directory is never mistaken for part of a parent repository. */
  ceiling?: string;
  /** Pass `--attr-source` and the pinned config. Off only for the checks that run before the version is known. */
  pinned?: boolean;
}

export interface RunOptions {
  /** Written to stdin, then stdin is closed. */
  input?: Buffer | string;
  /** Exit codes that are answers rather than failures, such as 1 from `merge-base --is-ancestor`. */
  okExitCodes?: readonly number[];
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

/** One repository's git, with the fixed environment and pinned options. */
export class Git {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly pinned: boolean;

  constructor(cwd: string, options: GitOptions = {}) {
    this.cwd = cwd;
    this.env = gitEnv(options.ceiling === undefined ? {} : { GIT_CEILING_DIRECTORIES: options.ceiling });
    this.pinned = options.pinned ?? true;
  }

  argv(args: readonly string[]): string[] {
    // GIT_PAGER=cat already keeps git from paging, so an unpinned call carries no global option at all.
    if (!this.pinned) return [...args];
    return ['--no-pager', `--attr-source=${EMPTY_TREE}`, ...PINNED_CONFIG.flatMap((c) => ['-c', c]), ...args];
  }

  /** Runs git to completion and collects stdout. No size cap: rev-list or a blame can be many megabytes. */
  run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const argv = this.argv(args);
    return new Promise((resolve, reject) => {
      const child = spawn('git', argv, {
        cwd: this.cwd,
        env: this.env,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      const stderr = new Tail();
      let failure: Error | undefined;
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        failure ??= error;
      });
      if (options.input !== undefined && child.stdin) {
        // git may exit before reading all of stdin; the exit code then says why, not EPIPE.
        child.stdin.on('error', () => {});
        child.stdin.end(options.input);
      }
      child.on('close', (code) => {
        if (failure) {
          reject(new GitError(`could not run git ${args[0] ?? ''}: ${failure.message}`, { args }));
          return;
        }
        const exitCode = code ?? -1;
        const text = stderr.text();
        if (exitCode === 0 || options.okExitCodes?.includes(exitCode)) {
          resolve({ stdout: Buffer.concat(chunks), stderr: text, exitCode });
        } else {
          reject(gitFailure(args, exitCode, text));
        }
      });
    });
  }

  /** stdout as UTF-8 with the trailing newline removed. */
  async text(args: readonly string[], options: RunOptions = {}): Promise<string> {
    const { stdout } = await this.run(args, options);
    return stdout.toString('utf8').replace(/\n$/, '');
  }

  /**
   * Streams stdout. stderr is drained as it arrives, since a full stderr pipe would block git. A
   * non-zero exit throws after the last chunk, before the caller can mistake a truncated stream for
   * malformed output. Stopping early kills git.
   */
  async *stream(args: readonly string[], onStderr?: (chunk: Buffer) => void): AsyncGenerator<Buffer, void, undefined> {
    const child = spawn('git', this.argv(args), { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = new Tail();
    let failure: Error | undefined;
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      onStderr?.(chunk);
    });
    child.on('error', (error) => {
      failure ??= error;
    });
    const closed = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
    let done = false;
    try {
      for await (const chunk of child.stdout) yield chunk as Buffer;
      const exitCode = await closed;
      done = true;
      if (failure) throw new GitError(`could not run git ${args[0] ?? ''}: ${failure.message}`, { args });
      if (exitCode !== 0) throw gitFailure(args, exitCode, stderr.text());
    } finally {
      if (!done) {
        child.kill();
        await closed;
      }
    }
  }
}

function gitFailure(args: readonly string[], exitCode: number, stderr: string): GitError {
  const reason = stderr.trim().split('\n').at(-1) ?? '';
  return new GitError(`git ${args[0] ?? ''} exited with ${exitCode}${reason ? `: ${reason}` : ''}`, {
    args,
    stderr,
    exitCode,
  });
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

/** `[major, minor, patch]` from `git version` output, such as `git version 2.50.1 (Apple Git-155)`. */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Throws unless `output` names git 2.41 or newer. */
export function assertSupportedGitVersion(output: string): void {
  const version = parseGitVersion(output);
  const [major, minor] = MIN_GIT_VERSION;
  const found = output.trim() || 'no version output';
  if (version === null) throw new GitError(`could not read the git version from "${found}"`, { args: ['version'] });
  if (version[0] > major || (version[0] === major && version[1] >= minor)) return;
  throw new GitError(`git ${major}.${minor} or newer is required (found ${version.join('.')})`, { args: ['version'] });
}

/**
 * Paths are kept as latin1 strings so they hold git's exact bytes. Node encodes argv as UTF-8,
 * so a path goes back to git through this. A path that is not valid UTF-8 cannot be passed at all.
 */
export function pathArg(path: string): string {
  if (!isPassablePath(path)) {
    throw new GitError(
      `the path ${JSON.stringify(displayPath(path))} is not valid UTF-8, so it cannot be passed to git`,
      {
        args: [],
      },
    );
  }
  return displayPath(path);
}

/** Whether pathArg can pass `path` to git: its bytes are valid UTF-8. */
export function isPassablePath(path: string): boolean {
  return Buffer.from(displayPath(path), 'utf8').toString('latin1') === path;
}

/** A path for people to read. Lossy for bytes that are not UTF-8. */
export function displayPath(path: string): string {
  return Buffer.from(path, 'latin1').toString('utf8');
}

/** A git pathspec that matches exactly this path from the repository root. */
export function literalPathspec(path: string): string {
  return `:(top,literal)${pathArg(path)}`;
}

/** What a blob holds, line by line, by the rules the walker counts with. */
export interface BlobLines {
  /** Git's verdict: a NUL in the first 8000 bytes, or bigger than core.bigFileThreshold. Binary blobs have no lines. */
  binary: boolean;
  /** Lines, counting a last line without a newline. 0 for binary blobs. */
  lineCount: number;
  /** Lines with anything but space, tab or CR on them. */
  nonBlankCount: number;
  /** Per line, 1 when it is not blank. Only filled when asked for. */
  nonBlank: Uint8Array | null;
}

/** Splits a blob into lines while it streams, so no blob is held whole. */
export class LineCounter {
  private readonly keepFlags: boolean;
  private flags: Uint8Array;
  private lines = 0;
  private nonBlankLines = 0;
  private lineHasContent = false;
  private lineIsBlank = true;
  private seen = 0;
  private nulSeen = false;

  constructor(keepFlags: boolean) {
    this.keepFlags = keepFlags;
    this.flags = new Uint8Array(keepFlags ? 64 : 0);
  }

  push(chunk: Uint8Array): void {
    if (this.seen < BINARY_SNIFF_BYTES) {
      const sniff = chunk.subarray(0, BINARY_SNIFF_BYTES - this.seen);
      if (sniff.includes(0)) this.nulSeen = true;
    }
    this.seen += chunk.length;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (byte === 0x0a) {
        this.endLine();
      } else {
        this.lineHasContent = true;
        if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) this.lineIsBlank = false;
      }
    }
  }

  finish(size: number): BlobLines {
    if (this.lineHasContent) this.endLine();
    if (this.nulSeen || size > BIG_FILE_THRESHOLD) {
      return { binary: true, lineCount: 0, nonBlankCount: 0, nonBlank: this.keepFlags ? new Uint8Array(0) : null };
    }
    return {
      binary: false,
      lineCount: this.lines,
      nonBlankCount: this.nonBlankLines,
      nonBlank: this.keepFlags ? this.flags.slice(0, this.lines) : null,
    };
  }

  private endLine(): void {
    if (this.keepFlags) {
      if (this.lines === this.flags.length) {
        const grown = new Uint8Array(this.flags.length * 2);
        grown.set(this.flags);
        this.flags = grown;
      }
      this.flags[this.lines] = this.lineIsBlank ? 0 : 1;
    }
    if (!this.lineIsBlank) this.nonBlankLines++;
    this.lines++;
    this.lineHasContent = false;
    this.lineIsBlank = true;
  }
}

interface BlobRequest {
  sha: string;
  counter: LineCounter;
  resolve: (lines: BlobLines) => void;
  reject: (error: Error) => void;
}

/**
 * One long-lived `git cat-file --batch`. Requests are answered in order, each blob streamed
 * through a LineCounter. Open it in a try block and close it in finally: an open one keeps git
 * waiting on stdin forever.
 */
export class BlobReader {
  private readonly child: ReturnType<typeof spawn>;
  private readonly queue: BlobRequest[] = [];
  private readonly closed: Promise<number>;
  private readonly stderr = new Tail();
  private header: Buffer[] = [];
  private remaining = -1;
  private size = 0;
  private trailer = false;
  private failure: Error | undefined;

  constructor(git: Git) {
    const args = ['cat-file', '--batch'];
    this.child = spawn('git', git.argv(args), { cwd: git.cwd, env: git.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk));
    this.child.stdin?.on('error', () => {});
    this.child.on('error', (error) =>
      this.fail(new GitError(`could not run git cat-file: ${error.message}`, { args })),
    );
    this.closed = new Promise((resolve) =>
      this.child.on('close', (code) => {
        const exitCode = code ?? -1;
        this.fail(
          exitCode === 0
            ? new GitError('git cat-file has already closed', { args })
            : gitFailure(args, exitCode, this.stderr.text()),
        );
        resolve(exitCode);
      }),
    );
  }

  /** Reads a blob. `keepFlags` also returns which lines are blank. */
  read(sha: string, keepFlags = false): Promise<BlobLines> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.queue.push({ sha, counter: new LineCounter(keepFlags), resolve, reject });
      this.child.stdin?.write(`${sha}\n`);
    });
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    await this.closed;
  }

  private onData(chunk: Buffer): void {
    let pos = 0;
    while (pos < chunk.length) {
      const request = this.queue[0];
      if (!request) {
        this.fail(new GitError('git cat-file wrote output nobody asked for', { args: ['cat-file'] }));
        return;
      }
      if (this.trailer) {
        // The newline git writes after each blob's content.
        pos++;
        this.trailer = false;
        this.queue.shift();
        request.resolve(request.counter.finish(this.size));
        continue;
      }
      if (this.remaining < 0) {
        const newline = chunk.indexOf(0x0a, pos);
        if (newline < 0) {
          this.header.push(chunk.subarray(pos));
          return;
        }
        this.header.push(chunk.subarray(pos, newline));
        pos = newline + 1;
        const line = Buffer.concat(this.header).toString('latin1');
        this.header = [];
        const match = /^([0-9a-f]+) (\w+) (\d+)$/.exec(line);
        if (match?.[2] !== 'blob') {
          this.queue.shift();
          request.reject(
            new GitError(`git cat-file could not read blob ${request.sha}: ${line}`, { args: ['cat-file'] }),
          );
          continue;
        }
        this.size = Number(match[3]);
        this.remaining = this.size;
      }
      const take = Math.min(this.remaining, chunk.length - pos);
      request.counter.push(chunk.subarray(pos, pos + take));
      pos += take;
      this.remaining -= take;
      if (this.remaining === 0) {
        this.remaining = -1;
        this.trailer = true;
      }
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.queue.splice(0)) request.reject(this.failure);
  }
}
