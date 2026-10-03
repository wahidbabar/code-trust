// pnpm --filter @code-trust/analyzer walk <repoDir> [--head <ref>] [--check]
//
// Walks a repository's history and prints what the walker measured. --check also recounts the
// alive lines from the head's blobs (exit 1 on any difference) and compares the introducing
// commits with git blame -w at the head. Runs under Node's type stripping, so this file and
// everything it imports must be plain erasable TypeScript.
import { parseArgs } from 'node:util';
import { runCheck } from './check.ts';
import { displayPath } from './git.ts';
import { countHeadLines } from './head-count.ts';
import { BLANK } from './tracker.ts';
import { walkHistoryDetailed } from './walk.ts';

const USAGE = 'usage: walk <repoDir> [--head <ref>] [--check]';
const started = performance.now();

let args: ReturnType<typeof parse>;
try {
  args = parse();
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
const repoDir = args.positionals[0];
if (repoDir === undefined || args.positionals.length > 1) {
  console.error(USAGE);
  process.exit(2);
}

try {
  process.exitCode = await main(repoDir, args.values.head, args.values.check === true);
} catch (error) {
  console.error(`walk: ${(error as Error).message}`);
  process.exitCode = 1;
}

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: { head: { type: 'string' }, check: { type: 'boolean' } },
  });
}

async function main(dir: string, head: string | undefined, check: boolean): Promise<number> {
  const details = await walkHistoryDetailed(head === undefined ? { repoDir: dir } : { repoDir: dir, head });
  const { result, repository } = details;
  const counted = await countHeadLines(repository.git, result.headSha, details.rules);
  const revListCount = await repository.git.text(['rev-list', '--count', '--first-parent', result.headSha]);

  const alive = sum(result.groups.filter((group) => group.removedBy === null).map((group) => group.lineCount));
  const removed = sum(result.groups.filter((group) => group.removedBy !== null).map((group) => group.lineCount));
  const aliveFiles = [...details.files.values()].filter((lines) => lines.some((owner) => owner !== BLANK)).length;

  print('head', `${result.headSha} (committed ${result.headCommittedAt})`);
  print('mainline', `${details.streamedCommits} commits walked (git rev-list --count --first-parent: ${revListCount})`);
  print('alive lines', `${alive} in ${aliveFiles} files`);
  print('removed lines', `${removed}`);
  print(
    'left out',
    counted.rules.map((rule) => `${rule.name}: ${rule.lines} lines in ${plural(rule.files, 'file')}`),
  );
  print('merges', [
    `${details.merges} (${details.blameJobs} blame jobs, ${Math.round(details.blameMs)} ms)`,
    ...(details.unblamableLines > 0
      ? [`${details.unblamableLines} lines in files whose names are not valid UTF-8 went to their merge`]
      : []),
  ]);
  print(
    'rename limit',
    details.renameSkipped.length === 0
      ? 'no commit exceeded it'
      : `${plural(details.renameSkipped.length, 'commit')} found only exact renames: ${details.renameSkipped.slice(0, 10).join(', ')}`,
  );
  print('extensions', topExtensions(details.files));

  let exitCode = 0;
  if (check) {
    const report = await runCheck(details, counted);
    if (report.fileDifferences.length === 0) {
      print('check', `alive lines match the blobs at the head in all ${report.files} measured files`);
    } else {
      exitCode = 1;
      print('check', [
        `${plural(report.fileDifferences.length, 'file')} differ from the blobs at the head:`,
        ...report.fileDifferences
          .slice(0, 20)
          .map(
            (difference) =>
              `  ${difference.path}: walker ${difference.walker ?? '-'}, blobs ${difference.blobs ?? '-'}`,
          ),
      ]);
    }
    const share = report.blameCompared === 0 ? 100 : (100 * report.blameMatched) / report.blameCompared;
    print('blame -w', [
      `${share.toFixed(2)}% of alive lines (${report.blameMatched} of ${report.blameCompared}) name the same introducing commit as git blame -w at the head`,
      ...(report.blameSkippedFiles > 0
        ? [`  ${plural(report.blameSkippedFiles, 'file')} skipped: names that are not valid UTF-8`]
        : []),
      ...report.blameDifferences.map(
        (difference) =>
          `  ${difference.path}:${difference.line} walker=${difference.walker.slice(0, 7)} blame=${difference.blame.slice(0, 7)}`,
      ),
    ]);
  }

  print('wall time', `${((performance.now() - started) / 1000).toFixed(2)} s`);
  // maxRSS is in kilobytes. It covers this Node process only, not the git processes it ran.
  print(
    'peak RSS',
    `${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB (node process; git children not included)`,
  );
  return exitCode;
}

function topExtensions(files: ReadonlyMap<string, Int32Array>): string[] {
  const byExtension = new Map<string, { lines: number; files: number }>();
  for (const [path, lines] of files) {
    const name = displayPath(path).split('/').at(-1) ?? '';
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot).toLowerCase() : '(none)';
    const entry = byExtension.get(extension) ?? { lines: 0, files: 0 };
    entry.lines += lines.filter((owner) => owner !== BLANK).length;
    entry.files++;
    byExtension.set(extension, entry);
  }
  const top = [...byExtension].sort(([a, x], [b, y]) => y.lines - x.lines || (a < b ? -1 : 1)).slice(0, 10);
  const width = Math.max(0, ...top.map(([extension]) => extension.length));
  return top.map(
    ([extension, { lines, files: count }]) => `${extension.padEnd(width)}  ${lines} lines in ${plural(count, 'file')}`,
  );
}

function print(label: string, value: string | readonly string[]): void {
  const lines = typeof value === 'string' ? [value] : value;
  lines.forEach((line, i) => {
    console.log(`${(i === 0 ? label : '').padEnd(15)}${line}`);
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
