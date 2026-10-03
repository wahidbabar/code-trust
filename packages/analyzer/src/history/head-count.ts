// Counts lines straight from the head's blobs, without the line tracker: the reference the
// walker's alive lines are checked against (walk --check and the test invariants).
import { BlobReader, EMPTY_TREE, type Git } from './git.ts';
import { type LeftOutRule, measuredPathspecs, rulePathspecs } from './measured-paths.ts';

export interface RuleCount {
  name: string;
  files: number;
  lines: number;
}

export interface HeadCount {
  /** Non-blank lines per measured text file, keyed by latin1 path. Binary files are absent. */
  files: Map<string, number>;
  /** Per left-out rule, the text files it leaves out and their non-blank lines. */
  rules: RuleCount[];
}

export async function countHeadLines(git: Git, headSha: string, rules: readonly LeftOutRule[]): Promise<HeadCount> {
  const blobs = new BlobReader(git);
  try {
    const files = await countFiles(git, blobs, headSha, measuredPathspecs(rules));
    const ruleCounts: RuleCount[] = [];
    for (let i = 0; i < rules.length; i++) {
      const counted = await countFiles(git, blobs, headSha, rulePathspecs(rules, i));
      let lines = 0;
      for (const count of counted.values()) lines += count;
      ruleCounts.push({ name: (rules[i] as LeftOutRule).name, files: counted.size, lines });
    }
    return { files, rules: ruleCounts };
  } finally {
    await blobs.close();
  }
}

/** Regular text files matched by `pathspecs` at `headSha`, with their non-blank lines. Matching is git's. */
async function countFiles(
  git: Git,
  blobs: BlobReader,
  headSha: string,
  pathspecs: readonly string[],
): Promise<Map<string, number>> {
  // ls-tree rejects glob and exclude pathspecs; diff-tree against the empty tree takes them.
  const { stdout } = await git.run([
    'diff-tree',
    '-r',
    '-z',
    '--raw',
    '--no-renames',
    '--no-abbrev',
    EMPTY_TREE,
    headSha,
    '--',
    ...pathspecs,
  ]);
  const fields = stdout.toString('latin1').split('\0');
  const reads: Promise<[string, number] | null>[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = /^:\d{6} (\d{6}) [0-9a-f]{40} ([0-9a-f]{40}) A$/.exec(fields[i] as string);
    if (!meta) throw new Error(`unexpected git diff-tree output: ${JSON.stringify(fields[i])}`);
    if (Number.parseInt(meta[1] as string, 8) >> 12 !== 0o10) continue; // symlinks and submodules have no lines
    const path = fields[i + 1] as string;
    reads.push(blobs.read(meta[2] as string).then((blob) => (blob.binary ? null : [path, blob.nonBlankCount])));
  }
  const files = new Map<string, number>();
  for (const read of await Promise.all(reads)) {
    if (read) files.set(read[0], read[1]);
  }
  return files;
}
