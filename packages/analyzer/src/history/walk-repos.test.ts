// The same history must walk the same from every layout git keeps it in. Conductor workspaces are
// linked worktrees, and the worker may clone bare.
import { afterAll, expect, test } from 'vitest';
import { removeTempDirs, ScriptedRepo, textLines, walkChecked } from './testing.ts';

afterAll(removeTempDirs);

function scriptRepoWithMerges(): ScriptedRepo {
  const repo = ScriptedRepo.create();
  repo.write({ 'a.txt': textLines('a', 4) });
  repo.commit('base\n');
  repo.switch('feature', { create: true });
  repo.write({ 'a.txt': 'a 1\na 2\nfeature\na 4\n', 'b.txt': 'b\n' });
  repo.commit('feature\n');
  repo.switch('main');
  repo.write({ 'c.txt': 'c\n' });
  repo.commit('main\n');
  repo.merge('feature');
  return repo;
}

test('a walk from a linked worktree is deep-equal to the walk from the main checkout', async () => {
  const repo = scriptRepoWithMerges();
  const worktree = repo.addWorktree();

  expect(await walkChecked(worktree)).toEqual(await walkChecked(repo));
});

test('a walk of a bare clone is deep-equal to the walk of the original', async () => {
  const repo = scriptRepoWithMerges();

  expect(await walkChecked(repo.bareClone())).toEqual(await walkChecked(repo));
});
