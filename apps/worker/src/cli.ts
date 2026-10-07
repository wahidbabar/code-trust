// pnpm --filter @code-trust/worker run-job <clone-url> <repo-id> [--installation-id <id>]
//
// Runs one backfill analysis the way the worker does on Lambda, against the workspace database
// (DATABASE_URL, or the one in .env.workspace), and prints the head, the commit count and the
// number of statements the job sent. The repo id is GitHub's, from
// `gh api repos/<owner>/<name> --jq .id`: the worker calls no GitHub API. Runs under Node's type
// stripping, so this file and everything it imports must be plain erasable TypeScript.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getRepo } from '@code-trust/db';
import { createPgDb } from '@code-trust/db/pg';
import { JobMessageSchema, RepoRefSchema } from '@code-trust/shared';
import { createGitRunner } from './git.ts';
import { runJob } from './job.ts';

const USAGE = 'usage: run-job <clone-url> <repo-id> [--installation-id <id>]';

let parsed: ReturnType<typeof parse>;
try {
  parsed = parse();
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
const [url, repoId] = parsed.positionals;
if (url === undefined || repoId === undefined || parsed.positionals.length > 2) {
  console.error(USAGE);
  process.exit(2);
}
// Owner and name are the URL's last two path segments, which is all the job's repo ref needs.
const segments = URL.canParse(url) ? new URL(url).pathname.split('/').filter(Boolean) : [];
const repo = RepoRefSchema.safeParse({
  id: Number(repoId),
  owner: segments.at(-2),
  name: segments.at(-1)?.replace(/\.git$/, ''),
});
const installationId = Number(parsed.values['installation-id']);
if (!repo.success || !Number.isInteger(installationId) || installationId <= 0) {
  console.error(`${repo.error?.issues[0]?.message ?? '--installation-id must be a positive integer'}\n${USAGE}`);
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set, and there is no .env.workspace that sets it.');
  process.exit(1);
}

const db = createPgDb(databaseUrl);
const workRoot = await mkdtemp(join(tmpdir(), 'code-trust-run-job-'));
try {
  const job = JobMessageSchema.parse({
    version: 1,
    jobId: randomUUID(),
    requestedAt: new Date().toISOString(),
    deliveryId: randomUUID(),
    type: 'analyze',
    reason: 'backfill',
    installationId,
    repo: repo.data,
    headSha: null,
  });
  const outcome = await runJob(job, {
    db,
    now: () => new Date(),
    // Its own temp directory, never /tmp itself: every job empties its work root.
    workRoot,
    git: createGitRunner(),
    cloneUrl: () => url,
    log: (entry) => console.error(JSON.stringify(entry)),
  });
  if (outcome.outcome === 'analyzed') {
    const stored = await getRepo(db, repo.data.id);
    console.log(`head ${outcome.headSha} (${stored?.defaultBranch ?? '?'})`);
    console.log(`commits ${outcome.commitCount}`);
    console.log(`statements ${outcome.statementCount}`);
  } else {
    console.error(`run-job: ${repo.data.owner}/${repo.data.name} was not analyzed: ${outcome.outcome}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`run-job: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await rm(workRoot, { recursive: true, force: true });
  await db.destroy();
}

function parse() {
  return parseArgs({
    allowPositionals: true,
    // The worker's jobs carry the App's installation id. A local run has none, and nothing reads it.
    options: { 'installation-id': { type: 'string', default: '1' } },
  });
}
