// The default rules, matched by git exactly as the walker matches them, over sample paths and
// near misses. A mistyped glob fails here rather than in the hardening trial.
import { afterAll, expect, test } from 'vitest';
import { EMPTY_TREE, Git } from './git.ts';
import { DEFAULT_LEFT_OUT_RULES, measuredPathspecs, rulePathspecs } from './measured-paths.ts';
import { removeTempDirs, ScriptedRepo } from './testing.ts';

afterAll(removeTempDirs);

const EXPECTED: Record<string, string[]> = {
  'lock files': [
    'Package.resolved',
    'go.sum',
    'go.work.sum',
    'gradle.lockfile',
    'infra/.terraform.lock.hcl',
    'npm-shrinkwrap.json',
    'packages.lock.json',
    'pnpm-lock.yaml',
    'sub/Cargo.lock',
    'web/package-lock.json',
    'yarn.lock',
  ],
  vendored: [
    '.yarn/releases/yarn.cjs',
    'bower_components/d.js',
    'ios/Pods/e.m',
    'lib/third_party/b.c',
    'node_modules/x/index.js',
    'third-party/c.js',
    'vendor/a.go',
  ],
  minified: ['app.js.map', 'style.css.map', 'style.min.css', 'web/app.min.js', 'x.min.cjs', 'x.min.mjs'],
  generated: [
    '.pnp.cjs',
    '.pnp.loader.mjs',
    'Forms/Main.Designer.cs',
    'Forms/Other.designer.cs',
    'api.generated.ts',
    'api.pb.cc',
    'api.pb.go',
    'api.pb.gw.go',
    'api.pb.h',
    'api_pb.js',
    'api_pb2.py',
    'api_pb2.pyi',
    'api_pb2_grpc.py',
    'b.snap',
    'dist/index.js',
    'model.freezed.dart',
    'model.g.dart',
    'pkg/zz_generated.deepcopy.go',
    'src/__generated__/types.ts',
    'src/__snapshots__/a.test.ts.snap',
  ],
  measured: [
    'Cargo.toml',
    'README.md',
    'app.mini.js',
    'build/x.js',
    'designer.cs',
    'distribution/a.ts',
    'lib/index.ts',
    'my_pbfile.txt',
    'out/x.js',
    'src/lock.ts',
    'vendors/x.ts',
  ],
};

test('each sample path lands in the rule that should leave it out, and near misses stay measured', async () => {
  const repo = ScriptedRepo.create();
  repo.write(Object.fromEntries(Object.values(EXPECTED).flatMap((paths) => paths.map((path) => [path, 'x\n']))));
  const head = repo.commit('samples\n');
  const git = new Git(repo.dir);
  const list = async (pathspecs: readonly string[]): Promise<string[]> => {
    const { stdout } = await git.run(['diff-tree', '-r', '-z', '--name-only', EMPTY_TREE, head, '--', ...pathspecs]);
    return stdout.toString('latin1').split('\0').filter(Boolean).sort();
  };

  const found: Record<string, string[]> = { measured: await list(measuredPathspecs(DEFAULT_LEFT_OUT_RULES)) };
  for (const [i, rule] of DEFAULT_LEFT_OUT_RULES.entries()) {
    found[rule.name] = await list(rulePathspecs(DEFAULT_LEFT_OUT_RULES, i));
  }

  expect(found).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([name, paths]) => [name, [...paths].sort()])));
});
