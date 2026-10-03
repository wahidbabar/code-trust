// Parses the mainline diff stream: one `git log -z --raw -p -U0` over the first-parent chain.
//
// The parser is driven by NUL separators and hunk header counts, never by what a line looks like:
// file content and commit messages can contain anything, diff headers included, and a text file
// can even hold NUL bytes past its first 8000. Per commit git writes:
//
//   \0commit <sha>\0                         the format, then -z's terminator
//   \n                                       only when a diff follows
//   :<om> <nm> <os> <ns> <status>\0<path>\0  one raw entry per file; renames carry two paths
//   \0                                       the separator, always after the raw entries
//   diff --git a/<old> b/<new>\n ...         patch sections; a whitespace-only change has none
//
// Hunk body lines are consumed in place and never buffered, so a many-megabyte minified line
// costs nothing. Only header lines are buffered, up to MAX_HEADER_BYTES.

/** Matches COMMIT_FORMAT: the format is followed by -z's NUL terminator. */
const COMMIT_FORMAT = '%x00commit %H';

/** The longest header line accepted: paths, raw fields and `@@` lines are all far shorter. */
export const MAX_HEADER_BYTES = 1024 * 1024;

const NUL = 0x00;
const LF = 0x0a;
const COLON = 0x3a;
const PLUS = 0x2b;
const MINUS = 0x2d;
const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const BACKSLASH = 0x5c;

/** The arguments for the mainline diff stream. Each one pins something a repository's config could change. */
export function mainlineLogArgs(head: string, pathspecs: readonly string[]): string[] {
  return [
    'log',
    head,
    '--first-parent',
    // Without it, a pathspec hides commits that change no measured file (a lockfile bump), and
    // the stream would no longer line up with the mainline.
    '--sparse',
    '--diff-merges=first-parent',
    '--reverse',
    '--root',
    `--format=${COMMIT_FORMAT}`,
    '-z',
    '--raw',
    '--no-abbrev',
    '--full-index',
    '-p',
    '-U0',
    '--inter-hunk-context=0',
    '-w',
    '--diff-algorithm=myers',
    '--indent-heuristic',
    '-M50%',
    '-l1000',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--submodule=short',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--no-relative',
    '-O/dev/null',
    '--no-use-mailmap',
    '--no-show-signature',
    '--no-notes',
    '--',
    ...pathspecs,
  ];
}

export interface Hunk {
  /** As in `@@ -oldStart,oldCount +newStart,newCount @@`. A zero count names the line before the change. */
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** One flag per added line: 1 when it has anything but space, tab or CR. */
  added: Uint8Array;
}

export interface Section {
  /** From `new file mode` or `deleted file mode`; `modified` otherwise (including renames). */
  kind: 'new' | 'deleted' | 'modified';
  /** Git printed `Binary files ... differ`: at least one side is binary. */
  binary: boolean;
  hunks: Hunk[];
}

export interface RawEntry {
  /** 0 when the side does not exist. */
  oldMode: number;
  newMode: number;
  oldBlob: string;
  newBlob: string;
  /** One letter: A, D, M, R or T. */
  status: string;
  /** Paths as latin1 strings, so they hold git's exact bytes. Equal unless renamed. */
  oldPath: string;
  newPath: string;
  /** Patch sections: none for whitespace-only or mode-only changes, two for a typechange. */
  sections: Section[];
}

export interface ParsedCommit {
  sha: string;
  entries: RawEntry[];
}

export class LogParseError extends Error {
  constructor(message: string) {
    super(`unexpected git log output: ${message}`);
    this.name = 'LogParseError';
  }
}

type State =
  | 'commit' // at a commit record: expect NUL
  | 'after-header' // expect LF (a diff follows), NUL (next commit) or the end
  | 'raw' // expect ':' (a raw entry) or NUL (the separator)
  | 'line' // at the start of a patch line
  | 'body-start' // at the start of a hunk body line
  | 'body'; // inside a hunk body line

type TokenKind = 'commit-header' | 'raw-meta' | 'raw-path' | 'line';

/**
 * Push-based: feed chunks as they arrive, collect each commit when it is complete. Feeding the
 * same bytes split anywhere gives the same result.
 */
export class MainlineLogParser {
  private state: State = 'commit';
  /** Set while a NUL- or LF-terminated token is being buffered. */
  private token: { kind: TokenKind; terminator: number } | null = null;
  private carry: Buffer[] = [];
  private carryBytes = 0;
  private highWater = 0;

  private commit: ParsedCommit | null = null;
  private pendingRaw: { meta: RegExpExecArray; paths: string[] } | null = null;
  /** Index of the next raw entry a patch section may match. */
  private nextEntry = 0;
  private entry: RawEntry | null = null;
  private section: Section | null = null;
  private hunk: Hunk | null = null;
  private oldLeft = 0;
  private newLeft = 0;
  private addedIndex = 0;
  private bodyKind = 0;
  private bodyBlank = true;
  private lastWasBody = false;
  private done: ParsedCommit[] = [];

  /** The most bytes ever buffered for one unfinished header line or token. */
  get maxBufferedBytes(): number {
    return this.highWater;
  }

  push(chunk: Uint8Array): ParsedCommit[] {
    let pos = 0;
    while (pos < chunk.length) {
      if (this.token) {
        pos = this.readToken(chunk, pos);
        continue;
      }
      const byte = chunk[pos] as number;
      switch (this.state) {
        case 'commit':
          if (byte !== NUL) throw new LogParseError(`expected a commit record, found byte ${byte}`);
          pos++;
          this.startToken('commit-header', NUL);
          break;
        case 'after-header':
          if (byte === LF) {
            pos++;
            this.state = 'raw';
          } else if (byte === NUL) {
            this.finishCommit();
          } else {
            throw new LogParseError(`expected a newline or NUL after commit ${this.commit?.sha}`);
          }
          break;
        case 'raw':
          if (byte === COLON) {
            this.startToken('raw-meta', NUL);
          } else if (byte === NUL) {
            if (this.currentCommit().entries.length === 0) {
              this.finishCommit();
            } else {
              pos++; // the separator between raw entries and patches
              this.state = 'line';
            }
          } else {
            throw new LogParseError(`expected a raw entry in commit ${this.commit?.sha}, found byte ${byte}`);
          }
          break;
        case 'line':
          if (byte === NUL) this.finishCommit();
          else this.startToken('line', LF);
          break;
        case 'body-start':
          pos = this.startBodyLine(byte, pos);
          break;
        case 'body':
          pos = this.readBody(chunk, pos);
          break;
      }
    }
    return this.drain();
  }

  /** Call once the stream has ended. Throws if it ended in the middle of something. */
  end(): ParsedCommit[] {
    if (this.token || this.state === 'body' || this.state === 'body-start') {
      throw new LogParseError('the stream ended in the middle of a commit');
    }
    if (this.state === 'raw' && this.commit && this.commit.entries.length > 0) {
      throw new LogParseError(`the stream ended after the raw entries of ${this.commit.sha}, without a separator`);
    }
    if (this.commit) this.finishCommit();
    return this.drain();
  }

  private drain(): ParsedCommit[] {
    const done = this.done;
    this.done = [];
    return done;
  }

  private currentCommit(): ParsedCommit {
    if (!this.commit) throw new LogParseError('a diff without a commit header');
    return this.commit;
  }

  private startToken(kind: TokenKind, terminator: number): void {
    this.token = { kind, terminator };
  }

  private readToken(chunk: Uint8Array, pos: number): number {
    const token = this.token as { kind: TokenKind; terminator: number };
    const end = chunk.indexOf(token.terminator, pos);
    const stop = end < 0 ? chunk.length : end;
    if (stop > pos) {
      this.carry.push(Buffer.from(chunk.subarray(pos, stop)));
      this.carryBytes += stop - pos;
      this.highWater = Math.max(this.highWater, this.carryBytes);
      if (this.carryBytes > MAX_HEADER_BYTES) {
        throw new LogParseError(`a header line longer than ${MAX_HEADER_BYTES} bytes`);
      }
    }
    if (end < 0) return chunk.length;
    const text = Buffer.concat(this.carry, this.carryBytes).toString('latin1');
    this.carry = [];
    this.carryBytes = 0;
    this.token = null;
    this.onToken(token.kind, text);
    return end + 1;
  }

  private onToken(kind: TokenKind, text: string): void {
    switch (kind) {
      case 'commit-header':
        this.onCommitHeader(text);
        return;
      case 'raw-meta':
        this.onRawMeta(text);
        return;
      case 'raw-path':
        this.onRawPath(text);
        return;
      case 'line':
        this.onLine(text);
        return;
    }
  }

  private onCommitHeader(text: string): void {
    const match = /^commit ([0-9a-f]{40})$/.exec(text);
    if (!match?.[1]) throw new LogParseError(`bad commit header ${JSON.stringify(text.slice(0, 80))}`);
    this.commit = { sha: match[1], entries: [] };
    this.nextEntry = 0;
    this.entry = null;
    this.section = null;
    this.lastWasBody = false;
    this.state = 'after-header';
  }

  private onRawMeta(text: string): void {
    const meta = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])(\d*)$/.exec(text);
    if (!meta) throw new LogParseError(`bad raw entry ${JSON.stringify(text.slice(0, 120))}`);
    const status = meta[5];
    if (status !== 'A' && status !== 'D' && status !== 'M' && status !== 'R' && status !== 'T') {
      throw new LogParseError(`raw status ${status} in commit ${this.commit?.sha}; copies are never detected`);
    }
    this.pendingRaw = { meta, paths: [] };
    this.startToken('raw-path', NUL);
  }

  private onRawPath(path: string): void {
    const pending = this.pendingRaw;
    if (!pending) throw new LogParseError('a raw path without its entry');
    pending.paths.push(path);
    const status = pending.meta[5] as string;
    if (status === 'R' && pending.paths.length < 2) {
      this.startToken('raw-path', NUL);
      return;
    }
    const [, oldMode, newMode, oldBlob, newBlob] = pending.meta;
    const oldPath = pending.paths[0] as string;
    this.currentCommit().entries.push({
      oldMode: Number.parseInt(oldMode as string, 8),
      newMode: Number.parseInt(newMode as string, 8),
      oldBlob: oldBlob as string,
      newBlob: newBlob as string,
      status,
      oldPath,
      newPath: pending.paths[1] ?? oldPath,
      sections: [],
    });
    this.pendingRaw = null;
    this.state = 'raw';
  }

  private onLine(line: string): void {
    const wasBody = this.lastWasBody;
    this.lastWasBody = false;
    if (line.startsWith('diff --git ')) {
      this.startSection(line);
      return;
    }
    if (line.startsWith('@@ ')) {
      this.startHunk(line);
      return;
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file", after the line it describes.
      if (!wasBody) throw new LogParseError(`a "\\" line that follows no hunk line in ${this.commit?.sha}`);
      return;
    }
    const section = this.section;
    if (!section || section.hunks.length > 0) {
      throw new LogParseError(`unexpected line ${JSON.stringify(line.slice(0, 80))} in ${this.commit?.sha}`);
    }
    if (line.startsWith('new file mode ')) section.kind = 'new';
    else if (line.startsWith('deleted file mode ')) section.kind = 'deleted';
    else if (line.startsWith('Binary files ') && line.endsWith(' differ')) section.binary = true;
    else if (!EXTENDED_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      throw new LogParseError(`unknown patch header ${JSON.stringify(line.slice(0, 80))} in ${this.commit?.sha}`);
    }
  }

  private startSection(line: string): void {
    const entries = this.currentCommit().entries;
    // A typechange is printed as a deletion and a creation under the same header.
    const current = this.entry;
    if (current?.status === 'T' && current.sections.length === 1 && line === sectionHeader(current)) {
      this.openSection(current);
      return;
    }
    for (let i = this.nextEntry; i < entries.length; i++) {
      const entry = entries[i] as RawEntry;
      if (line === sectionHeader(entry)) {
        this.nextEntry = i + 1;
        this.openSection(entry);
        return;
      }
    }
    throw new LogParseError(`patch ${JSON.stringify(line.slice(0, 120))} matches no raw entry of ${this.commit?.sha}`);
  }

  private openSection(entry: RawEntry): void {
    this.entry = entry;
    this.section = { kind: 'modified', binary: false, hunks: [] };
    entry.sections.push(this.section);
  }

  private startHunk(line: string): void {
    const section = this.section;
    if (!section) throw new LogParseError(`a hunk outside any patch in ${this.commit?.sha}`);
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) throw new LogParseError(`bad hunk header ${JSON.stringify(line.slice(0, 80))}`);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (oldCount + newCount === 0) throw new LogParseError(`an empty hunk in ${this.commit?.sha}`);
    this.hunk = {
      oldStart: Number(match[1]),
      oldCount,
      newStart: Number(match[3]),
      newCount,
      added: new Uint8Array(newCount),
    };
    section.hunks.push(this.hunk);
    this.oldLeft = oldCount;
    this.newLeft = newCount;
    this.addedIndex = 0;
    this.state = 'body-start';
  }

  private startBodyLine(byte: number, pos: number): number {
    if (byte === BACKSLASH) {
      // A "\ No newline at end of file" line between the removed and the added lines.
      if (!this.lastWasBody) throw new LogParseError(`a "\\" line that follows no hunk line in ${this.commit?.sha}`);
      this.startToken('line', LF);
      this.state = 'body-start';
      return pos;
    }
    if (byte === MINUS) {
      if (this.oldLeft === 0)
        throw new LogParseError(`more removed lines than the hunk header says in ${this.commit?.sha}`);
    } else if (byte === PLUS) {
      if (this.newLeft === 0)
        throw new LogParseError(`more added lines than the hunk header says in ${this.commit?.sha}`);
    } else {
      throw new LogParseError(`a hunk line starting with byte ${byte} in ${this.commit?.sha}`);
    }
    this.bodyKind = byte;
    this.bodyBlank = true;
    this.state = 'body';
    return pos + 1;
  }

  private readBody(chunk: Uint8Array, pos: number): number {
    const end = chunk.indexOf(LF, pos);
    const stop = end < 0 ? chunk.length : end;
    if (this.bodyKind === PLUS && this.bodyBlank) {
      for (let i = pos; i < stop; i++) {
        const byte = chunk[i];
        if (byte !== SPACE && byte !== TAB && byte !== CR) {
          this.bodyBlank = false;
          break;
        }
      }
    }
    if (end < 0) return chunk.length;
    if (this.bodyKind === MINUS) {
      this.oldLeft--;
    } else {
      (this.hunk as Hunk).added[this.addedIndex++] = this.bodyBlank ? 0 : 1;
      this.newLeft--;
    }
    this.lastWasBody = true;
    this.state = this.oldLeft + this.newLeft > 0 ? 'body-start' : 'line';
    return end + 1;
  }

  private finishCommit(): void {
    const commit = this.currentCommit();
    this.done.push(commit);
    this.commit = null;
    this.entry = null;
    this.section = null;
    this.state = 'commit';
  }
}

const EXTENDED_HEADER_PREFIXES = [
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'index ',
  // Consumed by prefix only: git appends a TAB to these when the path has a space, and sections
  // without hunks have none.
  '--- ',
  '+++ ',
];

function sectionHeader(entry: RawEntry): string {
  return `diff --git ${cQuote(`a/${entry.oldPath}`)} ${cQuote(`b/${entry.newPath}`)}`;
}

const C_ESCAPES = new Map<number, string>([
  [0x07, '\\a'],
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0b, '\\v'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x22, '\\"'],
  [0x5c, '\\\\'],
]);

/**
 * Git's C-style quoting of a path as `core.quotePath=false` prints it (quote.c): control bytes,
 * DEL, `"` and `\` are escaped and the whole name is wrapped in quotes; bytes from 0x80 stay as
 * they are. Works on latin1 strings, one character per byte.
 */
export function cQuote(path: string): string {
  let needsQuotes = false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c) {
      needsQuotes = true;
      break;
    }
  }
  if (!needsQuotes) return path;
  let quoted = '"';
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    const escaped = C_ESCAPES.get(code);
    if (escaped !== undefined) quoted += escaped;
    else if (code < 0x20 || code === 0x7f) quoted += `\\${code.toString(8).padStart(3, '0')}`;
    else quoted += path[i];
  }
  return `${quoted}"`;
}
