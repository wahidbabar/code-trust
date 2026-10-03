// Scenarios on a linear mainline: what happens to a line when its file is edited, re-indented,
// renamed, moved, deleted or misnamed. Every walk goes through walkChecked, which asserts the
// walker's invariants first.
import { afterAll, describe, expect, test } from 'vitest';
import {
  AUTHOR,
  COMMITTER,
  labelGroups,
  removeTempDirs,
  ScriptedRepo,
  sortGroups,
  textLines,
  walkChecked,
} from './testing.ts';

afterAll(removeTempDirs);

describe('linear history', () => {
  test('lines added, edited and deleted: an edited line ends, and its new version belongs to the editing commit', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'src/app.ts': 'alpha\nbeta\ngamma\ndelta\n' });
    const c1 = repo.commit('add app\n', { authoredAt: '2026-01-02T00:00:00Z', committedAt: '2026-01-02T06:00:00Z' });
    repo.write({ 'src/app.ts': 'alpha\nBETA\ngamma\ndelta\nepsilon\n' });
    const c2 = repo.commit('edit beta, add epsilon\n');
    repo.write({ 'src/app.ts': 'alpha\nBETA\ndelta\n' });
    const c3 = repo.commit('drop gamma and epsilon\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, c3 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 1 },
        { introducedBy: 'c1', removedBy: 'c3', lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 2 },
        { introducedBy: 'c2', removedBy: 'c3', lineCount: 1 },
        { introducedBy: 'c2', removedBy: null, lineCount: 1 },
      ]),
    );
    expect(result.headSha).toBe(c3);
    expect(result.headCommittedAt).toBe('2026-01-04T00:00:00.000Z');
    expect(result.commits).toEqual([
      {
        sha: c1,
        authoredAt: '2026-01-02T00:00:00.000Z',
        committedAt: '2026-01-02T06:00:00.000Z',
        landedAt: '2026-01-02T06:00:00.000Z',
        author: AUTHOR,
        committer: COMMITTER,
        message: 'add app\n',
      },
      {
        sha: c2,
        authoredAt: '2026-01-03T00:00:00.000Z',
        committedAt: '2026-01-03T00:00:00.000Z',
        landedAt: '2026-01-03T00:00:00.000Z',
        author: AUTHOR,
        committer: COMMITTER,
        message: 'edit beta, add epsilon\n',
      },
      {
        sha: c3,
        authoredAt: '2026-01-04T00:00:00.000Z',
        committedAt: '2026-01-04T00:00:00.000Z',
        landedAt: '2026-01-04T00:00:00.000Z',
        author: AUTHOR,
        committer: COMMITTER,
        message: 'drop gamma and epsilon\n',
      },
    ]);
    // Groups come in commit order, removals in mainline order, alive last.
    expect(result.groups.map((group) => [group.introducedBy, group.removedBy])).toEqual([
      [c1, c2],
      [c1, c3],
      [c1, null],
      [c2, c3],
      [c2, null],
    ]);
  });

  test('a whitespace-only edit (re-indent, trailing spaces, CRLF to LF, a final newline) keeps the line and its introducing commit', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'f.js': 'function f() {\r\nreturn 1;\r\n}\r\nlast' });
    const c1 = repo.commit('add f\n');
    repo.write({ 'f.js': '  function f() {\n\treturn 1;   \n}\nlast\n' });
    repo.commit('reformat\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1 })).toEqual([{ introducedBy: 'c1', removedBy: null, lineCount: 4 }]);
    expect(result.commits.map((commit) => commit.sha)).toEqual([c1]);
  });

  test('blank and whitespace-only lines are never counted', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'a\n\n   \n\t\nb\n \r\n', 'blank.txt': '\n  \n\t\r\n' });
    const c1 = repo.commit('add\n');
    repo.write({ 'a.txt': 'a\n\t \nb\n\n\n' });
    repo.commit('shuffle blank lines\n');
    repo.write({ 'a.txt': 'a\nc\nb\n', 'blank.txt': null });
    const c3 = repo.commit('fill a blank line, delete the blank file\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c3 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: null, lineCount: 2 },
        { introducedBy: 'c3', removedBy: null, lineCount: 1 },
      ]),
    );
  });

  test('a pure rename keeps every line; a rename with edits ends only the edited lines', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': textLines('alpha', 10), 'b.txt': textLines('beta', 10) });
    const c1 = repo.commit('add\n');
    repo.move('a.txt', 'dir/renamed.txt');
    repo.commit('pure rename\n');
    repo.move('b.txt', 'c.txt');
    repo.write({ 'c.txt': textLines('beta', 10).replace('beta 5\n', 'BETA FIVE\n') });
    const c3 = repo.commit('rename with one edit\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c3 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c3', lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 19 },
        { introducedBy: 'c3', removedBy: null, lineCount: 1 },
      ]),
    );
  });

  test('a rename that also re-indents the whole file ends every line (git pairs renames on raw bytes; a known limit)', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'src/a.ts': textLines('x', 6) });
    const c1 = repo.commit('add\n');
    repo.move('src/a.ts', 'src/lib/a.ts');
    repo.write({ 'src/lib/a.ts': textLines('x', 6).replace(/^/gm, '        ') });
    const c2 = repo.commit('move and indent\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 6 },
        { introducedBy: 'c2', removedBy: null, lineCount: 6 },
      ]),
    );
  });

  test('a block moved inside a file, and one moved to another file, ends in the old place and starts new lines that belong to the moving commit', async () => {
    const repo = ScriptedRepo.create();
    repo.write({
      'a.ts': 'block 1\nblock 2\nline 1\nline 2\nline 3\nline 4\n',
      'b.ts': 'other 1\nother 2\n',
    });
    const c1 = repo.commit('add\n');
    repo.write({ 'a.ts': 'line 1\nline 2\nline 3\nline 4\nblock 1\nblock 2\n' });
    const c2 = repo.commit('move the block down\n');
    repo.write({
      'a.ts': 'line 3\nline 4\nblock 1\nblock 2\n',
      'b.ts': 'other 1\nother 2\nline 1\nline 2\n',
    });
    const c3 = repo.commit('move two lines to b.ts\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, c3 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 2 },
        { introducedBy: 'c1', removedBy: 'c3', lineCount: 2 },
        { introducedBy: 'c1', removedBy: null, lineCount: 4 },
        { introducedBy: 'c2', removedBy: null, lineCount: 2 },
        { introducedBy: 'c3', removedBy: null, lineCount: 2 },
      ]),
    );
  });

  test('a deleted file ends all of its lines; the same path created again starts new lines', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'gone.txt': textLines('g', 3), 'keep.txt': 'keep\n' });
    const c1 = repo.commit('add\n');
    repo.write({ 'gone.txt': null });
    const c2 = repo.commit('delete\n');
    repo.write({ 'gone.txt': textLines('g', 3) });
    const c3 = repo.commit('create again\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, c3 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 3 },
        { introducedBy: 'c1', removedBy: null, lineCount: 1 },
        { introducedBy: 'c3', removedBy: null, lineCount: 3 },
      ]),
    );
  });

  test('a file with no trailing newline, a file whose content looks like diff output, and a commit message that contains diff text', async () => {
    const repo = ScriptedRepo.create();
    const patchLike = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      '-removed',
      '+added',
      ' context',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const message = 'add patch-like files\n\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-old\n+new\n';
    repo.write({ 'patch.txt': patchLike, 'tail.txt': 'first\nlast' });
    const c1 = repo.commit(message);
    repo.write({
      'patch.txt': patchLike.replace('@@ -1,2 +1,2 @@', '@@ -9,9 +9,9 @@').replace('+++ b/x', '+++ b/z'),
      'tail.txt': 'first\nLAST\nmore',
    });
    const c2 = repo.commit('edit them\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 3 },
        { introducedBy: 'c1', removedBy: null, lineCount: 7 },
        { introducedBy: 'c2', removedBy: null, lineCount: 4 },
      ]),
    );
    expect(result.commits.find((commit) => commit.sha === c1)?.message).toBe(message);
  });

  test('paths with spaces and non-ASCII characters, and names git must quote, renamed between each other', async () => {
    const repo = ScriptedRepo.create();
    repo.write({
      'dir with space/file one.txt': textLines('space', 2),
      'naïve.txt': textLines('naive', 6),
      '日本語/ファイル.md': textLines('nihongo', 2),
      'quote"d.txt': textLines('quote', 6),
      'back\\slash.txt': textLines('back', 2),
      'tab\there.txt': textLines('tab', 2),
    });
    const c1 = repo.commit('add\n');
    repo.move('naïve.txt', 'dir with space/naïve moved.txt');
    repo.move('quote"d.txt', 'tab\tand "quote".txt');
    repo.write({ 'back\\slash.txt': 'BACK 1\nback 2\n', '日本語/ファイル.md': 'nihongo 1\nnihongo 2\nnihongo 3\n' });
    const c2 = repo.commit('rename and edit\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 19 },
        { introducedBy: 'c2', removedBy: null, lineCount: 2 },
      ]),
    );
  });

  test('head set to an older commit ignores everything after it', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': textLines('a', 3) });
    const c1 = repo.commit('add\n');
    repo.write({ 'a.txt': 'a 1\na 2\na 3\nb\n' });
    const c2 = repo.commit('append\n');
    repo.write({ 'a.txt': 'b\n', 'new.txt': 'new\n' });
    repo.commit('remove and add\n');

    const bySha = await walkChecked(repo, { head: c2 });
    const byRef = await walkChecked(repo, { head: 'HEAD~1' });

    expect(byRef).toEqual(bySha);
    expect(bySha.headSha).toBe(c2);
    expect(bySha.headCommittedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(labelGroups(bySha, { c1, c2 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: null, lineCount: 3 },
        { introducedBy: 'c2', removedBy: null, lineCount: 1 },
      ]),
    );
  });

  test('committer dates that run backwards along the mainline are reported as git has them', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'one\ntwo\n' });
    const c1 = repo.commit('add\n', { authoredAt: '2026-02-01T00:00:00Z' });
    repo.write({ 'a.txt': 'one\nthree\n' });
    const c2 = repo.commit('edit with a skewed clock\n', { authoredAt: '2026-01-15T12:00:00Z' });

    const result = await walkChecked(repo);

    expect(result.commits.map((commit) => [commit.sha, commit.committedAt, commit.landedAt])).toEqual([
      [c2, '2026-01-15T12:00:00.000Z', '2026-01-15T12:00:00.000Z'],
      [c1, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
    ]);
    expect(labelGroups(result, { c1, c2 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 1 },
        { introducedBy: 'c2', removedBy: null, lineCount: 1 },
      ]),
    );
  });
});
