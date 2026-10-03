// Which files the metric leaves out. Lock files, vendored code and generated output churn for
// reasons unrelated to who wrote them, so their lines would drown the signal: in this repository
// pnpm-lock.yaml alone was about a quarter of all lines.
//
// The rule is a fixed list of git glob pathspecs, matched by git and never by a JavaScript glob.
// The walker passes it to git log as exclude pathspecs, so a file renamed across the boundary
// arrives as a plain add or delete with its full content. `.gitattributes` is not read: it changes
// over history and lives in the worktree (see the Decisions table in docs/architecture.md).

export interface LeftOutRule {
  /** Shown in the walk summary. */
  name: string;
  /** Git glob pathspec patterns, matched from the repository root. A leading `**` and slash also matches at the root. */
  patterns: readonly string[];
}

export const DEFAULT_LEFT_OUT_RULES: readonly LeftOutRule[] = [
  {
    name: 'lock files',
    patterns: [
      // yarn, Cargo, Gemfile, composer, poetry, Pipfile, Podfile, pubspec, mix, flake, bun, uv,
      // pdm, deno, conan and paket all end in .lock.
      '**/*.lock',
      '**/pnpm-lock.yaml',
      '**/package-lock.json',
      '**/npm-shrinkwrap.json',
      '**/packages.lock.json',
      '**/gradle.lockfile',
      '**/go.sum',
      '**/go.work.sum',
      '**/Package.resolved',
      '**/.terraform.lock.hcl',
    ],
  },
  {
    name: 'vendored',
    patterns: [
      '**/node_modules/**',
      '**/vendor/**',
      '**/third_party/**',
      '**/third-party/**',
      '**/bower_components/**',
      '**/Pods/**',
      '**/.yarn/**',
    ],
  },
  {
    name: 'minified',
    patterns: ['**/*.min.js', '**/*.min.mjs', '**/*.min.cjs', '**/*.min.css', '**/*.js.map', '**/*.css.map'],
  },
  {
    // build/, out/ and lib/ stay measured: too often hand-written source.
    name: 'generated',
    patterns: [
      '**/dist/**',
      '**/.pnp.cjs',
      '**/.pnp.loader.mjs',
      '**/__generated__/**',
      '**/*.generated.*',
      '**/*.pb.go',
      '**/*.pb.*.go',
      '**/*_pb.*',
      '**/*_pb2.py',
      '**/*_pb2.pyi',
      '**/*_pb2_grpc.py',
      '**/*.pb.cc',
      '**/*.pb.h',
      '**/*.g.dart',
      '**/*.freezed.dart',
      '**/zz_generated*',
      '**/*.[Dd]esigner.cs',
      '**/__snapshots__/**',
      '**/*.snap',
    ],
  },
];

/** Pathspecs for every measured file: the whole tree minus every rule. */
export function measuredPathspecs(rules: readonly LeftOutRule[]): string[] {
  return [':(top)', ...rules.flatMap((rule) => rule.patterns.map((pattern) => `:(top,exclude,glob)${pattern}`))];
}

/**
 * Pathspecs for the files rule `index` leaves out and no earlier rule does, so each left-out
 * file is counted under exactly one rule.
 */
export function rulePathspecs(rules: readonly LeftOutRule[], index: number): string[] {
  const rule = rules[index];
  if (!rule) throw new RangeError(`no left-out rule at index ${index}`);
  return [
    ...rule.patterns.map((pattern) => `:(top,glob)${pattern}`),
    ...rules.slice(0, index).flatMap((earlier) => earlier.patterns.map((pattern) => `:(top,exclude,glob)${pattern}`)),
  ];
}
