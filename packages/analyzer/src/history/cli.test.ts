// Runs the walk script the way `pnpm walk` does, under Node's type stripping, which also proves
// everything it imports is erasable TypeScript.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { makeTempDir, removeTempDirs, ScriptedRepo, textLines } from './testing.ts';

afterAll(removeTempDirs);

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

function walk(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args],
    {
      encoding: 'utf8',
    },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('walk --check prints every summary field and exits 0 on a consistent repository', () => {
  const repo = ScriptedRepo.create();
  repo.write({ 'src/a.ts': textLines('a', 3), 'pnpm-lock.yaml': textLines('lock', 2), 'README.md': 'readme\n' });
  repo.commit('one\n');
  repo.write({ 'src/a.ts': 'a 1\nA TWO\na 3\n' });
  const head = repo.commit('two\n');

  const { status, stdout, stderr } = walk(repo.dir, '--check');

  expect(stderr).toBe('');
  expect(status).toBe(0);
  for (const line of [
    `head           ${head} (committed 2026-01-03T00:00:00.000Z)`,
    'mainline       2 commits walked (git rev-list --count --first-parent: 2)',
    'alive lines    4 in 2 files',
    'removed lines  1',
    'left out       lock files: 2 lines in 1 file',
    '               vendored: 0 lines in 0 files',
    'merges         0 (0 blame jobs, 0 ms)',
    'extensions     .ts  3 lines in 1 file',
    '               .md  1 lines in 1 file',
    'check          alive lines match the blobs at the head in all 2 measured files',
    'blame -w       100.00% of alive lines (4 of 4) name the same introducing commit as git blame -w at the head',
  ]) {
    expect(stdout).toContain(`${line}\n`);
  }
  expect(stdout).toMatch(/^wall time {6}\d+\.\d\d s$/m);
  expect(stdout).toMatch(/^peak RSS {7}\d+\.\d MiB \(node process; git children not included\)$/m);
});

test('--head walks an older commit', () => {
  const repo = ScriptedRepo.create();
  repo.write({ 'a.txt': 'a\n' });
  const first = repo.commit('one\n');
  repo.write({ 'a.txt': 'a\nb\n' });
  repo.commit('two\n');

  const { status, stdout } = walk(repo.dir, '--head', first);

  expect(status).toBe(0);
  expect(stdout).toContain(`head           ${first} `);
  expect(stdout).toContain('alive lines    1 in 1 files');
});

test('a usage error exits 2 and a walk error exits 1 with its cause', () => {
  expect(walk().status).toBe(2);
  expect(walk('--nope', '.').status).toBe(2);

  const notRepo = walk(makeTempDir());
  expect(notRepo.status).toBe(1);
  expect(notRepo.stderr).toMatch(/^walk: .* is not a git repository$/m);
});
