// Process handling: a walk that fails must not leave git running or reject a promise nobody awaits.
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BlobReader, Git, GitError, LineCounter, pathArg } from './git.ts';
import { removeTempDirs, ScriptedRepo } from './testing.ts';

afterAll(removeTempDirs);

const unhandled = vi.fn();
beforeEach(() => {
  unhandled.mockClear();
  process.on('unhandledRejection', unhandled);
});
afterEach(() => {
  process.off('unhandledRejection', unhandled);
});

function scriptRepo(): ScriptedRepo {
  const repo = ScriptedRepo.create();
  for (let i = 0; i < 20; i++) {
    repo.write({ [`f${i}.txt`]: `${'line\n'.repeat(2000)}${i}\n` });
    repo.commit(`commit ${i}\n`);
  }
  return repo;
}

describe('Git.stream', () => {
  test('a consumer that throws mid-stream stops git, and nothing is left to reject unhandled', async () => {
    const repo = scriptRepo();
    const git = new Git(repo.dir);
    let chunks = 0;
    const consume = async (): Promise<void> => {
      for await (const _chunk of git.stream(['log', '-p', 'HEAD'])) {
        chunks++;
        throw new Error('consumer failed');
      }
    };

    await expect(consume()).rejects.toThrow('consumer failed');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks).toBe(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  test("a failing git command throws a GitError carrying git's own message", async () => {
    const repo = scriptRepo();
    const consume = async (): Promise<void> => {
      for await (const _chunk of new Git(repo.dir).stream(['log', 'no-such-ref', '--'])) {
        // nothing to read
      }
    };

    const error = await consume().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toMatch(/no-such-ref/);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('BlobReader', () => {
  test('counts lines by the walker rules, rejects a missing object, and closes', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'one\n\n  \ntwo\nthree' });
    repo.commit('one\n');
    const sha = repo.git(['rev-parse', 'HEAD:a.txt']).trim();
    const reader = new BlobReader(new Git(repo.dir));
    try {
      expect(await reader.read(sha, true)).toEqual({
        binary: false,
        lineCount: 5,
        nonBlankCount: 3,
        nonBlank: Uint8Array.from([1, 0, 0, 1, 1]),
      });
      await expect(reader.read('f'.repeat(40))).rejects.toThrow(/could not read blob/);
      expect((await reader.read(sha)).nonBlankCount).toBe(3);
    } finally {
      await reader.close();
    }
  });
});

describe('LineCounter', () => {
  test('calls a blob binary only for a NUL in its first 8000 bytes', () => {
    const late = new LineCounter(false);
    late.push(Buffer.from(`${'x'.repeat(8000)}\0\n`));
    expect(late.finish(8002)).toMatchObject({ binary: false, lineCount: 1 });

    const early = new LineCounter(false);
    early.push(Buffer.from(`${'x'.repeat(7999)}\0\n`));
    expect(early.finish(8001)).toMatchObject({ binary: true, lineCount: 0 });
  });
});

describe('pathArg', () => {
  test('turns a latin1 path back into UTF-8 argv and refuses bytes that are not UTF-8', () => {
    expect(pathArg(Buffer.from('naïve/日本.txt', 'utf8').toString('latin1'))).toBe('naïve/日本.txt');
    expect(() => pathArg('caf\xe9.txt')).toThrow(/not valid UTF-8/);
  });
});

describe('BlobReader framing', () => {
  test('a read that names a tree or a missing object is rejected without shifting the answers to later reads', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'dir/a.txt': 'one\ntwo\n', 'b.bin': Buffer.from('x\0y\n'), 'c.txt': 'c\n\n' });
    repo.commit('one\n');
    const blob = (path: string): string => repo.git(['rev-parse', `HEAD:${path}`]).trim();
    const tree = repo.git(['rev-parse', 'HEAD:dir']).trim();
    const reader = new BlobReader(new Git(repo.dir));
    try {
      const reads = await Promise.allSettled([
        reader.read(blob('dir/a.txt')),
        reader.read(tree),
        reader.read('f'.repeat(40)),
        reader.read(blob('b.bin')),
        reader.read(blob('c.txt')),
      ]);
      expect(reads.map((read) => (read.status === 'fulfilled' ? read.value.nonBlankCount : read.status))).toEqual([
        2,
        'rejected',
        'rejected',
        0,
        1,
      ]);
      expect(reads[3]).toMatchObject({ status: 'fulfilled', value: { binary: true } });
      expect(reads[1]).toMatchObject({
        status: 'rejected',
        reason: { message: expect.stringMatching(/is a tree, not a blob/) },
      });
    } finally {
      await reader.close();
    }
  });
});
