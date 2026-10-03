// Repositories the walker must refuse, each with an error that names the cause.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { assertSupportedGitVersion } from './git.ts';
import { makeTempDir, removeTempDirs, ScriptedRepo, textLines, walkChecked } from './testing.ts';
import { walkHistory } from './walk.ts';

afterAll(removeTempDirs);

function scriptSmallRepo(): ScriptedRepo {
  const repo = ScriptedRepo.create();
  for (let i = 1; i <= 3; i++) {
    repo.write({ 'a.txt': textLines('a', i) });
    repo.commit(`commit ${i}\n`);
  }
  return repo;
}

/** Writes a file at the path `git rev-parse --git-path <name>` names in `cwd`. */
function writeGitPath(repo: ScriptedRepo, cwd: string, name: string, content: string): string {
  const path = resolve(cwd, repo.git(['-C', cwd, 'rev-parse', '--git-path', name]).trim());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('refused repositories', () => {
  test('a shallow clone fails with an error that says it is shallow', async () => {
    const repo = scriptSmallRepo();
    await expect(walkHistory({ repoDir: repo.shallowClone() })).rejects.toThrow(/is a shallow clone/);
  });

  test('a directory that is not a git repository fails with an error that says so, also inside another repository', async () => {
    await expect(walkHistory({ repoDir: makeTempDir() })).rejects.toThrow(/is not a git repository/);
    const repo = scriptSmallRepo();
    const nested = join(repo.dir, 'nested');
    mkdirSync(nested);
    await expect(walkHistory({ repoDir: nested })).rejects.toThrow(/is not a git repository/);
    await expect(walkHistory({ repoDir: join(repo.dir, 'missing') })).rejects.toThrow(/does not exist/);
  });

  test('a partial clone fails with an error that says blobs are missing', async () => {
    const repo = scriptSmallRepo();
    await expect(walkHistory({ repoDir: repo.partialClone() })).rejects.toThrow(/partial clone/);
  });

  test('an unknown head fails with an error that names it', async () => {
    const repo = scriptSmallRepo();
    await expect(walkHistory({ repoDir: repo.dir, head: 'no-such-ref' })).rejects.toThrow(
      /no-such-ref is not a commit/,
    );
  });

  test('a SHA-256 repository fails with an error that names the object format', async () => {
    const repo = ScriptedRepo.create({ objectFormat: 'sha256' });
    repo.write({ 'a.txt': 'a\n' });
    repo.commit('one\n');
    await expect(walkHistory({ repoDir: repo.dir })).rejects.toThrow(/uses sha256 object names/);
  });

  test('a non-empty info/attributes fails, also when it lives in the main repository and the walk starts in a linked worktree', async () => {
    const repo = scriptSmallRepo();
    const worktree = repo.addWorktree();
    const gitDir = resolve(worktree, repo.git(['-C', worktree, 'rev-parse', '--git-dir']).trim());

    const path = writeGitPath(repo, worktree, 'info/attributes', '* -diff\n');

    expect(path).not.toContain(gitDir);
    await expect(walkHistory({ repoDir: worktree })).rejects.toThrow(/info\/attributes sets attributes/);
    await expect(walkHistory({ repoDir: repo.dir })).rejects.toThrow(/info\/attributes sets attributes/);
    writeFileSync(path, '# comments only\n\n');
    await expect(walkChecked(worktree)).resolves.toBeDefined();
  });

  test('a non-empty info/grafts fails with an error that names it', async () => {
    const repo = scriptSmallRepo();
    writeGitPath(repo, repo.dir, 'info/grafts', `${repo.head()}\n`);
    await expect(walkHistory({ repoDir: repo.dir })).rejects.toThrow(/info\/grafts rewrites commit parents/);
  });
});

describe('the git version gate', () => {
  test('git 2.40 is refused because the global --attr-source option arrived in 2.41', () => {
    expect(() => assertSupportedGitVersion('git version 2.40.1')).toThrow(
      'git 2.41 or newer is required (found 2.40.1)',
    );
    expect(() => assertSupportedGitVersion('git version 1.9.0')).toThrow(/2\.41 or newer/);
    expect(() => assertSupportedGitVersion('not git')).toThrow(/could not read the git version/);
  });

  test('2.41 and newer pass, with platform suffixes', () => {
    for (const output of [
      'git version 2.41.0',
      'git version 2.50.1 (Apple Git-155)',
      'git version 2.45.2.windows.1',
      'git version 3.0.0',
    ]) {
      expect(() => assertSupportedGitVersion(output)).not.toThrow();
    }
  });
});
