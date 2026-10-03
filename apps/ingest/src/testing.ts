// Test builders: GitHub-shaped payloads, signed requests and fakes for the injected dependencies.
// Only tests import this module. src/lambda.ts never reaches it, so it stays out of the bundle.
import { createHmac } from 'node:crypto';
import { INSTALLATION_ID, pushEventFixture, REPO_ID, SHA } from '@code-trust/shared/fixtures';
import type { LogEntry, QueueEntry, SendBatch, WebhookRequest } from './webhook.ts';

export const TEST_SECRET = 'test-webhook-secret-7f3a9c';
export const DELIVERY_ID = pushEventFixture.deliveryId;
export const RECEIVED_AT = pushEventFixture.receivedAt;

export function signatureOf(secret: string, body: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface SignedRequestOptions {
  readonly secret?: string;
  readonly deliveryId?: string | null;
  readonly base64?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A Function URL request as GitHub would send it: lowercase headers, signed over the exact body. */
export function signedRequest(
  event: string | null,
  payload: unknown,
  { secret = TEST_SECRET, deliveryId = DELIVERY_ID, base64 = false, headers = {} }: SignedRequestOptions = {},
): WebhookRequest {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const bytes = Buffer.from(body, 'utf8');
  return {
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/abc1234',
      'x-hub-signature-256': signatureOf(secret, bytes),
      ...(event === null ? {} : { 'x-github-event': event }),
      ...(deliveryId === null ? {} : { 'x-github-delivery': deliveryId }),
      ...headers,
    },
    body: base64 ? bytes.toString('base64') : body,
    isBase64Encoded: base64,
  };
}

/** The fields GitHub sends on a push to octo-org/hello.world, plus some this lane never reads. */
export function pushPayload(overrides: Record<string, unknown> = {}, repository: Record<string, unknown> = {}) {
  return {
    ref: 'refs/heads/main',
    before: SHA.removerTwo,
    after: SHA.head,
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    compare: 'https://github.com/octo-org/hello.world/compare/dddddddddddd...ffffffffffff',
    commits: [{ id: SHA.head, message: 'feat: add invoice export', distinct: true }],
    head_commit: { id: SHA.head, message: 'feat: add invoice export' },
    repository: {
      id: REPO_ID,
      node_id: 'R_kgDOABPHzQ',
      name: 'hello.world',
      full_name: 'octo-org/hello.world',
      private: false,
      visibility: 'public',
      default_branch: 'main',
      master_branch: 'main',
      // Push payloads carry these as Unix seconds; nothing here may depend on their type.
      created_at: 1_557_933_565,
      pushed_at: 1_790_933_400,
      ...repository,
    },
    pusher: { name: 'octocat' },
    sender: { login: 'octocat', id: 1, type: 'User' },
    installation: { id: INSTALLATION_ID, node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uNTIzNDA5MTc=' },
    ...overrides,
  };
}

export function repositoryEntry(id: number, fullName: string, isPrivate = false) {
  return { id, node_id: `R_${id}`, name: fullName.split('/')[1] ?? fullName, full_name: fullName, private: isPrivate };
}

/** `count` public repos with ids 1001, 1002, and so on. */
export function publicRepositories(count: number) {
  return Array.from({ length: count }, (_, i) => repositoryEntry(1001 + i, `octo-org/repo-${i + 1}`));
}

export function installationPayload(action: string, repositories: readonly unknown[] | undefined) {
  return {
    action,
    installation: {
      id: INSTALLATION_ID,
      account: { login: 'octo-org', type: 'Organization' },
      repository_selection: 'selected',
      permissions: { contents: 'read', metadata: 'read' },
      events: ['push'],
    },
    ...(repositories === undefined ? {} : { repositories }),
    requester: null,
    sender: { login: 'octocat', id: 1, type: 'User' },
  };
}

export function installationRepositoriesPayload(
  action: string,
  added: readonly unknown[],
  removed: readonly unknown[] = [],
) {
  return {
    action,
    installation: { id: INSTALLATION_ID, account: { login: 'octo-org', type: 'Organization' } },
    repository_selection: 'selected',
    repositories_added: added,
    repositories_removed: removed,
    requester: null,
    sender: { login: 'octocat', id: 1, type: 'User' },
  };
}

/** Records every batch. `failures` maps a batch index to an error to throw or a failed-entry count. */
export function fakeQueue(failures: Readonly<Record<number, Error | number>> = {}) {
  const batches: QueueEntry[][] = [];
  const sendBatch: SendBatch = async (entries) => {
    const index = batches.length;
    batches.push([...entries]);
    const failure = failures[index];
    if (failure instanceof Error) throw failure;
    return { failedCount: failure ?? 0 };
  };
  return {
    sendBatch,
    batches,
    get bodies() {
      return batches.flat().map((entry) => entry.body);
    },
  };
}

export function fakeSecret(value: string | Error = TEST_SECRET) {
  let calls = 0;
  return {
    loadSecret: async () => {
      calls += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    get calls() {
      return calls;
    },
  };
}

export function captureLogs() {
  const lines: string[] = [];
  return { log: (entry: LogEntry) => lines.push(JSON.stringify(entry)), lines };
}

export const fixedClock = () => new Date(RECEIVED_AT);
