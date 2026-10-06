import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Stack } from 'aws-cdk-lib';
import { Architecture, Code, LayerVersion, Runtime } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/** Where `pnpm build:git-layer` writes the layer. Gitignored: the human builds it before deploying. */
export const GIT_LAYER_ZIP = fileURLToPath(new URL('../layers/git/dist/git-layer.zip', import.meta.url));

// One text file, which CDK zips at synth time with no Docker. A layer can't use inline code, and a
// committed zip would be a binary in the repo.
const PLACEHOLDER_DIR = fileURLToPath(new URL('../layers/git/placeholder/', import.meta.url));

type Env = Readonly<Record<string, string | undefined>>;

export interface GitLayerProps {
  /** The built layer. Defaults to GIT_LAYER_ZIP. */
  readonly zipPath?: string;
  /** Where GIT_LAYER_PLACEHOLDER is read from. Defaults to process.env. */
  readonly env?: Env;
}

/**
 * git from Amazon Linux 2023 packages at /opt/bin/git, for arm64 nodejs24.x functions. What is in
 * it and how to build it: infra/layers/git/README.md.
 *
 * Whenever the CLI bundles this stack, the zip must exist. Only the root `synth` script may go on
 * without it, behind GIT_LAYER_PLACEHOLDER=1. A deploy never sets that, so a worker can't ship
 * without git.
 */
export class GitLayer extends LayerVersion {
  constructor(scope: Construct, id: string, props: GitLayerProps = {}) {
    const source = gitLayerSource(
      Stack.of(scope).bundlingRequired,
      props.zipPath ?? GIT_LAYER_ZIP,
      props.env ?? process.env,
    );
    super(scope, id, {
      code: Code.fromAsset(source.path),
      compatibleArchitectures: [Architecture.ARM_64],
      compatibleRuntimes: [Runtime.NODEJS_24_X],
      description: source.placeholder
        ? 'code-trust git layer PLACEHOLDER, without git: run pnpm build:git-layer'
        : 'code-trust git from Amazon Linux 2023 packages, at /opt/bin/git',
    });
  }
}

function gitLayerSource(bundlingRequired: boolean, zipPath: string, env: Env): { path: string; placeholder: boolean } {
  // The stack is not being bundled: the CLI is listing stacks, deploying another stack with
  // --exclusively, or a test skipped bundling. Nothing of this stack gets deployed.
  if (!bundlingRequired) return { path: PLACEHOLDER_DIR, placeholder: true };
  if (existsSync(zipPath)) return { path: zipPath, placeholder: false };
  if (env.GIT_LAYER_PLACEHOLDER === '1') return { path: PLACEHOLDER_DIR, placeholder: true };
  throw new Error(
    `The git layer is not built: ${zipPath} is missing. Run \`pnpm build:git-layer\` first ` +
      '(infra/layers/git/README.md). Only `pnpm synth` may run without it. The CDK CLI bundles every ' +
      'stack unless --exclusively (-e) is given, so to deploy another stack before the layer is built, ' +
      'name that stack with --exclusively.',
  );
}
