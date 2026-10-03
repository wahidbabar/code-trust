// Scenarios about which files have lines at all: binary files, symlinks, submodules, type changes,
// and the files the left-out rules exclude.
import { afterAll, describe, expect, test } from 'vitest';
import { labelGroups, removeTempDirs, ScriptedRepo, sortGroups, textLines, walkChecked } from './testing.ts';

afterAll(removeTempDirs);

const binary = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (i * seed) % 256);

describe('files without lines', () => {
  test('binary files, symlinks and submodules contribute nothing', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'one\ntwo\n', 'image.bin': binary(7), link: { symlink: 'a.txt' } });
    repo.gitlink('sub', '1111111111111111111111111111111111111111');
    const c1 = repo.commit('add\n');
    repo.write({ 'image.bin': binary(11), link: { symlink: 'elsewhere.txt' } });
    repo.gitlink('sub', '2222222222222222222222222222222222222222');
    repo.commit('change the binary, the symlink and the submodule\n');
    repo.write({ 'image.bin': null, link: null });
    repo.git(['rm', '--cached', '--quiet', 'sub']);
    repo.commit('remove them\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1 })).toEqual([{ introducedBy: 'c1', removedBy: null, lineCount: 2 }]);
    expect(result.commits.map((commit) => commit.sha)).toEqual([c1]);
  });

  test('a file that turns binary ends its lines, one that turns text starts them, and type changes between symlink and file do both', async () => {
    const repo = ScriptedRepo.create();
    repo.write({
      'doc.txt': textLines('doc', 3),
      'data.bin': binary(3),
      'file.txt': textLines('file', 2),
      link2: { symlink: 'doc.txt' },
      // Git only looks for a NUL in the first 8000 bytes, so this is a text file with two lines.
      'late-nul.txt': `${'x'.repeat(8100)}\n\0z\n`,
    });
    const c1 = repo.commit('add\n');
    repo.write({ 'doc.txt': `\0${textLines('doc', 3)}`, 'data.bin': textLines('data', 3) });
    const c2 = repo.commit('swap text and binary\n');
    repo.write({ link2: textLines('link', 2), 'file.txt': { symlink: 'doc.txt' } });
    const c3 = repo.commit('swap symlink and file\n');

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, c3 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c2', lineCount: 3 },
        { introducedBy: 'c1', removedBy: 'c3', lineCount: 2 },
        { introducedBy: 'c1', removedBy: null, lineCount: 2 },
        { introducedBy: 'c2', removedBy: null, lineCount: 3 },
        { introducedBy: 'c3', removedBy: null, lineCount: 2 },
      ]),
    );
  });
});

describe('files left out of the metric', () => {
  function scriptLeftOutRepo(): { repo: ScriptedRepo; c1: string; c2: string; c3: string; c4: string } {
    const repo = ScriptedRepo.create();
    repo.write({
      'pnpm-lock.yaml': textLines('lock', 5),
      'vendor/lib.js': textLines('vendored', 3),
      'node_modules/x/index.js': textLines('module', 2),
      'dist/app.js': textLines('bundle', 2),
      'web/app.min.js': 'minified();\n',
      'proto/api.pb.go': textLines('generated', 2),
      'Forms/Main.Designer.cs': textLines('designer', 2),
      'src/main.ts': textLines('main', 2),
    });
    const c1 = repo.commit('add\n');
    repo.move('pnpm-lock.yaml', 'notes/lock.txt');
    const c2 = repo.commit('move the lock file somewhere measured\n');
    repo.move('src/main.ts', 'vendor/main.ts');
    const c3 = repo.commit('vendor main.ts\n');
    repo.write({ 'vendor/lib.js': textLines('vendored', 3).replace('vendored 1', 'VENDORED') });
    const c4 = repo.commit('touch only a left-out file\n');
    repo.commit('an empty commit\n', { allowEmpty: true });
    return { repo, c1, c2, c3, c4 };
  }

  test('files left out by the rule contribute nothing; a rename from a left-out path starts fresh lines owned by the renaming commit, and the reverse ends them', async () => {
    const { repo, c1, c2, c3 } = scriptLeftOutRepo();

    const result = await walkChecked(repo);

    expect(labelGroups(result, { c1, c2, c3 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c3', lineCount: 2 },
        { introducedBy: 'c2', removedBy: null, lineCount: 5 },
      ]),
    );
  });

  test('with no rules every text file is measured, and commits that touch only left-out files or nothing still line up with the mainline', async () => {
    const { repo, c1, c4 } = scriptLeftOutRepo();

    const result = await walkChecked(repo, { leftOut: [] });

    expect(labelGroups(result, { c1, c4 })).toEqual(
      sortGroups([
        { introducedBy: 'c1', removedBy: 'c4', lineCount: 1 },
        { introducedBy: 'c1', removedBy: null, lineCount: 18 },
        { introducedBy: 'c4', removedBy: null, lineCount: 1 },
      ]),
    );
  });
});
