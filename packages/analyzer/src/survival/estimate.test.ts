import {
  type IsoTimestamp,
  SURVIVAL_HORIZON_DAYS,
  SurvivalCurvePointsSchema,
  SurvivalMetricSchema,
  type SurvivalObservation,
} from '@code-trust/shared';
import {
  OBSERVED_AT,
  REPO_ID,
  revertedObservationFixtures,
  revertedSurvivalCurveFixture,
  revertedSurvivalMetricFixture,
  SHA,
  survivalCurveFixture,
  survivalMetricFixture,
  survivalObservationFixtures,
} from '@code-trust/shared/fixtures';
import { describe, expect, test } from 'vitest';
import { seededRandom } from '../seeded-random.ts';
import { estimateSurvival, type SurvivalEstimate } from './estimate.ts';

const DAY_MS = 86_400_000;

type Observation = Pick<SurvivalObservation, 'lineCount' | 'introducedAt' | 'removedAt'>;

const at = (ms: number): IsoTimestamp => new Date(ms).toISOString();
const daysBefore = (days: number): IsoTimestamp => at(Date.parse(OBSERVED_AT) - days * DAY_MS);
const alive = (lineCount: number, age: number): Observation => ({
  lineCount,
  introducedAt: daysBefore(age),
  removedAt: null,
});
const removed = (lineCount: number, age: number, lifetime: number): Observation => ({
  lineCount,
  introducedAt: daysBefore(age),
  removedAt: daysBefore(age - lifetime),
});

function estimate(observations: readonly Observation[]): SurvivalEstimate {
  const result = estimateSurvival(observations, OBSERVED_AT);
  if (result === null) throw new Error('expected an estimate');
  return result;
}

const horizons = (result: SurvivalEstimate) => [result.survival30d, result.survival90d, result.survival180d];

/** Close to 1e-12, but 0 and null only ever equal themselves. */
function expectSurvival(actual: number | null, expected: number | null, context?: string): void {
  if (expected === null || expected === 0) expect(actual, context).toBe(expected);
  else {
    expect(actual, context).not.toBeNull();
    expect(actual, context).toBeCloseTo(expected, 12);
  }
}

describe('the shared fixtures', () => {
  test("survivalObservationFixtures give survivalMetricFixture's counts and horizons and survivalCurveFixture's points", () => {
    const result = estimate(survivalObservationFixtures);
    expect(result).toMatchObject({
      linesTotal: survivalMetricFixture.linesTotal,
      linesRemoved: survivalMetricFixture.linesRemoved,
      linesCensored: survivalMetricFixture.linesCensored,
    });
    expectSurvival(result.survival30d, survivalMetricFixture.survival30d);
    expectSurvival(result.survival90d, survivalMetricFixture.survival90d);
    expectSurvival(result.survival180d, survivalMetricFixture.survival180d);

    expect(result.points.map(({ day, atRisk }) => ({ day, atRisk }))).toEqual(
      survivalCurveFixture.points.map(({ day, atRisk }) => ({ day, atRisk })),
    );
    result.points.forEach((point, i) => {
      expectSurvival(point.survival, survivalCurveFixture.points[i]?.survival ?? null);
    });
  });

  test('revertedObservationFixtures give the reverted metric and curve, with survival exactly 0', () => {
    expect(estimate(revertedObservationFixtures)).toEqual({
      linesTotal: revertedSurvivalMetricFixture.linesTotal,
      linesRemoved: revertedSurvivalMetricFixture.linesRemoved,
      linesCensored: revertedSurvivalMetricFixture.linesCensored,
      survival30d: 0,
      survival90d: 0,
      survival180d: 0,
      points: revertedSurvivalCurveFixture.points,
    });
  });
});

describe('edges', () => {
  test('no observations returns null', () => {
    expect(estimateSurvival([], OBSERVED_AT)).toBeNull();
  });

  test('a removal time before the introduction counts as day 0', () => {
    const skewed = { lineCount: 3, introducedAt: daysBefore(60), removedAt: daysBefore(60.25) };
    expect(estimate([skewed]).points).toEqual([
      { day: 0, survival: 1, atRisk: 3 },
      { day: 1, survival: 0, atRisk: 0 },
    ]);
    expect(estimate([skewed, alive(1, 50.5)])).toEqual({
      linesTotal: 4,
      linesRemoved: 3,
      linesCensored: 1,
      survival30d: 0.25,
      survival90d: null,
      survival180d: null,
      points: [
        { day: 0, survival: 1, atRisk: 4 },
        { day: 1, survival: 0.25, atRisk: 1 },
        { day: 50, survival: 0.25, atRisk: 1 },
      ],
    });
  });

  test("a cohort whose every line is alive has survival 1 on every point, ends on its oldest line's day and is null past it", () => {
    const result = estimate([alive(2, 10.5), alive(5, 40.2), alive(1, 0.1)]);
    expect(result.points).toEqual([
      { day: 0, survival: 1, atRisk: 8 },
      { day: 1, survival: 1, atRisk: 7 },
      { day: 11, survival: 1, atRisk: 5 },
      { day: 40, survival: 1, atRisk: 5 },
    ]);
    expect(horizons(result)).toEqual([1, null, null]);
    expect(result).toMatchObject({ linesTotal: 8, linesRemoved: 0, linesCensored: 8 });
  });

  test.each([
    ['every line removed by day 20: 0 at every horizon', [removed(4, 100, 19.5)], [0, 0, 0]],
    ['S reaches 0 on day 30 itself: 0 at 30', [removed(4, 100, 29.5)], [0, 0, 0]],
    ['every line alive and the oldest 29 days old: null at 30', [alive(4, 29.9)], [null, null, null]],
    [
      'nothing at risk on day 30 while S is above 0: null, not 0',
      [removed(1, 40, 10), alive(3, 29.5)],
      [null, null, null],
    ],
    ['the oldest line exactly 30 days old: known at 30', [removed(1, 40, 10), alive(3, 30.5)], [0.75, null, null]],
    ['a long-lived tail keeps S above 0 at 180', [removed(1, 300, 5), alive(1, 250)], [0.5, 0.5, 0.5]],
  ])('0 and null are never confused at a horizon: %s', (_why, observations, expected) => {
    const result = estimate(observations);
    expect(horizons(result)).toEqual(expected);
    expect(SurvivalCurvePointsSchema.safeParse(result.points).error).toBeUndefined();
  });

  test('a timestamp that does not parse or a line count that is not a positive integer is refused', () => {
    expect(() => estimateSurvival([{ ...alive(1, 5), introducedAt: 'yesterday' }], OBSERVED_AT)).toThrow(RangeError);
    expect(() => estimateSurvival([alive(1, 5)], 'now')).toThrow(RangeError);
    expect(() => estimateSurvival([alive(0, 5)], OBSERVED_AT)).toThrow(RangeError);
    expect(() => estimateSurvival([alive(1.5, 5)], OBSERVED_AT)).toThrow(RangeError);
  });
});

// The estimator exactly as the doc states it, copied from the worked example at the end of
// packages/shared/src/domain.test.ts. Day by day, with no shortcuts. Changes from the copy:
// `observedAt` is a parameter, a line is removed when it has a removal time (the input carries no
// removedBy), and atRisk is returned too so point counts can be compared.
function referenceEstimator(observations: readonly Observation[], observedAt: IsoTimestamp) {
  const wholeDays = (o: Observation) =>
    Math.max(0, Math.floor((Date.parse(o.removedAt ?? observedAt) - Date.parse(o.introducedAt)) / DAY_MS));

  const lines = observations.map((o) => ({ t: wholeDays(o), n: o.lineCount, removed: o.removedAt !== null }));
  const atRisk = (day: number) => lines.filter((l) => l.t >= day).reduce((sum, l) => sum + l.n, 0);
  const survivalAt = (k: number): number | null => {
    let survival = 1;
    for (let day = 0; day < k && atRisk(day) > 0; day++) {
      const removed = lines.filter((l) => l.removed && l.t === day).reduce((sum, l) => sum + l.n, 0);
      survival *= 1 - removed / atRisk(day);
    }
    // Nothing at risk on day k: 0 if every line was removed, otherwise unknown.
    if (atRisk(k) === 0) return survival === 0 ? 0 : null;
    return survival;
  };
  return { survivalAt, atRisk };
}

/** The points rule 7 asks for, found by walking the reference day by day. */
function expectedPoints(reference: ReturnType<typeof referenceEstimator>) {
  const points = [{ day: 0, survival: reference.survivalAt(0), atRisk: reference.atRisk(0) }];
  for (let day = 1; ; day++) {
    const atRisk = reference.atRisk(day);
    const survival = reference.survivalAt(day);
    if (atRisk === 0) {
      if (survival === 0) points.push({ day, survival, atRisk });
      else if (points.at(-1)?.day !== day - 1) {
        points.push({ day: day - 1, survival: reference.survivalAt(day - 1), atRisk: reference.atRisk(day - 1) });
      }
      return points;
    }
    if (survival !== reference.survivalAt(day - 1) || atRisk !== reference.atRisk(day - 1)) {
      points.push({ day, survival, atRisk });
    }
  }
}

describe('rule: the estimator agrees with the day-by-day definition', () => {
  test('over 400 seeded random cohorts', () => {
    const random = seededRandom(20_261_001);
    const observedMs = Date.parse(OBSERVED_AT);

    for (let i = 0; i < 400; i++) {
      // A few shared whole-day ages and lifetimes per cohort, so lifetimes tie often.
      const days = Array.from({ length: random.int(1, 4) }, () => random.int(0, 200));
      const allRemoved = random.chance(0.2);
      const observations: Observation[] = Array.from({ length: random.int(1, 10) }, () => {
        const introducedMs = observedMs - random.pick(days) * DAY_MS - random.int(0, DAY_MS - 1);
        if (!allRemoved && random.chance(0.5))
          return { lineCount: random.int(1, 6), introducedAt: at(introducedMs), removedAt: null };
        const lifetimeMs = random.chance(0.1)
          ? -random.int(1, 2 * DAY_MS)
          : random.pick(days) * DAY_MS + random.int(0, DAY_MS - 1);
        const removedMs = Math.min(observedMs, introducedMs + lifetimeMs);
        return { lineCount: random.int(1, 6), introducedAt: at(introducedMs), removedAt: at(removedMs) };
      });
      const context = `cohort ${i}: ${JSON.stringify(observations)}`;
      const result = estimateSurvival(observations, OBSERVED_AT);
      if (result === null) throw new Error(`no estimate for ${context}`);

      expect(SurvivalCurvePointsSchema.safeParse(result.points).error, context).toBeUndefined();
      const metric = { repoId: REPO_ID, cohort: 'ai', headSha: SHA.head, observedAt: OBSERVED_AT, ...result };
      expect(SurvivalMetricSchema.safeParse(metric).error, context).toBeUndefined();
      const sum = (list: readonly Observation[]) => list.reduce((total, o) => total + o.lineCount, 0);
      expect(result.linesTotal, context).toBe(sum(observations));
      expect(result.linesRemoved, context).toBe(sum(observations.filter((o) => o.removedAt !== null)));
      expect(result.linesCensored, context).toBe(sum(observations.filter((o) => o.removedAt === null)));

      const reference = referenceEstimator(observations, OBSERVED_AT);
      const expected = expectedPoints(reference);
      expect(
        result.points.map(({ day, atRisk }) => ({ day, atRisk })),
        context,
      ).toEqual(expected.map(({ day, atRisk }) => ({ day, atRisk })));
      for (const point of result.points) {
        expectSurvival(point.survival, reference.survivalAt(point.day), context);
        expect(point.atRisk, context).toBe(reference.atRisk(point.day));
      }
      SURVIVAL_HORIZON_DAYS.forEach((horizon, h) => {
        expectSurvival(horizons(result)[h] ?? null, reference.survivalAt(horizon), `${context} at ${horizon}`);
      });
    }
  });
});
