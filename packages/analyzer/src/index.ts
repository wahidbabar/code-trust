// Kept for apps/worker's wiring test.
export const PACKAGE_NAME = '@code-trust/analyzer';

export { DEFAULT_LEFT_OUT_RULES, type LeftOutRule } from './history/measured-paths.ts';
export type { GitIdentity, HistoryCommit, HistoryResult, LineGroup, WalkOptions } from './history/types.ts';
export { walkHistory } from './history/walk.ts';
