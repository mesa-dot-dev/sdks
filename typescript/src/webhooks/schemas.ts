import { z } from 'zod';

const OrganizationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

const RepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
});
export type Repository = z.infer<typeof RepositorySchema>;

const RepoInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  default_bookmark: z.string(),
  head_change_id: z.string(),
  created_at: z.string(),
  tags: z.record(z.string(), z.string()),
});

const RepoSnapshotSchema = z.object({
  name: z.string(),
  default_bookmark: z.string(),
  tags: z.record(z.string(), z.string()),
});

const BookmarkInfoSchema = z.object({
  name: z.string(),
  is_default: z.boolean(),
  change_id: z.string(),
  commit_oid: z.string(),
});

const CommitAuthorSchema = z.object({
  name: z.string(),
  email: z.string(),
  date: z.string().optional(),
});

const ChangeInfoSchema = z.object({
  id: z.string(),
  current_commit_oid: z.string(),
  message: z.string(),
  author: CommitAuthorSchema,
  committer: CommitAuthorSchema,
  parents: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});

export const RepoCreatedPayloadSchema = z.object({ repo: RepoInfoSchema });
export type RepoCreatedPayload = z.infer<typeof RepoCreatedPayloadSchema>;

export const RepoUpdatedPayloadSchema = z.object({
  repo: RepoInfoSchema,
  before: RepoSnapshotSchema,
  after: RepoSnapshotSchema,
});
export type RepoUpdatedPayload = z.infer<typeof RepoUpdatedPayloadSchema>;

export const RepoDeletedPayloadSchema = z.object({ repo: RepoInfoSchema });
export type RepoDeletedPayload = z.infer<typeof RepoDeletedPayloadSchema>;

export const BookmarkCreatedPayloadSchema = z.object({ bookmark: BookmarkInfoSchema });
export type BookmarkCreatedPayload = z.infer<typeof BookmarkCreatedPayloadSchema>;

export const BookmarkDeletedPayloadSchema = z.object({ bookmark: BookmarkInfoSchema });
export type BookmarkDeletedPayload = z.infer<typeof BookmarkDeletedPayloadSchema>;

export const BookmarkMovedPayloadSchema = z.object({
  bookmark: BookmarkInfoSchema,
  from: z.object({ change_id: z.string(), commit_oid: z.string() }),
});
export type BookmarkMovedPayload = z.infer<typeof BookmarkMovedPayloadSchema>;

export const BookmarkMergedPayloadSchema = z.object({ bookmark: BookmarkInfoSchema });
export type BookmarkMergedPayload = z.infer<typeof BookmarkMergedPayloadSchema>;

export const ChangeCreatedPayloadSchema = z.object({ change: ChangeInfoSchema });
export type ChangeCreatedPayload = z.infer<typeof ChangeCreatedPayloadSchema>;

export const ChangeEvolvedPayloadSchema = z.object({
  change: ChangeInfoSchema,
  previous_current_commit_oid: z.string(),
});
export type ChangeEvolvedPayload = z.infer<typeof ChangeEvolvedPayloadSchema>;

export const PushPayloadSchema = z.object({
  updates: z.array(
    z.object({
      ref: z.string(),
      bookmark: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
      action: z.enum(['created', 'updated', 'deleted']),
    })
  ),
  reconciliation: z.object({
    reconciled_commit_count: z.number(),
    touched_change_count: z.number(),
    changes_created_count: z.number(),
    evolog_inserted_count: z.number(),
    invalid_change_id_header_count: z.number(),
    dirty_change_skip_count: z.number(),
  }),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

const SyncBaseSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  direction: z.enum(['pull', 'push']),
  attempt: z.number(),
  ref_globs: z.object({
    branches: z.string(),
    tags: z.string(),
  }),
});

// Per-ref outcome from one sync. Invariants:
// - 'updated'   → before !== after (moved forward or newly created)
// - 'unchanged' → before === after
// - 'filtered'  → ref was intentionally excluded by policy
// - 'rejected'  → target refused the update attempt
// `before` is null only when the ref was newly created.
const SyncStatsSchema = z.object({
  refs: z.array(
    z.object({
      name: z.string(),
      before: z.string().nullable(),
      after: z.string(),
      outcome: z.enum(['updated', 'unchanged', 'filtered', 'rejected']),
    })
  ),
});

const SyncQueuedInfoSchema = SyncBaseSchema.extend({
  status: z.literal('queued'),
  stats: z.null(),
  error: z.null(),
  created_at: z.string(),
  started_at: z.null(),
  finished_at: z.null(),
});
const SyncInProgressInfoSchema = SyncBaseSchema.extend({
  status: z.literal('in_progress'),
  stats: z.null(),
  error: z.null(),
  created_at: z.string(),
  started_at: z.string(),
  finished_at: z.null(),
});
const SyncCompletedInfoSchema = SyncBaseSchema.extend({
  status: z.literal('completed'),
  stats: SyncStatsSchema,
  error: z.null(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string(),
});
const SyncFailedInfoSchema = SyncBaseSchema.extend({
  status: z.literal('failed'),
  stats: SyncStatsSchema.nullable(),
  error: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string(),
});

export const SyncQueuedPayloadSchema = z.object({ sync: SyncQueuedInfoSchema });
export const SyncInProgressPayloadSchema = z.object({ sync: SyncInProgressInfoSchema });
export const SyncCompletedPayloadSchema = z.object({ sync: SyncCompletedInfoSchema });
export const SyncFailedPayloadSchema = z.object({ sync: SyncFailedInfoSchema });
export type SyncQueuedPayload = z.infer<typeof SyncQueuedPayloadSchema>;
export type SyncInProgressPayload = z.infer<typeof SyncInProgressPayloadSchema>;
export type SyncCompletedPayload = z.infer<typeof SyncCompletedPayloadSchema>;
export type SyncFailedPayload = z.infer<typeof SyncFailedPayloadSchema>;

const WebhookEnvelopeBaseSchema = z.object({
  id: z.string(),
  occurred_at: z.string(),
  organization: OrganizationSchema,
  repository: RepositorySchema.nullable(),
});

const RepoCreatedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('repo.created'),
  data: RepoCreatedPayloadSchema,
});
const RepoUpdatedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('repo.updated'),
  data: RepoUpdatedPayloadSchema,
});
const RepoDeletedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('repo.deleted'),
  data: RepoDeletedPayloadSchema,
});
const BookmarkCreatedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('bookmark.created'),
  data: BookmarkCreatedPayloadSchema,
});
const BookmarkDeletedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('bookmark.deleted'),
  data: BookmarkDeletedPayloadSchema,
});
const BookmarkMovedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('bookmark.moved'),
  data: BookmarkMovedPayloadSchema,
});
const BookmarkMergedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('bookmark.merged'),
  data: BookmarkMergedPayloadSchema,
});
const ChangeCreatedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('change.created'),
  data: ChangeCreatedPayloadSchema,
});
const ChangeEvolvedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('change.evolved'),
  data: ChangeEvolvedPayloadSchema,
});
const PushEventSchema = WebhookEnvelopeBaseSchema.extend({ type: z.literal('push'), data: PushPayloadSchema });
const SyncQueuedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('sync.queued'),
  data: SyncQueuedPayloadSchema,
});
const SyncInProgressEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('sync.in_progress'),
  data: SyncInProgressPayloadSchema,
});
const SyncCompletedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('sync.completed'),
  data: SyncCompletedPayloadSchema,
});
const SyncFailedEventSchema = WebhookEnvelopeBaseSchema.extend({
  type: z.literal('sync.failed'),
  data: SyncFailedPayloadSchema,
});

export const WebhookEventSchema = z.discriminatedUnion('type', [
  RepoCreatedEventSchema,
  RepoUpdatedEventSchema,
  RepoDeletedEventSchema,
  BookmarkCreatedEventSchema,
  BookmarkDeletedEventSchema,
  BookmarkMovedEventSchema,
  BookmarkMergedEventSchema,
  ChangeCreatedEventSchema,
  ChangeEvolvedEventSchema,
  PushEventSchema,
  SyncQueuedEventSchema,
  SyncInProgressEventSchema,
  SyncCompletedEventSchema,
  SyncFailedEventSchema,
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

export type WebhookEventName = WebhookEvent['type'];

export type WebhookEventOf<T extends WebhookEventName> = Extract<WebhookEvent, { type: T }>;

export type WebhookHandler<T extends WebhookEventName = WebhookEventName> = (
  event: WebhookEventOf<T>
) => void | Promise<void>;
