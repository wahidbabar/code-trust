import { existsSync, readdirSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import {
  classifyGitFailure,
  cloneMainline,
  createGitRunner,
  GitCommandError,
  GitTimeoutError,
  githubCloneUrl,
  lsRemoteHead,
  parseLsRemote,
  workerGitEnv,
} from './git.ts';
import {
  CREDENTIALS_STDERR,
  DNS_STDERR,
  failingGit,
  makeTempDir,
  NOT_FOUND_STDERR,
  removeTempDirs,
  spyGit,
  TestRepo,
} from './testing.ts';

afterAll(removeTempDirs);
afterEach(() => {
  vi.unstubAllEnvs();
});

const git = createGitRunner();

/** Serves `listener` on a loopback port for the length of `work`. */
async function withServer<T>(listener: RequestListener, work: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await work(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('classifyGitFailure', () => {
  test("GitHub's Repository not found is unavailable", () => {
    expect(classifyGitFailure(128, NOT_FOUND_STDERR)).toBe('unavailable');
  });

  test('terminal prompts disabled is unavailable', () => {
    expect(classifyGitFailure(128, CREDENTIALS_STDERR)).toBe('unavailable');
  });

  test('Could not resolve host throws', async () => {
    expect(classifyGitFailure(128, DNS_STDERR)).toBeNull();
    const fake = failingGit(git, 'ls-remote', DNS_STDERR);
    const workRoot = makeTempDir();
    await expect(lsRemoteHead(fake.git, { url: 'https://github.com/octo-org/hello.git', workRoot })).rejects.toThrow(
      GitCommandError,
    );
    await expect(lsRemoteHead(fake.git, { url: 'https://github.com/octo-org/hello.git', workRoot })).rejects.toThrow(
      /Could not resolve host: github\.com/,
    );
  });

  test('does not appear to be a git repository throws', async () => {
    const workRoot = makeTempDir();
    // What git says for a missing file:// path. It is not one of the two patterns, so a test that
    // used a missing path to stand in for a gone repo would be testing a throw.
    const missing = `file://${join(workRoot, 'missing')}`;
    await expect(lsRemoteHead(git, { url: missing, workRoot })).rejects.toThrow(
      /does not appear to be a git repository/,
    );
  });

  test("only git's fatal exit counts: the same text with another exit code throws", () => {
    expect(classifyGitFailure(1, NOT_FOUND_STDERR)).toBeNull();
    expect(classifyGitFailure(128, 'remote: Repository not found. Try again\n')).toBeNull();
  });
});

describe('workerGitEnv', () => {
  test('git gets PATH, HOME at the work root and the fixed settings, nothing inherited', () => {
    vi.stubEnv('GIT_DIR', '/nonexistent');
    vi.stubEnv('LD_LIBRARY_PATH', '/opt/lib');
    vi.stubEnv('GIT_EXEC_PATH', '/opt/libexec/git-core');
    vi.stubEnv('HOME', '/home/someone');
    expect(workerGitEnv('/tmp/work')).toEqual({
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CEILING_DIRECTORIES: '/tmp',
      HOME: '/tmp/work',
      PATH: process.env.PATH,
    });
  });

  test('a GIT_DIR in the process does not reach git', async () => {
    const origin = TestRepo.create();
    origin.commit({ files: { 'a.ts': 'a\n' } });
    vi.stubEnv('GIT_DIR', '/nonexistent');
    const spy = spyGit(git);
    const head = await lsRemoteHead(spy.git, { url: origin.url, workRoot: makeTempDir() });
    expect(head).toEqual({ status: 'found', branch: 'main', headSha: origin.head() });
    expect(spy.calls[0]?.options.env).not.toHaveProperty('GIT_DIR');
  });
});

describe('lsRemoteHead', () => {
  test('gives the default branch and its tip, whatever the branch is called', async () => {
    const origin = TestRepo.create('trunk');
    origin.commit({ files: { 'a.ts': 'a\n' } });
    const spy = spyGit(git);
    const workRoot = makeTempDir();
    expect(await lsRemoteHead(spy.git, { url: origin.url, workRoot })).toEqual({
      status: 'found',
      branch: 'trunk',
      headSha: origin.head(),
    });
    expect(spy.calls.map((call) => call.args)).toEqual([
      ['ls-remote', '--symref', '--end-of-options', origin.url, 'HEAD'],
    ]);
    expect(spy.calls[0]?.options).toMatchObject({ cwd: workRoot, timeoutMs: 30_000 });
  });

  test('an empty repository has no tip', async () => {
    const origin = TestRepo.create();
    expect(await lsRemoteHead(git, { url: origin.url, workRoot: makeTempDir() })).toEqual({ status: 'empty' });
  });

  test('a server answering 404 "Repository not found." as GitHub does is unavailable, with real git', async () => {
    await withServer(
      (_, res) => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Repository not found.\n');
      },
      async (base) => {
        expect(await lsRemoteHead(git, { url: `${base}/octo-org/gone.git`, workRoot: makeTempDir() })).toEqual({
          status: 'unavailable',
        });
      },
    );
  });

  test('a server asking for credentials is unavailable, because git may not prompt', async () => {
    await withServer(
      (_, res) => {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
        res.end();
      },
      async (base) => {
        expect(await lsRemoteHead(git, { url: `${base}/octo-org/private.git`, workRoot: makeTempDir() })).toEqual({
          status: 'unavailable',
        });
      },
    );
  });

  test('a server that never answers trips the timeout, which throws', async () => {
    await withServer(
      () => {},
      async (base) => {
        const started = Date.now();
        await expect(
          lsRemoteHead(git, { url: `${base}/octo-org/slow.git`, workRoot: makeTempDir(), timeoutMs: 300 }),
        ).rejects.toThrow(GitTimeoutError);
        expect(Date.now() - started).toBeLessThan(5_000);
      },
    );
  });
});

describe('parseLsRemote', () => {
  test('a tip without a default branch throws rather than guess one', () => {
    expect(() => parseLsRemote(`${'a'.repeat(40)}\tHEAD\n`)).toThrow(/no default branch/);
  });

  test('a SHA-256 tip throws', () => {
    expect(() => parseLsRemote(`ref: refs/heads/main\tHEAD\n${'a'.repeat(64)}\tHEAD\n`)).toThrow(/not a SHA-1/);
  });
});

describe('cloneMainline', () => {
  test('clones full history of the one branch, with no tags, no other branch and no checkout', async () => {
    const origin = TestRepo.create();
    const first = origin.commit({ files: { 'a.ts': 'a\n' } });
    origin.git('tag', 'v1');
    origin.git('checkout', '--quiet', '-b', 'feature');
    const feature = origin.commit({ files: { 'b.ts': 'b\n' } });
    origin.git('checkout', '--quiet', 'main');
    const tip = origin.commit({ files: { 'c.ts': 'c\n' } });

    const workRoot = makeTempDir();
    const dir = join(workRoot, 'clone');
    expect(await cloneMainline(git, { url: origin.url, branch: 'main', dir, workRoot })).toBe('cloned');

    const clone = (...args: string[]) =>
      createGitRunner()(args, { cwd: dir, env: workerGitEnv(workRoot), timeoutMs: 10_000 }).then((r) =>
        r.stdout.trim(),
      );
    expect(readdirSync(dir)).toEqual(['.git']);
    expect(await clone('rev-parse', 'HEAD')).toBe(tip);
    expect(await clone('rev-list', 'HEAD')).toBe([tip, first].join('\n'));
    expect(await clone('rev-parse', '--is-shallow-repository')).toBe('false');
    expect(await clone('tag')).toBe('');
    expect((await clone('for-each-ref', '--format=%(refname)')).split('\n')).toEqual([
      'refs/heads/main',
      'refs/remotes/origin/main',
    ]);
    expect(await clone('cat-file', '-t', feature)).toBe('');
    // The empty template: no hooks, no info/ files, nothing the walker would refuse.
    expect(existsSync(join(dir, '.git', 'hooks'))).toBe(false);
    expect(existsSync(join(dir, '.git', 'info'))).toBe(false);
  });

  test('a clone that needs credentials is unavailable', async () => {
    const fake = failingGit(git, 'clone', CREDENTIALS_STDERR);
    const workRoot = makeTempDir();
    expect(
      await cloneMainline(fake.git, {
        url: 'https://github.com/octo-org/private.git',
        branch: 'main',
        dir: join(workRoot, 'c'),
        workRoot,
      }),
    ).toBe('unavailable');
  });

  test('passes the branch as one argument, so it cannot become an option', async () => {
    const spy = spyGit(git, () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const workRoot = makeTempDir();
    await cloneMainline(spy.git, { url: 'https://github.com/o/n.git', branch: '-x', dir: '/w/c', workRoot });
    expect(spy.calls[0]?.args).toEqual([
      'clone',
      '--template=',
      '--single-branch',
      '--branch=-x',
      '--no-tags',
      '--no-checkout',
      '--end-of-options',
      'https://github.com/o/n.git',
      '/w/c',
    ]);
    expect(spy.calls[0]?.options.timeoutMs).toBe(600_000);
  });
});

describe('githubCloneUrl', () => {
  test('builds the anonymous HTTPS URL from a parsed repo ref', () => {
    expect(githubCloneUrl({ id: 1, owner: 'octo-org', name: 'hello.world' })).toBe(
      'https://github.com/octo-org/hello.world.git',
    );
  });

  test('refuses a name outside the closed character set', () => {
    expect(() => githubCloneUrl({ id: 1, owner: 'octo-org', name: 'x/../../y' })).toThrow();
  });
});
