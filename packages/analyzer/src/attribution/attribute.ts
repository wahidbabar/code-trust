// Puts a commit in a cohort. Both signals match an email on the AI list exactly, without regard to
// case, and nothing else: a name never matches, and nothing matches by substring or pattern.
// Evidence is built from the matched list entry, so text from the commit, such as a person's name
// next to an AI email, never reaches it.
import { AI_CONFIDENCE_THRESHOLD, type Attribution, type AttributionSignal, type Cohort } from '@code-trust/shared';
import type { HistoryCommit } from '../history/types.ts';
import { AI_IDENTITIES, type AiIdentity } from './identities.ts';

export interface CommitAttribution {
  cohort: Cohort;
  /** Empty unless the cohort is `ai`. At most one entry per (signal, tool). */
  attributions: Pick<Attribution, 'signal' | 'tool' | 'confidence' | 'evidence'>[];
}

const BY_EMAIL: ReadonlyMap<string, AiIdentity> = new Map(
  AI_IDENTITIES.map((entry) => [entry.email.toLowerCase(), entry]),
);

// A whole trimmed line that is one complete trailer. The name cannot start with a space, so the
// spaces after the colon split only one way, and a hostile line cannot make the match backtrack.
const TRAILER = /^co-authored-by: +[^\s<>](?:[^<>]*[^\s<>])? <([^\s<>]+)>$/i;

/** Pure: reads the identities and the message, and nothing else. */
export function attributeCommit(commit: Pick<HistoryCommit, 'author' | 'committer' | 'message'>): CommitAttribution {
  const attributions: CommitAttribution['attributions'] = [];
  const add = (signal: AttributionSignal, email: string): void => {
    const entry = BY_EMAIL.get(email.toLowerCase());
    if (entry === undefined || attributions.some((a) => a.signal === signal && a.tool === entry.tool)) return;
    const identity = `${entry.name} <${entry.email}>`;
    const evidence = signal === 'co_author_trailer' ? `Co-Authored-By: ${identity}` : identity;
    attributions.push({ signal, tool: entry.tool, confidence: 1, evidence });
  };

  // Every line counts, not only git's last paragraph: a squash merge carries the squashed commits'
  // trailers in the middle of its body, and `git merge --squash` indents them.
  for (const line of commit.message.split('\n')) {
    const email = TRAILER.exec(line.trim())?.[1];
    if (email !== undefined) add('co_author_trailer', email);
  }
  add('author_identity', commit.author.email);
  add('author_identity', commit.committer.email);

  if (attributions.some((a) => a.confidence >= AI_CONFIDENCE_THRESHOLD)) return { cohort: 'ai', attributions };
  return { cohort: commit.author.name.endsWith('[bot]') ? 'automation' : 'human', attributions: [] };
}
