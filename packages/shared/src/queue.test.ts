import { expect, test } from 'vitest';
import {
  analysisJobFixture,
  backfillJobFixture,
  deleteRepoJobFixture,
  pushEventFixture,
  repositoryAddedEventFixture,
  repositoryRemovedEventFixture,
  SHA,
} from './fixtures.ts';
import * as queue from './queue.ts';
import { describeSchemas, type SchemaCases } from './schema-cases.ts';

const REMOVED_REASONS = /expected one of "privatized"\|"deleted"\|"uninstalled"\|"removed_from_installation"/;

const cases: Record<string, SchemaCases> = {
  RepoRemovedReasonSchema: {
    valid: ['privatized', 'deleted', 'uninstalled', 'removed_from_installation'],
    invalid: [
      {
        why: 'a reason nobody sends',
        value: 'suspended',
        path: [],
        message: REMOVED_REASONS,
      },
      {
        why: 'an analysis reason',
        value: 'push',
        path: [],
        message: REMOVED_REASONS,
      },
    ],
  },
  RepoEventMessageSchema: {
    valid: [pushEventFixture, repositoryAddedEventFixture, repositoryRemovedEventFixture],
    invalid: [
      {
        why: 'a version this code does not know',
        value: { ...pushEventFixture, version: 2 },
        path: ['version'],
        message: /expected 1/,
      },
      {
        why: 'an event type nobody handles',
        value: { ...pushEventFixture, type: 'issue_comment' },
        path: ['type'],
        message: /Invalid/,
      },
      {
        why: 'a push without its head',
        value: { ...pushEventFixture, headSha: undefined },
        path: ['headSha'],
        message: /40 lowercase hex/,
      },
      {
        why: 'a delivery id that is not a GUID',
        value: { ...pushEventFixture, deliveryId: 'delivery-1' },
        path: ['deliveryId'],
        message: /X-GitHub-Delivery GUID/,
      },
      {
        why: 'a repo without an owner',
        value: { ...repositoryAddedEventFixture, repo: { id: 1, name: 'hello' } },
        path: ['repo', 'owner'],
        message: /GitHub owner/,
      },
      {
        why: 'a missing installation',
        value: { ...repositoryAddedEventFixture, installationId: null },
        path: ['installationId'],
        message: /GitHub numeric id/,
      },
      {
        why: 'a removal with an unknown reason',
        value: { ...repositoryRemovedEventFixture, reason: 'suspended' },
        path: ['reason'],
        message: REMOVED_REASONS,
      },
      {
        why: 'a removal without a reason',
        value: { ...repositoryRemovedEventFixture, reason: undefined },
        path: ['reason'],
        message: REMOVED_REASONS,
      },
    ],
  },
  AnalysisJobMessageSchema: {
    valid: [analysisJobFixture, backfillJobFixture],
    invalid: [
      {
        why: 'a version this code does not know',
        value: { ...analysisJobFixture, version: 2 },
        path: ['version'],
        message: /expected 1/,
      },
      {
        why: 'a missing version',
        value: { ...analysisJobFixture, version: undefined },
        path: ['version'],
        message: /expected 1/,
      },
      {
        why: 'an unknown reason',
        value: { ...analysisJobFixture, reason: 'cron' },
        path: ['reason'],
        message: /"push"\|"backfill"/,
      },
      {
        why: 'a removal reason on an analyze job',
        value: { ...analysisJobFixture, reason: 'deleted' },
        path: ['reason'],
        message: /"push"\|"backfill"/,
      },
      {
        why: 'a job id that is not a UUID',
        value: { ...analysisJobFixture, jobId: 'job-1' },
        path: ['jobId'],
        message: /UUID/,
      },
      {
        why: 'a branch name where the head SHA goes',
        value: { ...analysisJobFixture, headSha: 'main' },
        path: ['headSha'],
        message: /40 lowercase hex/,
      },
      {
        why: 'a request time without milliseconds',
        value: { ...analysisJobFixture, requestedAt: '2026-10-01T09:30:01Z' },
        path: ['requestedAt'],
        message: /UTC ISO timestamp/,
      },
      {
        why: 'an analyze job without type',
        value: { ...analysisJobFixture, type: undefined },
        path: ['type'],
        message: /expected "analyze"/,
      },
      {
        why: 'a delivery id that is not a GUID',
        value: { ...analysisJobFixture, deliveryId: 'delivery-1' },
        path: ['deliveryId'],
        message: /X-GitHub-Delivery GUID/,
      },
    ],
  },
  DeleteRepoJobMessageSchema: {
    valid: [deleteRepoJobFixture],
    invalid: [
      {
        why: 'a delete_repo job without repo',
        value: { ...deleteRepoJobFixture, repo: undefined },
        path: ['repo'],
        message: /expected object/,
      },
      {
        why: 'an analysis reason on a delete job',
        value: { ...deleteRepoJobFixture, reason: 'push' },
        path: ['reason'],
        message: REMOVED_REASONS,
      },
      {
        why: 'a version this code does not know',
        value: { ...deleteRepoJobFixture, version: 2 },
        path: ['version'],
        message: /expected 1/,
      },
      {
        why: 'a job id that is not a UUID',
        value: { ...deleteRepoJobFixture, jobId: 'job-1' },
        path: ['jobId'],
        message: /UUID/,
      },
    ],
  },
  JobMessageSchema: {
    valid: [analysisJobFixture, backfillJobFixture, deleteRepoJobFixture],
    invalid: [
      {
        why: 'a job with an unknown type',
        value: { ...analysisJobFixture, type: 'reanalyze' },
        path: ['type'],
        message: /Expected 'analyze' \| 'delete_repo'/,
      },
      {
        why: 'an analyze job without type',
        value: { ...analysisJobFixture, type: undefined },
        path: ['type'],
        message: /Expected 'analyze' \| 'delete_repo'/,
      },
      {
        why: 'a delete_repo job without repo',
        value: { ...deleteRepoJobFixture, repo: undefined },
        path: ['repo'],
        message: /expected object/,
      },
      {
        why: 'a delete_repo job with an analysis reason',
        value: { ...deleteRepoJobFixture, reason: 'backfill' },
        path: ['reason'],
        message: REMOVED_REASONS,
      },
    ],
  },
};

describeSchemas(queue, cases);

// JSON.stringify of each fixture as it was on main before T07, generated from main's fixtures.ts.
// Frozen as literals so an edit to the fixtures cannot carry this test along with it.
const EVENT_FIXTURES_ON_MAIN = {
  push: '{"version":1,"type":"push","deliveryId":"72d3162e-cc78-11e3-81ab-4c9367dc0958","receivedAt":"2026-10-01T09:30:00.123Z","installationId":52340917,"repo":{"id":1296269,"owner":"octo-org","name":"hello.world"},"headSha":"ffffffffffffffffffffffffffffffffffffffff"}',
  repositoryAdded:
    '{"version":1,"type":"repository_added","deliveryId":"0b989ba4-242f-11e5-81e1-c7b6966d2516","receivedAt":"2026-10-01T09:31:00.000Z","installationId":52340917,"repo":{"id":1296269,"owner":"octo-org","name":"hello.world"}}',
};

test('RepoEventMessageSchema still parses the event fixtures exactly as they were on main before T07', () => {
  expect(JSON.stringify(pushEventFixture)).toBe(EVENT_FIXTURES_ON_MAIN.push);
  expect(JSON.stringify(repositoryAddedEventFixture)).toBe(EVENT_FIXTURES_ON_MAIN.repositoryAdded);
  for (const body of Object.values(EVENT_FIXTURES_ON_MAIN)) {
    expect(queue.RepoEventMessageSchema.parse(JSON.parse(body))).toEqual(JSON.parse(body));
  }
});

test('each job fixture carries the delivery, repo and installation of the event that causes it', () => {
  expect(analysisJobFixture).toMatchObject({
    deliveryId: pushEventFixture.deliveryId,
    installationId: pushEventFixture.installationId,
    repo: pushEventFixture.repo,
    headSha: pushEventFixture.type === 'push' ? pushEventFixture.headSha : undefined,
  });
  expect(backfillJobFixture).toMatchObject({
    deliveryId: repositoryAddedEventFixture.deliveryId,
    installationId: repositoryAddedEventFixture.installationId,
    repo: repositoryAddedEventFixture.repo,
  });
  expect(deleteRepoJobFixture).toMatchObject({
    deliveryId: repositoryRemovedEventFixture.deliveryId,
    repo: repositoryRemovedEventFixture.repo,
    reason:
      repositoryRemovedEventFixture.type === 'repository_removed' ? repositoryRemovedEventFixture.reason : undefined,
  });
});

test('messages stay small enough for SQS', () => {
  const messages = [
    pushEventFixture,
    repositoryAddedEventFixture,
    repositoryRemovedEventFixture,
    analysisJobFixture,
    backfillJobFixture,
    deleteRepoJobFixture,
  ];
  for (const message of messages) {
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(1024);
  }
});

test('a consumer drops fields it does not know instead of failing', () => {
  const parsed = queue.RepoEventMessageSchema.parse({ ...pushEventFixture, pusher: 'someone', headSha: SHA.head });
  expect(parsed).toEqual(pushEventFixture);
});
