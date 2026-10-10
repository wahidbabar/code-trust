// `pnpm --filter @code-trust/infra smoke:worker`, after `pnpm synth`: loads the synthesized
// CodeTrustWorker bundles, the worker's and the dispatcher's, as the Lambda runtime would, and sends
// each an SQS event with no records. That proves each CommonJS bundle loads with the runtime's SDK
// and nothing else, and that an empty batch calls no AWS service: any network call fails the run.
import https from 'node:https';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { callExport, loadFunctionBundle } from './function-bundle.ts';

const INFRA = fileURLToPath(new URL('..', import.meta.url));
// Each function's own package stands in for the SDK the runtime ships.
const FUNCTIONS = [
  { constructPath: 'WorkerFunction', sdkFrom: fileURLToPath(new URL('../../apps/worker/', import.meta.url)) },
  { constructPath: 'DispatcherFunction', sdkFrom: fileURLToPath(new URL('../../apps/ingest/', import.meta.url)) },
];
const EMPTY_BATCH = { batchItemFailures: [] };

const networkCall = () => {
  throw new Error('The bundle made a network call.');
};
// Neon's driver sends through fetch, and the AWS SDK through https.request, which it looks up on
// every call.
globalThis.fetch = networkCall;
https.request = networkCall;

for (const { constructPath, sdkFrom } of FUNCTIONS) {
  const bundle = loadFunctionBundle({ stack: 'CodeTrustWorker', constructPath, sdkFrom });
  try {
    const result = await callExport(bundle, 'handler', { Records: [] });
    console.log(`${constructPath}: bundle ${relative(INFRA, bundle.file)}, ${(bundle.bytes / 2 ** 20).toFixed(1)} MiB`);
    console.log(`${constructPath}: ${JSON.stringify(result)}`);
    if (!isDeepStrictEqual(result, EMPTY_BATCH)) {
      console.error(`smoke:worker failed: ${constructPath} should answer exactly ${JSON.stringify(EMPTY_BATCH)}.`);
      process.exitCode = 1;
    }
  } finally {
    bundle.release();
  }
}
