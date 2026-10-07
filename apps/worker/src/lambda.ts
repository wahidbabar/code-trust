// The Lambda entry that WorkerStack bundles. It is bundled as CommonJS, so nothing it imports may
// use import.meta or top-level await. The AWS SDK comes from the nodejs24.x runtime. This is the
// only file that imports the Neon dialect.
import { SSMClient } from '@aws-sdk/client-ssm';
import { createNeonDb } from '@code-trust/db/neon';
import { SSM_CLIENT_CONFIG, ssmParameterLoader } from './aws.ts';
import { DEFAULT_WORK_ROOT, WORKER_ENV } from './env.ts';
import { createGitRunner, githubCloneUrl } from './git.ts';
import { createHandler } from './handler.ts';

export { createHandler } from './handler.ts';

const workRoot = process.env[WORKER_ENV.workRoot] || DEFAULT_WORK_ROOT;

// The analyzer's git takes HOME from the process, and Lambda may leave it unset. The work root is
// the one directory the worker owns, so every git call, the worker's and the analyzer's, gets it.
process.env.HOME = workRoot;

// Built once per execution environment. Nothing calls AWS or Neon until the first record.
export const handler = createHandler({
  loadDatabaseUrl: ssmParameterLoader(new SSMClient(SSM_CLIENT_CONFIG), process.env[WORKER_ENV.databaseUrlParameter]),
  openDb: (url) => createNeonDb(url, { queryTimeoutMs: 30_000 }),
  workRoot,
  git: createGitRunner(),
  cloneUrl: githubCloneUrl,
  now: () => new Date(),
});
