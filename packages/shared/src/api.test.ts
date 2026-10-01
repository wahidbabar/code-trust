import { expect, test } from 'vitest';
import * as api from './api.ts';
import {
  apiRepoFixture,
  listReposResponseFixture,
  repoFixture,
  repoSummaryResponseFixture,
  survivalCurveFixture,
  survivalCurveResponseFixture,
  survivalMetricFixture,
} from './fixtures.ts';
import { describeSchemas, type SchemaCases } from './schema-cases.ts';

const cases: Record<string, SchemaCases> = {
  ListReposResponseSchema: {
    valid: [listReposResponseFixture, { repos: [] }],
    invalid: [
      { why: 'a bare array', value: [apiRepoFixture], path: [], message: /expected object/ },
      {
        why: 'a repo whose head has no commit date',
        value: { repos: [apiRepoFixture, { ...apiRepoFixture, headCommittedAt: null }] },
        path: ['repos', 1, 'headSha'],
        message: /set together/,
      },
    ],
  },
  RepoSummaryResponseSchema: {
    valid: [repoSummaryResponseFixture, { repo: apiRepoFixture, metrics: [] }],
    invalid: [
      {
        why: 'a metric whose line counts do not add up',
        value: { repo: apiRepoFixture, metrics: [{ ...survivalMetricFixture, linesRemoved: 9 }] },
        path: ['metrics', 0, 'linesTotal'],
        message: /linesRemoved \+ linesCensored/,
      },
      { why: 'a missing repo', value: { metrics: [] }, path: ['repo'], message: /expected object/ },
    ],
  },
  SurvivalCurveResponseSchema: {
    valid: [survivalCurveResponseFixture, { ...survivalCurveResponseFixture, curves: [] }],
    invalid: [
      {
        why: 'curves without the last activity beside them',
        value: { ...survivalCurveResponseFixture, headCommittedAt: undefined },
        path: ['headCommittedAt'],
        message: /UTC ISO timestamp/,
      },
      {
        why: 'a curve that does not start at day 0',
        value: {
          ...survivalCurveResponseFixture,
          curves: [{ cohort: 'ai', points: survivalCurveFixture.points.slice(1) }],
        },
        path: ['curves', 0, 'points'],
        message: /first point at day 0/,
      },
    ],
  },
};

describeSchemas(api, cases);

test('API repos carry the last activity and not the installation', () => {
  const parsed = api.ListReposResponseSchema.parse({ repos: [repoFixture] });
  expect(parsed.repos[0]).toEqual(apiRepoFixture);
  expect(parsed.repos[0]).not.toHaveProperty('installationId');
  expect(parsed.repos[0]?.headCommittedAt).toBe(repoFixture.headCommittedAt);
});
