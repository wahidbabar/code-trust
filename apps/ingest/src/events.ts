// GitHub webhook payload to RepoEventMessage[]. The schemas name only the fields read here:
// GitHub's payloads are large and keep growing, and zod strips everything else.
//
// Each event is parsed in two stages. The first reads just enough to decide whether the delivery
// matters, so an action or ref this lane ignores never fails on a field only the enqueue path
// needs. The second is strict, and a delivery that fails it is a 400.
import { type RepoEventMessage, RepoEventMessageSchema } from '@code-trust/shared';
import { type ZodError, z } from 'zod';

export type IgnoreReason =
  | 'unhandled-event'
  | 'unhandled-action'
  | 'branch-deleted'
  | 'not-default-branch'
  | 'not-public'
  | 'no-public-repos';

export type InvalidReason = 'push-fields' | 'installation-fields' | 'full-name' | 'message-contract';

export type RepoEventsResult =
  | { readonly kind: 'ignored'; readonly reason: IgnoreReason }
  | { readonly kind: 'messages'; readonly messages: readonly RepoEventMessage[] }
  /** `fields` holds schema paths only, never payload values, so it is safe to log. */
  | { readonly kind: 'invalid'; readonly reason: InvalidReason; readonly fields: readonly string[] };

export interface RepoEventsInput {
  /** The `X-GitHub-Event` header. */
  readonly event: string | undefined;
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly payload: unknown;
}

const InstallationRefSchema = z.object({ id: z.number() });

const PushRouteSchema = z.object({
  ref: z.string(),
  deleted: z.boolean(),
  repository: z.object({ default_branch: z.string() }),
});

const PushSchema = z.object({
  after: z.string(),
  repository: z.object({
    id: z.number(),
    full_name: z.string(),
    private: z.boolean(),
    // Present on push payloads. An internal repo is not public even if `private` were false.
    visibility: z.string().optional(),
  }),
  installation: InstallationRefSchema,
});

const ActionSchema = z.object({ action: z.string() });

// The repository entries of installation payloads carry `private` but no `visibility`.
const RepositoryEntrySchema = z.object({ id: z.number(), full_name: z.string(), private: z.boolean() });

const InstallationCreatedSchema = z.object({
  installation: InstallationRefSchema,
  repositories: z.array(RepositoryEntrySchema),
});

const InstallationRepositoriesAddedSchema = z.object({
  installation: InstallationRefSchema,
  repositories_added: z.array(RepositoryEntrySchema),
});

type Envelope = Pick<RepoEventMessage, 'deliveryId' | 'receivedAt'> & { installationId: number };
type RepositoryEntry = z.infer<typeof RepositoryEntrySchema>;

const ignored = (reason: IgnoreReason): RepoEventsResult => ({ kind: 'ignored', reason });

const invalid = (reason: InvalidReason, error?: ZodError): RepoEventsResult => ({
  kind: 'invalid',
  reason,
  fields: error ? [...new Set(error.issues.map((issue) => issue.path.join('.') || '(root)'))] : [],
});

export function toRepoEvents(input: RepoEventsInput): RepoEventsResult {
  switch (input.event) {
    case 'push':
      return fromPush(input);
    case 'installation':
      return fromInstallation(input, 'created', InstallationCreatedSchema, (p) => p.repositories);
    case 'installation_repositories':
      return fromInstallation(input, 'added', InstallationRepositoriesAddedSchema, (p) => p.repositories_added);
    default:
      // ping, and every event this lane does not handle.
      return ignored('unhandled-event');
  }
}

function fromPush(input: RepoEventsInput): RepoEventsResult {
  const route = PushRouteSchema.safeParse(input.payload);
  if (!route.success) return invalid('push-fields', route.error);
  if (route.data.deleted) return ignored('branch-deleted');
  // Only the mainline is measured, so only pushes to the default branch matter.
  if (route.data.ref !== `refs/heads/${route.data.repository.default_branch}`) return ignored('not-default-branch');

  const push = PushSchema.safeParse(input.payload);
  if (!push.success) return invalid('push-fields', push.error);
  const { repository } = push.data;
  // Private repos never enter the pipeline: the read API has no auth.
  if (repository.private || (repository.visibility !== undefined && repository.visibility !== 'public')) {
    return ignored('not-public');
  }
  const envelope = { ...envelopeOf(input), installationId: push.data.installation.id };
  return toMessages([{ ...envelope, type: 'push', repo: repository, headSha: push.data.after }]);
}

function fromInstallation<T extends { installation: { id: number } }>(
  input: RepoEventsInput,
  action: 'created' | 'added',
  schema: z.ZodType<T>,
  repositoriesOf: (payload: T) => readonly RepositoryEntry[],
): RepoEventsResult {
  const route = ActionSchema.safeParse(input.payload);
  if (!route.success) return invalid('installation-fields', route.error);
  if (route.data.action !== action) return ignored('unhandled-action');

  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) return invalid('installation-fields', parsed.error);
  const envelope = { ...envelopeOf(input), installationId: parsed.data.installation.id };
  // Private repos never enter the pipeline: the read API has no auth.
  const publicRepos = repositoriesOf(parsed.data).filter((repo) => !repo.private);
  if (publicRepos.length === 0) return ignored('no-public-repos');
  return toMessages(publicRepos.map((repo) => ({ ...envelope, type: 'repository_added' as const, repo })));
}

function envelopeOf(input: RepoEventsInput): Omit<Envelope, 'installationId'> {
  return { deliveryId: input.deliveryId, receivedAt: input.receivedAt };
}

type Draft = Envelope & { repo: { id: number; full_name: string } } & (
    | { type: 'push'; headSha: string }
    | { type: 'repository_added' }
  );

function toMessages(drafts: readonly Draft[]): RepoEventsResult {
  const messages: RepoEventMessage[] = [];
  for (const { repo, ...draft } of drafts) {
    // Owner and name come from full_name, which push and installation payloads both carry.
    const [owner, name, ...rest] = repo.full_name.split('/');
    if (owner === undefined || name === undefined || rest.length > 0) return invalid('full-name');
    // The contract is the last check: an id, owner, name or SHA that breaks it never reaches the queue.
    const message = RepoEventMessageSchema.safeParse({ version: 1, ...draft, repo: { id: repo.id, owner, name } });
    if (!message.success) return invalid('message-contract', message.error);
    messages.push(message.data);
  }
  return { kind: 'messages', messages };
}
