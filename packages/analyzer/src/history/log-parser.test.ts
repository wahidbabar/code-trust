// The parser on synthetic streams, byte for byte in the layout git writes (git-contract.test.ts
// pins that layout against real git). These cover what real repositories rarely reach: every split
// point, NUL bytes inside content, diff-looking text, huge lines and malformed input.
import { describe, expect, test } from 'vitest';
import { cQuote, LogParseError, MAX_HEADER_BYTES, MainlineLogParser, type ParsedCommit } from './log-parser.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const Z = '0'.repeat(40);
const BLOB1 = '1'.repeat(40);
const BLOB2 = '2'.repeat(40);

const bytes = (text: string): Buffer => Buffer.from(text, 'latin1');

/** Commit A adds a file with diff-looking content; B is a header-only record; C is whitespace-only, so its separator is the last byte. */
const STREAM = [
  `\0commit ${A}\0\n`,
  `:000000 100644 ${Z} ${BLOB1} A\0a.txt\0`,
  `:000000 120000 ${Z} ${BLOB2} A\0link\0`,
  '\0',
  'diff --git a/a.txt b/a.txt\n',
  'new file mode 100644\n',
  `index ${Z}..${BLOB1}\n`,
  '--- /dev/null\n',
  '+++ b/a.txt\n',
  '@@ -0,0 +1,6 @@\n',
  '+diff --git a/x b/x\n',
  '+\n',
  '+@@ -1 +1 @@ fake\n',
  '+ \t\r\n',
  '+a\0b\n',
  '+no newline\n',
  '\\ No newline at end of file\n',
  'diff --git a/link b/link\n',
  'new file mode 120000\n',
  `index ${Z}..${BLOB2}\n`,
  '--- /dev/null\n',
  '+++ b/link\n',
  '@@ -0,0 +1 @@\n',
  '+a.txt\n',
  '\\ No newline at end of file\n',
  `\0commit ${B}\0`,
  `\0commit ${C}\0\n`,
  `:100644 100644 ${BLOB1} ${BLOB2} M\0a.txt\0`,
  '\0',
].join('');

const EXPECTED: ParsedCommit[] = [
  {
    sha: A,
    entries: [
      {
        oldMode: 0,
        newMode: 0o100644,
        oldBlob: Z,
        newBlob: BLOB1,
        status: 'A',
        oldPath: 'a.txt',
        newPath: 'a.txt',
        sections: [
          {
            kind: 'new',
            binary: false,
            hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 6, added: Uint8Array.from([1, 0, 1, 0, 1, 1]) }],
          },
        ],
      },
      {
        oldMode: 0,
        newMode: 0o120000,
        oldBlob: Z,
        newBlob: BLOB2,
        status: 'A',
        oldPath: 'link',
        newPath: 'link',
        sections: [
          {
            kind: 'new',
            binary: false,
            hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, added: Uint8Array.from([1]) }],
          },
        ],
      },
    ],
  },
  { sha: B, entries: [] },
  {
    sha: C,
    entries: [
      {
        oldMode: 0o100644,
        newMode: 0o100644,
        oldBlob: BLOB1,
        newBlob: BLOB2,
        status: 'M',
        oldPath: 'a.txt',
        newPath: 'a.txt',
        sections: [],
      },
    ],
  },
];

function parseAll(chunks: readonly Uint8Array[]): ParsedCommit[] {
  const parser = new MainlineLogParser();
  const commits = chunks.flatMap((chunk) => parser.push(chunk));
  return [...commits, ...parser.end()];
}

describe('MainlineLogParser', () => {
  test('parses commit records, raw entries and patches, with diff-looking content, NUL bytes, markers, a header-only record and a separator as the last byte', () => {
    expect(parseAll([bytes(STREAM)])).toEqual(EXPECTED);
  });

  test('gives the same result however the stream is split', () => {
    const whole = bytes(STREAM);
    for (let split = 1; split < whole.length; split++) {
      expect(parseAll([whole.subarray(0, split), whole.subarray(split)])).toEqual(EXPECTED);
    }
    expect(parseAll([...whole].map((byte) => Uint8Array.of(byte)))).toEqual(EXPECTED);
  });

  test('accepts the layout git 2.55 writes for a whitespace-only commit (a newline, no raw entries, then the separator), and raw entries with no separator before the next commit', () => {
    const stream = bytes(
      [
        `\0commit ${A}\0\n\0`,
        `\0commit ${B}\0\n:100644 100644 ${BLOB1} ${BLOB2} M\0a.txt\0`,
        `\0commit ${C}\0\n\0`,
      ].join(''),
    );
    const expected = [
      { sha: A, entries: [] },
      {
        sha: B,
        entries: [
          {
            oldMode: 0o100644,
            newMode: 0o100644,
            oldBlob: BLOB1,
            newBlob: BLOB2,
            status: 'M',
            oldPath: 'a.txt',
            newPath: 'a.txt',
            sections: [],
          },
        ],
      },
      { sha: C, entries: [] },
    ];
    for (let split = 1; split < stream.length; split++) {
      expect(parseAll([stream.subarray(0, split), stream.subarray(split)])).toEqual(expected);
    }
  });

  test('reads hunk counts, zero-length sides, markers between removed and added lines, and function-name text after the second @@', () => {
    const stream = [
      `\0commit ${A}\0\n`,
      `:100644 100644 ${BLOB1} ${BLOB2} M\0my file.txt\0\0`,
      'diff --git a/my file.txt b/my file.txt\n',
      `index ${BLOB1}..${BLOB2} 100644\n`,
      '--- a/my file.txt\t\n',
      '+++ b/my file.txt\t\n',
      '@@ -2 +2 @@ diff --git a/q b/q @@ -1 +1 @@\n',
      '-old\n',
      '+new\n',
      '@@ -5,2 +4,0 @@ context\n',
      '-gone 1\n',
      '-gone 2\n',
      '@@ -9,0 +8,2 @@\n',
      '+one\n',
      '+\n',
      '@@ -20 +20 @@\n',
      '-last\n',
      '\\ No newline at end of file\n',
      '+last!\n',
      '\\ No newline at end of file\n',
    ].join('');

    const [commit] = parseAll([bytes(stream)]);

    expect(commit?.entries[0]?.sections[0]?.hunks).toEqual([
      { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, added: Uint8Array.from([1]) },
      { oldStart: 5, oldCount: 2, newStart: 4, newCount: 0, added: new Uint8Array(0) },
      { oldStart: 9, oldCount: 0, newStart: 8, newCount: 2, added: Uint8Array.from([1, 0]) },
      { oldStart: 20, oldCount: 1, newStart: 20, newCount: 1, added: Uint8Array.from([1]) },
    ]);
  });

  test('matches sections to raw entries by C-quoted headers, skips entries without a section, and gives a typechange both of its sections', () => {
    const stream = [
      `\0commit ${A}\0\n`,
      `:100644 100644 ${BLOB1} ${BLOB2} M\0quiet.txt\0`,
      `:100644 100644 ${BLOB1} ${BLOB2} R087\0old\tname.txt\0new "name".txt\0`,
      `:120000 100644 ${BLOB1} ${BLOB2} T\0swap\0`,
      `:100644 100644 ${BLOB1} ${BLOB2} M\0bin.dat\0`,
      '\0',
      'diff --git "a/old\\tname.txt" "b/new \\"name\\".txt"\n',
      'similarity index 87%\n',
      'rename from "old\\tname.txt"\n',
      'rename to "new \\"name\\".txt"\n',
      `index ${BLOB1}..${BLOB2} 100644\n`,
      '--- "a/old\\tname.txt"\n',
      '+++ "b/new \\"name\\".txt"\n',
      '@@ -1 +1 @@\n',
      '-x\n',
      '+y\n',
      'diff --git a/swap b/swap\n',
      'deleted file mode 120000\n',
      `index ${BLOB1}..${Z}\n`,
      '--- a/swap\n',
      '+++ /dev/null\n',
      '@@ -1 +0,0 @@\n',
      '-target\n',
      '\\ No newline at end of file\n',
      'diff --git a/swap b/swap\n',
      'new file mode 100644\n',
      `index ${Z}..${BLOB2}\n`,
      '--- /dev/null\n',
      '+++ b/swap\n',
      '@@ -0,0 +1 @@\n',
      '+text\n',
      'diff --git a/bin.dat b/bin.dat\n',
      `index ${BLOB1}..${BLOB2} 100644\n`,
      'Binary files a/bin.dat and b/bin.dat differ\n',
    ].join('');

    const [commit] = parseAll([bytes(stream)]);
    const entries = commit?.entries ?? [];

    expect(entries.map((entry) => [entry.status, entry.oldPath, entry.newPath, entry.sections.length])).toEqual([
      ['M', 'quiet.txt', 'quiet.txt', 0],
      ['R', 'old\tname.txt', 'new "name".txt', 1],
      ['T', 'swap', 'swap', 2],
      ['M', 'bin.dat', 'bin.dat', 1],
    ]);
    expect(entries[2]?.sections.map((section) => section.kind)).toEqual(['deleted', 'new']);
    expect(entries[3]?.sections[0]).toEqual({ kind: 'modified', binary: true, hunks: [] });
  });

  test('never buffers a hunk line: a 50 MB single-line hunk keeps the buffered bytes under the header cap', () => {
    const parser = new MainlineLogParser();
    const head = bytes(
      [
        `\0commit ${A}\0\n`,
        `:000000 100644 ${Z} ${BLOB1} A\0bundle.js\0\0`,
        'diff --git a/bundle.js b/bundle.js\n',
        'new file mode 100644\n',
        `index ${Z}..${BLOB1}\n`,
        '--- /dev/null\n',
        '+++ b/bundle.js\n',
        '@@ -0,0 +1 @@\n',
        '+',
      ].join(''),
    );
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    const commits = [...parser.push(head)];
    for (let sent = 0; sent < 50 * 1024 * 1024; sent += chunk.length) commits.push(...parser.push(chunk));
    commits.push(...parser.push(bytes('\n')), ...parser.end());

    expect(commits[0]?.entries[0]?.sections[0]?.hunks[0]?.added).toEqual(Uint8Array.from([1]));
    expect(parser.maxBufferedBytes).toBeLessThan(MAX_HEADER_BYTES);
    expect(parser.maxBufferedBytes).toBeLessThan(1024);
  });

  test('refuses a header line longer than the cap', () => {
    const parser = new MainlineLogParser();
    parser.push(bytes(`\0commit ${A}\0\n:000000 100644 ${Z} ${BLOB1} A\0`));
    expect(() => parser.push(new Uint8Array(MAX_HEADER_BYTES + 1).fill(0x61))).toThrow(LogParseError);
  });

  test('throws on malformed input instead of guessing', () => {
    const cases: string[] = [
      'commit without a leading NUL',
      `\0commit ${A}\0\n:000000 100644 ${Z} ${BLOB1} A\0a.txt\0\0diff --git a/a.txt b/a.txt\nunknown header\n`,
      `\0commit ${A}\0\n:000000 100644 ${Z} ${BLOB1} A\0a.txt\0\0diff --git a/b.txt b/b.txt\n`,
      `\0commit ${A}\0\n:000000 100644 ${Z} ${BLOB1} A\0a.txt\0\0diff --git a/a.txt b/a.txt\n@@ -0,0 +1 @@\n+one\n+two\n`,
      `\0commit ${A}\0\n:000000 100644 ${Z} ${BLOB1} C100\0a.txt\0b.txt\0`,
      `\0commit ${A}\0\n:000000 100644 ${Z} ${BLOB1} A\0a.txt\0\0diff --git a/a.txt b/a.txt\n\\ marker without a line\n`,
    ];
    for (const stream of cases) expect(() => parseAll([bytes(stream)]), stream).toThrow(LogParseError);
  });

  test('throws when the stream stops in the middle of a commit', () => {
    const truncated = [
      `\0commit ${A}\0\n:000000 100644 ${Z} ${BLOB1} A\0a.txt\0\0diff --git a/a.txt b/a.txt\n@@ -0,0 +1,2 @@\n+one\n`,
      `\0commit ${A}\0\n:000000 100644 ${Z} ${BLOB1} A\0a.txt\0`,
      `\0commit ${A}\0\n:000000 100644 ${Z}`,
      `\0commit ${A}`,
    ];
    for (const stream of truncated) expect(() => parseAll([bytes(stream)]), stream).toThrow(LogParseError);
  });
});

describe('cQuote', () => {
  test('quotes like git with core.quotePath=false: control bytes, DEL, quote and backslash; bytes from 0x80 stay as they are', () => {
    expect(cQuote('a/plain name.txt')).toBe('a/plain name.txt');
    expect(cQuote(Buffer.from('a/naïve 日本.txt', 'utf8').toString('latin1'))).toBe(
      Buffer.from('a/naïve 日本.txt', 'utf8').toString('latin1'),
    );
    expect(cQuote('a/tab\there')).toBe('"a/tab\\there"');
    expect(cQuote('a/say "hi"')).toBe('"a/say \\"hi\\""');
    expect(cQuote('a/back\\slash')).toBe('"a/back\\\\slash"');
    expect(cQuote('a/\x01\x07\x1b\x7f')).toBe('"a/\\001\\a\\033\\177"');
  });
});
