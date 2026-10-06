import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

// A URL that new URL() rejects, with a password in it. Node's ERR_INVALID_URL carries the whole
// input, so an uncaught one prints the password.
const BAD_URL = 'postgres://u:s3cret-pw@[bad';

test('migrate with a malformed DATABASE_URL exits 1 without printing the password', () => {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', 'src/migrate.ts'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: BAD_URL },
    encoding: 'utf8',
  });
  const output = `${run.stdout}\n${run.stderr}`;
  expect(output).not.toContain('s3cret-pw');
  expect(output).toMatch(/DATABASE_URL is not a valid URL/);
  expect(run.status).toBe(1);
});
