// WorkerStack bundles src/lambda.ts with CDK's NodejsFunction, which runs esbuild with these
// settings (see the esbuild row in docs/architecture.md). In a CommonJS bundle import.meta is
// empty and top-level await is an error, so the whole import graph must do without both.
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, formatMessages } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import type { WorkerHandler } from './handler.ts';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('src/lambda.ts bundles as NodejsFunction does with zero warnings, loads, and answers an empty batch', async () => {
  const result = await build({
    entryPoints: [join(PACKAGE_DIR, 'src', 'lambda.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    external: ['@aws-sdk/*', '@smithy/*'],
    write: false,
    logLevel: 'silent',
  });
  expect(await formatMessages(result.warnings, { kind: 'warning' })).toEqual([]);

  const [output] = result.outputFiles;
  if (!output) throw new Error('esbuild wrote no output');
  // The handler reaches Postgres through Neon only: node-postgres must not be in the bundle at all.
  expect(output.text).not.toMatch(/require\(["']pg["']\)/);
  expect(output.text).not.toMatch(/node_modules\/(\.pnpm\/)?pg[@/]/);

  // The bundle requires the AWS SDK, which Lambda's runtime provides. Here it resolves through a
  // node_modules link to this package's own.
  const dir = await mkdtemp(join(tmpdir(), 'code-trust-worker-bundle-'));
  const workRoot = join(dir, 'work');
  vi.stubEnv('WORK_ROOT', workRoot);
  vi.stubEnv('DATABASE_URL_PARAMETER', '/code-trust/database-url');
  vi.stubEnv('HOME', process.env.HOME);
  const fetch = vi.fn(() => {
    throw new Error('the bundle made a network call');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await symlink(join(PACKAGE_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const file = join(dir, 'index.cjs');
    await writeFile(file, output.text);
    const bundle = createRequire(import.meta.url)(file) as { handler: WorkerHandler; createHandler: unknown };

    expect(typeof bundle.createHandler).toBe('function');
    expect(process.env.HOME).toBe(workRoot);
    expect(await bundle.handler({ Records: [] })).toEqual({ batchItemFailures: [] });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
