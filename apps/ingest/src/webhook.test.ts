import { type RepoEventMessage, RepoEventMessageSchema } from '@code-trust/shared';
import {
  INSTALLATION_ID,
  pushEventFixture,
  REPO_ID,
  repositoryAddedEventFixture,
  repositoryRemovedEventFixture,
} from '@code-trust/shared/fixtures';
import { describe, expect, test } from 'vitest';
import {
  captureLogs,
  DELIVERY_ID,
  fakeQueue,
  fakeSecret,
  installationPayload,
  installationRepositoriesPayload,
  publicRepositories,
  pushPayload,
  repositoryEntry,
  repositoryPayload,
  signatureOf,
  signedRequest,
  TEST_SECRET,
} from './testing.ts';
import { createWebhookHandler, MAX_BATCH_SIZE, type WebhookRequest } from './webhook.ts';

// Later than the fixture's receivedAt, so the test can tell the clock's value from the fixture's.
const NOW = new Date('2026-10-02T08:15:30.456Z');

function setup({
  secret = TEST_SECRET,
  failures = {},
}: {
  secret?: string | Error;
  failures?: Record<number, Error | number>;
} = {}) {
  const secrets = fakeSecret(secret);
  const queue = fakeQueue(failures);
  const logs = captureLogs();
  const handler = createWebhookHandler({
    loadSecret: secrets.loadSecret,
    sendBatch: queue.sendBatch,
    now: () => NOW,
    log: logs.log,
  });
  return { handler, secrets, queue, logs };
}

const messagesOf = (bodies: readonly string[]): RepoEventMessage[] =>
  bodies.map((body) => RepoEventMessageSchema.parse(JSON.parse(body)));

function withHeader(request: WebhookRequest, name: string, value: string | undefined): WebhookRequest {
  const headers = { ...request.headers };
  if (value === undefined) delete headers[name];
  else headers[name] = value;
  return { ...request, headers };
}

describe('row: signature missing, malformed or wrong returns 401 and enqueues nothing', () => {
  const valid = signedRequest('push', pushPayload());
  const goodHex = (valid.headers?.['x-hub-signature-256'] ?? '').slice('sha256='.length);

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['without the sha256= prefix', goodHex],
    ['a sha1= value', `sha1=${goodHex.slice(0, 40)}`],
    ['one hex digit short', `sha256=${goodHex.slice(1)}`],
    ['not hex', `sha256=${'z'.repeat(64)}`],
    ['two values joined by a comma, as a duplicated header arrives', `sha256=${goodHex},sha256=${goodHex}`],
  ])('malformed: %s, rejected before the secret is loaded', async (_, header) => {
    const { handler, secrets, queue } = setup();
    const response = await handler(withHeader(valid, 'x-hub-signature-256', header));
    expect(response.statusCode).toBe(401);
    expect(secrets.calls).toBe(0);
    expect(queue.batches).toEqual([]);
  });

  test('only the legacy sha1 X-Hub-Signature header', async () => {
    const { handler, queue } = setup();
    const request = withHeader(valid, 'x-hub-signature-256', undefined);
    const response = await handler(withHeader(request, 'x-hub-signature', `sha1=${goodHex.slice(0, 40)}`));
    expect(response.statusCode).toBe(401);
    expect(queue.batches).toEqual([]);
  });

  test('wrong: signed with another secret', async () => {
    const { handler, queue } = setup();
    const response = await handler(signedRequest('push', pushPayload(), { secret: 'not-the-secret' }));
    expect(response.statusCode).toBe(401);
    expect(queue.batches).toEqual([]);
  });

  test('wrong: the body changed after it was signed', async () => {
    const { handler, queue } = setup();
    const tampered = { ...valid, body: (valid.body ?? '').replace('refs/heads/main', 'refs/heads/main ') };
    const response = await handler(tampered);
    expect(response.statusCode).toBe(401);
    expect(queue.batches).toEqual([]);
  });

  test('an unsigned POST with no body, as in the README smoke test', async () => {
    const { handler, queue } = setup();
    const response = await handler({ headers: { 'content-type': 'application/json' } });
    expect(response).toMatchObject({ statusCode: 401, body: 'invalid signature' });
    expect(queue.batches).toEqual([]);
  });

  test('header names are matched case-insensitively', async () => {
    const { handler } = setup();
    const request = signedRequest('push', pushPayload());
    const upper = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
    expect((await handler({ ...request, headers: upper })).statusCode).toBe(200);
  });
});

describe('row: a valid ping, or an event or action not listed, returns 200 and enqueues nothing', () => {
  test.each([
    ['ping', 'ping', { zen: 'Design for failure.', hook_id: 1, hook: { type: 'App', app_id: 42 } }],
    ['an unlisted event', 'issues', { action: 'opened', issue: { number: 1 }, repository: { id: REPO_ID } }],
    ['no X-GitHub-Event header', null, { zen: 'Keep it logically awesome.' }],
    ['installation suspend', 'installation', { action: 'suspend' }],
    ['installation new_permissions_accepted', 'installation', installationPayload('new_permissions_accepted', [])],
  ])('%s', async (_, event, payload) => {
    const { handler, queue } = setup();
    const response = await handler(signedRequest(event, payload));
    expect(response.statusCode).toBe(200);
    expect(queue.batches).toEqual([]);
  });
});

describe('row: a push to the default branch of a public repo returns 200 and enqueues one push message', () => {
  test('the message equals pushEventFixture apart from receivedAt, which comes from the clock', async () => {
    const { handler, queue } = setup();
    const response = await handler(signedRequest('push', pushPayload()));
    expect(response.statusCode).toBe(200);
    const [message, ...rest] = messagesOf(queue.bodies);
    expect(rest).toEqual([]);
    expect(message?.receivedAt).toBe(NOW.toISOString());
    expect({ ...message, receivedAt: pushEventFixture.receivedAt }).toEqual(pushEventFixture);
  });

  test('headSha is the push payload\'s "after"', async () => {
    const { handler, queue } = setup();
    const after = '0123456789abcdef0123456789abcdef01234567';
    await handler(signedRequest('push', pushPayload({ after })));
    expect(messagesOf(queue.bodies)).toMatchObject([{ type: 'push', headSha: after }]);
  });

  test('the default branch is whatever the repo says, not main', async () => {
    const { handler, queue } = setup();
    await handler(signedRequest('push', pushPayload({ ref: 'refs/heads/trunk' }, { default_branch: 'trunk' })));
    expect(messagesOf(queue.bodies)).toHaveLength(1);
  });
});

describe('row: a push to another ref, a branch deletion, or a private repo returns 200 and enqueues nothing', () => {
  test.each([
    [
      'another branch, with no installation field to read',
      pushPayload({ ref: 'refs/heads/feature', installation: undefined }),
    ],
    ['a branch whose name starts with the default one', pushPayload({ ref: 'refs/heads/main-old' })],
    ['a tag', pushPayload({ ref: 'refs/tags/v1.0.0' })],
    [
      'a deletion of the default branch',
      pushPayload({ deleted: true, after: '0'.repeat(40), commits: [], head_commit: null }),
    ],
    ['a private repo', pushPayload({}, { private: true, visibility: 'private' })],
    ['an internal repo that does not say private', pushPayload({}, { private: false, visibility: 'internal' })],
  ])('%s', async (_, payload) => {
    const { handler, queue } = setup();
    const response = await handler(signedRequest('push', payload));
    expect(response.statusCode).toBe(200);
    expect(queue.batches).toEqual([]);
  });
});

describe('row: installation created returns 200 and enqueues one repository_added per public repo', () => {
  test('private repos are left out, and every message shares the delivery id', async () => {
    const { handler, queue } = setup();
    const repositories = [
      repositoryEntry(REPO_ID, 'octo-org/hello.world'),
      repositoryEntry(2001, 'octo-org/secret-sauce', true),
      repositoryEntry(2002, 'octo-org/docs'),
      repositoryEntry(2003, 'octo-org/payroll', true),
    ];
    const response = await handler(signedRequest('installation', installationPayload('created', repositories)));
    expect(response.statusCode).toBe(200);
    const messages = messagesOf(queue.bodies);
    expect(messages.map((m) => [m.type, m.repo.id, m.deliveryId, m.installationId])).toEqual([
      ['repository_added', REPO_ID, DELIVERY_ID, INSTALLATION_ID],
      ['repository_added', 2002, DELIVERY_ID, INSTALLATION_ID],
    ]);
    const { deliveryId, receivedAt } = repositoryAddedEventFixture;
    expect({ ...messages[0], deliveryId, receivedAt }).toEqual(repositoryAddedEventFixture);
  });

  test('an installation on private repos only enqueues nothing', async () => {
    const { handler, queue } = setup();
    const repositories = [repositoryEntry(2001, 'octo-org/secret-sauce', true)];
    const response = await handler(signedRequest('installation', installationPayload('created', repositories)));
    expect(response.statusCode).toBe(200);
    expect(queue.batches).toEqual([]);
  });
});

describe('row: installation_repositories added returns 200 and enqueues one repository_added per public repo', () => {
  test('private repos are left out, and repositories_removed is not read', async () => {
    const { handler, queue } = setup();
    const added = [repositoryEntry(3001, 'octo-org/new-lib'), repositoryEntry(3002, 'octo-org/hr-tools', true)];
    const removed = [repositoryEntry(3003, 'octo-org/old-lib')];
    const response = await handler(
      signedRequest('installation_repositories', installationRepositoriesPayload('added', added, removed)),
    );
    expect(response.statusCode).toBe(200);
    expect(messagesOf(queue.bodies)).toEqual([
      {
        version: 1,
        type: 'repository_added',
        deliveryId: DELIVERY_ID,
        receivedAt: NOW.toISOString(),
        installationId: INSTALLATION_ID,
        repo: { id: 3001, owner: 'octo-org', name: 'new-lib' },
      },
    ]);
  });
});

describe('row: a valid signature with a bad body, a missing field or no delivery id returns 400', () => {
  const { installation: _installation, ...pushWithoutInstallation } = pushPayload();
  const { after: _after, ...pushWithoutAfter } = pushPayload();
  const { ref: _ref, ...pushWithoutRef } = pushPayload();
  const { private: _private, ...repositoryWithoutPrivate } = pushPayload().repository;

  test.each([
    ['a body that is not JSON', 'push', 'not json {'],
    ['a form-encoded body', 'push', `payload=${encodeURIComponent(JSON.stringify(pushPayload()))}`],
    ['a push to the default branch without "after"', 'push', pushWithoutAfter],
    ['a push to the default branch without installation', 'push', pushWithoutInstallation],
    ['a push without repository.private', 'push', { ...pushPayload(), repository: repositoryWithoutPrivate }],
    ['a push without ref', 'push', pushWithoutRef],
    ['a push whose body is a JSON array', 'push', [pushPayload()]],
    ['a push whose head is not a commit SHA', 'push', pushPayload({ after: 'main' })],
    ['a full_name without a slash', 'push', pushPayload({}, { full_name: 'hello.world' })],
    ['a full_name with two slashes', 'push', pushPayload({}, { full_name: 'octo-org/hello/world' })],
    ['an installation created without repositories', 'installation', installationPayload('created', undefined)],
    ['an installation without an action', 'installation', { installation: { id: INSTALLATION_ID } }],
    [
      'an installation with a repo whose id is not a GitHub id',
      'installation',
      installationPayload('created', [repositoryEntry(-5, 'octo-org/x')]),
    ],
    [
      'installation_repositories added without repositories_added',
      'installation_repositories',
      { action: 'added', installation: { id: 1 } },
    ],
  ])('%s', async (_, event, payload) => {
    const { handler, queue } = setup();
    const response = await handler(signedRequest(event, payload));
    expect(response.statusCode).toBe(400);
    expect(queue.batches).toEqual([]);
  });

  test.each([
    ['missing', null],
    ['not a GUID', 'delivery-1'],
  ])('X-GitHub-Delivery %s, even on a ping', async (_, deliveryId) => {
    const { handler, queue } = setup();
    for (const [event, payload] of [
      ['ping', { zen: 'Speak like a human.' }],
      ['push', pushPayload()],
    ] as const) {
      const response = await handler(signedRequest(event, payload, { deliveryId }));
      expect(response.statusCode).toBe(400);
    }
    expect(queue.batches).toEqual([]);
  });
});

describe('row: a failed queue send or an unloadable secret returns 500', () => {
  test('the queue send rejects', async () => {
    const { handler } = setup({ failures: { 0: new Error('connect ETIMEDOUT') } });
    expect((await handler(signedRequest('push', pushPayload()))).statusCode).toBe(500);
  });

  test('the secret cannot be loaded, and the next request tries again', async () => {
    let attempt = 0;
    const queue = fakeQueue();
    const handler = createWebhookHandler({
      loadSecret: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('AccessDeniedException');
        return TEST_SECRET;
      },
      sendBatch: queue.sendBatch,
      now: () => NOW,
      log: () => {},
    });
    expect((await handler(signedRequest('push', pushPayload()))).statusCode).toBe(500);
    expect(queue.batches).toEqual([]);
    expect((await handler(signedRequest('push', pushPayload()))).statusCode).toBe(200);
    expect(attempt).toBe(2);
  });

  test('the secret loads as an empty string', async () => {
    const { handler, queue } = setup({ secret: '' });
    const request = signedRequest('push', pushPayload(), { secret: '' });
    expect((await handler(request)).statusCode).toBe(500);
    expect(queue.batches).toEqual([]);
  });
});

describe('extra cases', () => {
  test('a base64-encoded body is verified on the decoded bytes', async () => {
    const { handler, queue } = setup();
    const response = await handler(signedRequest('push', pushPayload(), { base64: true }));
    expect(response.statusCode).toBe(200);
    expect(messagesOf(queue.bodies)).toHaveLength(1);
  });

  test('a signature over the base64 text instead of the decoded bytes fails', async () => {
    const { handler } = setup();
    const request = signedRequest('push', pushPayload(), { base64: true });
    const forged = withHeader(request, 'x-hub-signature-256', signatureOf(TEST_SECRET, request.body ?? ''));
    expect((await handler(forged)).statusCode).toBe(401);
  });

  test('a body with non-ASCII UTF-8 verifies on its exact bytes', async () => {
    const { handler, queue } = setup();
    const payload = pushPayload({ head_commit: { message: 'fix: Größe, 日本語 und 🎉' } });
    expect((await handler(signedRequest('push', payload))).statusCode).toBe(200);
    expect(queue.batches).toHaveLength(1);
  });

  test('an installation with 25 public repos enqueues 25 messages in batches of at most 10', async () => {
    const { handler, queue } = setup();
    const response = await handler(
      signedRequest('installation', installationPayload('created', publicRepositories(25))),
    );
    expect(response.statusCode).toBe(200);
    expect(queue.batches.map((batch) => batch.length)).toEqual([10, 10, 5]);
    expect(Math.max(...queue.batches.map((batch) => batch.length))).toBeLessThanOrEqual(MAX_BATCH_SIZE);
    for (const batch of queue.batches) expect(new Set(batch.map((entry) => entry.id)).size).toBe(batch.length);
    const repoIds = messagesOf(queue.bodies).map((message) => message.repo.id);
    expect(new Set(repoIds).size).toBe(25);
  });

  test('a partial batch failure returns 500, after every batch was attempted', async () => {
    const { handler, queue } = setup({ failures: { 1: 1 } });
    const response = await handler(
      signedRequest('installation', installationPayload('created', publicRepositories(25))),
    );
    expect(response.statusCode).toBe(500);
    expect(queue.batches).toHaveLength(3);
  });

  test('every enqueued body parses with RepoEventMessageSchema and carries nothing else', async () => {
    const { handler, queue } = setup();
    await handler(signedRequest('push', pushPayload()));
    await handler(signedRequest('installation', installationPayload('created', publicRepositories(12))));
    await handler(
      signedRequest('installation_repositories', installationRepositoriesPayload('added', publicRepositories(3))),
    );
    expect(queue.bodies).toHaveLength(16);
    for (const body of queue.bodies) {
      const raw: unknown = JSON.parse(body);
      expect(RepoEventMessageSchema.parse(raw)).toEqual(raw);
    }
  });

  test('the secret is loaded once and reused across invocations', async () => {
    const { handler, secrets } = setup();
    for (let i = 0; i < 3; i += 1) {
      expect((await handler(signedRequest('push', pushPayload()))).statusCode).toBe(200);
    }
    expect(secrets.calls).toBe(1);
  });

  test('concurrent first requests share one secret load', async () => {
    const { handler, secrets } = setup();
    const responses = await Promise.all([1, 2, 3].map(() => handler(signedRequest('ping', { zen: 'Half measures.' }))));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(secrets.calls).toBe(1);
  });

  test('log lines never carry the secret, the signature or the body', async () => {
    const canary = 'leak-canary-5d1f';
    const secret = `${canary}-secret`;
    const { handler, logs } = setup({ secret, failures: { 0: new Error(`${canary} in an SDK error message`) } });
    const requests = [
      signedRequest('push', pushPayload({ head_commit: { message: canary } }), { secret }),
      signedRequest('push', `${canary} is not json`, { secret }),
      signedRequest('push', pushPayload({ after: canary }), { secret }),
      signedRequest('push', pushPayload({ ref: `refs/heads/${canary}` }), { secret }),
      signedRequest(canary, { action: canary }, { secret }),
      signedRequest('push', pushPayload(), { secret: 'wrong' }),
      withHeader(signedRequest('push', pushPayload(), { secret }), 'x-hub-signature-256', `sha256=${canary}`),
      signedRequest('push', pushPayload(), { secret, deliveryId: canary }),
    ];
    for (const request of requests) await handler(request);

    expect(logs.lines).toHaveLength(requests.length);
    const signatures = requests.map((request) => request.headers?.['x-hub-signature-256'] ?? '');
    for (const line of logs.lines) {
      expect(line).not.toContain(canary);
      expect(line).not.toContain(secret);
      for (const signature of signatures) expect(line).not.toContain(signature.slice('sha256='.length));
    }
    // The lines are still useful: each says what happened and why.
    for (const line of logs.lines) expect(JSON.parse(line)).toMatchObject({ outcome: expect.any(String) });
  });
});

// Repo removal events. Payloads follow octokit/webhooks' captured examples
// (payload-examples/api.github.com/<event>/<action>.payload.json) unless a test says otherwise.

const reasonOf = (message: RepoEventMessage | undefined) =>
  message?.type === 'repository_removed' ? message.reason : undefined;

const logLine = (lines: readonly string[], index = 0): Record<string, unknown> => JSON.parse(lines[index] ?? '{}');

const removal = (id: number, fullName: string, reason: string) => {
  const [owner, name] = fullName.split('/');
  return {
    version: 1,
    type: 'repository_removed',
    deliveryId: DELIVERY_ID,
    receivedAt: NOW.toISOString(),
    installationId: INSTALLATION_ID,
    repo: { id, owner, name },
    reason,
  };
};

describe('row: repository privatized returns 200 and enqueues one repository_removed, reason privatized', () => {
  test('the message equals repositoryRemovedEventFixture apart from the delivery id and the clock', async () => {
    const { handler, queue } = setup();
    // As in octokit's example: private is true while visibility still says public. A removal reads neither.
    const payload = repositoryPayload('privatized', { private: true, visibility: 'public' });
    const response = await handler(signedRequest('repository', payload));
    expect(response.statusCode).toBe(200);
    const [message, ...rest] = messagesOf(queue.bodies);
    expect(rest).toEqual([]);
    expect(message?.deliveryId).toBe(DELIVERY_ID);
    expect(message?.receivedAt).toBe(NOW.toISOString());
    const { deliveryId, receivedAt } = repositoryRemovedEventFixture;
    expect({ ...message, deliveryId, receivedAt }).toEqual(repositoryRemovedEventFixture);
  });
});

describe('row: repository deleted returns 200 and enqueues one repository_removed, reason deleted', () => {
  // octokit has no repository/deleted example. GitHub's webhook-repository-deleted schema uses the
  // same repository object as privatized, so the payload has the same shape.
  test.each([
    ['a public repo', { private: false, visibility: 'public' }],
    ['a private repo', { private: true, visibility: 'private' }],
  ])('%s', async (_, repository) => {
    const { handler, queue } = setup();
    const response = await handler(signedRequest('repository', repositoryPayload('deleted', repository)));
    expect(response.statusCode).toBe(200);
    expect(messagesOf(queue.bodies)).toEqual([removal(REPO_ID, 'octo-org/hello.world', 'deleted')]);
  });
});

describe('row: repository publicized returns 200 and enqueues one repository_added', () => {
  test('the message equals repositoryAddedEventFixture apart from the delivery id and the clock', async () => {
    const { handler, queue } = setup();
    const payload = repositoryPayload('publicized', { private: false, visibility: 'public' });
    const response = await handler(signedRequest('repository', payload));
    expect(response.statusCode).toBe(200);
    const [message, ...rest] = messagesOf(queue.bodies);
    expect(rest).toEqual([]);
    expect(message?.receivedAt).toBe(NOW.toISOString());
    const { deliveryId, receivedAt } = repositoryAddedEventFixture;
    expect({ ...message, deliveryId, receivedAt }).toEqual(repositoryAddedEventFixture);
  });

  test.each([
    ['visibility internal', { private: false, visibility: 'internal' }],
    ['private still true', { private: true, visibility: 'private' }],
  ])('a publicized repo that is not public enqueues nothing: %s', async (_, repository) => {
    const { handler, queue, logs } = setup();
    const response = await handler(signedRequest('repository', repositoryPayload('publicized', repository)));
    expect(response.statusCode).toBe(200);
    expect(queue.batches).toEqual([]);
    expect(logLine(logs.lines)).toMatchObject({ outcome: 'ignored', reason: 'not-public' });
  });
});

describe('row: repository with any other action returns 200 and enqueues nothing', () => {
  test.each([
    [
      'renamed',
      repositoryPayload(
        'renamed',
        { name: 'hello.world2', full_name: 'octo-org/hello.world2' },
        { changes: { repository: { name: { from: 'hello.world' } } } },
      ),
    ],
    [
      'transferred',
      repositoryPayload(
        'transferred',
        { full_name: 'new-org/hello.world', owner: { login: 'new-org', id: 9_920, type: 'Organization' } },
        { changes: { owner: { from: { organization: { login: 'octo-org', id: 9_919 } } } } },
      ),
    ],
    ['edited', repositoryPayload('edited', {}, { changes: { description: { from: 'An older description.' } } })],
    ['archived', repositoryPayload('archived', { archived: true })],
    ['unarchived', repositoryPayload('unarchived')],
    ['created', repositoryPayload('created')],
  ])('%s', async (_, payload) => {
    const { handler, queue, logs } = setup();
    const response = await handler(signedRequest('repository', payload));
    expect(response.statusCode).toBe(200);
    expect(queue.batches).toEqual([]);
    expect(logLine(logs.lines)).toMatchObject({ outcome: 'ignored', reason: 'unhandled-action' });
  });
});

describe('row: installation deleted returns 200 and enqueues one repository_removed per repo, reason uninstalled', () => {
  test('public and private repos alike, every message sharing the delivery and the installation', async () => {
    const { handler, queue } = setup();
    const repositories = [
      repositoryEntry(REPO_ID, 'octo-org/hello.world'),
      repositoryEntry(2001, 'octo-org/secret-sauce', true),
      repositoryEntry(2002, 'octo-org/docs'),
      repositoryEntry(2003, 'octo-org/payroll', true),
    ];
    const response = await handler(signedRequest('installation', installationPayload('deleted', repositories)));
    expect(response.statusCode).toBe(200);
    const messages = messagesOf(queue.bodies);
    expect(messages.map((m) => [m.type, m.repo.id, reasonOf(m), m.deliveryId, m.installationId])).toEqual([
      ['repository_removed', REPO_ID, 'uninstalled', DELIVERY_ID, INSTALLATION_ID],
      ['repository_removed', 2001, 'uninstalled', DELIVERY_ID, INSTALLATION_ID],
      ['repository_removed', 2002, 'uninstalled', DELIVERY_ID, INSTALLATION_ID],
      ['repository_removed', 2003, 'uninstalled', DELIVERY_ID, INSTALLATION_ID],
    ]);
    expect(messages[1]).toEqual(removal(2001, 'octo-org/secret-sauce', 'uninstalled'));
  });
});

describe('row: installation deleted that names no repos returns 200 and enqueues nothing', () => {
  // The data of such repos stays until a delete by installation exists: see Decisions.
  test.each([
    [
      'no repositories key, as an all-repositories installation may send',
      installationPayload('deleted', undefined, 'all'),
    ],
    ['an empty repositories list', installationPayload('deleted', [], 'all')],
  ])('%s', async (_, payload) => {
    const { handler, queue, logs } = setup();
    const response = await handler(signedRequest('installation', payload));
    expect(response.statusCode).toBe(200);
    expect(queue.batches).toEqual([]);
    expect(logLine(logs.lines)).toMatchObject({ outcome: 'ignored', reason: 'no-repository-list' });
  });
});

describe('row: installation_repositories removed returns 200 and enqueues one repository_removed per repo in repositories_removed', () => {
  test('private repos included, and repositories_added is not read', async () => {
    const { handler, queue } = setup();
    const added = [repositoryEntry(3001, 'octo-org/new-lib')];
    const removed = [repositoryEntry(3003, 'octo-org/old-lib'), repositoryEntry(3004, 'octo-org/hr-tools', true)];
    const response = await handler(
      signedRequest('installation_repositories', installationRepositoriesPayload('removed', added, removed)),
    );
    expect(response.statusCode).toBe(200);
    expect(messagesOf(queue.bodies)).toEqual([
      removal(3003, 'octo-org/old-lib', 'removed_from_installation'),
      removal(3004, 'octo-org/hr-tools', 'removed_from_installation'),
    ]);
  });

  // The dispatcher dedupes jobs on <deliveryId>:<repo id>, so a second event for the same repo in
  // one delivery would be dropped without a trace.
  test('one delivery yields at most one event per repo, even for a repo listed as added and removed', async () => {
    const { handler, queue } = setup();
    const both = [repositoryEntry(3005, 'octo-org/flip-flop')];
    await handler(signedRequest('installation_repositories', installationRepositoriesPayload('removed', both, both)));
    await handler(signedRequest('installation_repositories', installationRepositoriesPayload('added', both, both)));
    expect(messagesOf(queue.bodies).map((m) => [m.type, m.repo.id])).toEqual([
      ['repository_removed', 3005],
      ['repository_added', 3005],
    ]);
  });
});

describe('row: installation_repositories removed with an empty repositories_removed returns 200 and enqueues nothing', () => {
  test('as GitHub sends when an installation narrows from all repositories to selected ones', async () => {
    const { handler, queue, logs } = setup();
    const payload = installationRepositoriesPayload('removed', [], []);
    const response = await handler(signedRequest('installation_repositories', payload));
    expect(response.statusCode).toBe(200);
    expect(queue.batches).toEqual([]);
    expect(logLine(logs.lines)).toMatchObject({ outcome: 'ignored', reason: 'selection-narrowed' });
  });
});

describe('extra cases: repo removal events', () => {
  test('installation_repositories removed with 25 repos enqueues 25 messages in batches of at most 10', async () => {
    const { handler, queue } = setup();
    const payload = installationRepositoriesPayload('removed', [], publicRepositories(25));
    const response = await handler(signedRequest('installation_repositories', payload));
    expect(response.statusCode).toBe(200);
    expect(queue.batches.map((batch) => batch.length)).toEqual([10, 10, 5]);
    expect(Math.max(...queue.batches.map((batch) => batch.length))).toBeLessThanOrEqual(MAX_BATCH_SIZE);
    for (const batch of queue.batches) expect(new Set(batch.map((entry) => entry.id)).size).toBe(batch.length);
    const messages = messagesOf(queue.bodies);
    expect(new Set(messages.map((message) => message.repo.id)).size).toBe(25);
    expect(new Set(messages.map(reasonOf))).toEqual(new Set(['removed_from_installation']));
  });

  describe('a handled action missing a field the enqueue path needs is a 400, read by the strict stage', () => {
    const { installation: _installation, ...privatizedWithoutInstallation } = repositoryPayload('privatized');
    const { id: _id, ...repositoryWithoutId } = repositoryPayload('deleted').repository;
    const { private: _private, ...repositoryWithoutPrivate } = repositoryPayload('publicized').repository;
    const { action: _action, ...repositoryWithoutAction } = repositoryPayload('privatized');

    test.each([
      [
        'repository privatized without installation',
        'repository',
        privatizedWithoutInstallation,
        'repository-fields',
        'installation',
      ],
      [
        'repository deleted without repository.id',
        'repository',
        { ...repositoryPayload('deleted'), repository: repositoryWithoutId },
        'repository-fields',
        'repository.id',
      ],
      [
        'repository publicized without repository.private',
        'repository',
        { ...repositoryPayload('publicized'), repository: repositoryWithoutPrivate },
        'repository-fields',
        'repository.private',
      ],
      ['repository without an action', 'repository', repositoryWithoutAction, 'repository-fields', 'action'],
      [
        'installation deleted, carrying only its action',
        'installation',
        { action: 'deleted' },
        'installation-fields',
        'installation',
      ],
      [
        'installation_repositories removed, carrying only its action',
        'installation_repositories',
        { action: 'removed' },
        'installation-fields',
        'repositories_removed',
      ],
    ])('%s', async (_, event, payload, reason, field) => {
      const { handler, queue, logs } = setup();
      const response = await handler(signedRequest(event, payload));
      expect(response.statusCode).toBe(400);
      expect(queue.batches).toEqual([]);
      const line = logLine(logs.lines);
      expect(line).toMatchObject({ outcome: 'invalid', reason });
      expect(String(line.fields).split(',')).toContain(field);
    });

    test('repository privatized whose full_name has no slash', async () => {
      const { handler, queue, logs } = setup();
      const payload = repositoryPayload('privatized', { full_name: 'hello.world' });
      expect((await handler(signedRequest('repository', payload))).statusCode).toBe(400);
      expect(queue.batches).toEqual([]);
      expect(logLine(logs.lines)).toMatchObject({ outcome: 'invalid', reason: 'full-name' });
    });
  });

  test.each([
    ['renamed', { action: 'renamed' }],
    ['transferred', { action: 'transferred' }],
    ['edited', { action: 'edited' }],
    ['an action named like an Object.prototype key', { action: 'constructor' }],
  ])('an unhandled repository action is a 200 even with every other field missing: %s', async (_, payload) => {
    const { handler, queue, logs } = setup();
    const response = await handler(signedRequest('repository', payload));
    expect(response.statusCode).toBe(200);
    expect(queue.batches).toEqual([]);
    expect(logLine(logs.lines)).toMatchObject({ outcome: 'ignored', reason: 'unhandled-action' });
  });

  test('the log line for a removal carries the reason and the repo ids, and no payload text', async () => {
    const canary = 'leak-canary-5d1f';
    const user = { login: canary, id: 2, type: 'User' };
    const { handler, queue, logs } = setup();
    const privatized = repositoryPayload(
      'privatized',
      { full_name: `${canary}/hello.world`, owner: user, description: canary, private: true, visibility: 'private' },
      { sender: user },
    );
    const uninstalled = installationPayload('deleted', [
      repositoryEntry(1001, `${canary}/a`),
      repositoryEntry(1002, `${canary}/b`, true),
    ]);
    await handler(signedRequest('repository', privatized));
    await handler(signedRequest('installation', uninstalled));

    // The canary reached the queue as the owner, so its absence from the log means something.
    expect(queue.bodies.join('\n')).toContain(canary);
    expect(logs.lines).toHaveLength(2);
    for (const line of logs.lines) expect(line).not.toContain(canary);
    expect(logs.lines.map((line) => JSON.parse(line))).toMatchObject([
      {
        status: 200,
        event: 'repository',
        action: 'privatized',
        outcome: 'enqueued',
        removalReason: 'privatized',
        repoIds: String(REPO_ID),
      },
      {
        status: 200,
        event: 'installation',
        action: 'deleted',
        outcome: 'enqueued',
        removalReason: 'uninstalled',
        repoIds: '1001,1002',
      },
    ]);
  });

  test('a removal whose queue send fails logs the reason and the repo ids on its 500 line', async () => {
    const canary = 'leak-canary-5d1f';
    const { handler, logs } = setup({ failures: { 0: new Error(`${canary} in an SDK error message`) } });
    const payload = repositoryPayload('deleted', { full_name: `${canary}/hello.world` });
    expect((await handler(signedRequest('repository', payload))).statusCode).toBe(500);
    expect(logs.lines[0]).not.toContain(canary);
    expect(logLine(logs.lines)).toMatchObject({
      status: 500,
      reason: 'queue-send',
      removalReason: 'deleted',
      repoIds: String(REPO_ID),
    });
  });

  test('every removal and publicized body parses with RepoEventMessageSchema and carries nothing else', async () => {
    const { handler, queue } = setup();
    await handler(signedRequest('repository', repositoryPayload('privatized')));
    await handler(signedRequest('repository', repositoryPayload('deleted')));
    await handler(signedRequest('repository', repositoryPayload('publicized')));
    await handler(signedRequest('installation', installationPayload('deleted', publicRepositories(3))));
    await handler(
      signedRequest('installation_repositories', installationRepositoriesPayload('removed', [], publicRepositories(2))),
    );
    expect(queue.bodies).toHaveLength(8);
    for (const body of queue.bodies) {
      const raw: unknown = JSON.parse(body);
      expect(RepoEventMessageSchema.parse(raw)).toEqual(raw);
    }
  });
});
