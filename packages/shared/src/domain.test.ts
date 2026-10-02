import { describe, expect, test } from 'vitest';
import * as domain from './domain.ts';
import {
  AI_CONFIDENCE_THRESHOLD,
  AttributionSchema,
  EVIDENCE_MAX_LENGTH,
  SURVIVAL_HORIZON_DAYS,
  type SurvivalObservation,
} from './domain.ts';
import {
  apiRepoFixture,
  attributionFixtures,
  commitFixtures,
  lineSpanFixture,
  newApiRepoFixture,
  newRepoFixture,
  OBSERVED_AT,
  repoFixture,
  revertedObservationFixtures,
  revertedSurvivalCurveFixture,
  revertedSurvivalMetricFixture,
  SHA,
  survivalCurveFixture,
  survivalMetricFixture,
  survivalObservationFixtures,
  youngSurvivalMetricFixture,
} from './fixtures.ts';
import { describeSchemas, type SchemaCases } from './schema-cases.ts';

const [trailerAttribution, , identityAttribution] = attributionFixtures;
const [removedObservation, aliveObservation] = survivalObservationFixtures;
const [commit] = commitFixtures;
const points = survivalCurveFixture.points;

const SHA_MESSAGE = /40 lowercase hex/;
const TIMESTAMP_MESSAGE = /UTC ISO timestamp with milliseconds/;

const cases: Record<string, SchemaCases> = {
  IsoTimestampSchema: {
    valid: ['2026-10-02T09:30:00.000Z', new Date(0).toISOString()],
    invalid: [
      { why: 'a timestamp without milliseconds', value: '2026-10-02T09:30:00Z', path: [], message: TIMESTAMP_MESSAGE },
      { why: 'a local offset', value: '2026-10-02T09:30:00.000+05:30', path: [], message: TIMESTAMP_MESSAGE },
      { why: 'a date without a time', value: '2026-10-02', path: [], message: TIMESTAMP_MESSAGE },
      { why: 'epoch milliseconds', value: 1_790_000_000_000, path: [], message: TIMESTAMP_MESSAGE },
    ],
  },
  CommitShaSchema: {
    valid: [SHA.head],
    invalid: [
      { why: 'an abbreviated SHA', value: 'a459361', path: [], message: SHA_MESSAGE },
      { why: 'uppercase hex', value: 'A'.repeat(40), path: [], message: SHA_MESSAGE },
      { why: 'a branch name', value: 'main', path: [], message: SHA_MESSAGE },
    ],
  },
  GithubIdSchema: {
    valid: [1, 1_296_269],
    invalid: [
      { why: 'zero', value: 0, path: [], message: /GitHub numeric id/ },
      { why: 'a fraction', value: 1.5, path: [], message: /GitHub numeric id/ },
      { why: 'a numeric string', value: '1296269', path: [], message: /GitHub numeric id/ },
      { why: 'an id past the safe integer range', value: 2 ** 60, path: [], message: /GitHub numeric id/ },
    ],
  },
  CohortSchema: {
    valid: ['ai', 'human', 'automation'],
    invalid: [{ why: 'an unknown cohort', value: 'bot', path: [], message: /"ai"\|"human"\|"automation"/ }],
  },
  MeasuredCohortSchema: {
    valid: ['ai', 'human'],
    invalid: [
      { why: 'the automation cohort, which has no curve', value: 'automation', path: [], message: /"ai"\|"human"/ },
    ],
  },
  AttributionSignalSchema: {
    valid: ['co_author_trailer', 'author_identity'],
    invalid: [
      {
        why: 'a signal that does not count yet',
        value: 'pr_label',
        path: [],
        message: /"co_author_trailer"\|"author_identity"/,
      },
    ],
  },
  RepoSchema: {
    valid: [repoFixture, newRepoFixture, { ...repoFixture, installationId: null }],
    invalid: [
      {
        why: 'a head without its commit date',
        value: { ...repoFixture, headCommittedAt: null },
        path: ['headSha'],
        message: /set together/,
      },
      {
        why: 'an observation time without a head',
        value: { ...newRepoFixture, observedAt: OBSERVED_AT },
        path: ['headSha'],
        message: /set together/,
      },
      {
        why: 'an owner with a path separator',
        value: { ...repoFixture, owner: 'octo/org' },
        path: ['owner'],
        message: /GitHub owner/,
      },
      { why: 'an empty name', value: { ...repoFixture, name: '' }, path: ['name'], message: /GitHub repository name/ },
      {
        why: 'an empty default branch',
        value: { ...repoFixture, defaultBranch: '' },
        path: ['defaultBranch'],
        message: /branch name/,
      },
      { why: 'a string id', value: { ...repoFixture, id: '1296269' }, path: ['id'], message: /GitHub numeric id/ },
      {
        why: 'a missing installation',
        value: { ...repoFixture, installationId: undefined },
        path: ['installationId'],
        message: /GitHub numeric id/,
      },
    ],
  },
  ApiRepoSchema: {
    valid: [apiRepoFixture, newApiRepoFixture],
    invalid: [
      {
        why: 'a head without its commit date',
        value: { ...apiRepoFixture, headCommittedAt: null },
        path: ['headSha'],
        message: /set together/,
      },
      {
        why: 'a head commit date in a local offset',
        value: { ...apiRepoFixture, headCommittedAt: '2026-09-29T05:30:00.000+05:30' },
        path: ['headCommittedAt'],
        message: TIMESTAMP_MESSAGE,
      },
    ],
  },
  RepoRefSchema: {
    valid: [{ id: repoFixture.id, owner: repoFixture.owner, name: repoFixture.name }],
    invalid: [
      { why: 'a missing owner', value: { id: 1, name: 'hello' }, path: ['owner'], message: /GitHub owner/ },
      {
        why: 'a name with a space',
        value: { id: 1, owner: 'octo-org', name: 'hello world' },
        path: ['name'],
        message: /GitHub repository name/,
      },
    ],
  },
  CommitSchema: {
    valid: commitFixtures,
    invalid: [
      { why: 'a short SHA', value: { ...commit, sha: 'abc123' }, path: ['sha'], message: SHA_MESSAGE },
      { why: 'an unknown cohort', value: { ...commit, cohort: 'robot' }, path: ['cohort'], message: /"ai"/ },
      {
        why: 'a landing time without milliseconds',
        value: { ...commit, landedAt: '2026-03-14T12:00:00Z' },
        path: ['landedAt'],
        message: TIMESTAMP_MESSAGE,
      },
    ],
  },
  AttributionSchema: {
    valid: attributionFixtures,
    invalid: [
      {
        why: 'confidence above 1',
        value: { ...trailerAttribution, confidence: 1.2 },
        path: ['confidence'],
        message: /<=1/,
      },
      {
        why: 'negative confidence',
        value: { ...trailerAttribution, confidence: -0.1 },
        path: ['confidence'],
        message: />=0/,
      },
      {
        why: 'a tool name that is not a slug',
        value: { ...trailerAttribution, tool: 'Claude Code' },
        path: ['tool'],
        message: /tool slug/,
      },
      {
        why: 'a signal that does not count yet',
        value: { ...trailerAttribution, signal: 'message_marker' },
        path: ['signal'],
        message: /"co_author_trailer"/,
      },
      {
        why: 'trailer evidence on an author_identity signal',
        value: { ...identityAttribution, evidence: trailerAttribution?.evidence },
        path: ['evidence'],
        message: /bare identity/,
      },
      {
        why: 'a bare identity on a co_author_trailer signal',
        value: { ...trailerAttribution, evidence: 'Claude <noreply@anthropic.com>' },
        path: ['evidence'],
        message: /Co-Authored-By trailer/,
      },
    ],
  },
  LineSpanSchema: {
    valid: [lineSpanFixture, { path: 'README.md', startLine: 1, lineCount: 1 }],
    invalid: [
      { why: 'line 0', value: { ...lineSpanFixture, startLine: 0 }, path: ['startLine'], message: />=1/ },
      { why: 'an empty span', value: { ...lineSpanFixture, lineCount: 0 }, path: ['lineCount'], message: />=1/ },
      { why: 'an empty path', value: { ...lineSpanFixture, path: '' }, path: ['path'], message: /file path/ },
    ],
  },
  SurvivalObservationSchema: {
    valid: survivalObservationFixtures,
    invalid: [
      {
        why: 'a removing commit without a removal time',
        value: { ...removedObservation, removedAt: null },
        path: ['removedAt'],
        message: /set together/,
      },
      {
        why: 'a removal time on lines that are alive',
        value: { ...aliveObservation, removedAt: OBSERVED_AT },
        path: ['removedAt'],
        message: /set together/,
      },
      { why: 'zero lines', value: { ...aliveObservation, lineCount: 0 }, path: ['lineCount'], message: />=1/ },
      {
        why: 'a fractional line count',
        value: { ...aliveObservation, lineCount: 2.5 },
        path: ['lineCount'],
        message: /expected int/,
      },
      {
        why: 'an abbreviated introducing SHA',
        value: { ...aliveObservation, introducedBy: 'aaaaaaa' },
        path: ['introducedBy'],
        message: SHA_MESSAGE,
      },
    ],
  },
  SurvivalCurvePointSchema: {
    valid: [...points, { day: 6, survival: 0, atRisk: 0 }],
    invalid: [
      {
        why: 'survival above 1',
        value: { day: 3, survival: 1.01, atRisk: 4 },
        path: ['survival'],
        message: /<=1/,
      },
      { why: 'a negative day', value: { day: -1, survival: 1, atRisk: 4 }, path: ['day'], message: />=0/ },
      {
        why: 'a point with nothing at risk while survival is above 0',
        value: { day: 300, survival: 0.64, atRisk: 0 },
        path: ['atRisk'],
        message: /atRisk is 0 exactly when survival is 0/,
      },
      {
        why: 'zero survival with lines still at risk',
        value: { day: 6, survival: 0, atRisk: 4 },
        path: ['atRisk'],
        message: /atRisk is 0 exactly when survival is 0/,
      },
    ],
  },
  SurvivalCurvePointsSchema: {
    valid: [points, [{ day: 0, survival: 1, atRisk: 1 }], revertedSurvivalCurveFixture.points],
    invalid: [
      {
        why: 'points after survival has reached 0',
        value: [...revertedSurvivalCurveFixture.points, { day: 9, survival: 0, atRisk: 0 }],
        path: [],
        message: /reaches 0 to be the last one/,
      },
      { why: 'an empty curve', value: [], path: [], message: /day 0 point/ },
      { why: 'a curve that starts after day 0', value: points.slice(1), path: [], message: /first point at day 0/ },
      {
        why: 'points out of order',
        value: [points[0], points[2], points[1]],
        path: [],
        message: /ascending day order/,
      },
      { why: 'a repeated day', value: [points[0], points[1], points[1]], path: [], message: /ascending day order/ },
    ],
  },
  SurvivalCurveSchema: {
    valid: [survivalCurveFixture, revertedSurvivalCurveFixture],
    invalid: [
      {
        why: 'a curve for the automation cohort',
        value: { ...survivalCurveFixture, cohort: 'automation' },
        path: ['cohort'],
        message: /"ai"\|"human"/,
      },
      {
        why: 'a bad point inside the curve',
        value: { cohort: 'ai', points: [{ day: 0, survival: 2, atRisk: 1 }] },
        path: ['points', 0, 'survival'],
        message: /<=1/,
      },
    ],
  },
  SurvivalMetricSchema: {
    valid: [survivalMetricFixture, youngSurvivalMetricFixture, revertedSurvivalMetricFixture],
    invalid: [
      {
        why: 'line counts that do not add up',
        value: { ...survivalMetricFixture, linesCensored: 6 },
        path: ['linesTotal'],
        message: /linesRemoved \+ linesCensored/,
      },
      {
        why: 'survival as a percentage',
        value: { ...survivalMetricFixture, survival30d: 80 },
        path: ['survival30d'],
        message: /<=1/,
      },
      {
        why: 'a missing horizon instead of an explicit null',
        value: { ...survivalMetricFixture, survival180d: undefined },
        path: ['survival180d'],
        message: /expected number/,
      },
      {
        why: 'the automation cohort',
        value: { ...survivalMetricFixture, cohort: 'automation' },
        path: ['cohort'],
        message: /"ai"\|"human"/,
      },
    ],
  },
};

describeSchemas(domain, cases);

describe('attribution evidence never carries a human identity', () => {
  const HUMAN = 'Jane Doe <jane@example.com>';
  const AI_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

  const parseEvidence = (evidence: string) => AttributionSchema.safeParse({ ...trailerAttribution, evidence });

  test('accepts the AI trailer on its own', () => {
    expect(parseEvidence(AI_TRAILER).success).toBe(true);
  });

  test.each([
    ['the whole trailer block, AI and human', `${AI_TRAILER}\nCo-Authored-By: ${HUMAN}`],
    ['a human trailer before the AI one', `Co-Authored-By: ${HUMAN}\r\n${AI_TRAILER}`],
    ['two identities on one line', `${AI_TRAILER}, ${HUMAN}`],
    ['the commit author appended to the trailer', `${AI_TRAILER} (author: ${HUMAN})`],
    ['a full commit message', `fix: rounding\n\nReviewed by Jane.\n\n${AI_TRAILER}`],
  ])('rejects %s', (_why, evidence) => {
    const result = parseEvidence(evidence);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['evidence']);
    expect(result.error?.issues[0]?.message).toMatch(/exactly one identity on one line/);
  });

  test('rejects evidence too long to be one identity', () => {
    const evidence = `Co-Authored-By: ${'x'.repeat(EVIDENCE_MAX_LENGTH)} <noreply@anthropic.com>`;
    expect(parseEvidence(evidence).success).toBe(false);
  });

  test('no domain schema has a field for an author name or email', () => {
    const fields = Object.values(domain).flatMap((value) =>
      value instanceof Object && 'shape' in value ? Object.keys(value.shape as object) : [],
    );
    expect(fields).toContain('evidence');
    expect(fields.filter((field) => /author(Name|Email)|email|login/i.test(field))).toEqual([]);
  });
});

describe('worked example from docs/architecture.md', () => {
  const DAY_MS = 86_400_000;

  const wholeDays = (o: SurvivalObservation) =>
    Math.max(0, Math.floor((Date.parse(o.removedAt ?? OBSERVED_AT) - Date.parse(o.introducedAt)) / DAY_MS));

  // The estimator exactly as the doc states it. The analyzer owns the real one; this only checks
  // that the fixtures and the documented numbers agree with the definition.
  const estimator =
    (observations: SurvivalObservation[]) =>
    (k: number): number | null => {
      const lines = observations.map((o) => ({ t: wholeDays(o), n: o.lineCount, removed: o.removedBy !== null }));
      const atRisk = (day: number) => lines.filter((l) => l.t >= day).reduce((sum, l) => sum + l.n, 0);
      let survival = 1;
      for (let day = 0; day < k && atRisk(day) > 0; day++) {
        const removed = lines.filter((l) => l.removed && l.t === day).reduce((sum, l) => sum + l.n, 0);
        survival *= 1 - removed / atRisk(day);
      }
      // Nothing at risk on day k: 0 if every line was removed, otherwise unknown.
      if (atRisk(k) === 0) return survival === 0 ? 0 : null;
      return survival;
    };

  const survivalAt = estimator(survivalObservationFixtures);

  test('the fixtures have the lifetimes the doc lists', () => {
    expect(survivalObservationFixtures.map((o) => [o.lineCount, wholeDays(o), o.removedBy !== null])).toEqual([
      [2, 10, true],
      [3, 45, false],
      [1, 60, true],
      [4, 200, false],
    ]);
  });

  test('S(30) = 0.8, S(90) = S(180) = 0.64, S(365) is unknown', () => {
    expect(SURVIVAL_HORIZON_DAYS).toEqual([30, 90, 180]);
    expect(survivalAt(30)).toBeCloseTo(0.8, 12);
    expect(survivalAt(90)).toBeCloseTo(0.64, 12);
    expect(survivalAt(180)).toBeCloseTo(0.64, 12);
    expect(survivalAt(365)).toBeNull();
    expect(survivalMetricFixture).toMatchObject({ survival30d: 0.8, survival90d: 0.64, survival180d: 0.64 });
  });

  test('the curve fixture is the same step function', () => {
    for (const point of survivalCurveFixture.points) {
      expect(survivalAt(point.day)).toBeCloseTo(point.survival, 12);
    }
    // One day past the last point nothing is at risk.
    expect(survivalAt((survivalCurveFixture.points.at(-1)?.day ?? 0) + 1)).toBeNull();
  });

  test('a reverted change has survival 0, not unknown', () => {
    const reverted = estimator(revertedObservationFixtures);
    expect(revertedObservationFixtures.map(wholeDays)).toEqual([5]);
    expect(reverted(5)).toBe(1);
    expect(reverted(6)).toBe(0);
    for (const horizon of SURVIVAL_HORIZON_DAYS) expect(reverted(horizon)).toBe(0);
    expect(revertedSurvivalMetricFixture).toMatchObject({ survival30d: 0, survival90d: 0, survival180d: 0 });
    for (const point of revertedSurvivalCurveFixture.points) expect(reverted(point.day)).toBe(point.survival);
  });

  test('explicit signals sit above the AI threshold', () => {
    expect(attributionFixtures.every((a) => a.confidence >= AI_CONFIDENCE_THRESHOLD)).toBe(true);
  });
});
