// Responses of the read endpoints the dashboard polls.
import { z } from 'zod';
import {
  ApiRepoSchema,
  CommitShaSchema,
  GithubIdSchema,
  IsoTimestampSchema,
  SurvivalCurveSchema,
  SurvivalMetricSchema,
} from './domain.ts';

export const ListReposResponseSchema = z.object({
  repos: z.array(ApiRepoSchema),
});
export type ListReposResponse = z.infer<typeof ListReposResponseSchema>;

export const RepoSummaryResponseSchema = z.object({
  repo: ApiRepoSchema,
  /** One entry per measured cohort that has lines. Empty until the first analysis finishes. */
  metrics: z.array(SurvivalMetricSchema),
});
export type RepoSummaryResponse = z.infer<typeof RepoSummaryResponseSchema>;

export const SurvivalCurveResponseSchema = z.object({
  repoId: GithubIdSchema,
  headSha: CommitShaSchema,
  // Survival means unchanged, not correct: an abandoned repo's code survives by default. The last
  // activity travels with the curves so the dashboard can always show it beside them.
  headCommittedAt: IsoTimestampSchema,
  observedAt: IsoTimestampSchema,
  curves: z.array(SurvivalCurveSchema),
});
export type SurvivalCurveResponse = z.infer<typeof SurvivalCurveResponseSchema>;
