// Kept for apps/worker's wiring test.
export const PACKAGE_NAME = '@code-trust/analyzer';

export { type AnalyzeOptions, analyzeRepo, type RepoAnalysis } from './analyze.ts';
export { attributeCommit, type CommitAttribution } from './attribution/attribute.ts';
export { AI_IDENTITIES, type AiIdentity } from './attribution/identities.ts';
export { DEFAULT_LEFT_OUT_RULES, type LeftOutRule } from './history/measured-paths.ts';
export type { GitIdentity, HistoryCommit, HistoryResult, LineGroup, WalkOptions } from './history/types.ts';
export { walkHistory } from './history/walk.ts';
export { estimateSurvival, type SurvivalEstimate } from './survival/estimate.ts';
