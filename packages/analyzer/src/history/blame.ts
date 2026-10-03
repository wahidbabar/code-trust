// git blame, for the two places the walker needs it: lines a merge commit adds (rule 3 of the
// task: the introducing commit is the one blame names at the merge), and the --check comparison
// at the head.
import { availableParallelism } from 'node:os';
import { type Git, pathArg } from './git.ts';

/** Past this many line ranges a merge blames the whole file instead of passing -L for each. */
export const MAX_BLAME_RANGES = 1000;

export interface BlamedLine {
  sha: string;
  /** The file's path in that commit, as git prints it (C-quoted when it needs quoting). Differs from the blamed path after a rename. */
  filename: string;
}

/**
 * Blame arguments. `range` is `<P>..<M>` at a merge or the head SHA at --check; git refuses a
 * separate commit next to a range. The diff algorithm and indent heuristic come from the pinned
 * config, the same as the log stream, so both align lines alike.
 */
export function blameArgs(
  range: string,
  path: string,
  lineRanges: readonly (readonly [number, number])[] = [],
): string[] {
  const args = ['blame', '--line-porcelain', '-w', '--root', '--no-textconv', '--no-ignore-revs-file'];
  if (lineRanges.length <= MAX_BLAME_RANGES) {
    for (const [first, last] of lineRanges) args.push('-L', `${first},${last}`);
  }
  args.push(range, '--', pathArg(path));
  return args;
}

/** Runs blame and returns the answer for each final line number (1-based). */
export async function blame(git: Git, args: readonly string[]): Promise<Map<number, BlamedLine>> {
  const { stdout } = await git.run(args);
  return parseLinePorcelain(stdout.toString('latin1'));
}

/**
 * Parses `--line-porcelain`: per line a header `<sha> <orig> <final>[ <count>]`, then key lines,
 * then the content prefixed by a TAB. Every line carries its own `filename`.
 */
export function parseLinePorcelain(output: string): Map<number, BlamedLine> {
  const lines = new Map<number, BlamedLine>();
  const rows = output.split('\n');
  let i = 0;
  while (i < rows.length) {
    const header = rows[i] as string;
    if (header === '' && i === rows.length - 1) break;
    const match = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(header);
    if (!match) throw new Error(`unexpected git blame output: ${JSON.stringify(header.slice(0, 80))}`);
    let filename: string | null = null;
    i++;
    for (; i < rows.length && !(rows[i] as string).startsWith('\t'); i++) {
      const row = rows[i] as string;
      if (row.startsWith('filename ')) filename = row.slice('filename '.length);
    }
    if (i >= rows.length) throw new Error('git blame output ended before a line');
    i++; // the content line
    if (filename === null) throw new Error(`git blame printed no filename for line ${match[2]}`);
    lines.set(Number(match[2]), { sha: match[1] as string, filename });
  }
  return lines;
}

const UNESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/** Undoes git's C-style path quoting. Works on latin1 strings, one character per byte. */
export function cUnquote(text: string): string {
  if (!text.startsWith('"')) return text;
  if (!text.endsWith('"') || text.length < 2) throw new Error(`badly quoted path ${JSON.stringify(text)}`);
  let out = '';
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i] as string;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[i + 1] as string;
    const escaped = UNESCAPES[next];
    if (escaped !== undefined) {
      out += String.fromCharCode(escaped);
      i++;
    } else if (/^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) {
      out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      throw new Error(`badly quoted path ${JSON.stringify(text)}`);
    }
  }
  return out;
}

/** Limits how many git processes run at once. */
export class Pool {
  private readonly size: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(size = Math.max(1, availableParallelism())) {
    this.size = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // A finishing task hands its slot straight to the next waiter, so a new caller can never
    // slip in between and push the count past the limit.
    if (this.running >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

/** Contiguous `[first, last]` ranges (1-based, inclusive) covering the given line numbers. */
export function toRanges(lineNumbers: readonly number[]): [number, number][] {
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last && line <= last[1] + 1) last[1] = Math.max(last[1], line);
    else ranges.push([line, line]);
  }
  return ranges;
}
