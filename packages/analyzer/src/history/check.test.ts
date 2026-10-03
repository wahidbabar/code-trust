import { afterAll, expect, test } from 'vitest';
import { runCheck } from './check.ts';
import { countHeadLines } from './head-count.ts';
import { removeTempDirs, ScriptedRepo, textLines } from './testing.ts';
import { walkHistoryDetailed } from './walk.ts';

afterAll(removeTempDirs);

function scriptRepo(): ScriptedRepo {
  const repo = ScriptedRepo.create();
  repo.write({ 'a.txt': textLines('a', 5), 'pnpm-lock.yaml': textLines('lock', 4) });
  repo.commit('base\n');
  repo.switch('feature', { create: true });
  repo.write({ 'a.txt': 'a 1\na 2\nfeature\na 4\na 5\n', 'b.txt': 'b\n' });
  repo.commit('feature\n');
  repo.switch('main');
  repo.write({ 'a.txt': 'a 1\na 2\na 3\na 4\na 5\nmain\n' });
  repo.commit('main\n');
  repo.merge('feature');
  return repo;
}

test('on a repository with a merge, every file matches the blobs and every alive line agrees with git blame -w', async () => {
  const repo = scriptRepo();
  const details = await walkHistoryDetailed({ repoDir: repo.dir });
  const head = await countHeadLines(details.repository.git, details.result.headSha, details.rules);

  const report = await runCheck(details, head);

  expect(report).toEqual({
    files: 2,
    fileDifferences: [],
    blameCompared: 7,
    blameMatched: 7,
    blameDifferences: [],
    blameSkippedFiles: 0,
  });
  expect(head.rules[0]).toEqual({ name: 'lock files', files: 1, lines: 4 });
});

test('reports a file whose alive lines differ from its blob, and lines whose owner differs from blame', async () => {
  const repo = scriptRepo();
  const details = await walkHistoryDetailed({ repoDir: repo.dir });
  const head = await countHeadLines(details.repository.git, details.result.headSha, details.rules);
  const lines = details.files.get('a.txt') as Int32Array;
  const otherOwner = (lines[0] as number) === 0 ? 1 : 0;
  const tampered = Int32Array.from([...lines, otherOwner]);
  tampered[0] = otherOwner;
  (details.files as Map<string, Int32Array>).set('a.txt', tampered);

  const report = await runCheck(details, head);

  expect(report.fileDifferences).toEqual([{ path: 'a.txt', walker: 7, blobs: 6 }]);
  expect(report.blameMatched).toBe(report.blameCompared - 2);
  expect(report.blameDifferences.map((difference) => difference.line)).toEqual([1, 7]);
});
