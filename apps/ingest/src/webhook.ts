// The webhook Lambda handler: verify GitHub's signature, map the delivery to queue messages,
// enqueue them, and answer well inside GitHub's 10 second limit. The secret loader, the queue
// sender and the clock are injected, so tests need no AWS.
import { z } from 'zod';
import { toRepoEvents } from './events.ts';
import { parseSignatureHeader, verifySignature } from './signature.ts';

/** SQS's limit on entries in one SendMessageBatch call. */
export const MAX_BATCH_SIZE = 10;

export interface QueueEntry {
  /** Unique within its batch, as SQS requires. */
  readonly id: string;
  readonly body: string;
}

/** Sends one batch of at most MAX_BATCH_SIZE entries. SQS reports partial failures without throwing. */
export type SendBatch = (entries: readonly QueueEntry[]) => Promise<{ readonly failedCount: number }>;

export type LogEntry = Readonly<Record<string, string | number>>;

export interface WebhookDeps {
  readonly loadSecret: () => Promise<string>;
  readonly sendBatch: SendBatch;
  readonly now: () => Date;
  readonly log?: (entry: LogEntry) => void;
}

/** The fields read from a Lambda Function URL event (API Gateway payload format 2.0). */
export interface WebhookRequest {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface WebhookResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type WebhookHandler = (request: WebhookRequest) => Promise<WebhookResponse>;

class EmptySecretError extends Error {
  override readonly name = 'EmptySecretError';
}

const DeliveryIdSchema = z.guid();

// Only these values are logged as they are. Anything else is logged as 'other', so a log line
// never carries an arbitrary string from the request.
const KNOWN_EVENTS = new Set(['ping', 'push', 'installation', 'installation_repositories']);
const KNOWN_ACTIONS = new Set([
  'created',
  'deleted',
  'suspend',
  'unsuspend',
  'new_permissions_accepted',
  'added',
  'removed',
]);

const RESPONSE_BODY: Readonly<Record<number, string>> = {
  200: 'ok',
  400: 'bad request',
  401: 'invalid signature',
  500: 'internal error',
};

export function createWebhookHandler(deps: WebhookDeps): WebhookHandler {
  const log = deps.log ?? ((entry: LogEntry) => console.log(JSON.stringify(entry)));

  // Loaded on the first request and reused for the life of the execution environment. A failed
  // load is forgotten, so the next request tries again instead of failing until a cold start.
  let secret: Promise<string> | undefined;
  const loadSecretOnce = (): Promise<string> => {
    if (secret === undefined) {
      const pending = deps.loadSecret().then((value) => {
        // An empty key would make every signature forgeable.
        if (value === '') throw new EmptySecretError('the webhook secret is empty');
        return value;
      });
      secret = pending;
      pending.catch(() => {
        if (secret === pending) secret = undefined;
      });
    }
    return secret;
  };

  const respond = (statusCode: number, entry: LogEntry): WebhookResponse => {
    log({ status: statusCode, ...entry });
    return {
      statusCode,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: RESPONSE_BODY[statusCode] ?? 'error',
    };
  };

  const handle = async (request: WebhookRequest): Promise<WebhookResponse> => {
    const headers = lowercaseKeys(request.headers);
    const signature = headers['x-hub-signature-256'];
    // A missing or malformed header needs no secret, so junk traffic never reaches SSM.
    if (parseSignatureHeader(signature) === null) return respond(401, { outcome: 'rejected', reason: 'no-signature' });

    let key: string;
    try {
      key = await loadSecretOnce();
    } catch (error) {
      return respond(500, { outcome: 'failed', reason: 'secret-unavailable', error: errorName(error) });
    }

    // The exact bytes GitHub sent. A Function URL base64-encodes bodies it treats as binary.
    const raw = Buffer.from(request.body ?? '', request.isBase64Encoded === true ? 'base64' : 'utf8');
    if (!verifySignature(key, raw, signature)) return respond(401, { outcome: 'rejected', reason: 'bad-signature' });

    // From here the request is GitHub's own, but log lines still carry only known values.
    const event = headers['x-github-event'];
    const context: Record<string, string> = { event: event === undefined ? 'none' : known(KNOWN_EVENTS, event) };

    const deliveryId = DeliveryIdSchema.safeParse(headers['x-github-delivery']);
    if (!deliveryId.success) return respond(400, { ...context, outcome: 'invalid', reason: 'delivery-id' });
    context.deliveryId = deliveryId.data;

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      // The parse error quotes the body, so it is not logged.
      return respond(400, { ...context, outcome: 'invalid', reason: 'body-not-json' });
    }
    const action = actionOf(payload);
    if (action !== undefined) context.action = known(KNOWN_ACTIONS, action);

    const result = toRepoEvents({
      event,
      deliveryId: deliveryId.data,
      receivedAt: deps.now().toISOString(),
      payload,
    });
    if (result.kind === 'invalid') {
      return respond(400, { ...context, outcome: 'invalid', reason: result.reason, fields: result.fields.join(',') });
    }
    if (result.kind === 'ignored') return respond(200, { ...context, outcome: 'ignored', reason: result.reason });

    const batches = chunk(
      result.messages.map((message) => JSON.stringify(message)),
      MAX_BATCH_SIZE,
    ).map((bodies) => bodies.map((body, i) => ({ id: `m${i}`, body })));
    // Every batch is attempted, so one failure does not drop the rest. A redelivery after a 500
    // repeats the ones that succeeded; the consumer dedupes on deliveryId plus repo.id.
    const sent = await Promise.allSettled(batches.map((batch) => deps.sendBatch(batch)));
    const rejected = sent.filter((outcome) => outcome.status === 'rejected');
    const failedEntries = sent.reduce(
      (n, outcome) => n + (outcome.status === 'fulfilled' ? outcome.value.failedCount : 0),
      0,
    );
    if (rejected.length > 0 || failedEntries > 0) {
      return respond(500, {
        ...context,
        outcome: 'failed',
        reason: 'queue-send',
        messages: result.messages.length,
        failedBatches: rejected.length,
        failedEntries,
        error: rejected[0] === undefined ? 'PartialBatchFailure' : errorName(rejected[0].reason),
      });
    }
    return respond(200, { ...context, outcome: 'enqueued', messages: result.messages.length });
  };

  return async (request) => {
    try {
      return await handle(request);
    } catch (error) {
      // Answer GitHub with a 500 the handler chose, rather than an error from the Lambda runtime.
      return respond(500, { outcome: 'failed', reason: 'unexpected', error: errorName(error) });
    }
  };
}

function lowercaseKeys(headers: WebhookRequest['headers']): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
}

function known(values: ReadonlySet<string>, value: string): string {
  return values.has(value) ? value : 'other';
}

function actionOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('action' in payload)) return undefined;
  return typeof payload.action === 'string' ? payload.action : undefined;
}

// Only the name: an error message can quote the request or a response body.
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
