import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { describe, expect, test, vi } from 'vitest';
import { REGION } from './config.ts';
import { GIT_LAYER_ZIP, GitLayer } from './git-layer.ts';

// The CLI feeds cdk.json's feature flags to the app. Load the same ones here.
const { context } = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

const scratch = mkdtempSync(join(tmpdir(), 'git-layer-test-'));
const MISSING_ZIP = join(scratch, 'missing.zip');
const PRESENT_ZIP = join(scratch, 'git-layer.zip');
// CDK uploads a zip as it is and never opens it, so any bytes stand in for the built layer.
writeFileSync(PRESENT_ZIP, 'stands in for the built layer');

// How the asset manifest packages the layer's code: a zip file is uploaded as a file, and the
// placeholder directory is zipped by CDK.
const FROM_ZIP = 'file';
const FROM_PLACEHOLDER = 'zip';

type Resource = { Type: string; Properties: Record<string, unknown> };
type AssetManifest = { files: Record<string, { source: { packaging: string } }> };

interface SynthOptions {
  /** False puts the stack outside `aws:cdk:bundling-stacks`, as the CLI does for stacks it skips. */
  bundling: boolean;
  zipPath: string;
  /** Left out, GitLayer reads process.env. */
  env?: Record<string, string>;
}

function synth({ bundling, zipPath, env }: SynthOptions): { layer: Record<string, unknown>; packaging: string } {
  const app = new App({ context: { ...context, 'aws:cdk:bundling-stacks': bundling ? ['**'] : [] } });
  const stack = new Stack(app, 'GitLayerTest', { env: { region: REGION } });
  new GitLayer(stack, 'GitLayer', env === undefined ? { zipPath } : { zipPath, env });
  const assembly = app.synth();

  const resources = (assembly.getStackArtifact(stack.artifactId).template as { Resources: Record<string, Resource> })
    .Resources;
  const layers = Object.values(resources).filter((resource) => resource.Type === 'AWS::Lambda::LayerVersion');
  expect(layers).toHaveLength(1);
  const layer = layers[0]?.Properties ?? {};

  // The layer's S3 key is its asset's hash, which keys the asset in the stack's manifest.
  const key = (layer.Content as { S3Key: string }).S3Key;
  const manifest = JSON.parse(
    readFileSync(join(assembly.directory, `${stack.artifactId}.assets.json`), 'utf8'),
  ) as AssetManifest;
  const asset = manifest.files[key.replace(/\.zip$/, '')];
  expect(asset).toBeDefined();
  return { layer, packaging: asset?.source.packaging ?? '' };
}

describe('GitLayer', () => {
  test('the layer is compatible with arm64 and nodejs24.x only', () => {
    for (const { layer } of [
      synth({ bundling: true, zipPath: PRESENT_ZIP }),
      synth({ bundling: false, zipPath: MISSING_ZIP }),
    ]) {
      expect(layer.CompatibleArchitectures).toEqual(['arm64']);
      expect(layer.CompatibleRuntimes).toEqual(['nodejs24.x']);
    }
  });

  test('with bundling skipped for its stack it synthesizes with no zip and no flag, from the placeholder', () => {
    const { layer, packaging } = synth({ bundling: false, zipPath: MISSING_ZIP, env: {} });
    expect(packaging).toBe(FROM_PLACEHOLDER);
    expect(layer.Description).toMatch(/PLACEHOLDER, without git/);
  });

  test('with bundling skipped it uses the placeholder even when the zip exists', () => {
    expect(synth({ bundling: false, zipPath: PRESENT_ZIP, env: {} }).packaging).toBe(FROM_PLACEHOLDER);
  });

  test('with bundling required, no zip and no flag it throws an error naming pnpm build:git-layer', () => {
    const run = () => synth({ bundling: true, zipPath: MISSING_ZIP, env: {} });
    expect(run).toThrow(/pnpm build:git-layer/);
    // Deploying another stack bundles this one too, unless that deploy is --exclusively.
    expect(run).toThrow(/--exclusively/);
  });

  test('with bundling required, no zip and the flag it synthesizes from the placeholder', () => {
    const { packaging } = synth({ bundling: true, zipPath: MISSING_ZIP, env: { GIT_LAYER_PLACEHOLDER: '1' } });
    expect(packaging).toBe(FROM_PLACEHOLDER);
  });

  test.each([
    { GIT_LAYER_PLACEHOLDER: 'true' },
    { GIT_LAYER_PLACEHOLDER: '0' },
    { CI: 'true' },
    { ALERT_EMAIL_PLACEHOLDER: '1' },
  ])('only GIT_LAYER_PLACEHOLDER=1 unlocks the placeholder, not %o', (env) => {
    expect(() => synth({ bundling: true, zipPath: MISSING_ZIP, env })).toThrow(/pnpm build:git-layer/);
  });

  test('with bundling required and the zip present the layer is the zip, flag or not', () => {
    const { layer, packaging } = synth({ bundling: true, zipPath: PRESENT_ZIP, env: {} });
    expect(packaging).toBe(FROM_ZIP);
    expect(layer.Description).toBe('code-trust git from Amazon Linux 2023 packages, at /opt/bin/git');
    expect(synth({ bundling: true, zipPath: PRESENT_ZIP, env: { GIT_LAYER_PLACEHOLDER: '1' } }).packaging).toBe(
      FROM_ZIP,
    );
  });

  test('without an env prop it reads the flag from process.env, where the synth script puts it', () => {
    try {
      vi.stubEnv('GIT_LAYER_PLACEHOLDER', '1');
      expect(synth({ bundling: true, zipPath: MISSING_ZIP }).packaging).toBe(FROM_PLACEHOLDER);
      vi.stubEnv('GIT_LAYER_PLACEHOLDER', undefined);
      expect(() => synth({ bundling: true, zipPath: MISSING_ZIP })).toThrow(/pnpm build:git-layer/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('by default it reads the zip pnpm build:git-layer writes', () => {
    expect(GIT_LAYER_ZIP).toMatch(/\/infra\/layers\/git\/dist\/git-layer\.zip$/);
  });
});
