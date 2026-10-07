import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { callExport, findFunctionAsset, loadFunctionBundle } from './function-bundle.ts';

// apps/api depends on @aws-sdk/client-ssm, as the runtime would provide it.
const API_PACKAGE = fileURLToPath(new URL('../../apps/api/', import.meta.url));
const ASSET = 'asset.0123abcd';

// A CommonJS bundle, like NodejsFunction's, reporting what it could load.
const BUNDLE = `
const path = require('node:path');
const { SSMClient } = require('@aws-sdk/client-ssm');
let leaky = 'loaded';
try { require('leaky'); } catch (error) { leaky = error.code; }
module.exports = { joined: path.join('a', 'b'), ssm: typeof SSMClient, leaky, handler: (...args) => ({ args }) };
`;

let root: string;
let cdkOut: string;

function writeAssembly(dir: string, functionMetadata: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      artifacts: {
        TestStack: { type: 'aws:cloudformation:stack', properties: { templateFile: 'TestStack.template.json' } },
        Tree: { type: 'cdk:tree' },
      },
    }),
  );
  writeFileSync(
    join(dir, 'TestStack.template.json'),
    JSON.stringify({
      Resources: {
        LogsABC: { Type: 'AWS::Logs::LogGroup', Metadata: { 'aws:cdk:path': 'TestStack/Fn/Resource' } },
        FnABC: {
          Type: 'AWS::Lambda::Function',
          Properties: { Handler: 'index.handler' },
          Metadata: { 'aws:cdk:path': 'TestStack/Fn/Resource', ...functionMetadata },
        },
      },
    }),
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'code-trust-function-bundle-'));
  // As in infra: the assembly sits under a package.json that makes .js files ES modules.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  cdkOut = join(root, 'cdk.out');
  writeAssembly(cdkOut, { 'aws:asset:path': ASSET, 'aws:asset:is-bundled': true });
  mkdirSync(join(cdkOut, ASSET));
  writeFileSync(join(cdkOut, ASSET, 'index.js'), BUNDLE);
  // Found by walking up from the bundle, as the repo's node_modules would be. Lambda has no such thing.
  mkdirSync(join(cdkOut, 'node_modules', 'leaky'), { recursive: true });
  writeFileSync(join(cdkOut, 'node_modules', 'leaky', 'index.js'), 'module.exports = 1;');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findFunctionAsset', () => {
  test('finds the bundled file of a function by its construct path', () => {
    expect(findFunctionAsset({ cdkOut, stack: 'TestStack', constructPath: 'Fn' })).toBe(
      join(cdkOut, ASSET, 'index.js'),
    );
  });

  test('says to run pnpm synth when the assembly, the stack or the bundle is missing', () => {
    expect(() => findFunctionAsset({ cdkOut: join(root, 'nope'), stack: 'TestStack', constructPath: 'Fn' })).toThrow(
      /manifest\.json does not exist\. Run `pnpm synth` first/,
    );
    expect(() => findFunctionAsset({ cdkOut, stack: 'Tree', constructPath: 'Fn' })).toThrow(/has no stack Tree/);
    expect(() => findFunctionAsset({ cdkOut, stack: 'TestStack', constructPath: 'Other' })).toThrow(
      'TestStack has no Lambda function at TestStack/Other/Resource.',
    );

    // A stack synthesized without bundling, as in the stack tests, has no bundled asset.
    const unbundled = join(root, 'unbundled');
    writeAssembly(unbundled, { 'aws:asset:path': ASSET });
    expect(() => findFunctionAsset({ cdkOut: unbundled, stack: 'TestStack', constructPath: 'Fn' })).toThrow(
      /has no bundled asset/,
    );
  });
});

describe('loadFunctionBundle', () => {
  test('loads the bundle as CommonJS with only builtins and the runtime SDK, and calls its exports', () => {
    const bundle = loadFunctionBundle({ cdkOut, stack: 'TestStack', constructPath: 'Fn', sdkFrom: API_PACKAGE });
    try {
      expect(bundle.exports).toMatchObject({ joined: join('a', 'b'), ssm: 'function', leaky: 'MODULE_NOT_FOUND' });
      expect(bundle.bytes).toBe(Buffer.byteLength(BUNDLE));
      expect(callExport(bundle, 'handler', { Records: [] })).toEqual({ args: [{ Records: [] }] });
      expect(() => callExport(bundle, 'missing')).toThrow(/exports no function missing\. It exports: .*handler/);
    } finally {
      bundle.release();
    }
  });
});
