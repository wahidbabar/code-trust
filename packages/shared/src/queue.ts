// Queue messages. Small on purpose: a message says what happened and to which repo, and the
// consumer fetches the rest. Every message carries `version`; a consumer that meets a version it
// does not know fails to parse it, and the message goes to the DLQ instead of being misread.
import { z } from 'zod';
import { CommitShaSchema, GithubIdSchema, IsoTimestampSchema, RepoRefSchema } from './domain.ts';

const repoEventFields = {
  version: z.literal(1),
  /** GitHub's X-GitHub-Delivery header. The same delivery can arrive twice; this is the dedupe key. */
  deliveryId: z.guid('expected the X-GitHub-Delivery GUID'),
  receivedAt: IsoTimestampSchema,
  installationId: GithubIdSchema,
  repo: RepoRefSchema,
};

/** Webhook Lambda to dispatcher: something happened to a repo that may need an analysis. */
export const RepoEventMessageSchema = z.discriminatedUnion('type', [
  // Only pushes to the default branch are enqueued; the mainline is all the metric reads.
  z.object({ ...repoEventFields, type: z.literal('push'), headSha: CommitShaSchema }),
  z.object({ ...repoEventFields, type: z.literal('repository_added') }),
]);
export type RepoEventMessage = z.infer<typeof RepoEventMessageSchema>;

/** Dispatcher to worker: analyze this repo. */
export const AnalysisJobMessageSchema = z.object({
  version: z.literal(1),
  jobId: z.uuid('expected a UUID'),
  requestedAt: IsoTimestampSchema,
  reason: z.enum(['push', 'backfill']),
  installationId: GithubIdSchema,
  repo: RepoRefSchema,
  /** Null means whatever the default branch points at when the worker fetches. */
  headSha: CommitShaSchema.nullable(),
});
export type AnalysisJobMessage = z.infer<typeof AnalysisJobMessageSchema>;
