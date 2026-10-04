// Runs the analyze script the way `pnpm analyze` does, under Node's type stripping, which also
// proves everything it imports is erasable TypeScript.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { makeTempDir, removeTempDirs, ScriptedRepo, textLines } from './history/testing.ts';

afterAll(removeTempDirs);

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

function analyze(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args],
    { encoding: 'utf8' },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('analyze prints each cohort and every commit outside ai, and exits 0', () => {
  // One commit a day from 2026-01-02.
  const repo = ScriptedRepo.create();
  repo.write({ 'src/human.ts': textLines('human', 4) });
  const human = repo.commit('feat: human code\n');
  repo.write({ 'src/ai.ts': textLines('ai', 3) });
  repo.commit('feat: ai code\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  repo.write({ 'deps.txt': textLines('dep', 2) });
  const bot = repo.commit('Bump deps\n', {
    author: { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' },
  });
  repo.write({ 'src/ai.ts': textLines('ai', 2) });
  const remover = repo.commit('refactor: trim\n');

  const { status, stdout, stderr } = analyze(repo.dir, '--observed-at', '2026-02-10T00:00:00.000Z');

  expect(stderr).toBe('');
  expect(status).toBe(0);
  // AI: 3 lines from day 2, 1 removed on day 4 (T = 2) and 2 alive (T = 38), so S(30) = 2/3.
  expect(stdout).toBe(
    [
      `head           ${remover} (committed 2026-01-05T00:00:00.000Z)`,
      'observed at    2026-02-10T00:00:00.000Z',
      'ai             1 commit with measured lines; 3 lines: 1 removed, 2 alive; S(30) 0.6667, S(90) unknown, S(180) unknown',
      'human          2 commits with measured lines; 4 lines: 0 removed, 4 alive; S(30) 1.0000, S(90) unknown, S(180) unknown',
      'automation     1 commit with measured lines; 2 lines: 0 removed, 2 alive; no curve',
      'outside ai     3 commits',
      `               ${human} human`,
      `               ${bot} automation`,
      `               ${remover} human`,
      '',
    ].join('\n'),
  );
});

test('--head analyzes an older commit, and a cohort without lines has no curve', () => {
  const repo = ScriptedRepo.create();
  repo.write({ 'a.txt': 'a\n' });
  const first = repo.commit('one\n');
  repo.write({ 'b.txt': 'b\n' });
  repo.commit('two\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');

  const { status, stdout } = analyze(repo.dir, '--head', first, '--observed-at', '2026-02-10T00:00:00.000Z');

  expect(status).toBe(0);
  expect(stdout).toContain(`head           ${first} `);
  expect(stdout).toContain(
    'ai             0 commits with measured lines; 0 lines: 0 removed, 0 alive; no curve: no lines\n',
  );
});

test('a usage error exits 2 and an analysis error exits 1 with its cause', () => {
  expect(analyze().status).toBe(2);
  expect(analyze('--nope', '.').status).toBe(2);
  const badTime = analyze('.', '--observed-at', '2026-02-10');
  expect(badTime.status).toBe(2);
  expect(badTime.stderr).toMatch(/^--observed-at: .*UTC ISO timestamp/m);

  const notRepo = analyze(makeTempDir());
  expect(notRepo.status).toBe(1);
  expect(notRepo.stderr).toMatch(/^analyze: .* is not a git repository$/m);
});
