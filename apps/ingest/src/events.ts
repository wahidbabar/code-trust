// GitHub webhook payload to RepoEventMessage[]. The schemas name only the fields read here:
// GitHub's payloads are large and keep growing, and zod strips everything else.
//
// Each event is parsed in two stages. The first reads just enough to decide whether the delivery
// matters, so an action or ref this lane ignores never fails on a field only the enqueue path
// needs. The second is strict, and a delivery that fails it is a 400.
import { type RepoEventMessage, RepoEventMessageSchema, type RepoRemovedReason } from '@code-trust/shared';
import { type ZodError, z } from 'zod';

export type IgnoreReason =
  | 'unhandled-event'
  | 'unhandled-action'
  | 'branch-deleted'
  | 'not-default-branch'
  | 'not-public'
  | 'no-public-repos'
  | 'no-repository-list'
  | 'selection-narrowed';

export type InvalidReason =
  | 'push-fields'
  | 'installation-fields'
  | 'repository-fields'
  | 'full-name'
  | 'message-contract';

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

// A removal reads no visibility: a repo is deleted whether or not it says it is private.
const RemovedRepositorySchema = z.object({ id: z.number(), full_name: z.string() });

const InstallationCreatedSchema = z.object({
  installation: InstallationRefSchema,
  repositories: z.array(RepositoryEntrySchema),
});

const InstallationDeletedSchema = z.object({
  installation: InstallationRefSchema,
  // Optional in GitHub's schema, and every documented example is a selected installation, so an
  // uninstall of an all-repositories installation may name no repos.
  repositories: z.array(RemovedRepositorySchema).optional(),
});

const InstallationRepositoriesAddedSchema = z.object({
  installation: InstallationRefSchema,
  repositories_added: z.array(RepositoryEntrySchema),
});

const InstallationRepositoriesRemovedSchema = z.object({
  installation: InstallationRefSchema,
  // Empty when the installation narrows from all repositories to selected ones.
  repositories_removed: z.array(RemovedRepositorySchema),
});

const RepositoryRemovedSchema = z.object({
  repository: RemovedRepositorySchema,
  installation: InstallationRefSchema,
});

const RepositoryPublicizedSchema = z.object({
  repository: z.object({
    id: z.number(),
    full_name: z.string(),
    private: z.boolean(),
    visibility: z.string().optional(),
  }),
  installation: InstallationRefSchema,
});

type Envelope = Pick<RepoEventMessage, 'deliveryId' | 'receivedAt'> & { installationId: number };
type RepositoryEntry = z.infer<typeof RepositoryEntrySchema>;
type RemovedRepository = z.infer<typeof RemovedRepositorySchema>;
type Installed = { installation: { id: number } };
type ActionHandlers = Readonly<Record<string, () => RepoEventsResult>>;

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
    case 'repository':
      return routeOnAction(input, 'repository-fields', {
        privatized: () => fromRepositoryRemoved(input, 'privatized'),
        // GitHub documents that Apps never receive this action. It is mapped in case one ever arrives.
        deleted: () => fromRepositoryRemoved(input, 'deleted'),
        publicized: () => fromRepositoryPublicized(input),
      });
    case 'installation':
      return routeOnAction(input, 'installation-fields', {
        created: () => fromReposAdded(input, InstallationCreatedSchema, (p) => p.repositories),
        deleted: () =>
          fromReposRemoved(
            input,
            InstallationDeletedSchema,
            (p) => p.repositories,
            'uninstalled',
            'no-repository-list',
          ),
      });
    case 'installation_repositories':
      return routeOnAction(input, 'installation-fields', {
        added: () => fromReposAdded(input, InstallationRepositoriesAddedSchema, (p) => p.repositories_added),
        removed: () =>
          fromReposRemoved(
            input,
            InstallationRepositoriesRemovedSchema,
            (p) => p.repositories_removed,
            'removed_from_installation',
            'selection-narrowed',
          ),
      });
    default:
      // ping, and every event this lane does not handle.
      return ignored('unhandled-event');
  }
}

/** The first stage for events with an `action`: an action without a handler is ignored unread. */
function routeOnAction(input: RepoEventsInput, reason: InvalidReason, handlers: ActionHandlers): RepoEventsResult {
  const route = ActionSchema.safeParse(input.payload);
  if (!route.success) return invalid(reason, route.error);
  // Own keys only, so an action such as "constructor" never reaches Object.prototype.
  const handler = Object.hasOwn(handlers, route.data.action) ? handlers[route.data.action] : undefined;
  return handler === undefined ? ignored('unhandled-action') : handler();
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
  if (!isPublic(repository)) return ignored('not-public');
  const envelope = envelopeOf(input, push.data.installation.id);
  return toMessages([{ ...envelope, type: 'push', repo: repository, headSha: push.data.after }]);
}

function fromRepositoryRemoved(input: RepoEventsInput, reason: RepoRemovedReason): RepoEventsResult {
  const parsed = RepositoryRemovedSchema.safeParse(input.payload);
  if (!parsed.success) return invalid('repository-fields', parsed.error);
  const envelope = envelopeOf(input, parsed.data.installation.id);
  return toMessages([{ ...envelope, type: 'repository_removed', reason, repo: parsed.data.repository }]);
}

function fromRepositoryPublicized(input: RepoEventsInput): RepoEventsResult {
  const parsed = RepositoryPublicizedSchema.safeParse(input.payload);
  if (!parsed.success) return invalid('repository-fields', parsed.error);
  const { repository } = parsed.data;
  // The same rule as a push: an addition is only ever a public repo.
  if (!isPublic(repository)) return ignored('not-public');
  const envelope = envelopeOf(input, parsed.data.installation.id);
  return toMessages([{ ...envelope, type: 'repository_added', repo: repository }]);
}

function fromReposAdded<T extends Installed>(
  input: RepoEventsInput,
  schema: z.ZodType<T>,
  repositoriesOf: (payload: T) => readonly RepositoryEntry[],
): RepoEventsResult {
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) return invalid('installation-fields', parsed.error);
  const envelope = envelopeOf(input, parsed.data.installation.id);
  // Private repos never enter the pipeline: the read API has no auth.
  const publicRepos = repositoriesOf(parsed.data).filter((repo) => !repo.private);
  if (publicRepos.length === 0) return ignored('no-public-repos');
  return toMessages(publicRepos.map((repo) => ({ ...envelope, type: 'repository_added' as const, repo })));
}

function fromReposRemoved<T extends Installed>(
  input: RepoEventsInput,
  schema: z.ZodType<T>,
  repositoriesOf: (payload: T) => readonly RemovedRepository[] | undefined,
  reason: RepoRemovedReason,
  unlisted: IgnoreReason,
): RepoEventsResult {
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) return invalid('installation-fields', parsed.error);
  const repos = repositoriesOf(parsed.data) ?? [];
  // The payload names none of the repos the App lost, so there is nothing to delete by repo id.
  // Their data stays until a delete by installation exists (see Decisions).
  if (repos.length === 0) return ignored(unlisted);
  const envelope = envelopeOf(input, parsed.data.installation.id);
  // Every listed repo goes, private or not: deleting is always safe, and a repo that turned
  // private while a delivery was missed must still lose its data.
  return toMessages(repos.map((repo) => ({ ...envelope, type: 'repository_removed' as const, reason, repo })));
}

function isPublic(repo: { readonly private: boolean; readonly visibility?: string | undefined }): boolean {
  return !repo.private && (repo.visibility === undefined || repo.visibility === 'public');
}

function envelopeOf(input: RepoEventsInput, installationId: number): Envelope {
  return { deliveryId: input.deliveryId, receivedAt: input.receivedAt, installationId };
}

type Draft = Envelope & { repo: { id: number; full_name: string } } & (
    | { type: 'push'; headSha: string }
    | { type: 'repository_added' }
    | { type: 'repository_removed'; reason: RepoRemovedReason }
  );

function toMessages(drafts: readonly Draft[]): RepoEventsResult {
  const messages: RepoEventMessage[] = [];
  for (const { repo, ...draft } of drafts) {
    // Owner and name come from full_name, which every payload read here carries.
    const [owner, name, ...rest] = repo.full_name.split('/');
    if (owner === undefined || name === undefined || rest.length > 0) return invalid('full-name');
    // The contract is the last check: an id, owner, name or SHA that breaks it never reaches the queue.
    const message = RepoEventMessageSchema.safeParse({ version: 1, ...draft, repo: { id: repo.id, owner, name } });
    if (!message.success) return invalid('message-contract', message.error);
    messages.push(message.data);
  }
  return { kind: 'messages', messages };
}
