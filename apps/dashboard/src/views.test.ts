import type { ApiRepo, SurvivalMetric } from '@code-trust/shared';
import {
  apiRepoFixture,
  newApiRepoFixture,
  OBSERVED_AT,
  REPO_ID,
  repoSummaryResponseFixture,
  revertedSurvivalMetricFixture,
  SHA,
  survivalCurveFixture,
  survivalCurveResponseFixture,
  survivalMetricFixture,
  youngSurvivalCurveFixture,
  youngSurvivalMetricFixture,
} from '@code-trust/shared/fixtures';
import { describe, expect, test } from 'vitest';
import type { RepoListData, RepoViewData } from './load.ts';
import { renderListView, renderRepoView, type ViewActions, type ViewState } from './views.ts';

const noActions: ViewActions = { retry: () => undefined };
const ready = <T>(data: T): ViewState<T> => ({
  status: 'ready',
  data,
  fetchedAt: Date.parse('2026-10-11T10:00:00.000Z'),
  stale: null,
});

// listReposResponseFixture lists the analyzed and the new repo under one id; ids are unique in a
// real /repos body, so the new repo gets its own here.
const freshRepo: ApiRepo = { ...newApiRepoFixture, id: 2, name: 'fresh-repo' };

const listView = (rows: RepoListData['rows']) => renderListView(ready({ rows }), noActions);

const repoView = (metrics: SurvivalMetric[], curves = [survivalCurveFixture, youngSurvivalCurveFixture]) =>
  renderRepoView(
    REPO_ID,
    ready<RepoViewData>({
      kind: 'analyzed',
      summary: { repo: apiRepoFixture, metrics },
      curves: { ...survivalCurveResponseFixture, curves },
    }),
    noActions,
  );

/** The headline cells under `scope`, keyed by cohort and horizon. */
function cells(scope: ParentNode | null | undefined): Record<string, string | null> {
  const found = [...(scope?.querySelectorAll('td[data-horizon]') ?? [])];
  return Object.fromEntries(
    found.map((cell) => [`${cell.getAttribute('data-cohort')} ${cell.getAttribute('data-horizon')}`, cell.textContent]),
  );
}

describe('the repo list', () => {
  test("shows apiRepoFixture's name, its last activity and its S(30), S(90), S(180) per cohort", () => {
    const view = listView([{ repo: apiRepoFixture, metrics: repoSummaryResponseFixture.metrics }]);
    const row = view.querySelector(`tr[data-repo-id="${REPO_ID}"]`);
    expect(row?.querySelector('th')?.textContent).toBe('octo-org/hello.world');
    expect(row?.querySelector('th a')?.getAttribute('href')).toBe(`#/repos/${REPO_ID}`);
    const lastActivity = row?.querySelector('time');
    expect(lastActivity?.getAttribute('datetime')).toBe(apiRepoFixture.headCommittedAt);
    expect(lastActivity?.textContent).toBe('Sep 29, 2026');
    expect(cells(row)).toEqual({
      'ai 30': '80%',
      'ai 90': '64%',
      'ai 180': '64%',
      'human 30': '90%',
      'human 90': 'not observed yet',
      'human 180': 'not observed yet',
    });
  });

  test('a never-analyzed repo shows "not analyzed yet" and no numbers', () => {
    const view = listView([
      { repo: apiRepoFixture, metrics: [survivalMetricFixture] },
      { repo: freshRepo, metrics: null },
    ]);
    const row = view.querySelector('tr[data-repo-id="2"]');
    expect(row?.querySelector('th')?.textContent).toBe('octo-org/fresh-repo');
    const rest = [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent).join(' ');
    expect(rest).toBe('not analyzed yet');
    expect(row?.querySelector('time')).toBeNull();
    expect(cells(row)).toEqual({});
  });

  test('a cohort without lines shows "no human lines": absent is neither null nor 0', () => {
    const view = listView([{ repo: apiRepoFixture, metrics: [survivalMetricFixture] }]);
    const row = view.querySelector(`tr[data-repo-id="${REPO_ID}"]`);
    expect(row?.querySelector('td[data-cohort="human"]')?.textContent).toBe('no human lines');
    expect(Object.keys(cells(row))).toEqual(['ai 30', 'ai 90', 'ai 180']);
  });
});

describe('null versus 0', () => {
  // The list and the repo view's headline both render metrics; the rule holds in each.
  const rendered = (metrics: SurvivalMetric[]) => [
    cells(listView([{ repo: apiRepoFixture, metrics }]).querySelector('tbody')),
    cells(repoView(metrics).querySelector('.headline')),
  ];

  test('a horizon whose value is null renders as "not observed yet", never 0 and never a dash', () => {
    for (const shown of rendered([youngSurvivalMetricFixture])) {
      for (const horizon of [90, 180]) {
        const text = shown[`human ${horizon}`];
        expect(text).toBe('not observed yet');
        expect(text).not.toMatch(/\d|[-‐-―−]/);
      }
    }
  });

  test('a horizon of exactly 0 renders as 0%', () => {
    for (const shown of rendered([revertedSurvivalMetricFixture])) {
      expect(shown).toEqual({ 'ai 30': '0%', 'ai 90': '0%', 'ai 180': '0%' });
    }
  });
});

describe('the repo view', () => {
  test('shows the last activity next to the chart, inside its figure', () => {
    const figure = repoView(repoSummaryResponseFixture.metrics).querySelector('figure');
    expect(figure?.querySelector('svg')).not.toBeNull();
    const lastActivity = figure?.querySelector('[data-meta="last-activity"]');
    expect(lastActivity?.textContent).toBe('Last activity Sep 29, 2026, 2 days before it was observed');
    expect(lastActivity?.querySelector('time')?.getAttribute('datetime')).toBe(
      survivalCurveResponseFixture.headCommittedAt,
    );
  });

  test('shows the headline numbers, the analyzed head and when it was observed', () => {
    const view = repoView(repoSummaryResponseFixture.metrics);
    expect(view.querySelector('h1')?.textContent).toBe('octo-org/hello.world');
    expect(cells(view.querySelector('.headline'))).toMatchObject({ 'ai 30': '80%', 'human 30': '90%' });
    expect(view.querySelector('tr[data-cohort="ai"] .counted')?.textContent).toBe('10 lines, 3 removed');
    const head = view.querySelector('figure [data-meta="head"]');
    expect(head?.textContent).toBe('Analyzed head fffffff');
    expect(head?.querySelector('a')?.getAttribute('href')).toBe(
      `https://github.com/octo-org/hello.world/commit/${SHA.head}`,
    );
    expect(view.querySelector('figure [data-meta="observed"] time')?.getAttribute('datetime')).toBe(OBSERVED_AT);
    expect(view.querySelector('figure [data-meta="observed"]')?.textContent).toBe('Observed Oct 1, 2026, 00:00 UTC');
  });

  test('a cohort with numbers but no curve says so instead of drawing nothing silently', () => {
    const view = repoView(repoSummaryResponseFixture.metrics, [survivalCurveFixture]);
    expect(view.querySelector('.chart-missing')?.textContent).toBe('No human curve yet.');
    expect(view.querySelector('g[data-cohort="human"]')).toBeNull();
  });

  test('a stale view keeps its numbers and says it could not refresh', () => {
    const state: ViewState<RepoViewData> = {
      status: 'ready',
      data: { kind: 'analyzed', summary: repoSummaryResponseFixture, curves: survivalCurveResponseFixture },
      fetchedAt: Date.parse('2026-10-11T10:00:00.000Z'),
      stale: { error: new Error('The API answered 503'), failedAt: Date.parse('2026-10-11T10:10:00.000Z') },
    };
    const view = renderRepoView(REPO_ID, state, noActions);
    expect(view.querySelector('[data-stale]')?.textContent).toContain("Couldn't refresh (The API answered 503)");
    expect(cells(view.querySelector('.headline'))['ai 30']).toBe('80%');
  });
});
