// `walk --check`: recounts the alive lines per file from the head's blobs, and compares each alive
// line's introducing commit with what `git blame -w` says at the head.
import { blame, blameArgs, Pool } from './blame.ts';
import { displayPath, isPassablePath } from './git.ts';
import type { HeadCount } from './head-count.ts';
import { BLANK } from './tracker.ts';
import type { WalkDetails } from './walk.ts';

export interface FileDifference {
  path: string;
  /** Alive lines the walker tracks, or null when it does not track the file. */
  walker: number | null;
  /** Non-blank lines in the blob, or null when the file is not a measured text file at the head. */
  blobs: number | null;
}

export interface BlameDifference {
  path: string;
  line: number;
  walker: string;
  blame: string;
}

export interface CheckReport {
  files: number;
  fileDifferences: FileDifference[];
  blameCompared: number;
  blameMatched: number;
  /** The first `maxDifferences` lines where the walker and blame disagree. */
  blameDifferences: BlameDifference[];
  /** Files left out of the blame comparison because their names are not valid UTF-8. */
  blameSkippedFiles: number;
}

export async function runCheck(details: WalkDetails, head: HeadCount, maxDifferences = 10): Promise<CheckReport> {
  const fileDifferences: FileDifference[] = [];
  const paths = new Set([...details.files.keys(), ...head.files.keys()]);
  for (const path of [...paths].sort()) {
    const lines = details.files.get(path);
    const walker = lines ? lines.filter((owner) => owner !== BLANK).length : null;
    const blobs = head.files.get(path) ?? null;
    if (walker !== blobs) fileDifferences.push({ path: displayPath(path), walker, blobs });
  }

  const pool = new Pool();
  const { git } = details.repository;
  const headSha = details.result.headSha;
  const withLines = [...details.files].filter(([, lines]) => lines.some((owner) => owner !== BLANK));
  const files = withLines.filter(([path]) => isPassablePath(path));
  // Each file is compared as soon as its blame returns, so only counts and a few differences
  // stay in memory, not every file's blame at once.
  const perFile = await Promise.all(
    files.map(([path, lines]) =>
      pool.run(async () => {
        const answer = await blame(git, blameArgs(headSha, path));
        let compared = 0;
        let matched = 0;
        const differences: BlameDifference[] = [];
        lines.forEach((owner, index) => {
          if (owner === BLANK) return;
          compared++;
          const walker = details.commitShas[owner] as string;
          const blamed = answer.get(index + 1)?.sha ?? '(none)';
          if (walker === blamed) matched++;
          else if (differences.length < maxDifferences) {
            differences.push({ path: displayPath(path), line: index + 1, walker, blame: blamed });
          }
        });
        return { compared, matched, differences };
      }),
    ),
  );
  let blameCompared = 0;
  let blameMatched = 0;
  const blameDifferences: BlameDifference[] = [];
  for (const file of perFile) {
    blameCompared += file.compared;
    blameMatched += file.matched;
    blameDifferences.push(...file.differences.slice(0, maxDifferences - blameDifferences.length));
  }
  return {
    files: paths.size,
    fileDifferences,
    blameCompared,
    blameMatched,
    blameDifferences,
    blameSkippedFiles: withLines.length - files.length,
  };
}
