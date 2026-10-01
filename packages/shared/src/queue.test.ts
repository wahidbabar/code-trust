import { expect, test } from 'vitest';
import {
  analysisJobFixture,
  backfillJobFixture,
  pushEventFixture,
  repositoryAddedEventFixture,
  SHA,
} from './fixtures.ts';
import * as queue from './queue.ts';
import { describeSchemas, type SchemaCases } from './schema-cases.ts';

const cases: Record<string, SchemaCases> = {
  RepoEventMessageSchema: {
    valid: [pushEventFixture, repositoryAddedEventFixture],
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
    ],
  },
};

describeSchemas(queue, cases);

test('messages stay small enough for SQS and for an ECS task override', () => {
  for (const message of [pushEventFixture, repositoryAddedEventFixture, analysisJobFixture, backfillJobFixture]) {
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(1024);
  }
});

test('a consumer drops fields it does not know instead of failing', () => {
  const parsed = queue.RepoEventMessageSchema.parse({ ...pushEventFixture, pusher: 'someone', headSha: SHA.head });
  expect(parsed).toEqual(pushEventFixture);
});
