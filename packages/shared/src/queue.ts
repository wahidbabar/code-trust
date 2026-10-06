// Queue messages. Small on purpose: a message says what happened and to which repo, and the
// consumer fetches the rest. Every message carries `version`; a consumer that meets a version it
// does not know fails to parse it, and the message goes to the DLQ instead of being misread.
import { z } from 'zod';
import { CommitShaSchema, GithubIdSchema, IsoTimestampSchema, RepoRefSchema } from './domain.ts';

const DeliveryIdSchema = z.guid('expected the X-GitHub-Delivery GUID');

/** Why a repo's data must go. Our words, so the worker never needs GitHub's event names. */
export const RepoRemovedReasonSchema = z.enum(['privatized', 'deleted', 'uninstalled', 'removed_from_installation']);
export type RepoRemovedReason = z.infer<typeof RepoRemovedReasonSchema>;

const repoEventFields = {
  version: z.literal(1),
  /** GitHub's X-GitHub-Delivery header. The same delivery can arrive twice; this is the dedupe key. */
  deliveryId: DeliveryIdSchema,
  receivedAt: IsoTimestampSchema,
  installationId: GithubIdSchema,
  repo: RepoRefSchema,
};

/** Webhook Lambda to dispatcher: something happened to a repo that may need an analysis or a delete. */
export const RepoEventMessageSchema = z.discriminatedUnion('type', [
  // Only pushes to the default branch are enqueued; the mainline is all the metric reads.
  z.object({ ...repoEventFields, type: z.literal('push'), headSha: CommitShaSchema }),
  z.object({ ...repoEventFields, type: z.literal('repository_added') }),
  // Sent for every affected repo, public or not: deleting is always safe.
  z.object({ ...repoEventFields, type: z.literal('repository_removed'), reason: RepoRemovedReasonSchema }),
]);
export type RepoEventMessage = z.infer<typeof RepoEventMessageSchema>;

const jobFields = {
  version: z.literal(1),
  jobId: z.uuid('expected a UUID'),
  requestedAt: IsoTimestampSchema,
  /** The delivery that caused the job, so a job can be traced back to its webhook in logs. */
  deliveryId: DeliveryIdSchema,
};

/** Dispatcher to worker: analyze this repo. */
export const AnalysisJobMessageSchema = z.object({
  ...jobFields,
  type: z.literal('analyze'),
  reason: z.enum(['push', 'backfill']),
  installationId: GithubIdSchema,
  repo: RepoRefSchema,
  /** Null means whatever the default branch points at when the worker fetches. */
  headSha: CommitShaSchema.nullable(),
});
export type AnalysisJobMessage = z.infer<typeof AnalysisJobMessageSchema>;

/** Dispatcher to worker: remove everything stored about this repo. The worker fetches nothing. */
export const DeleteRepoJobMessageSchema = z.object({
  ...jobFields,
  type: z.literal('delete_repo'),
  repo: RepoRefSchema,
  /** Carried from the event so the worker's log line says why the data went. */
  reason: RepoRemovedReasonSchema,
});
export type DeleteRepoJobMessage = z.infer<typeof DeleteRepoJobMessageSchema>;

/** Everything the jobs queue carries. */
export const JobMessageSchema = z.discriminatedUnion('type', [AnalysisJobMessageSchema, DeleteRepoJobMessageSchema]);
export type JobMessage = z.infer<typeof JobMessageSchema>;
