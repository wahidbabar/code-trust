// Test support: git repositories built in temp directories with fixed identities and dates, git
// runners that fake or record, and helpers that compare stored rows with an analysis. Only tests
// import this module; src/lambda.ts never reaches it, so it stays out of the bundle.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GetParameterCommand } from '@aws-sdk/client-ssm';
import { analyzeRepo, type RepoAnalysis } from '@code-trust/analyzer';
import {
  type Database,
  type Db,
  getRepo,
  getSurvivalCurves,
  listAttributions,
  listCommits,
  listSurvivalMetrics,
  listSurvivalObservations,
  type RepoDetails,
  upsertAttributions,
  upsertSurvivalObservations,
} from '@code-trust/db';
import { testDatabaseUrl } from '@code-trust/db/testing';
import {
  type AnalysisJobMessage,
  type Attribution,
  type Commit,
  type DeleteRepoJobMessage,
  JobMessageSchema,
  type Repo,
  type RepoRef,
  type SurvivalCurve,
  type SurvivalMetric,
  type SurvivalObservation,
} from '@code-trust/shared';
import {
  DeleteQueryNode,
  InsertQueryNode,
  Kysely,
  type KyselyPlugin,
  type LogEvent,
  type OperationNode,
  PostgresDialect,
  type RootOperationNode,
  TableNode,
  UpdateQueryNode,
} from 'kysely';
import { Pool } from 'pg';
import type { SsmClientLike } from './aws.ts';
import type { GitRunner, GitRunOptions, GitRunResult } from './git.ts';

export interface Identity {
  name: string;
  email: string;
}

// Made up: the repository is public, so fixtures never carry a real person's name or email.
export const HUMAN: Identity = { name: 'Ada Example', email: 'ada@example.com' };
export const DEPENDABOT: Identity = {
  name: 'dependabot[bot]',
  email: '49699333+dependabot[bot]@users.noreply.github.com',
};
export const AI_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/** 2026-01-01T00:00:00Z. Each commit lands one day after the previous one. */
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const DAY = 86_400;

// The builder's own settings. core.excludesFile matters: git reads ~/.config/git/ignore even with
// GIT_CONFIG_GLOBAL=/dev/null.
const BUILDER_CONFIG = [
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'core.autocrlf=false',
  'core.excludesFile=/dev/null',
  'core.hooksPath=/dev/null',
  'gc.auto=0',
  'maintenance.auto=false',
  'advice.detachedHead=false',
];

const tempDirs = new Set<string>();

/** A fresh temp directory, removed by removeTempDirs(). */
export function makeTempDir(prefix = 'code-trust-worker-'): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  tempDirs.add(dir);
  return dir;
}

/** Removes every temp directory this process created. Call it from afterAll. */
export function removeTempDirs(): void {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

function builderEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: tmpdir(),
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export interface CommitOptions {
  /** Path to new content, or null to delete the file. */
  files: Record<string, string | null>;
  author?: Identity;
  /** Adds Claude Code's trailer, which makes the commit `ai`. */
  ai?: boolean;
  message?: string;
}

/** A non-bare repository that jobs clone over file://. Tests change its history directly. */
export class TestRepo {
  readonly dir: string;
  private commits = 0;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static create(branch = 'main'): TestRepo {
    const repo = new TestRepo(join(makeTempDir('code-trust-origin-'), 'origin'));
    mkdirSync(repo.dir);
    repo.git('init', '--quiet', `--initial-branch=${branch}`);
    return repo;
  }

  get url(): string {
    return `file://${this.dir}`;
  }

  git(...args: string[]): string {
    return this.gitWith({}, args);
  }

  head(): string {
    return this.git('rev-parse', 'HEAD');
  }

  commit({ files, author = HUMAN, ai = false, message }: CommitOptions): string {
    for (const [path, content] of Object.entries(files)) {
      const file = join(this.dir, path);
      if (content === null) {
        rmSync(file, { force: true });
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
    }
    this.git('add', '--all');
    this.commits += 1;
    const date = `@${BASE_TIME + this.commits * DAY} +0000`;
    const subject = message ?? `change ${this.commits}`;
    this.gitWith(
      {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: date,
      },
      ['commit', '--quiet', '--allow-empty', '--message', ai ? `${subject}\n\n${AI_TRAILER}` : subject],
    );
    return this.head();
  }

  /** What a force-push leaves on the remote: the branch moved back to `sha`. */
  resetHard(sha: string): void {
    this.git('reset', '--quiet', '--hard', sha);
  }

  private gitWith(env: Record<string, string>, args: string[]): string {
    return execFileSync('git', [...BUILDER_CONFIG.flatMap((c) => ['-c', c]), ...args], {
      cwd: this.dir,
      env: builderEnv(env),
      encoding: 'utf8',
    }).trim();
  }
}

/** Lines `from` to `to` of a file, each naming its file and number so no two lines anywhere are alike. */
export function lines(file: string, from: number, to: number): string {
  let text = '';
  for (let i = from; i <= to; i++) text += `${file} line ${i}\n`;
  return text;
}

/**
 * `count` commits cycling through AI, human, human, dependabot. Each adds a file and rewrites the
 * first two lines of the file from two commits back, so every cohort has removed lines and alive ones.
 */
export function buildHistory(repo: TestRepo, count: number, prefix = 'f'): string[] {
  const shas: string[] = [];
  for (let i = 0; i < count; i++) {
    const files: Record<string, string> = { [`src/${prefix}${i}.ts`]: lines(`${prefix}${i}`, 1, 6) };
    if (i >= 2) {
      const old = `${prefix}${i - 2}`;
      files[`src/${old}.ts`] = `${lines(`${old}-rewrite`, 1, 2)}${lines(old, 3, 6)}`;
    }
    const kind = i % 4;
    shas.push(repo.commit({ files, ai: kind === 0, author: kind === 3 ? DEPENDABOT : HUMAN }));
  }
  return shas;
}

export interface RecordedCall {
  args: readonly string[];
  options: GitRunOptions;
}

/** Wraps a runner and records every call. `answer` may replace git's result for a call. */
export function spyGit(
  inner: GitRunner,
  answer?: (args: readonly string[], options: GitRunOptions) => GitRunResult | undefined,
): { git: GitRunner; calls: RecordedCall[]; commands: () => string[] } {
  const calls: RecordedCall[] = [];
  const git: GitRunner = async (args, options) => {
    calls.push({ args, options });
    return answer?.(args, options) ?? inner(args, options);
  };
  return { git, calls, commands: () => calls.map((call) => call.args[0] ?? '') };
}

/** GitHub's stderr for a repo that does not exist, or is private, to an anonymous client. */
export const NOT_FOUND_STDERR =
  "remote: Repository not found.\nfatal: repository 'https://github.com/octo-org/gone.git/' not found\n";
export const CREDENTIALS_STDERR =
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
export const DNS_STDERR =
  "fatal: unable to access 'https://github.com/octo-org/hello.git/': Could not resolve host: github.com\n";

/** A runner that fails `command` with git's fatal exit and `stderr`, and runs everything else for real. */
export function failingGit(inner: GitRunner, command: string, stderr: string) {
  return spyGit(inner, (args) => (args[0] === command ? { exitCode: 128, stdout: '', stderr } : undefined));
}

const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const REQUESTED_AT = '2026-09-01T00:00:00.000Z';

export function analyzeJob(
  repo: RepoRef,
  reason: 'push' | 'backfill',
  headSha: string | null = null,
): AnalysisJobMessage {
  return JobMessageSchema.parse({
    version: 1,
    jobId: randomUUID(),
    requestedAt: REQUESTED_AT,
    deliveryId: DELIVERY_ID,
    type: 'analyze',
    reason,
    installationId: 52_340_917,
    repo,
    headSha,
  }) as AnalysisJobMessage;
}

export function deleteJob(repo: RepoRef): DeleteRepoJobMessage {
  return JobMessageSchema.parse({
    version: 1,
    jobId: randomUUID(),
    requestedAt: REQUESTED_AT,
    deliveryId: DELIVERY_ID,
    type: 'delete_repo',
    repo,
    reason: 'privatized',
  }) as DeleteRepoJobMessage;
}

/** The repo details an analyze job built by analyzeJob writes, for comparing with stored rows. */
export function detailsOf(repo: RepoRef, defaultBranch = 'main'): RepoDetails {
  return { ...repo, defaultBranch, installationId: 52_340_917 };
}

/** A clock that stands still during a job, so the job's observedAt is known. Starts 2026-09-01. */
export class TestClock {
  private ms = Date.parse(REQUESTED_AT);
  readonly now = (): Date => new Date(this.ms);

  /** Moves the clock a day on, and returns the new time as an ISO timestamp. */
  advance(): string {
    this.ms += 86_400_000;
    return this.iso();
  }

  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

/** Everything stored about one repo, in an order that does not depend on how it was read. */
export interface StoredRows {
  repo: Repo | null;
  commits: Commit[];
  attributions: Attribution[];
  observations: SurvivalObservation[];
  metrics: SurvivalMetric[];
  curves: SurvivalCurve[];
}

export async function snapshot(db: Db, repoId: number): Promise<StoredRows> {
  return canonical({
    repo: await getRepo(db, repoId),
    commits: await listCommits(db, repoId),
    attributions: await listAttributions(db, repoId),
    observations: await listSurvivalObservations(db, repoId),
    metrics: await listSurvivalMetrics(db, repoId),
    curves: await getSurvivalCurves(db, repoId),
  });
}

/** What the tables should hold after `analysis` was written for the repo `details` describes. */
export function expectedRows(analysis: RepoAnalysis, details: RepoDetails): StoredRows {
  return canonical({
    repo: { ...details, ...analysis.head },
    commits: analysis.commits,
    attributions: analysis.attributions,
    observations: analysis.observations,
    metrics: analysis.rollups.map((rollup) => rollup.metric),
    curves: analysis.rollups.map((rollup) => ({ cohort: rollup.metric.cohort, points: rollup.points })),
  });
}

export const NOTHING_STORED: StoredRows = {
  repo: null,
  commits: [],
  attributions: [],
  observations: [],
  metrics: [],
  curves: [],
};

function canonical(rows: StoredRows): StoredRows {
  const by =
    <T>(key: (item: T) => string) =>
    (items: readonly T[]) =>
      [...items].sort((a, b) => key(a).localeCompare(key(b)));
  return {
    repo: rows.repo,
    commits: by<Commit>((c) => c.sha)(rows.commits),
    attributions: by<Attribution>((a) => `${a.commitSha} ${a.signal} ${a.tool}`)(rows.attributions),
    observations: by<SurvivalObservation>((o) => `${o.introducedBy} ${o.removedBy ?? '-'}`)(rows.observations),
    metrics: by<SurvivalMetric>((m) => m.cohort)(rows.metrics),
    curves: by<SurvivalCurve>((c) => c.cohort)(rows.curves),
  };
}

/**
 * The analysis of `origin`'s current tip at `observedAt`, from an ordinary clone: every branch,
 * the tags and a checkout. A job's rows must equal it, which also shows that the job's narrower
 * clone changes nothing the analyzer reads.
 */
export async function expectedAnalysis(origin: TestRepo, repoId: number, observedAt: string): Promise<RepoAnalysis> {
  const dir = join(makeTempDir('code-trust-expected-'), 'clone');
  execFileSync('git', ['clone', '--quiet', origin.url, dir], { env: builderEnv() });
  return analyzeRepo({ repoDir: dir, repoId, observedAt });
}

/**
 * Rows an older analyzer could have left on commits the repo still has: an attribution the current
 * rules do not give, and an observation group the walk does not report. No commit they name goes
 * away, so no cascade removes them; only the attribution and observation prunes can.
 */
export async function writeStaleRows(db: Db, repoId: number, introducedBy: string, removedBy: string): Promise<void> {
  await upsertAttributions(db, [
    {
      repoId,
      commitSha: introducedBy,
      signal: 'author_identity',
      tool: 'copilot',
      confidence: 1,
      evidence: 'copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>',
    },
  ]);
  await upsertSurvivalObservations(db, [
    {
      repoId,
      introducedBy,
      removedBy,
      lineCount: 7,
      introducedAt: '2026-01-02T00:00:00.000Z',
      removedAt: '2026-01-03T00:00:00.000Z',
    },
  ]);
}

export class InjectedFailure extends Error {
  override readonly name = 'InjectedFailure';
}

/** The writes a test can make fail, by the statement each one sends. */
const FAIL_TARGETS = {
  deleteCommitsExcept: (node) => DeleteQueryNode.is(node) && tableOf(node.from.froms[0]) === 'commits',
  deleteAttributionsExcept: (node) => DeleteQueryNode.is(node) && tableOf(node.from.froms[0]) === 'attributions',
  deleteSurvivalObservationsExcept: (node) =>
    DeleteQueryNode.is(node) && tableOf(node.from.froms[0]) === 'survival_observations',
  upsertSurvivalRollup: (node) => InsertQueryNode.is(node) && tableOf(node.into) === 'survival_rollups',
  setRepoHead: (node) => UpdateQueryNode.is(node) && tableOf(node.table) === 'repos',
} satisfies Record<string, (node: RootOperationNode) => boolean>;

export type FailTarget = keyof typeof FAIL_TARGETS;

function tableOf(node: OperationNode | undefined): string | undefined {
  return node !== undefined && TableNode.is(node) ? node.table.identifier.name : undefined;
}

/**
 * The same database, except that `target`'s statement fails before it is sent: everything the job
 * wrote before it really happened, and nothing after it does.
 */
export function failOn(db: Db, target: FailTarget): { db: Db; readonly fired: boolean } {
  let fired = false;
  const plugin: KyselyPlugin = {
    transformQuery: ({ node }) => {
      if (FAIL_TARGETS[target](node)) {
        fired = true;
        throw new InjectedFailure(`${target} failed on purpose`);
      }
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  return {
    db: db.withPlugin(plugin),
    get fired() {
      return fired;
    },
  };
}

/**
 * A second handle on a test's scratch schema, with a Kysely log hook that records every statement
 * it runs, failed ones too. createPgDb takes no log option, so this builds its own pool.
 */
export function loggedDb(schema: string): { db: Db; events: LogEvent[]; destroy(): Promise<void> } {
  if (testDatabaseUrl === null) throw new Error('No test database. Guard the suite with testDatabaseUrl.');
  const events: LogEvent[] = [];
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` }),
    }),
    log: (event) => {
      events.push(event);
    },
  });
  return { db, events, destroy: () => db.destroy() };
}

/** A logged statement as its verb and first table, such as `insert commits` or `update repos`. */
export function statementOf(event: LogEvent): string {
  const sql = event.query.sql;
  return `${sql.slice(0, sql.indexOf(' '))} ${/"(\w+)"/.exec(sql)?.[1] ?? '?'}`;
}

/**
 * An SSM client that answers every read with `value`, or fails with each error in `failures` first.
 * `sent` records every command, so a test can count reads.
 */
export function fakeSsm(value: string | undefined, failures: Error[] = []) {
  const sent: GetParameterCommand[] = [];
  const client: SsmClientLike = {
    send: async (command) => {
      sent.push(command);
      const failure = failures.shift();
      if (failure) throw failure;
      return { $metadata: {}, ...(value === undefined ? {} : { Parameter: { Value: value } }) };
    },
  };
  return { client, sent };
}
