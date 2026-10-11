// The client for the read API. The API is cross-origin and has no auth, so nothing it sends is
// trusted: every body is parsed with its schema from @code-trust/shared, and a body that fails is
// an error, never a partial render.
import {
  GithubIdSchema,
  type ListReposResponse,
  ListReposResponseSchema,
  type RepoSummaryResponse,
  RepoSummaryResponseSchema,
  type SurvivalCurveResponse,
  SurvivalCurveResponseSchema,
} from '@code-trust/shared';
import type { z } from 'zod';

/** In dev, Vite's server proxies this prefix to the local API, so no CORS is involved. */
export const DEV_API_BASE = '/api';
export const REQUEST_TIMEOUT_MS = 30_000;

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'not_json' | 'contract' | 'not_found' | 'moving';

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ApiClient {
  listRepos(signal?: AbortSignal): Promise<ListReposResponse>;
  getRepoSummary(repoId: number, signal?: AbortSignal): Promise<RepoSummaryResponse>;
  getSurvivalCurve(repoId: number, signal?: AbortSignal): Promise<SurvivalCurveResponse>;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

/** `/api` in dev: the deployed API's CORS allows only the Pages origin, so localhost could not call it anyway. */
export function apiBaseUrl(env: { DEV: boolean; VITE_API_URL?: string | undefined }): string {
  if (env.DEV) return DEV_API_BASE;
  if (!env.VITE_API_URL) throw new Error('VITE_API_URL was not set when this site was built');
  return env.VITE_API_URL;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  // The Function URL that CodeTrustApi outputs ends in `/`, and a plain join would request `//repos`.
  // A string join and not `new URL(path, base)`, which would drop a path the base carries.
  const base = options.baseUrl.replace(/\/+$/, '');
  // Wrapped, because a bare `fetch` called as a method of another object throws "Illegal invocation".
  const doFetch: Fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function get<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
    const request = new AbortController();
    // A timer rather than AbortSignal.timeout, which ignores the fake timers the tests drive time with.
    const timer = setTimeout(() => request.abort(), timeoutMs);
    const forwardAbort = () => request.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) request.abort();

    const failure = (error: unknown, fallback: ApiError): unknown => {
      if (signal?.aborted) return error;
      if (request.signal.aborted) {
        return new ApiError('timeout', `The API did not answer within ${timeoutMs / 1000} seconds`);
      }
      return fallback;
    };

    try {
      let response: Response;
      try {
        response = await doFetch(`${base}${path}`, {
          signal: request.signal,
          credentials: 'omit',
          // Only a CORS-safelisted header, so the browser sends no preflight first.
          headers: { accept: 'application/json' },
        });
      } catch (error) {
        throw failure(error, new ApiError('network', 'Could not reach the API'));
      }
      if (response.status === 404) throw new ApiError('not_found', `The API has nothing at ${path}`, 404);
      if (!response.ok) throw new ApiError('http', `The API answered ${response.status}`, response.status);

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw failure(error, new ApiError('not_json', 'The API answered with something that is not JSON'));
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError('contract', `The API's answer to ${path} broke the contract (${firstIssue(parsed.error)})`);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  const repoPath = (repoId: number): string => {
    // Only a GitHub id reaches the path, so a crafted route can never point a request elsewhere.
    if (!GithubIdSchema.safeParse(repoId).success) {
      throw new ApiError('not_found', `${repoId} is not a GitHub repository id`);
    }
    return `/repos/${repoId}`;
  };

  return {
    listRepos: async (signal) => get('/repos', ListReposResponseSchema, signal),
    getRepoSummary: async (repoId, signal) => get(repoPath(repoId), RepoSummaryResponseSchema, signal),
    getSurvivalCurve: async (repoId, signal) =>
      get(`${repoPath(repoId)}/survival-curve`, SurvivalCurveResponseSchema, signal),
  };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return error.message;
  const at = issue.path.map(String).join('.');
  return at ? `${at}: ${issue.message}` : issue.message;
}
