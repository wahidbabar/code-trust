// Runs a Lambda function's bundle from the synthesized cloud assembly (infra/cdk.out) on this
// machine, the way the nodejs runtime would. The stack tests skip bundling, so this is what proves
// a CommonJS bundle loads and boots. smoke-api.ts uses it for the API; the worker's stack (T13)
// uses it for the worker and the dispatcher.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin, type ModuleHooks, registerHooks } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CDK_OUT = fileURLToPath(new URL('../cdk.out', import.meta.url));

// What the runtime provides besides Node itself. NodejsFunction leaves both out of the bundle.
const RUNTIME_PACKAGES = /^@(aws-sdk|smithy)\//;

export interface FunctionAssetLocation {
  /** Defaults to infra/cdk.out. */
  cdkOut?: string;
  /** The stack ID, such as `CodeTrustApi`. */
  stack: string;
  /** The function's construct path inside the stack, such as `ApiFunction`. */
  constructPath: string;
}

type Manifest = { artifacts?: Record<string, { type?: string; properties?: { templateFile?: string } }> };
type Template = {
  Resources?: Record<string, { Type?: string; Properties?: { Handler?: unknown }; Metadata?: Record<string, unknown> }>;
};

const SYNTH_FIRST = 'Run `pnpm synth` first: it bundles every stack.';

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The bundled file of the function at `${stack}/${constructPath}`, found through the template's
 * asset metadata (`aws:cdk:path` and `aws:asset:path`), which the CDK CLI writes on every synth.
 */
export function findFunctionAsset({ cdkOut = CDK_OUT, stack, constructPath }: FunctionAssetLocation): string {
  const manifestFile = join(cdkOut, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error(`${manifestFile} does not exist. ${SYNTH_FIRST}`);
  const artifact = (readJson(manifestFile) as Manifest).artifacts?.[stack];
  const templateFile = artifact?.properties?.templateFile;
  if (artifact?.type !== 'aws:cloudformation:stack' || templateFile === undefined) {
    throw new Error(`${cdkOut} has no stack ${stack}. ${SYNTH_FIRST}`);
  }

  const cdkPath = `${stack}/${constructPath}/Resource`;
  const resources = Object.values((readJson(join(cdkOut, templateFile)) as Template).Resources ?? {});
  const fn = resources.find((r) => r.Type === 'AWS::Lambda::Function' && r.Metadata?.['aws:cdk:path'] === cdkPath);
  if (fn === undefined) throw new Error(`${stack} has no Lambda function at ${cdkPath}.`);

  const assetPath = fn.Metadata?.['aws:asset:path'];
  const handler = fn.Properties?.Handler;
  if (typeof assetPath !== 'string' || fn.Metadata?.['aws:asset:is-bundled'] !== true) {
    throw new Error(`${cdkPath} has no bundled asset in ${cdkOut}. ${SYNTH_FIRST}`);
  }
  if (typeof handler !== 'string' || !handler.includes('.')) throw new Error(`${cdkPath} has no file.export handler.`);
  // `index.handler` is the export `handler` of index.js.
  const file = join(cdkOut, assetPath, `${handler.slice(0, handler.lastIndexOf('.'))}.js`);
  if (!existsSync(file)) throw new Error(`${file} does not exist. ${SYNTH_FIRST}`);
  return file;
}

export interface LoadFunctionBundleOptions extends FunctionAssetLocation {
  /**
   * The function's own package directory, such as apps/api. Its dependencies stand in for the AWS
   * SDK the runtime ships, which is the only package outside the bundle the function may load.
   */
  sdkFrom: string;
}

export interface FunctionBundle {
  file: string;
  bytes: number;
  exports: Record<string, unknown>;
  /** Removes the resolve hook. Calls into the bundle after this resolve normally. */
  release(): void;
}

/**
 * Requires the bundle as CommonJS, with module resolution limited to what Lambda offers: Node's builtins, and
 * `@aws-sdk/*` and `@smithy/*` from `sdkFrom`. Anything else the bundle asks for is missing, as it
 * is in /var/task, rather than found by walking up into the repo's node_modules. Nest expects that
 * for the optional packages it is bundled without, and catches it.
 */
export function loadFunctionBundle(options: LoadFunctionBundleOptions): FunctionBundle {
  const file = findFunctionAsset(options);
  // Real path: Node hands the hooks resolved paths, and cdk.out may be reached through a symlink.
  const assetDir = pathToFileURL(realpathSync(dirname(file)) + sep).href;
  // A require() resolves from its parent module's directory whatever parentURL says, so the
  // runtime's packages are resolved here, as the function's own package would require them.
  const requireSdk = createRequire(join(options.sdkFrom, 'package.json'));

  const hooks: ModuleHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL?.startsWith(assetDir) || isBuiltin(specifier) || /^\.{0,2}\//.test(specifier)) {
        return nextResolve(specifier, context);
      }
      if (RUNTIME_PACKAGES.test(specifier)) {
        return { url: pathToFileURL(requireSdk.resolve(specifier)).href, shortCircuit: true };
      }
      throw Object.assign(
        new Error(
          `Cannot find module '${specifier}': it is not in the bundle, and the Lambda runtime does not provide it.`,
        ),
        { code: 'MODULE_NOT_FOUND' },
      );
    },
    // cdk.out sits under infra/package.json, whose "type": "module" would make the bundle's .js an
    // ES module. In /var/task no package.json says so, and the runtime loads it as CommonJS.
    load(url, context, nextLoad) {
      if (!url.startsWith(assetDir)) return nextLoad(url, context);
      return { ...nextLoad(url, { ...context, format: 'commonjs' }), format: 'commonjs' };
    },
  });

  try {
    const loaded: unknown = createRequire(import.meta.url)(file);
    return {
      file,
      bytes: statSync(file).size,
      exports: loaded as Record<string, unknown>,
      release: () => hooks.deregister(),
    };
  } catch (error) {
    hooks.deregister();
    throw error;
  }
}

/** Calls the bundle's export `name` with `args`, which T13's smoke passes as an SQS event. */
export function callExport(bundle: FunctionBundle, name: string, ...args: unknown[]): unknown {
  const fn = bundle.exports[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `${bundle.file} exports no function ${name}. It exports: ${Object.keys(bundle.exports).join(', ')}.`,
    );
  }
  return fn(...args);
}
