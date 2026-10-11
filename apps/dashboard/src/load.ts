// What each view fetches. Both loaders are all or nothing: a response that fails rejects the whole
// load, so a view never renders half of what it asked for.
import type { ApiRepo, RepoSummaryResponse, SurvivalCurveResponse, SurvivalMetric } from '@code-trust/shared';
import { type ApiClient, ApiError } from './api.ts';

/** Summary requests the repo list makes at once. */
export const LIST_CONCURRENCY = 4;

export interface RepoListRow {
  repo: ApiRepo;
  /** Null when the repo has no analyzed head: it has no metrics, so its summary is not requested. */
  metrics: SurvivalMetric[] | null;
}

export interface RepoListData {
  rows: RepoListRow[];
}

/**
 * `/repos` carries no metrics, so the list asks for each analyzed repo's summary: one request per
 * repo, a stopgap until `/repos` carries them (see Decisions in docs/architecture.md). A summary
 * that answers 404 means the repo was removed between the two requests, and only its row goes; any
 * other failure fails the list.
 */
export async function loadRepoList(client: ApiClient, signal: AbortSignal): Promise<RepoListData> {
  const { repos } = await client.listRepos(signal);
  // Once one summary fails, the rest are cancelled instead of finishing for nothing.
  const batch = new AbortController();
  const cancelBatch = () => batch.abort();
  signal.addEventListener('abort', cancelBatch, { once: true });
  if (signal.aborted) batch.abort();
  try {
    const rows = await mapWithLimit(repos, LIST_CONCURRENCY, async (repo): Promise<RepoListRow | null> => {
      if (repo.headSha === null) return { repo, metrics: null };
      try {
        const summary = await client.getRepoSummary(repo.id, batch.signal);
        return { repo: summary.repo, metrics: summary.metrics };
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'not_found') return null;
        throw error;
      }
    });
    return { rows: rows.filter((row): row is RepoListRow => row !== null) };
  } catch (error) {
    batch.abort();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelBatch);
  }
}

export type RepoViewData =
  | { kind: 'not_analyzed'; repo: ApiRepo }
  | { kind: 'analyzed'; summary: RepoSummaryResponse; curves: SurvivalCurveResponse };

export async function loadRepoView(client: ApiClient, repoId: number, signal: AbortSignal): Promise<RepoViewData> {
  // A new analysis can land between the two requests. One immediate retry covers that; a second
  // mismatch waits for the next poll rather than showing numbers and curves from different heads.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const summary = await client.getRepoSummary(repoId, signal);
    // The curve route answers 404 until the repo has an analyzed head, so it is not asked.
    if (summary.repo.headSha === null) return { kind: 'not_analyzed', repo: summary.repo };
    const curves = await client.getSurvivalCurve(repoId, signal);
    if (curves.headSha === summary.repo.headSha) return { kind: 'analyzed', summary, curves };
  }
  throw new ApiError('moving', 'A new analysis landed while this page loaded; it shows on the next refresh');
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
