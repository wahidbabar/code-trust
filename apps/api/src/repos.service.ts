import { type Db, getRepo, getSurvivalCurves, listRepos, listSurvivalMetrics } from '@code-trust/db';
import type { Repo, SurvivalCurveResponse, SurvivalMetric } from '@code-trust/shared';
import { Inject, Injectable } from '@nestjs/common';
import { DB } from './tokens.ts';

export interface RepoSummary {
  repo: Repo;
  metrics: SurvivalMetric[];
}

// Rows come back as the full domain types, installationId included. The controller parses every
// body with its response schema, which is what keeps that field out.
@Injectable()
export class ReposService {
  // An explicit @Inject on every constructor parameter: nothing in this app emits decorator
  // metadata, and without the token Nest would inject undefined and still boot.
  constructor(@Inject(DB) private readonly db: Db) {}

  listRepos(): Promise<Repo[]> {
    return listRepos(this.db);
  }

  /** Null when there is no such repo. A repo with no analyzed head has no metrics. */
  async getSummary(repoId: number): Promise<RepoSummary | null> {
    const repo = await getRepo(this.db, repoId);
    if (repo === null) return null;
    if (repo.headSha === null) return { repo, metrics: [] };
    const metrics = await listSurvivalMetrics(this.db, repoId);
    return { repo, metrics: metrics.filter((metric) => metric.headSha === repo.headSha) };
  }

  /** Null when there is no such repo, or it has no analyzed head yet. */
  async getSurvivalCurve(repoId: number): Promise<SurvivalCurveResponse | null> {
    const repo = await getRepo(this.db, repoId);
    if (repo === null) return null;
    const { headSha, headCommittedAt, observedAt } = repo;
    if (headSha === null || headCommittedAt === null || observedAt === null) return null;
    // A rollup counts only under the repo's head: workers write rollups before they move the head,
    // and a cohort that lost all its lines keeps its old row. The curve query carries no head, so
    // the metrics name the current cohorts. Curves are read first: a rollup rewritten between the
    // two reads then drops its cohort, where the other order could pair a new curve with the old head.
    const curves = await getSurvivalCurves(this.db, repoId);
    const metrics = await listSurvivalMetrics(this.db, repoId);
    const current = new Set(metrics.filter((metric) => metric.headSha === headSha).map((metric) => metric.cohort));
    return {
      repoId: repo.id,
      headSha,
      headCommittedAt,
      observedAt,
      curves: curves.filter((curve) => current.has(curve.cohort)),
    };
  }
}
