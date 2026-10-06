// The Lambda functions (T09, T10) are CommonJS bundles from CDK's NodejsFunction, which runs esbuild
// with these settings (see the esbuild row in docs/architecture.md). In a CommonJS bundle
// import.meta is empty, so a root entry that reaches a file using it would break at runtime.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, formatMessages } from 'esbuild';
import { expect, test, vi } from 'vitest';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

const ENTRY = `
import { listRepos } from '@code-trust/db';
import { createNeonDb } from '@code-trust/db/neon';
export { createNeonDb, listRepos };
`;

test('a CommonJS Lambda bundle of @code-trust/db and @code-trust/db/neon has no warnings and no pg, and builds a handle offline', async () => {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: PACKAGE_DIR, sourcefile: 'lambda-entry.ts', loader: 'ts' },
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
  // The root and /neon must not pull node-postgres in at all, bundled or external.
  expect(output.text).not.toMatch(/require\(["']pg["']\)/);
  expect(output.text).not.toMatch(/node_modules\/pg\//);

  const dir = await mkdtemp(join(tmpdir(), 'code-trust-db-bundle-'));
  const fetch = vi.fn(() => {
    throw new Error('createNeonDb made a network call');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const file = join(dir, 'index.cjs');
    await writeFile(file, output.text);
    const bundle = createRequire(import.meta.url)(file) as {
      createNeonDb(url: string, options: { queryTimeoutMs: number }): { selectFrom: unknown; destroy(): Promise<void> };
      listRepos: unknown;
    };
    expect(typeof bundle.listRepos).toBe('function');
    const db = bundle.createNeonDb('postgres://u:p@example.invalid/db', { queryTimeoutMs: 1000 });
    expect(typeof db.selectFrom).toBe('function');
    await db.destroy();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});
