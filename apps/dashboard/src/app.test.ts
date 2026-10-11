// The whole app, mounted with the client's default fetch replaced: routing, loading, polling and
// rendering together.
import type { ApiRepo } from '@code-trust/shared';
import {
  apiRepoFixture,
  newApiRepoFixture,
  REPO_ID,
  repoSummaryResponseFixture,
  survivalCurveFixture,
  survivalCurveResponseFixture,
  survivalMetricFixture,
  youngSurvivalCurveFixture,
} from '@code-trust/shared/fixtures';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiClient } from './api.ts';
import { mountApp, parseRoute } from './app.ts';
import { fakeResponse, restoreVisibility, settle, stubFetch, stubVisibility } from './testing.ts';

const BASE = 'https://example.invalid';
// Literals, not imported from poller.ts, so the app is held to the polling rules themselves.
const TEN_MINUTES_MS = 10 * 60_000;
const ONE_MINUTE_MS = 60_000;
const freshRepo: ApiRepo = { ...newApiRepoFixture, id: 2, name: 'fresh-repo' };
const listBody = { repos: [apiRepoFixture, freshRepo] };
const curvesBody = { ...survivalCurveResponseFixture, curves: [survivalCurveFixture, youngSurvivalCurveFixture] };

const routesFor = (base: string) => ({
  [`${base}/repos`]: () => fakeResponse(listBody),
  [`${base}/repos/${REPO_ID}`]: () => fakeResponse(repoSummaryResponseFixture),
  [`${base}/repos/${REPO_ID}/survival-curve`]: () => fakeResponse(curvesBody),
});

let app: { destroy(): void } | undefined;
let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  stubVisibility('visible');
  window.location.hash = '';
  root = document.createElement('main');
  document.body.replaceChildren(root);
});

afterEach(() => {
  app?.destroy();
  app = undefined;
  restoreVisibility();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(baseUrl = BASE, hash = '') {
  window.location.hash = hash;
  app = mountApp({ root, client: createApiClient({ baseUrl }) });
}

function navigate(hash: string) {
  window.location.hash = hash;
  window.dispatchEvent(new Event('hashchange'));
}

const headline = (cohort: string, days: number) =>
  root.querySelector(`.headline td[data-cohort="${cohort}"][data-horizon="${days}"]`)?.textContent;

describe('requests', () => {
  test.each([BASE, '/api'])('no request goes anywhere but the API base (%s)', async (base) => {
    const calls = stubFetch(routesFor(base));
    mount(base);
    await settle();
    navigate(`#/repos/${REPO_ID}`);
    await settle();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    await settle();
    expect(calls).toEqual([
      `${base}/repos`,
      `${base}/repos/${REPO_ID}`,
      `${base}/repos/${REPO_ID}`,
      `${base}/repos/${REPO_ID}/survival-curve`,
      `${base}/repos/${REPO_ID}`,
      `${base}/repos/${REPO_ID}/survival-curve`,
    ]);

    // A crafted route never becomes a request: protocol-relative, traversal, userinfo, hex.
    for (const hash of [
      '#/repos//evil.example/x',
      '#/repos/..%2F..%2Fevil',
      '#/repos/1@evil.example',
      '#/repos/0x10',
      '#//evil.example',
    ]) {
      navigate(hash);
      await settle();
      expect(root.querySelector('h1')?.textContent).toBe('Nothing here');
    }
    expect(calls).toHaveLength(6);
    expect(calls.filter((url) => !url.startsWith(`${base}/`))).toEqual([]);
    // And nothing on the page loads from anywhere: no images, scripts, styles or frames.
    expect(root.querySelectorAll('img, image, script, link, iframe, object, embed, use')).toHaveLength(0);
  });

  test('the list requests no summary for a repo that has no analyzed head', async () => {
    const calls = stubFetch(routesFor(BASE));
    mount();
    await settle();
    expect(calls).toEqual([`${BASE}/repos`, `${BASE}/repos/${REPO_ID}`]);
    expect(root.querySelector('tr[data-repo-id="2"]')?.textContent).toContain('not analyzed yet');
  });

  test('a repo without an analyzed head requests no curve and shows "not analyzed yet", not an error', async () => {
    const calls = stubFetch({
      [`${BASE}/repos/${REPO_ID}`]: () => fakeResponse({ repo: newApiRepoFixture, metrics: [] }),
    });
    mount(BASE, `#/repos/${REPO_ID}`);
    await settle();
    expect(calls).toEqual([`${BASE}/repos/${REPO_ID}`]);
    expect(root.querySelector('[data-state="not-analyzed"]')?.textContent).toContain('not analyzed yet');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('svg')).toBeNull();
  });
});

describe('errors and staleness', () => {
  test('a body that fails its schema shows an error state, not a partial chart', async () => {
    // Day 0 stays first, so only the ordering rule is broken: days 0, 46, 11, 61, 200.
    const [first, second, third, ...rest] = survivalCurveFixture.points;
    stubFetch({
      ...routesFor(BASE),
      [`${BASE}/repos/${REPO_ID}/survival-curve`]: () =>
        fakeResponse({
          ...survivalCurveResponseFixture,
          curves: [{ cohort: 'ai', points: [first, third, second, ...rest] }],
        }),
    });
    mount(BASE, `#/repos/${REPO_ID}`);
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('broke the contract');
    // The summary parsed fine, and still none of it is shown.
    expect(root.querySelector('.headline')).toBeNull();
    expect(root.querySelector('svg')).toBeNull();
    expect(root.textContent).not.toContain('80%');
  });

  test('a failed poll after a good one keeps the data and marks it stale', async () => {
    let summary: () => Response = () => fakeResponse(repoSummaryResponseFixture);
    stubFetch({ ...routesFor(BASE), [`${BASE}/repos/${REPO_ID}`]: () => summary() });
    mount(BASE, `#/repos/${REPO_ID}`);
    await settle();
    expect(headline('ai', 30)).toBe('80%');
    expect(root.querySelector('[data-stale]')).toBeNull();

    summary = () => fakeResponse({ message: 'Service Unavailable' }, 503);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    await settle();
    expect(root.querySelector('[data-stale]')?.textContent).toContain('The API answered 503');
    expect(headline('ai', 30)).toBe('80%');
    expect(root.querySelector('svg')).not.toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();

    // A body that breaks the contract on a later poll is stale data too, never a partial render.
    summary = () =>
      fakeResponse({ ...repoSummaryResponseFixture, metrics: [{ ...survivalMetricFixture, linesTotal: 11 }] });
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    await settle();
    expect(root.querySelector('[data-stale]')?.textContent).toContain('broke the contract');
    expect(root.querySelector('tr[data-cohort="ai"] .counted')?.textContent).toBe('10 lines, 3 removed');

    summary = () => fakeResponse(repoSummaryResponseFixture);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    await settle();
    expect(root.querySelector('[data-stale]')).toBeNull();
  });

  test('a repo that answers 404 after good data shows not found, not its old data', async () => {
    let gone = false;
    stubFetch({
      ...routesFor(BASE),
      [`${BASE}/repos/${REPO_ID}`]: () =>
        gone ? fakeResponse({ message: 'No repo' }, 404) : fakeResponse(repoSummaryResponseFixture),
    });
    mount(BASE, `#/repos/${REPO_ID}`);
    await settle();
    gone = true;
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    await settle();
    expect(root.querySelector('h1')?.textContent).toBe('Repository not found');
    expect(root.textContent).not.toContain('80%');
  });

  test('in the list, a summary that 404s drops only its row', async () => {
    const removed: ApiRepo = { ...apiRepoFixture, id: 3, name: 'removed-repo' };
    stubFetch({
      [`${BASE}/repos`]: () => fakeResponse({ repos: [apiRepoFixture, removed] }),
      [`${BASE}/repos/${REPO_ID}`]: () => fakeResponse(repoSummaryResponseFixture),
      [`${BASE}/repos/3`]: () => fakeResponse({ message: 'No repo with id 3' }, 404),
    });
    mount();
    await settle();
    const ids = [...root.querySelectorAll('tbody tr')].map((row) => row.getAttribute('data-repo-id'));
    expect(ids).toEqual([String(REPO_ID)]);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  test('in the list, any other failed summary fails the whole list', async () => {
    const broken: ApiRepo = { ...apiRepoFixture, id: 3, name: 'broken-repo' };
    stubFetch({
      [`${BASE}/repos`]: () => fakeResponse({ repos: [apiRepoFixture, broken] }),
      [`${BASE}/repos/${REPO_ID}`]: () => fakeResponse(repoSummaryResponseFixture),
      [`${BASE}/repos/3`]: () => fakeResponse({ message: 'Internal server error' }, 500),
    });
    mount();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('The API answered 500');
    expect(root.querySelector('table')).toBeNull();
  });
});

describe('navigation', () => {
  test('leaving a view drops its late response', async () => {
    let releaseList: (() => void) | undefined;
    stubFetch({
      ...routesFor(BASE),
      [`${BASE}/repos`]: () =>
        new Promise<Response>((resolve) => {
          releaseList = () => resolve(fakeResponse(listBody));
        }),
    });
    mount();
    await settle();
    navigate(`#/repos/${REPO_ID}`);
    await settle();
    expect(root.querySelector('h1')?.textContent).toBe('octo-org/hello.world');

    releaseList?.();
    await settle();
    expect(root.querySelector('h1')?.textContent).toBe('octo-org/hello.world');
    expect(root.querySelector('.repo-table')).toBeNull();
  });

  test('going back to a view shows its data at once and refetches only once it is a minute old', async () => {
    const calls = stubFetch(routesFor(BASE));
    mount();
    await settle();
    navigate(`#/repos/${REPO_ID}`);
    await settle();
    expect(calls).toHaveLength(4);

    navigate('#/');
    expect(root.querySelector('.repo-table')).not.toBeNull();
    await settle();
    expect(calls).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS + 1);
    navigate(`#/repos/${REPO_ID}`);
    await settle();
    expect(calls).toHaveLength(6);
  });

  test('routes accept only a GitHub id', () => {
    expect(parseRoute('')).toEqual({ name: 'list' });
    expect(parseRoute('#/')).toEqual({ name: 'list' });
    expect(parseRoute(`#/repos/${REPO_ID}`)).toEqual({ name: 'repo', repoId: REPO_ID });
    for (const hash of ['#/repos/012', '#/repos/1e3', '#/repos/ 12', '#/repos/12/', '#/repos/99999999999999999999']) {
      expect(parseRoute(hash)).toEqual({ name: 'unknown' });
    }
  });
});
