// pnpm --filter @code-trust/analyzer analyze <repoDir> [--head <ref>] [--observed-at <iso>]
//
// Analyzes a repository the way the worker will. Prints, per cohort, the commits with measured
// lines, their line counts and the survival horizons, then every commit outside `ai`, so each can
// be checked by hand. Runs under Node's type stripping, so this file and everything it imports
// must be plain erasable TypeScript.
import { parseArgs } from 'node:util';
import { type Cohort, CohortSchema, IsoTimestampSchema } from '@code-trust/shared';
import { analyzeRepo, type RepoAnalysis } from './analyze.ts';

const USAGE = 'usage: analyze <repoDir> [--head <ref>] [--observed-at <iso timestamp>]';
// Nothing printed depends on the repository id, but the shared schemas require one.
const PLACEHOLDER_REPO_ID = 1;

let args: ReturnType<typeof parse>;
try {
  args = parse();
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
const repoDir = args.positionals[0];
const observedAt = IsoTimestampSchema.safeParse(args.values['observed-at'] ?? new Date().toISOString());
if (repoDir === undefined || args.positionals.length > 1 || !observedAt.success) {
  if (!observedAt.success) console.error(`--observed-at: ${observedAt.error.issues[0]?.message}`);
  console.error(USAGE);
  process.exit(2);
}

try {
  const head = args.values.head;
  const analysis = await analyzeRepo({
    repoDir,
    repoId: PLACEHOLDER_REPO_ID,
    observedAt: observedAt.data,
    ...(head === undefined ? {} : { head }),
  });
  report(analysis);
} catch (error) {
  console.error(`analyze: ${(error as Error).message}`);
  process.exitCode = 1;
}

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: { head: { type: 'string' }, 'observed-at': { type: 'string' } },
  });
}

function report(analysis: RepoAnalysis): void {
  const cohortOf = new Map(analysis.commits.map((commit) => [commit.sha, commit.cohort]));
  print('head', `${analysis.head.headSha} (committed ${analysis.head.headCommittedAt})`);
  print('observed at', analysis.head.observedAt);

  for (const cohort of CohortSchema.options) {
    const commits = analysis.commits.filter((commit) => commit.cohort === cohort).length;
    const observations = analysis.observations.filter((o) => cohortOf.get(o.introducedBy) === cohort);
    const removed = sum(observations.filter((o) => o.removedBy !== null).map((o) => o.lineCount));
    const alive = sum(observations.filter((o) => o.removedBy === null).map((o) => o.lineCount));
    const counts = `${plural(commits, 'commit')} with measured lines; ${plural(removed + alive, 'line')}: ${removed} removed, ${alive} alive`;
    print(cohort, `${counts}; ${horizons(analysis, cohort)}`);
  }

  const outside = analysis.commits.filter((commit) => commit.cohort !== 'ai');
  print('outside ai', [plural(outside.length, 'commit'), ...outside.map((commit) => `${commit.sha} ${commit.cohort}`)]);
}

function horizons(analysis: RepoAnalysis, cohort: Cohort): string {
  if (cohort === 'automation') return 'no curve';
  const metric = analysis.rollups.find((rollup) => rollup.metric.cohort === cohort)?.metric;
  if (metric === undefined) return 'no curve: no lines';
  const show = (value: number | null) => (value === null ? 'unknown' : value.toFixed(4));
  return `S(30) ${show(metric.survival30d)}, S(90) ${show(metric.survival90d)}, S(180) ${show(metric.survival180d)}`;
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
