import {
  AttributionSchema,
  CommitSchema,
  RepoSchema,
  SurvivalCurveSchema,
  SurvivalMetricSchema,
  type SurvivalObservation,
  SurvivalObservationSchema,
} from '@code-trust/shared';
import { repoFixture } from '@code-trust/shared/fixtures';
import { afterAll, describe, expect, test } from 'vitest';
import { analyzeRepo, type RepoAnalysis } from './analyze.ts';
import {
  BASE_TIME,
  DAY,
  type Identity,
  isoAt,
  removeTempDirs,
  ScriptedRepo,
  textLines,
  walkChecked,
} from './history/testing.ts';

afterAll(removeTempDirs);

const REPO_ID = 1_296_269;
const DEPENDABOT: Identity = { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' };
const COPILOT_AGENT: Identity = { name: 'copilot-swe-agent[bot]', email: '198982749+Copilot@users.noreply.github.com' };
const GITHUB_WEB: Identity = { name: 'GitHub', email: 'noreply@github.com' };

/** Day `d` after 2026-01-01, as unix seconds and as the domain's timestamp. */
const day = (d: number): number => BASE_TIME + d * DAY;
const iso = (d: number): string => isoAt(day(d));

const pairs = (observations: readonly SurvivalObservation[]) =>
  observations.map((o) => `${o.introducedBy} ${o.removedBy}`);
const sortObservations = (observations: readonly SurvivalObservation[]) =>
  [...observations].sort((a, b) =>
    `${a.introducedBy} ${a.removedBy ?? '~'}`.localeCompare(`${b.introducedBy} ${b.removedBy ?? '~'}`),
  );

/** The shape checks every analysis must pass, whatever the repo. */
function expectWellFormed(analysis: RepoAnalysis): void {
  expect(CommitSchema.array().safeParse(analysis.commits).error).toBeUndefined();
  expect(AttributionSchema.array().safeParse(analysis.attributions).error).toBeUndefined();
  expect(SurvivalObservationSchema.array().safeParse(analysis.observations).error).toBeUndefined();
  for (const { metric, points } of analysis.rollups) {
    expect(SurvivalMetricSchema.safeParse(metric).error).toBeUndefined();
    expect(SurvivalCurveSchema.safeParse({ cohort: metric.cohort, points }).error).toBeUndefined();
    expect({ headSha: metric.headSha, observedAt: metric.observedAt }).toEqual({
      headSha: analysis.head.headSha,
      observedAt: analysis.head.observedAt,
    });
  }
  expect(RepoSchema.safeParse({ ...repoFixture, ...analysis.head }).error).toBeUndefined();

  const listed = new Set(analysis.commits.map((commit) => commit.sha));
  expect(listed.size).toBe(analysis.commits.length);
  const referenced = [
    ...analysis.observations.flatMap((o) => (o.removedBy === null ? [o.introducedBy] : [o.introducedBy, o.removedBy])),
    ...analysis.attributions.map((a) => a.commitSha),
  ];
  for (const sha of referenced) expect(listed.has(sha), sha).toBe(true);
  expect(new Set(pairs(analysis.observations)).size).toBe(analysis.observations.length);

  const cohorts = analysis.rollups.map((rollup) => rollup.metric.cohort);
  expect(new Set(cohorts).size).toBe(cohorts.length);
  for (const { metric } of analysis.rollups) {
    expect(['ai', 'human']).toContain(metric.cohort);
    expect(metric.linesTotal).toBeGreaterThan(0);
  }
}

describe('analyzeRepo', () => {
  test('on a scripted repo with AI, human and dependabot commits and a removal days later', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'src/human.ts': textLines('human', 4) });
    const human = repo.commit('feat: human code\n', { authoredAt: day(0) });
    // Written on a branch on day 1, landed by a merge on day 5: the clock starts on day 5.
    repo.switch('feature', { create: true });
    repo.write({ 'src/ai.ts': textLines('ai', 5) });
    const ai = repo.commit('feat: ai code\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n', {
      authoredAt: day(1),
    });
    repo.switch('main');
    repo.write({ 'deps.txt': textLines('dep', 3) });
    const bot = repo.commit('Bump deps\n', { author: DEPENDABOT, committer: GITHUB_WEB, authoredAt: day(2) });
    repo.merge('feature', { authoredAt: day(5), message: "Merge branch 'feature'\n" });
    repo.write({ 'src/agent.ts': textLines('agent', 2) });
    const agent = repo.commit('Add retries\n', { author: COPILOT_AGENT, committer: GITHUB_WEB, authoredAt: day(6) });
    // Day 15: removes 2 AI lines, 1 human line and 1 dependabot line.
    repo.write({
      'src/ai.ts': textLines('ai', 3),
      'src/human.ts': textLines('human', 3),
      'deps.txt': textLines('dep', 2),
    });
    const remover = repo.commit('refactor: trim\n', { authoredAt: day(15) });
    await walkChecked(repo);

    const observedAt = iso(100);
    const analysis = await analyzeRepo({ repoDir: repo.dir, repoId: REPO_ID, observedAt });

    expectWellFormed(analysis);
    expect(analysis.head).toEqual({
      headSha: repo.head(),
      headCommittedAt: isoAt(Number(repo.git(['log', '-1', '--format=%ct']).trim())),
      observedAt,
    });
    expect(analysis.head).toEqual({ headSha: remover, headCommittedAt: iso(15), observedAt });

    const commit = (sha: string, authored: number, landed: number, cohort: string) => ({
      repoId: REPO_ID,
      sha,
      authoredAt: iso(authored),
      committedAt: iso(authored),
      landedAt: iso(landed),
      cohort,
    });
    // The merge adds no line of its own, so the walk does not list it.
    expect(analysis.commits).toEqual([
      commit(human, 0, 0, 'human'),
      commit(bot, 2, 2, 'automation'),
      commit(ai, 1, 5, 'ai'),
      commit(agent, 6, 6, 'ai'),
      commit(remover, 15, 15, 'human'),
    ]);
    expect(analysis.attributions).toEqual([
      {
        repoId: REPO_ID,
        commitSha: ai,
        signal: 'co_author_trailer',
        tool: 'claude',
        confidence: 1,
        evidence: 'Co-Authored-By: Claude <noreply@anthropic.com>',
      },
      {
        repoId: REPO_ID,
        commitSha: agent,
        signal: 'author_identity',
        tool: 'copilot',
        confidence: 1,
        evidence: 'copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>',
      },
    ]);

    const observation = (introducedBy: string, removedBy: string | null, lineCount: number, from: number) => ({
      repoId: REPO_ID,
      introducedBy,
      removedBy,
      lineCount,
      introducedAt: iso(from),
      removedAt: removedBy === null ? null : iso(15),
    });
    expect(sortObservations(analysis.observations)).toEqual(
      sortObservations([
        observation(human, null, 3, 0),
        observation(human, remover, 1, 0),
        observation(ai, null, 3, 5),
        observation(ai, remover, 2, 5),
        observation(bot, null, 2, 2),
        observation(bot, remover, 1, 2),
        observation(agent, null, 2, 6),
      ]),
    );

    // Worked by hand. AI: 7 lines landed on days 5 and 6; 2 removed on day 15 (T = 10), 3 alive
    // from day 5 (T = 95) and 2 from day 6 (T = 94). So S(11) = 1 - 2/7 with 5 at risk, n_95 = 3,
    // and day 95 is the last with lines at risk: S(30) = S(90) = 1 - 2/7, S(180) unknown.
    // Human: 4 lines from day 0; 1 removed on day 15 (T = 15), 3 alive (T = 100). Dependabot's
    // lines are in neither curve.
    const metric = { repoId: REPO_ID, headSha: remover, observedAt };
    expect(analysis.rollups).toEqual([
      {
        metric: {
          ...metric,
          cohort: 'ai',
          linesTotal: 7,
          linesRemoved: 2,
          linesCensored: 5,
          survival30d: 1 - 2 / 7,
          survival90d: 1 - 2 / 7,
          survival180d: null,
        },
        points: [
          { day: 0, survival: 1, atRisk: 7 },
          { day: 11, survival: 1 - 2 / 7, atRisk: 5 },
          { day: 95, survival: 1 - 2 / 7, atRisk: 3 },
        ],
      },
      {
        metric: {
          ...metric,
          cohort: 'human',
          linesTotal: 4,
          linesRemoved: 1,
          linesCensored: 3,
          survival30d: 0.75,
          survival90d: 0.75,
          survival180d: null,
        },
        points: [
          { day: 0, survival: 1, atRisk: 4 },
          { day: 16, survival: 0.75, atRisk: 3 },
          { day: 100, survival: 0.75, atRisk: 3 },
        ],
      },
    ]);

    expect(await analyzeRepo({ repoDir: repo.dir, repoId: REPO_ID, observedAt })).toEqual(analysis);
  });

  test('rollups exist only for measured cohorts that have lines', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'deps.txt': textLines('dep', 3) });
    repo.commit('Bump deps\n', { author: DEPENDABOT, committer: GITHUB_WEB });
    // A human commit that only removes: the human cohort still has no lines.
    repo.write({ 'deps.txt': textLines('dep', 2) });
    const removerOnly = repo.commit('Drop a dependency\n');
    repo.write({ 'src/a.ts': textLines('a', 2) });
    repo.commit('feat: a\n');
    const observedAt = iso(30);

    const early = await analyzeRepo({ repoDir: repo.dir, repoId: REPO_ID, head: removerOnly, observedAt });
    expectWellFormed(early);
    expect(early.commits.map((c) => c.cohort)).toEqual(['automation', 'human']);
    expect(early.observations.map((o) => o.lineCount).sort()).toEqual([1, 2]);
    expect(early.rollups).toEqual([]);

    const late = await analyzeRepo({ repoDir: repo.dir, repoId: REPO_ID, observedAt });
    expectWellFormed(late);
    expect(late.rollups.map((rollup) => [rollup.metric.cohort, rollup.metric.linesTotal])).toEqual([['human', 2]]);
  });

  test('a repo id or observation time the shared schemas reject is refused before the walk', async () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': 'a\n' });
    repo.commit('a\n');
    await expect(analyzeRepo({ repoDir: repo.dir, repoId: 0, observedAt: iso(1) })).rejects.toThrow(
      /GitHub numeric id/,
    );
    await expect(
      analyzeRepo({ repoDir: repo.dir, repoId: REPO_ID, observedAt: '2026-01-02T00:00:00Z' }),
    ).rejects.toThrow(/UTC ISO timestamp with milliseconds/);
  });
});
