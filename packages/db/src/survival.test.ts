// Proves the database row types and the shared zod types agree for survival data: at compile time
// through the mapper signatures and a field-by-field type comparison, and at run time by writing
// the shared fixtures to real Postgres and parsing what comes back.
import {
  type SurvivalCurve,
  SurvivalCurveSchema,
  type SurvivalMetric,
  SurvivalMetricSchema,
  type SurvivalObservation,
  SurvivalObservationSchema,
} from '@code-trust/shared';
import {
  REPO_ID,
  revertedSurvivalCurveFixture,
  revertedSurvivalMetricFixture,
  SHA,
  survivalCurveFixture,
  survivalMetricFixture,
  survivalObservationFixtures,
  youngSurvivalCurveFixture,
  youngSurvivalMetricFixture,
} from '@code-trust/shared/fixtures';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, test } from 'vitest';
import {
  deleteRepo,
  deleteSurvivalObservations,
  getSurvivalCurves,
  listSurvivalMetrics,
  listSurvivalObservations,
  upsertSurvivalObservations,
  upsertSurvivalRollup,
} from './queries.ts';
import {
  type SurvivalObservationRow,
  type SurvivalRollupRow,
  toSurvivalCurve,
  toSurvivalMetric,
  toSurvivalObservation,
} from './rows.ts';
import { createTestDatabase, seedFixtures, type TestDatabase, testDatabaseUrl } from './testing.ts';

// How a row is spelled as a domain object: snake_case keys become camelCase, and a timestamptz,
// read as a Date, becomes a UTC ISO string. Nothing else may differ.
type Camel<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<Camel<Tail>>}` : S;
type Stored<T> = T extends Date ? string : T;
type AsDomain<Row> = { [Column in keyof Row & string as Camel<Column>]: Stored<Row[Column]> };

describe('row types and zod types agree (checked by tsc)', () => {
  test('survival_observations is SurvivalObservation, field by field', () => {
    expectTypeOf<Camel<keyof SurvivalObservationRow>>().toEqualTypeOf<keyof SurvivalObservation>();
    // repo_id is the one exception: bigint arrives as a string and the mapper makes it a number.
    expectTypeOf<AsDomain<Omit<SurvivalObservationRow, 'repo_id'>>>().toEqualTypeOf<
      Omit<SurvivalObservation, 'repoId'>
    >();
    expectTypeOf<SurvivalObservationRow['repo_id']>().toEqualTypeOf<string>();
    expectTypeOf<SurvivalObservation['repoId']>().toEqualTypeOf<number>();

    expectTypeOf(toSurvivalObservation).parameter(0).toEqualTypeOf<SurvivalObservationRow>();
    expectTypeOf(toSurvivalObservation).returns.toEqualTypeOf<SurvivalObservation>();
  });

  test('survival_rollups is SurvivalMetric plus the curve, field by field', () => {
    expectTypeOf<Camel<keyof SurvivalRollupRow>>().toEqualTypeOf<keyof SurvivalMetric | 'curve'>();
    expectTypeOf<AsDomain<Omit<SurvivalRollupRow, 'repo_id' | 'curve'>>>().toEqualTypeOf<
      Omit<SurvivalMetric, 'repoId'>
    >();
    // jsonb is untyped in the database, so the mapper has to parse it into the curve type.
    expectTypeOf<SurvivalRollupRow['curve']>().toEqualTypeOf<unknown>();

    expectTypeOf(toSurvivalMetric).parameter(0).toEqualTypeOf<Omit<SurvivalRollupRow, 'curve'>>();
    expectTypeOf(toSurvivalMetric).returns.toEqualTypeOf<SurvivalMetric>();
    expectTypeOf(toSurvivalCurve).returns.toEqualTypeOf<SurvivalCurve>();
  });

  test('the comparison can fail', () => {
    // @ts-expect-error A raw row is not a domain object: its keys are snake_case and its timestamps are Dates.
    expectTypeOf<SurvivalObservationRow>().toEqualTypeOf<SurvivalObservation>();
    type WithoutLineCount = Omit<SurvivalObservation, 'repoId' | 'lineCount'>;
    // @ts-expect-error A field the zod type lacks breaks the agreement.
    expectTypeOf<AsDomain<Omit<SurvivalObservationRow, 'repo_id'>>>().toEqualTypeOf<WithoutLineCount>();
  });
});

describe.skipIf(testDatabaseUrl === null)('survival data round-trips through Postgres', () => {
  let scratch: TestDatabase;

  beforeAll(async () => {
    scratch = await createTestDatabase();
  });

  afterAll(async () => {
    await scratch?.destroy();
  });

  beforeEach(async () => {
    await deleteRepo(scratch.db, REPO_ID);
    await seedFixtures(scratch.db);
  });

  const byKey = (a: SurvivalObservation, b: SurvivalObservation) =>
    `${a.introducedBy}${a.removedBy}`.localeCompare(`${b.introducedBy}${b.removedBy}`);

  test('observations come back equal to what was written, and valid', async () => {
    const stored = await listSurvivalObservations(scratch.db, REPO_ID);
    expect(stored).toHaveLength(survivalObservationFixtures.length);
    for (const observation of stored) expect(SurvivalObservationSchema.parse(observation)).toEqual(observation);
    expect([...stored].sort(byKey)).toEqual([...survivalObservationFixtures].sort(byKey));
  });

  test('the raw rows have the types database.ts declares', async () => {
    const row = await scratch.db
      .selectFrom('survival_observations')
      .selectAll()
      .where('removed_by', '=', SHA.removerOne)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      repo_id: String(REPO_ID),
      introduced_by: SHA.aiOld,
      removed_by: SHA.removerOne,
      line_count: 2,
      introduced_at: expect.any(Date),
      removed_at: expect.any(Date),
    });
  });

  test('observations can be read per cohort, the input to one curve', async () => {
    expect(await listSurvivalObservations(scratch.db, REPO_ID, 'ai')).toHaveLength(4);
    expect(await listSurvivalObservations(scratch.db, REPO_ID, 'human')).toEqual([]);
  });

  test('writing a group again replaces its size, alive groups included', async () => {
    const [removed, alive] = survivalObservationFixtures;
    if (!removed || !alive) throw new Error('fixtures missing');
    await upsertSurvivalObservations(scratch.db, [
      { ...removed, lineCount: 5 },
      { ...alive, lineCount: 1 },
    ]);
    const stored = await listSurvivalObservations(scratch.db, REPO_ID);
    expect(stored).toHaveLength(survivalObservationFixtures.length);
    expect(stored.find((o) => o.removedBy === removed.removedBy)?.lineCount).toBe(5);
    expect(stored.find((o) => o.introducedBy === alive.introducedBy && o.removedBy === null)?.lineCount).toBe(1);
  });

  test('a group that no longer exists can be deleted by key, alive groups included', async () => {
    await deleteSurvivalObservations(scratch.db, REPO_ID, [
      { introducedBy: SHA.aiOld, removedBy: null },
      { introducedBy: SHA.aiOld, removedBy: SHA.removerTwo },
    ]);
    const left = await listSurvivalObservations(scratch.db, REPO_ID);
    expect(left.map((o) => [o.introducedBy, o.removedBy]).sort()).toEqual(
      [
        [SHA.aiOld, SHA.removerOne],
        [SHA.aiRecent, null],
      ].sort(),
    );
  });

  test('rollups come back equal to what was written, and valid', async () => {
    const metrics = await listSurvivalMetrics(scratch.db, REPO_ID);
    for (const metric of metrics) expect(SurvivalMetricSchema.parse(metric)).toEqual(metric);
    expect(metrics).toEqual([survivalMetricFixture, youngSurvivalMetricFixture]);

    const curves = await getSurvivalCurves(scratch.db, REPO_ID);
    for (const curve of curves) expect(SurvivalCurveSchema.parse(curve)).toEqual(curve);
    expect(curves).toEqual([survivalCurveFixture, youngSurvivalCurveFixture]);
  });

  test('a new analysis replaces a rollup instead of adding one', async () => {
    const next: SurvivalMetric = { ...survivalMetricFixture, linesTotal: 12, linesCensored: 9, survival180d: null };
    await upsertSurvivalRollup(scratch.db, { metric: next, points: [{ day: 0, survival: 1, atRisk: 12 }] });
    expect(await listSurvivalMetrics(scratch.db, REPO_ID)).toEqual([next, youngSurvivalMetricFixture]);
    expect((await getSurvivalCurves(scratch.db, REPO_ID))[0]?.points).toEqual([{ day: 0, survival: 1, atRisk: 12 }]);
  });

  test('survival 0 (all removed) and null (not observed yet) stay different through Postgres', async () => {
    await upsertSurvivalRollup(scratch.db, {
      metric: revertedSurvivalMetricFixture,
      points: revertedSurvivalCurveFixture.points,
    });
    const [ai, human] = await listSurvivalMetrics(scratch.db, REPO_ID);
    expect(ai).toEqual(revertedSurvivalMetricFixture);
    expect([ai?.survival90d, human?.survival90d]).toEqual([0, null]);
    expect((await getSurvivalCurves(scratch.db, REPO_ID))[0]).toEqual(revertedSurvivalCurveFixture);
  });

  test('a curve that is not a valid step function is refused on the way in', async () => {
    await expect(
      upsertSurvivalRollup(scratch.db, { metric: survivalMetricFixture, points: survivalCurveFixture.points.slice(1) }),
    ).rejects.toThrow(/first point at day 0/);
  });

  test('a curve corrupted in the database is refused on the way out', async () => {
    await sql`update survival_rollups set curve = '[{"day": 0, "survival": 7}]' where cohort = 'ai'`.execute(
      scratch.db,
    );
    await expect(getSurvivalCurves(scratch.db, REPO_ID)).rejects.toThrow(/atRisk/);
  });
});
