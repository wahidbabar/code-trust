import {
  listReposResponseFixture,
  REPO_ID,
  survivalCurveFixture,
  survivalCurveResponseFixture,
} from '@code-trust/shared/fixtures';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, apiBaseUrl, createApiClient, type Fetch, REQUEST_TIMEOUT_MS } from './api.ts';
import { fakeResponse, notJsonResponse } from './testing.ts';

const answering = (response: Response) => vi.fn<Fetch>(async () => response);

afterEach(() => {
  vi.useRealTimers();
});

describe('URLs', () => {
  test('with a base URL that ends in /, the client requests https://example.invalid/repos', async () => {
    const fetch = answering(fakeResponse(listReposResponseFixture));
    await createApiClient({ baseUrl: 'https://example.invalid/', fetch }).listRepos();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://example.invalid/repos']);
  });

  test('a path the base URL carries is kept', async () => {
    const fetch = answering(fakeResponse(survivalCurveResponseFixture));
    await createApiClient({ baseUrl: 'https://example.invalid/prefix/', fetch }).getSurvivalCurve(REPO_ID);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `https://example.invalid/prefix/repos/${REPO_ID}/survival-curve`,
    ]);
  });

  test('a repo id that is not a GitHub id never reaches a request', async () => {
    const fetch = answering(fakeResponse({}));
    const client = createApiClient({ baseUrl: 'https://example.invalid', fetch });
    for (const id of [Number.NaN, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(client.getRepoSummary(id)).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test('requests are simple CORS requests without credentials, so no preflight', async () => {
    const fetch = answering(fakeResponse(listReposResponseFixture));
    await createApiClient({ baseUrl: 'https://example.invalid', fetch }).listRepos();
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('omit');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.headers).toEqual({ accept: 'application/json' });
  });

  test('dev uses the /api proxy; a build uses VITE_API_URL and has no fallback', () => {
    expect(apiBaseUrl({ DEV: true, VITE_API_URL: 'https://example.invalid/' })).toBe('/api');
    expect(apiBaseUrl({ DEV: false, VITE_API_URL: 'https://example.invalid/' })).toBe('https://example.invalid/');
    expect(() => apiBaseUrl({ DEV: false })).toThrow('VITE_API_URL');
  });
});

describe('responses', () => {
  test('the client rejects a curve whose points are out of order', async () => {
    // Day 0 stays first, so only the ordering rule is broken: days 0, 46, 11, 61, 200.
    const [first, second, third, ...rest] = survivalCurveFixture.points;
    const body = {
      ...survivalCurveResponseFixture,
      curves: [{ cohort: 'ai', points: [first, third, second, ...rest] }],
    };
    const client = createApiClient({ baseUrl: 'https://example.invalid', fetch: answering(fakeResponse(body)) });
    const error = await client.getSurvivalCurve(REPO_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'contract' });
    expect((error as Error).message).toContain('ascending day order');
  });

  test('a valid body comes back parsed', async () => {
    const client = createApiClient({
      baseUrl: 'https://example.invalid',
      fetch: answering(fakeResponse(survivalCurveResponseFixture)),
    });
    await expect(client.getSurvivalCurve(REPO_ID)).resolves.toEqual(survivalCurveResponseFixture);
  });

  test('a 404, another non-2xx answer, a body that is not JSON and a network failure are each an error', async () => {
    const outcome = (fetch: Fetch) =>
      createApiClient({ baseUrl: 'https://example.invalid', fetch })
        .listRepos()
        .catch((e: unknown) => e);
    expect(await outcome(answering(fakeResponse({ message: 'gone' }, 404)))).toMatchObject({ kind: 'not_found' });
    expect(await outcome(answering(fakeResponse({ message: 'boom' }, 503)))).toMatchObject({
      kind: 'http',
      status: 503,
    });
    expect(await outcome(answering(notJsonResponse()))).toMatchObject({ kind: 'not_json' });
    expect(
      await outcome(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toMatchObject({ kind: 'network' });
  });

  test('a request that hangs is aborted after 30 seconds', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<Fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const result = createApiClient({ baseUrl: 'https://example.invalid', fetch })
      .listRepos()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ kind: 'timeout' });
  });
});
