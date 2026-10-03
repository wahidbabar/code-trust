// The git behaviours the parser and walker rely on, checked against real git. If a git release
// changes one of them, this file fails before any walk goes quietly wrong.
import { afterAll, describe, expect, test } from 'vitest';
import { blame, blameArgs } from './blame.ts';
import { Git } from './git.ts';
import { mainlineLogArgs } from './log-parser.ts';
import { DEFAULT_LEFT_OUT_RULES, measuredPathspecs } from './measured-paths.ts';
import { removeTempDirs, ScriptedRepo, textLines } from './testing.ts';
import { readMainline } from './walk.ts';

afterAll(removeTempDirs);

/** The raw mainline stream, as latin1 text with NUL bytes shown as `␀`. */
async function stream(repo: ScriptedRepo, head = 'HEAD'): Promise<string> {
  const git = new Git(repo.dir);
  const sha = repo.sha(head);
  const chunks: Buffer[] = [];
  for await (const chunk of git.stream(mainlineLogArgs(sha, measuredPathspecs(DEFAULT_LEFT_OUT_RULES)))) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('latin1').replaceAll('\0', '␀');
}

describe('the mainline diff stream', () => {
  test('a commit that changes no measured file still gets a header-only record (--sparse)', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'a\n' });
    repo.commit('one\n');
    repo.write({ 'pnpm-lock.yaml': 'lock\n' });
    const lockOnly = repo.commit('lock file only\n');
    const empty = repo.commit('empty\n', { allowEmpty: true });

    const text = await stream(repo);

    expect(text).toContain(`␀commit ${lockOnly}␀␀commit ${empty}␀`);
    expect(text.endsWith(`␀commit ${empty}␀`)).toBe(true);
  });

  test('raw entries come first, then a NUL separator, then patches; a whitespace-only change gets no patch, and its separator can end the stream', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'x\n  y\n', 'b.txt': 'b\n' });
    const first = repo.commit('one\n');
    repo.write({ 'a.txt': 'x\ny\n' });
    const last = repo.commit('re-indent only\n');

    const text = await stream(repo);

    expect(text).toMatch(
      new RegExp(
        `^␀commit ${first}␀\\n:000000 100644 0{40} [0-9a-f]{40} A␀a\\.txt␀:000000 100644 0{40} [0-9a-f]{40} A␀b\\.txt␀␀diff --git a/a\\.txt b/a\\.txt\\n`,
      ),
    );
    // Git 2.50 still lists the whitespace-only change as a raw entry; git 2.55 drops it and
    // writes the separator straight after the newline. Neither writes a patch for it.
    const blobs = `${repo.git(['rev-parse', `${first}:a.txt`]).trim()} ${repo.git(['rev-parse', `${last}:a.txt`]).trim()}`;
    expect([`␀commit ${last}␀\n:100644 100644 ${blobs} M␀a.txt␀␀`, `␀commit ${last}␀\n␀`]).toContain(
      text.slice(text.lastIndexOf('␀commit ')),
    );
  });

  test('a typechange is a deletion and a creation under one header', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ swap: { symlink: 'target' } });
    repo.commit('symlink\n');
    repo.write({ swap: 'now a file\n' });
    repo.commit('file\n');

    const text = await stream(repo);
    const sections = text.split('diff --git a/swap b/swap\n').slice(1);

    expect(text).toMatch(/120000 100644 [0-9a-f]{40} [0-9a-f]{40} T␀swap␀/);
    expect(sections.at(-2)).toMatch(/^deleted file mode 120000\n/);
    expect(sections.at(-1)).toMatch(/^new file mode 100644\n/);
  });

  test('hunk headers carry function-name text, and ---/+++ lines get a TAB when the path has a space', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'my file.txt': 'function one\nbody\nfunction two\nbody\n' });
    repo.commit('one\n');
    repo.write({ 'my file.txt': 'function one\nbody\nfunction two\nBODY\n' });
    repo.commit('two\n');

    const text = await stream(repo);

    expect(text).toContain('--- a/my file.txt\t\n+++ b/my file.txt\t\n@@ -4 +4 @@ function two\n');
  });

  test('in-tree .gitattributes cannot make a text file binary (--attr-source is the empty tree)', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ '.gitattributes': '*.txt binary\n', 'a.txt': 'one\n' });
    repo.commit('one\n');
    repo.write({ 'a.txt': 'two\n' });
    repo.commit('two\n');

    const text = await stream(repo);

    expect(text).not.toContain('Binary files');
    expect(text).toContain('@@ -1 +1 @@\n-one\n+two\n');
  });
});

describe('mainline and blame', () => {
  test('the mainline log lists every parent of a merge, and a range-only blame names the branch commit', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': textLines('a', 2) });
    repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'a.txt': 'a 1\na 2\nbranch\n' });
    const branch = repo.commit('branch\n');
    repo.switch('main');
    repo.write({ 'b.txt': 'b\n' });
    const parent = repo.commit('main\n');
    const merge = repo.merge('feature');
    const git = new Git(repo.dir);

    const mainline = await readMainline(git, merge);
    const lines = await blame(git, blameArgs(`${parent}..${merge}`, 'a.txt', [[3, 3]]));

    expect(mainline.at(-1)?.parents).toEqual([parent, branch]);
    expect(lines.get(3)).toEqual({ sha: branch, filename: 'a.txt' });
  });
});
