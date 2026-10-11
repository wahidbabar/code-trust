// The two views, rendered from a view state. Pure: the app owns fetching, polling and routing.
import { type ApiRepo, type MeasuredCohort, SURVIVAL_HORIZON_DAYS, type SurvivalMetric } from '@code-trust/shared';
import { renderSurvivalChart } from './chart.ts';
import { COHORT_LABEL, COHORT_NOUN, COHORT_ORDER } from './curve.ts';
import { h } from './dom.ts';
import {
  describeLastActivityGap,
  formatClock,
  formatDate,
  formatDateTime,
  formatSurvival,
  NOT_ANALYZED,
  NOT_OBSERVED,
  plural,
  shortSha,
} from './format.ts';
import type { RepoListData, RepoViewData } from './load.ts';

export interface StaleInfo {
  error: Error;
  failedAt: number;
}

export type ViewState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; fetchedAt: number; stale: StaleInfo | null }
  | { status: 'error'; error: Error }
  | { status: 'not_found' };

export interface ViewActions {
  retry(): void;
}

type Horizon = (typeof SURVIVAL_HORIZON_DAYS)[number];

const HORIZON_FIELD = {
  30: 'survival30d',
  90: 'survival90d',
  180: 'survival180d',
} as const satisfies Record<Horizon, keyof SurvivalMetric>;

export function renderListView(state: ViewState<RepoListData>, actions: ViewActions): HTMLElement {
  const view = h(
    'section',
    { class: 'view view-list' },
    h('h1', {}, 'Repositories'),
    h(
      'p',
      { class: 'lede' },
      'Survival is the share of lines still unchanged 30, 90 and 180 days after they landed, AI-written next to human-written.',
    ),
  );
  if (state.status !== 'ready') {
    view.append(pending(state, actions));
    return view;
  }
  view.append(statusLine(state));
  const { rows } = state.data;
  if (rows.length === 0) {
    view.append(h('p', { class: 'card empty' }, 'No repositories yet. Install the GitHub App on a public repository.'));
    return view;
  }
  view.append(
    h(
      'div',
      { class: 'card table-card' },
      h(
        'table',
        { class: 'repo-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col', rowspan: 2 }, 'Repository'),
            h('th', { scope: 'col', rowspan: 2 }, 'Last activity'),
            ...COHORT_ORDER.map((cohort) =>
              h(
                'th',
                { scope: 'colgroup', colspan: 3, class: 'group' },
                `${COHORT_LABEL[cohort]} lines unchanged after`,
              ),
            ),
          ),
          h(
            'tr',
            {},
            ...COHORT_ORDER.flatMap(() =>
              SURVIVAL_HORIZON_DAYS.map((days) => h('th', { scope: 'col' }, `${days} days`)),
            ),
          ),
        ),
        h('tbody', {}, ...rows.map((row) => listRow(row.repo, row.metrics))),
      ),
    ),
  );
  return view;
}

function listRow(repo: ApiRepo, metrics: SurvivalMetric[] | null): HTMLElement {
  const name = h('th', { scope: 'row' }, h('a', { href: `#/repos/${repo.id}` }, `${repo.owner}/${repo.name}`));
  if (metrics === null || repo.headCommittedAt === null) {
    return h(
      'tr',
      { 'data-repo-id': repo.id, 'data-analyzed': 'false' },
      name,
      h('td', { colspan: 7, class: 'unknown' }, NOT_ANALYZED),
    );
  }
  return h(
    'tr',
    { 'data-repo-id': repo.id },
    name,
    h('td', { 'data-label': 'Last activity' }, timeElement(repo.headCommittedAt, formatDate)),
    ...COHORT_ORDER.flatMap((cohort) =>
      survivalCells(
        cohort,
        metrics.find((metric) => metric.cohort === cohort),
      ),
    ),
  );
}

/** A cohort's three headline cells, or one cell saying it has no lines: absent is neither null nor 0. */
function survivalCells(cohort: MeasuredCohort, metric: SurvivalMetric | undefined): HTMLElement[] {
  if (metric === undefined) {
    return [h('td', { colspan: 3, class: 'unknown', 'data-cohort': cohort }, `no ${COHORT_NOUN[cohort]} lines`)];
  }
  return SURVIVAL_HORIZON_DAYS.map((days) => {
    const value = metric[HORIZON_FIELD[days]];
    return h(
      'td',
      {
        class: value === null ? 'value unknown' : 'value',
        'data-cohort': cohort,
        'data-horizon': days,
        'data-label': `${COHORT_LABEL[cohort]}, ${days} days`,
      },
      formatSurvival(value),
    );
  });
}

export function renderRepoView(repoId: number, state: ViewState<RepoViewData>, actions: ViewActions): HTMLElement {
  const view = h('section', { class: 'view view-repo' }, h('nav', {}, h('a', { href: '#/' }, 'All repositories')));
  if (state.status === 'not_found') {
    view.append(
      h('h1', {}, 'Repository not found'),
      h(
        'p',
        { class: 'card' },
        `No repository with id ${repoId} is tracked. It may have been made private or removed.`,
      ),
    );
    return view;
  }
  if (state.status !== 'ready') {
    view.append(h('h1', {}, `Repository ${repoId}`), pending(state, actions));
    return view;
  }

  const { data } = state;
  const repo = data.kind === 'analyzed' ? data.summary.repo : data.repo;
  view.append(
    h(
      'h1',
      {},
      h(
        'a',
        { href: `https://github.com/${repo.owner}/${repo.name}`, rel: 'noreferrer' },
        `${repo.owner}/${repo.name}`,
      ),
    ),
    statusLine(state),
  );
  if (data.kind === 'not_analyzed') {
    view.append(
      h(
        'p',
        { class: 'card unknown', 'data-state': 'not-analyzed' },
        `This repository is ${NOT_ANALYZED}. Its numbers appear once the first analysis finishes.`,
      ),
    );
    return view;
  }

  const { summary, curves } = data;
  const missing = COHORT_ORDER.filter(
    (cohort) =>
      summary.metrics.some((metric) => metric.cohort === cohort) &&
      !curves.curves.some((curve) => curve.cohort === cohort),
  );
  view.append(
    h(
      'section',
      { class: 'card headline' },
      h('h2', {}, 'Survival at 30, 90 and 180 days'),
      h(
        'table',
        { class: 'headline-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, 'Lines'),
            ...SURVIVAL_HORIZON_DAYS.map((days) => h('th', { scope: 'col' }, `${days} days`)),
            h('th', { scope: 'col' }, 'Counted'),
          ),
        ),
        h(
          'tbody',
          {},
          ...COHORT_ORDER.map((cohort) => {
            const metric = summary.metrics.find((m) => m.cohort === cohort);
            return h(
              'tr',
              { 'data-cohort': cohort },
              h(
                'th',
                { scope: 'row' },
                h('span', { class: `line-key line-key-${cohort}`, 'aria-hidden': 'true' }),
                `${COHORT_LABEL[cohort]}-written`,
              ),
              ...survivalCells(cohort, metric),
              metric
                ? h('td', { class: 'counted' }, `${plural(metric.linesTotal, 'line')}, ${metric.linesRemoved} removed`)
                : false,
            );
          }),
        ),
      ),
    ),
    h(
      'figure',
      { class: 'card chart-card' },
      h(
        'figcaption',
        {},
        h('h2', {}, 'Share of lines still unchanged, by age'),
        // The last activity sits with the curves: survival means unchanged, not correct, and an
        // abandoned repo's code survives by default.
        h(
          'p',
          { class: 'chart-meta' },
          h(
            'span',
            { 'data-meta': 'last-activity' },
            'Last activity ',
            timeElement(curves.headCommittedAt, formatDate),
            `, ${describeLastActivityGap(curves.headCommittedAt, curves.observedAt)}`,
          ),
          h(
            'span',
            { 'data-meta': 'head' },
            'Analyzed head ',
            h(
              'a',
              { href: `https://github.com/${repo.owner}/${repo.name}/commit/${curves.headSha}`, rel: 'noreferrer' },
              h('code', {}, shortSha(curves.headSha)),
            ),
          ),
          h('span', { 'data-meta': 'observed' }, 'Observed ', timeElement(curves.observedAt, formatDateTime)),
        ),
      ),
      renderSurvivalChart(curves.curves),
      ...missing.map((cohort) => h('p', { class: 'chart-missing' }, `No ${COHORT_NOUN[cohort]} curve yet.`)),
    ),
    h(
      'p',
      { class: 'footnote' },
      `Survival means unchanged, not correct: code in an abandoned repository survives by default, so read it with the last activity. Lines from one commit tend to be removed together, so a curve is noisier than its line count suggests. Unknown values read "${NOT_OBSERVED}" and are never drawn as 0.`,
    ),
  );
  return view;
}

export function renderUnknownRoute(): HTMLElement {
  return h(
    'section',
    { class: 'view' },
    h('h1', {}, 'Nothing here'),
    h('p', { class: 'card' }, h('a', { href: '#/' }, 'See all repositories')),
  );
}

function timeElement(iso: string, format: (iso: string) => string): HTMLElement {
  return h('time', { datetime: iso }, format(iso));
}

function statusLine(state: { fetchedAt: number; stale: StaleInfo | null }): HTMLElement {
  if (state.stale) {
    return h(
      'p',
      { class: 'status status-stale', role: 'status', 'data-stale': true },
      h('span', { class: 'status-icon', 'aria-hidden': 'true' }, '!'),
      `Couldn't refresh (${state.stale.error.message}). Showing data from ${formatClock(state.fetchedAt)}; the next try is in 10 minutes.`,
    );
  }
  return h(
    'p',
    { class: 'status', role: 'status' },
    `Updated ${formatClock(state.fetchedAt)}. Refreshes every 10 minutes while this tab is open.`,
  );
}

function pending(
  state: { status: 'loading' } | { status: 'error'; error: Error } | { status: 'not_found' },
  actions: ViewActions,
) {
  if (state.status === 'loading') {
    return h(
      'p',
      { class: 'status', role: 'status', 'data-loading': true },
      'Loading. The database sleeps when idle, so the first answer can take a few seconds.',
    );
  }
  const retry = h('button', { type: 'button' }, 'Try again');
  retry.addEventListener('click', () => actions.retry());
  const message = state.status === 'error' ? state.error.message : 'Not found';
  return h(
    'div',
    { class: 'card error', role: 'alert' },
    h('p', { class: 'error-title' }, "Couldn't load this page"),
    h('p', {}, message),
    retry,
  );
}
