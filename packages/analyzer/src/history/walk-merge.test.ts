// Scenarios with branches: which commit a line belongs to when it lands through a merge commit,
// a squash, or a merge that resolves a conflict (rule 3 of the task), and who removes it (rule 4).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  isoAt,
  labelGroups,
  makeTempDir,
  removeTempDirs,
  ScriptedRepo,
  sortGroups,
  textLines,
  walkChecked,
} from './testing.ts';
import { walkHistory } from './walk.ts';

afterAll(removeTempDirs);

describe('merges', () => {
  test('a --no-ff merge of a branch with two commits: each line belongs to the branch commit that wrote it, both land with the merge, and a line added and removed inside the branch appears nowhere', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'base 1\nbase 2\n' });
    const c1 = repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'a.txt': 'base 1\nbase 2\nfeat 1\nfeat 2\ntemp\n', 'b.txt': 'b only\n' });
    const b1 = repo.commit('feature part 1\n');
    repo.write({ 'a.txt': 'base 1\nbase 2\nfeat 1\nfeat 2\nfeat 3\n' });
    const b2 = repo.commit('feature part 2\n');
    repo.switch('main');
    repo.write({ 'other.txt': 'other\n' });
    const c2 = repo.commit('main moves on\n');
    const m = repo.merge('feature', { committedAt: '2026-03-01T12:00:00Z', authoredAt: '2026-02-28T00:00:00Z' });

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, b1, b2, m })).toEqual(
      sortGroups([
        { introducedBy: 'b1', removedBy: null, lineCount: 3 },
        { introducedBy: 'b2', removedBy: null, lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 2 },
        { introducedBy: 'c2', removedBy: null, lineCount: 1 },
      ]),
    );
    const landed = Object.fromEntries(result.commits.map((commit) => [commit.sha, commit.landedAt]));
    expect(landed[b1]).toBe('2026-03-01T12:00:00.000Z');
    expect(landed[b2]).toBe('2026-03-01T12:00:00.000Z');
    expect(result.commits.find((commit) => commit.sha === b1)?.committedAt).not.toBe('2026-03-01T12:00:00.000Z');
    expect(landed[m]).toBeUndefined();
  });

  test('a line changed in the merge commit itself (a conflict resolution) belongs to the merge commit', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'conf.txt': 'x\nshared\ny\n' });
    const c1 = repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'conf.txt': 'x\ntheirs\ny\n', 'feature-only.txt': 'f\n' });
    const b1 = repo.commit('theirs\n');
    repo.switch('main');
    repo.write({ 'conf.txt': 'x\nours\ny\n' });
    const c2 = repo.commit('ours\n');
    const m = repo.merge('feature', { resolve: { 'conf.txt': 'x\nresolved\ny\n' } });

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, b1, m })).toEqual(
      sortGroups([
        { introducedBy: 'b1', removedBy: null, lineCount: 1 },
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 2 },
        { introducedBy: 'c2', removedBy: 'm', lineCount: 1 },
        { introducedBy: 'm', removedBy: null, lineCount: 1 },
      ]),
    );
  });

  test('a squash merge: the lines belong to the squash commit', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'base\n' });
    const c1 = repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'a.txt': 'base\nfeat 1\n' });
    repo.commit('feature 1\n');
    repo.write({ 'a.txt': 'base\nfeat 1\nfeat 2\n', 'b.txt': 'b\n' });
    repo.commit('feature 2\n');
    repo.switch('main');
    repo.squash('feature');
    const s = repo.commit('Squashed feature (#1)\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, s })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: null, lineCount: 1 },
        { introducedBy: 's', removedBy: null, lineCount: 3 },
      ]),
    );
    expect(result.commits.map((commit) => commit.sha)).toEqual([c1, s]);
  });

  test('lines deleted on a branch are removed by the merge commit that lands the deletion', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': textLines('line', 4) });
    const c1 = repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'a.txt': 'line 1\nline 4\n' });
    repo.commit('delete two lines on the branch\n');
    repo.switch('main');
    repo.write({ 'b.txt': 'b\n' });
    const c2 = repo.commit('main moves on\n');
    const m = repo.merge('feature');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, m })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'm', lineCount: 2 },
        { introducedBy: 'c1', removedBy: null, lineCount: 2 },
        { introducedBy: 'c2', removedBy: null, lineCount: 1 },
      ]),
    );
  });

  test('a line blame traces to a commit already on the mainline belongs to the merge (rule 3 fallback)', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'f.txt': 'head\nL\nK\ntail\n' });
    const c1 = repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'f.txt': 'head\nL\nK2\ntail\n' });
    const b1 = repo.commit('edit K\n');
    repo.switch('main');
    repo.write({ 'f.txt': 'head\nK\ntail\n' });
    const c2 = repo.commit('delete L\n');
    // Resolved with the branch's side, which brings back L, a line the mainline had deleted.
    const m = repo.merge('feature', { resolve: { 'f.txt': 'head\nL\nK2\ntail\n' } });

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, b1, m })).toEqual(
      sortGroups([
        { introducedBy: 'b1', removedBy: null, lineCount: 1 },
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 1 },
        { introducedBy: 'c1', removedBy: 'm', lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 2 },
        { introducedBy: 'm', removedBy: null, lineCount: 1 },
      ]),
    );
  });

  test('a merge of an unrelated history: lines belong to that history root and its child, and land with the merge', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'main.txt': 'main\n' });
    const c1 = repo.commit('main root\n');
    repo.git(['switch', '--quiet', '--orphan', 'other']);
    repo.write({ 'other/one.txt': textLines('one', 2) });
    const r1 = repo.commit('other root\n');
    repo.write({ 'other/two.txt': 'two\n' });
    const r2 = repo.commit('other child\n');
    repo.switch('main');
    const m = repo.merge('other', { allowUnrelated: true });

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, r1, r2 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: null, lineCount: 1 },
        { introducedBy: 'r1', removedBy: null, lineCount: 2 },
        { introducedBy: 'r2', removedBy: null, lineCount: 1 },
      ]),
    );
    const landing = result.commits.find((commit) => commit.sha === m);
    expect(landing).toBeUndefined();
    const mergeDate = isoAt(Number(repo.git(['log', '-1', '--format=%ct', m]).trim()));
    for (const sha of [r1, r2]) expect(result.commits.find((commit) => commit.sha === sha)?.landedAt).toBe(mergeDate);
  });

  test('an octopus merge, and a branch that merged main back in before landing', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'base.txt': 'base\n' });
    const c1 = repo.commit('base\n');
    repo.switch('f1', { create: true });
    repo.write({ 'f1.txt': 'f1\n' });
    const f1 = repo.commit('f1\n');
    repo.switch('f2', { create: true, from: c1 });
    repo.write({ 'f2.txt': textLines('f2', 2) });
    const f2 = repo.commit('f2\n');
    repo.switch('main');
    repo.merge(['f1', 'f2']);
    repo.switch('feature', { create: true });
    repo.write({ 'feat.txt': 'feat 1\n' });
    const b1 = repo.commit('feature 1\n');
    repo.switch('main');
    repo.write({ 'main.txt': 'main 2\n' });
    const c2 = repo.commit('main 2\n');
    repo.switch('feature');
    repo.merge('main');
    repo.write({ 'feat.txt': 'feat 1\nfeat 2\n' });
    const b3 = repo.commit('feature 2\n');
    repo.switch('main');
    repo.merge('feature');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, f1, f2, b1, b3 })).toEqual(
      sortGroups([
        { introducedBy: 'b1', removedBy: null, lineCount: 1 },
        { introducedBy: 'b3', removedBy: null, lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 1 },
        { introducedBy: 'c2', removedBy: null, lineCount: 1 },
        { introducedBy: 'f1', removedBy: null, lineCount: 1 },
        { introducedBy: 'f2', removedBy: null, lineCount: 2 },
      ]),
    );
  });

  test('a merge with the ours strategy lands nothing from the branch', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'a\n' });
    const c1 = repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'b.txt': 'b\n' });
    repo.commit('feature\n');
    repo.switch('main');
    repo.merge('feature', { strategy: 'ours' });

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1 })).toEqual([{ introducedBy: 'c1', removedBy: null, lineCount: 1 }]);
  });

  test('paths with non-ASCII, decomposed (NFD) and quoted names edited on a branch are blamed to the branch commit', async () => {
    const repo = ScriptedRepo.create();
    // One decomposed name and never its composed twin: APFS would treat the two as one file.
    const names = [
      'naïve.txt',
      '日本語/ファイル.txt',
      'café.txt',
      'quote"d name.txt',
      'tab\there.txt',
      'back\\slash.txt',
    ];
    repo.write(Object.fromEntries(names.map((name) => [name, 'base\n'])));
    const c1 = repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write(Object.fromEntries(names.map((name) => [name, 'base\nbranch\n'])));
    const b1 = repo.commit('edit every file\n');
    repo.switch('main');
    repo.write({ 'main.txt': 'main\n' });
    const c2 = repo.commit('main\n');
    repo.merge('feature');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, b1 })).toEqual(
      sortGroups([
        { introducedBy: 'b1', removedBy: null, lineCount: names.length },
        { introducedBy: 'c1', removedBy: null, lineCount: names.length },
        { introducedBy: 'c2', removedBy: null, lineCount: 1 },
      ]),
    );
  });

  test('a file renamed on a branch from a left-out path to a measured one starts lines that belong to the merge', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'base.txt': 'base\n' });
    const c1 = repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'dist/x.js': textLines('built', 3) });
    repo.commit('add a build output\n');
    repo.move('dist/x.js', 'src/x.js');
    repo.commit('adopt it as source\n');
    repo.switch('main');
    repo.write({ 'main.txt': 'main\n' });
    const c2 = repo.commit('main\n');
    const m = repo.merge('feature');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, m })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: null, lineCount: 1 },
        { introducedBy: 'c2', removedBy: null, lineCount: 1 },
        { introducedBy: 'm', removedBy: null, lineCount: 3 },
      ]),
    );
  });

  test("a repository's own config cannot change the result", async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': textLines('a', 10), 'b.txt': 'one\ntwo\n', link: { symlink: 'a.txt' } });
    repo.gitlink('sub', '1111111111111111111111111111111111111111');
    repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.move('a.txt', 'moved.txt');
    repo.write({ 'moved.txt': textLines('a', 10).replace('a 3\n', 'A THREE\n'), 'c.txt': 'c\n  indented\n' });
    repo.commit('branch work\n');
    repo.switch('main');
    repo.write({ 'b.txt': 'one\nTWO\n' });
    repo.gitlink('sub', '2222222222222222222222222222222222222222');
    repo.commit('main work\n');
    repo.merge('feature');
    const before = await walkChecked(repo);

    const scratch = makeTempDir('code-trust-config-');
    writeFileSync(join(scratch, 'attributes'), '* binary\n');
    writeFileSync(join(scratch, 'ignore-revs'), `${repo.head()}\n`);
    writeFileSync(join(scratch, 'mailmap'), 'Someone Else <else@example.com> <ada@example.com>\n');
    writeFileSync(join(scratch, 'order'), 'b.txt\n*\n');
    const hostile: [string, string][] = [
      ['diff.algorithm', 'histogram'],
      ['diff.renames', 'copies'],
      ['diff.renameLimit', '1'],
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.submodule', 'log'],
      ['diff.context', '5'],
      ['diff.interHunkContext', '10'],
      ['diff.relative', 'true'],
      ['diff.indentHeuristic', 'false'],
      ['diff.external', '/bin/false'],
      ['diff.orderFile', join(scratch, 'order')],
      ['diff.ignoreSubmodules', 'all'],
      ['core.quotePath', 'true'],
      ['core.precomposeUnicode', 'true'],
      ['core.attributesFile', join(scratch, 'attributes')],
      ['core.abbrev', '7'],
      ['log.follow', 'true'],
      ['log.mailmap', 'true'],
      ['mailmap.file', join(scratch, 'mailmap')],
      ['log.decorate', 'full'],
      ['format.pretty', 'fuller'],
      ['color.ui', 'always'],
      ['blame.ignoreRevsFile', join(scratch, 'ignore-revs')],
      ['blame.showRoot', 'false'],
      ['i18n.logOutputEncoding', 'ISO-8859-1'],
    ];
    for (const [key, value] of hostile) repo.git(['config', key, value]);

    const after = await walkChecked(repo);

    expect(after).toEqual(before);
    expect(await walkHistory({ repoDir: repo.dir })).toEqual(before);
  });
});
