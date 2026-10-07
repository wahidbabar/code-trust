// One job from the jobs queue, start to finish. An analyze job clones the repo's default branch,
// runs the analyzer and writes the result in the order packages/db/README.md gives, so a job that
// dies midway is invisible and a retry converges. A delete job removes everything stored about
// the repo.
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeRepo, type RepoAnalysis } from '@code-trust/analyzer';
import {
  type Db,
  deleteAttributionsExcept,
  deleteCommitsExcept,
  deleteRepo,
  deleteSurvivalObservationsExcept,
  getRepo,
  setRepoHead,
  upsertAttributions,
  upsertCommits,
  upsertRepo,
  upsertSurvivalObservations,
  upsertSurvivalRollup,
} from '@code-trust/db';
import type { AnalysisJobMessage, JobMessage, RepoRef } from '@code-trust/shared';
import { cloneMainline, type GitRunner, lsRemoteHead } from './git.ts';
import { countStatements } from './statements.ts';

export type LogEntry = Readonly<Record<string, string | number | boolean | null>>;

export interface JobDeps {
  db: Db;
  now: () => Date;
  /** Emptied at the start of every job, so it must belong to the worker alone. */
  workRoot: string;
  git: GitRunner;
  cloneUrl: (repo: RepoRef) => string;
  log?: (entry: LogEntry) => void;
}

type Result =
  | { outcome: 'analyzed'; headSha: string }
  /** `head-unchanged`: a push whose tip is already the stored head. `empty`: the repo has no commits. */
  | { outcome: 'skipped'; skip: 'head-unchanged' | 'empty'; headSha: string | null }
  /** git says the repo does not exist or needs credentials: it went private or away. Nothing is written. */
  | { outcome: 'unavailable'; stage: 'ls-remote' | 'clone' }
  | { outcome: 'deleted'; existed: boolean };

export type JobOutcome = Result & { commitCount: number; statementCount: number };

/**
 * Runs one job. Returns for every outcome that should be acknowledged and throws for anything SQS
 * should retry: network faults, timeouts, analyzer errors and database errors.
 */
export async function runJob(job: JobMessage, deps: JobDeps): Promise<JobOutcome> {
  const started = deps.now().getTime();
  const log = deps.log ?? ((entry: LogEntry) => console.log(JSON.stringify(entry)));
  const counted = countStatements(deps.db);
  const progress = { commitCount: 0 };
  const line = (outcome: string) => ({
    jobId: job.jobId,
    deliveryId: job.deliveryId,
    repoId: job.repo.id,
    type: job.type,
    reason: job.reason,
    outcome,
    durationMs: deps.now().getTime() - started,
    commitCount: progress.commitCount,
    statementCount: counted.count,
  });
  try {
    await emptyWorkRoot(deps.workRoot);
    const result =
      job.type === 'delete_repo'
        ? ({ outcome: 'deleted', existed: await deleteRepo(counted.db, job.repo.id) } as const)
        : await analyze(job, { ...deps, db: counted.db }, progress);
    const outcome: JobOutcome = { ...result, commitCount: progress.commitCount, statementCount: counted.count };
    log({ ...line(result.outcome), ...details(result) });
    return outcome;
  } catch (error) {
    log({ ...line('failed'), error: describe(error) });
    throw error;
  }
}

/**
 * A timeout or an out-of-memory kill skips every `finally`, and Lambda keeps /tmp for the next
 * invocation, so whatever a killed job left is removed here.
 */
async function emptyWorkRoot(workRoot: string): Promise<void> {
  await mkdir(workRoot, { recursive: true });
  for (const entry of await readdir(workRoot)) await rm(join(workRoot, entry), { recursive: true, force: true });
}

async function analyze(job: AnalysisJobMessage, deps: JobDeps, progress: { commitCount: number }): Promise<Result> {
  const { db, git, workRoot } = deps;
  const url = deps.cloneUrl(job.repo);
  const remote = await lsRemoteHead(git, { url, workRoot });
  if (remote.status === 'unavailable') return { outcome: 'unavailable', stage: 'ls-remote' };
  if (remote.status === 'empty') return { outcome: 'skipped', skip: 'empty', headSha: null };

  // A burst of pushes becomes one analysis: the first analyzes the tip and the rest find it stored.
  // A backfill always analyzes, so re-adding a repo refreshes it after an analyzer change.
  if (job.reason === 'push') {
    const stored = await getRepo(db, job.repo.id);
    if (stored?.headSha === remote.headSha)
      return { outcome: 'skipped', skip: 'head-unchanged', headSha: remote.headSha };
  }

  const dir = await mkdtemp(join(workRoot, 'clone-'));
  try {
    const cloned = await cloneMainline(git, { url, branch: remote.branch, dir, workRoot });
    if (cloned === 'unavailable') return { outcome: 'unavailable', stage: 'clone' };
    const observedAt = deps.now().toISOString();
    // The clone's own HEAD, never job.headSha: a repo's jobs run in order, and analyzing the current
    // tip is what keeps a late job from moving the head back.
    const analysis = await analyzeRepo({ repoDir: dir, repoId: job.repo.id, observedAt });
    progress.commitCount = analysis.commits.length;
    await write(db, job, remote.branch, analysis);
    return { outcome: 'analyzed', headSha: analysis.head.headSha };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The write order of packages/db/README.md: one statement per call, up to 1000 rows each. */
async function write(db: Db, job: AnalysisJobMessage, defaultBranch: string, analysis: RepoAnalysis): Promise<void> {
  const repoId = job.repo.id;
  await upsertRepo(db, {
    id: repoId,
    owner: job.repo.owner,
    name: job.repo.name,
    defaultBranch,
    installationId: job.installationId,
  });
  await upsertCommits(db, analysis.commits);
  await upsertAttributions(db, analysis.attributions);
  await upsertSurvivalObservations(db, analysis.observations);
  // Every commit an attribution or observation names is in the analysis's commits, so the cascade
  // from deleteCommitsExcept removes only rows the analysis no longer has.
  await deleteCommitsExcept(
    db,
    repoId,
    analysis.commits.map((commit) => commit.sha),
  );
  await deleteAttributionsExcept(db, repoId, analysis.attributions);
  await deleteSurvivalObservationsExcept(db, repoId, analysis.observations);
  for (const rollup of analysis.rollups) await upsertSurvivalRollup(db, rollup);
  // Last, with nothing after it. Until it runs the repo keeps its old head, and a push job compares
  // its tip with this head to skip, so a write after it that failed would never be retried.
  if (!(await setRepoHead(db, repoId, analysis.head))) {
    throw new Error(`repo ${repoId} was deleted while its analysis was being written`);
  }
}

function details(result: Result): LogEntry {
  switch (result.outcome) {
    case 'analyzed':
      return { headSha: result.headSha };
    case 'skipped':
      return { skip: result.skip, headSha: result.headSha };
    case 'unavailable':
      return { stage: result.stage };
    case 'deleted':
      return { existed: result.existed };
  }
}

/** Errors here come from git, the analyzer and the database driver, none of which holds the database URL. */
function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
