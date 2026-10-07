// Test support: git repositories built in temp directories with fixed identities and dates, git
// runners that fake or record, and helpers that compare stored rows with an analysis. Only tests
// import this module; src/lambda.ts never reaches it, so it stays out of the bundle.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GitRunner, GitRunOptions, GitRunResult } from './git.ts';

export interface Identity {
  name: string;
  email: string;
}

// Made up: the repository is public, so fixtures never carry a real person's name or email.
export const HUMAN: Identity = { name: 'Ada Example', email: 'ada@example.com' };
export const DEPENDABOT: Identity = {
  name: 'dependabot[bot]',
  email: '49699333+dependabot[bot]@users.noreply.github.com',
};
export const AI_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/** 2026-01-01T00:00:00Z. Each commit lands one day after the previous one. */
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const DAY = 86_400;

// The builder's own settings. core.excludesFile matters: git reads ~/.config/git/ignore even with
// GIT_CONFIG_GLOBAL=/dev/null.
const BUILDER_CONFIG = [
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'core.autocrlf=false',
  'core.excludesFile=/dev/null',
  'core.hooksPath=/dev/null',
  'gc.auto=0',
  'maintenance.auto=false',
  'advice.detachedHead=false',
];

const tempDirs = new Set<string>();

/** A fresh temp directory, removed by removeTempDirs(). */
export function makeTempDir(prefix = 'code-trust-worker-'): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  tempDirs.add(dir);
  return dir;
}

/** Removes every temp directory this process created. Call it from afterAll. */
export function removeTempDirs(): void {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

function builderEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: tmpdir(),
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export interface CommitOptions {
  /** Path to new content, or null to delete the file. */
  files: Record<string, string | null>;
  author?: Identity;
  /** Adds Claude Code's trailer, which makes the commit `ai`. */
  ai?: boolean;
  message?: string;
}

/** A non-bare repository that jobs clone over file://. Tests change its history directly. */
export class TestRepo {
  readonly dir: string;
  private commits = 0;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static create(branch = 'main'): TestRepo {
    const repo = new TestRepo(join(makeTempDir('code-trust-origin-'), 'origin'));
    mkdirSync(repo.dir);
    repo.git('init', '--quiet', `--initial-branch=${branch}`);
    return repo;
  }

  get url(): string {
    return `file://${this.dir}`;
  }

  git(...args: string[]): string {
    return this.gitWith({}, args);
  }

  head(): string {
    return this.git('rev-parse', 'HEAD');
  }

  commit({ files, author = HUMAN, ai = false, message }: CommitOptions): string {
    for (const [path, content] of Object.entries(files)) {
      const file = join(this.dir, path);
      if (content === null) {
        rmSync(file, { force: true });
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
    }
    this.git('add', '--all');
    this.commits += 1;
    const date = `@${BASE_TIME + this.commits * DAY} +0000`;
    const subject = message ?? `change ${this.commits}`;
    this.gitWith(
      {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: date,
      },
      ['commit', '--quiet', '--allow-empty', '--message', ai ? `${subject}\n\n${AI_TRAILER}` : subject],
    );
    return this.head();
  }

  /** What a force-push leaves on the remote: the branch moved back to `sha`. */
  resetHard(sha: string): void {
    this.git('reset', '--quiet', '--hard', sha);
  }

  private gitWith(env: Record<string, string>, args: string[]): string {
    return execFileSync('git', [...BUILDER_CONFIG.flatMap((c) => ['-c', c]), ...args], {
      cwd: this.dir,
      env: builderEnv(env),
      encoding: 'utf8',
    }).trim();
  }
}

/** Lines `from` to `to` of a file, each naming its file and number so no two lines anywhere are alike. */
export function lines(file: string, from: number, to: number): string {
  let text = '';
  for (let i = from; i <= to; i++) text += `${file} line ${i}\n`;
  return text;
}

/**
 * `count` commits cycling through AI, human, human, dependabot. Each adds a file and rewrites the
 * first two lines of the file from two commits back, so every cohort has removed lines and alive ones.
 */
export function buildHistory(repo: TestRepo, count: number, prefix = 'f'): string[] {
  const shas: string[] = [];
  for (let i = 0; i < count; i++) {
    const files: Record<string, string> = { [`src/${prefix}${i}.ts`]: lines(`${prefix}${i}`, 1, 6) };
    if (i >= 2) {
      const old = `${prefix}${i - 2}`;
      files[`src/${old}.ts`] = `${lines(`${old}-rewrite`, 1, 2)}${lines(old, 3, 6)}`;
    }
    const kind = i % 4;
    shas.push(repo.commit({ files, ai: kind === 0, author: kind === 3 ? DEPENDABOT : HUMAN }));
  }
  return shas;
}

export interface RecordedCall {
  args: readonly string[];
  options: GitRunOptions;
}

/** Wraps a runner and records every call. `answer` may replace git's result for a call. */
export function spyGit(
  inner: GitRunner,
  answer?: (args: readonly string[], options: GitRunOptions) => GitRunResult | undefined,
): { git: GitRunner; calls: RecordedCall[]; commands: () => string[] } {
  const calls: RecordedCall[] = [];
  const git: GitRunner = async (args, options) => {
    calls.push({ args, options });
    return answer?.(args, options) ?? inner(args, options);
  };
  return { git, calls, commands: () => calls.map((call) => call.args[0] ?? '') };
}

/** GitHub's stderr for a repo that does not exist, or is private, to an anonymous client. */
export const NOT_FOUND_STDERR =
  "remote: Repository not found.\nfatal: repository 'https://github.com/octo-org/gone.git/' not found\n";
export const CREDENTIALS_STDERR =
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
export const DNS_STDERR =
  "fatal: unable to access 'https://github.com/octo-org/hello.git/': Could not resolve host: github.com\n";

/** A runner that fails `command` with git's fatal exit and `stderr`, and runs everything else for real. */
export function failingGit(inner: GitRunner, command: string, stderr: string) {
  return spyGit(inner, (args) => (args[0] === command ? { exitCode: 128, stdout: '', stderr } : undefined));
}
