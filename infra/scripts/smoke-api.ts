// `pnpm --filter @code-trust/infra smoke:api`, after `pnpm synth`: loads the synthesized CodeTrustApi
// bundle as the Lambda runtime would, builds its handler with a placeholder database URL, and sends
// GET /health through it. That proves the CommonJS bundle boots Nest with its externals left out.
// Nothing connects to the URL: /health makes no query, and any network call fails the run.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callExport, loadFunctionBundle } from './function-bundle.ts';

const API_PACKAGE = fileURLToPath(new URL('../../apps/api/', import.meta.url));
const INFRA = fileURLToPath(new URL('..', import.meta.url));
const PLACEHOLDER_DATABASE_URL = 'postgres://u:p@example.invalid/db';

// A Function URL event (payload format 2.0), trimmed to what the adapter reads.
const HEALTH = {
  version: '2.0',
  routeKey: '$default',
  rawPath: '/health',
  rawQueryString: '',
  headers: { host: 'smoke.lambda-url.ap-south-1.on.aws' },
  requestContext: {
    domainName: 'smoke.lambda-url.ap-south-1.on.aws',
    http: { method: 'GET', path: '/health', protocol: 'HTTP/1.1', sourceIp: '203.0.113.7', userAgent: 'smoke' },
    requestId: 'smoke',
    routeKey: '$default',
    stage: '$default',
  },
  isBase64Encoded: false,
};

type Result = { statusCode?: number; body?: string };
type Handler = (event: unknown) => Promise<Result>;

globalThis.fetch = () => {
  throw new Error('The bundle made a network call.');
};

const started = performance.now();
const bundle = loadFunctionBundle({ stack: 'CodeTrustApi', constructPath: 'ApiFunction', sdkFrom: API_PACKAGE });
const loaded = performance.now();

// The runtime's SDK and node-postgres must stay out: one bundled by mistake still boots.
const text = readFileSync(bundle.file, 'utf8');
const inlined = [/node_modules\/@aws-sdk\//, /node_modules\/pg\//, /require\(["']pg["']\)/].filter((p) => p.test(text));
if (inlined.length > 0) throw new Error(`The bundle holds what it must not: ${inlined.join(', ')}`);

const handler = callExport(bundle, 'createHandler', {
  loadDatabaseUrl: async () => PLACEHOLDER_DATABASE_URL,
}) as Handler;
const result = await handler(HEALTH);
const answered = performance.now();

console.log(`bundle ${relative(INFRA, bundle.file)}, ${(bundle.bytes / 2 ** 20).toFixed(1)} MiB`);
console.log(
  `required in ${Math.round(loaded - started)} ms, first answer ${Math.round(answered - loaded)} ms later ` +
    '(this machine; on Lambda, read Init Duration in the log)',
);
console.log(`status ${result.statusCode}`);
console.log(result.body);

if (result.statusCode !== 200 || result.body !== '{"status":"ok"}') {
  console.error('smoke:api failed: expected status 200 and {"status":"ok"}.');
  process.exitCode = 1;
}
