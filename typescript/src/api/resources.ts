import { createHmac, timingSafeEqual } from 'node:crypto';
import { parse as parseQueryString } from 'node:querystring';
import {
  type CreateBookmarkData,
  type CreateBookmarkResponse,
  type CreateChangeData,
  type CreateChangeResponse,
  type CreateRepoData,
  type CreateRepoResponse,
  type CreateWebhookTargetData,
  type CreateWebhookTargetResponse,
  createBookmark,
  createChange,
  createRepo,
  createWebhookTarget,
  type DeleteBookmarkData,
  type DeleteBookmarkResponse,
  type DeleteRepoData,
  type DeleteRepoResponse,
  type DeleteWebhookTargetData,
  type DeleteWebhookTargetResponse,
  deleteBookmark,
  deleteRepo,
  deleteWebhookTarget,
  type GetBookmarkData,
  type GetBookmarkResponse,
  type GetChangeData,
  type GetChangeResponse,
  type GetContentData,
  type GetContentResponse,
  type GetDiffData,
  type GetDiffResponse,
  type GetOrgResponse,
  type GetRepoData,
  type GetRepoResponse,
  type GetRepoUpstreamSyncData,
  type GetRepoUpstreamSyncResponse,
  getBookmark,
  getChange,
  getContent,
  getDiff,
  getOrg,
  getRepo,
  getRepoUpstreamSync,
  type ListBookmarksData,
  type ListBookmarksResponse,
  type ListChangesData,
  type ListChangesResponse,
  type ListReposData,
  type ListReposResponse,
  type ListRepoUpstreamSyncsData,
  type ListRepoUpstreamSyncsResponse,
  type ListWebhookTargetsData,
  type ListWebhookTargetsResponse,
  listBookmarks,
  listChanges,
  listRepos,
  listRepoUpstreamSyncs,
  listWebhookTargets,
  type MergeBookmarkData,
  type MergeBookmarkResponse,
  type MoveBookmarkData,
  type MoveBookmarkResponse,
  mergeBookmark,
  moveBookmark,
  type SyncUpstreamData,
  type SyncUpstreamResponse,
  syncUpstream,
  type UpdateChangeData,
  type UpdateChangeResponse,
  type UpdateRepoData,
  type UpdateRepoResponse,
  type UpdateWebhookTargetData,
  type UpdateWebhookTargetResponse,
  updateChange,
  updateRepo,
  updateWebhookTarget,
} from '@mesadev/rest';
import { prettifyError } from 'zod';
import { InvalidOptionsError, MesaWebhookVerificationError, MissingWebhookSecretError } from '../lib/errors.js';
import { type WebhookEventName, WebhookEventSchema, type WebhookHandler } from '../webhooks/schemas.js';
import { normalizeSigningKeyAuthors, type SigningKeyAuthorInput } from './access-token.js';
import type { RestClient } from './client.js';
import { serializeRepoTagsFilter, type RepoTagFilter } from './repo-tag-filter.js';

const SIGNATURE_HEADER = 'x-mesa-signature';
const WEBHOOK_TOLERANCE_SECONDS = 300;

function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

type NormalizedSigningKeyAuthors = ReturnType<typeof normalizeSigningKeyAuthors>;

type RequestAttribution = {
  sign: (authors: NormalizedSigningKeyAuthors) => string;
};

type OrgRequestContext = {
  restClient: RestClient;
  orgSlug: string;
  webhookSecret?: string;
  requestAttribution: RequestAttribution;
};

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

type ReposListInput = Omit<NonNullable<ListReposData['query']>, 'tags'> & {
  /** Structured tag filter object. */
  tags?: RepoTagFilter;
};
type ReposCreateInput = CreateRepoData['body'];
type ReposGetInput = Omit<GetRepoData['path'], 'org'>;
type ReposUpdateInput = Omit<UpdateRepoData['path'], 'org'> & UpdateRepoData['body'];
type ReposDeleteInput = Omit<DeleteRepoData['path'], 'org'>;
type SyncRefGlobsInput = { branches: string; tags?: string } | { branches?: string; tags: string };
type ReposSyncUpstreamInput = Omit<SyncUpstreamData['path'], 'org'> &
  Omit<SyncUpstreamData['body'], 'ref_globs'> & { ref_globs?: SyncRefGlobsInput | undefined };
type ReposGetUpstreamSyncInput = Omit<GetRepoUpstreamSyncData['path'], 'org'>;
type ReposListUpstreamSyncsInput = Omit<ListRepoUpstreamSyncsData['path'], 'org'> &
  NonNullable<ListRepoUpstreamSyncsData['query']>;

type ContentGetInput = Omit<GetContentData['path'], 'org'> & NonNullable<GetContentData['query']>;

type BookmarksListInput = Omit<ListBookmarksData['path'], 'org'> & NonNullable<ListBookmarksData['query']>;
type BookmarksGetInput = Omit<GetBookmarkData['path'], 'org'>;
type BookmarksCreateInput = Omit<CreateBookmarkData['path'], 'org'> & CreateBookmarkData['body'];
type BookmarksDeleteInput = Omit<DeleteBookmarkData['path'], 'org'>;
type BookmarksMoveInput = Omit<MoveBookmarkData['path'], 'org'> & MoveBookmarkData['body'];
export type BookmarksMergeInput = Omit<MergeBookmarkData['path'], 'org'> & Omit<MergeBookmarkData['body'], 'author'>;

type PrivateKeyCommitAuthors = {
  /** Ordered, nonempty commit attribution signed into this request's token. */
  authors: NonEmptyReadonlyArray<SigningKeyAuthorInput>;
};

export type PrivateKeyBookmarksMergeInput = BookmarksMergeInput & PrivateKeyCommitAuthors;

type ChangesListInput = Omit<ListChangesData['path'], 'org'> & NonNullable<ListChangesData['query']>;

/**
 * Base fields shared by all `changes.create()` calls.
 */
type ChangesCreateBase = Omit<CreateChangeData['path'], 'org'> &
  Pick<CreateChangeData['body'], 'base_change_id' | 'committer'>;

/**
 * When `files` is provided (non-empty), `author` and `message` are required.
 */
type ChangesCreateWithFiles = ChangesCreateBase & {
  files: NonNullable<CreateChangeData['body']['files']>;
  author: NonNullable<CreateChangeData['body']['author']>;
  message: NonNullable<CreateChangeData['body']['message']>;
};

/**
 * When no `files` are provided, `author` and `message` remain optional.
 */
type ChangesCreateWithoutFiles = ChangesCreateBase & {
  files?: never[] | undefined;
  author?: CreateChangeData['body']['author'];
  message?: CreateChangeData['body']['message'];
};

/**
 * Input for `changes.create()`.
 *
 * The API requires `author` and `message` when `files` is provided.
 * This type enforces that constraint at compile time.
 */
export type ChangesCreateInput = ChangesCreateWithFiles | ChangesCreateWithoutFiles;
type ChangesGetInput = Omit<GetChangeData['path'], 'org'>;
export type ChangesPatchInput = Omit<UpdateChangeData['path'], 'org'> & UpdateChangeData['body'];

type DistributiveOmit<T, TKey extends PropertyKey> = T extends unknown ? Omit<T, TKey> : never;

export type PrivateKeyChangesCreateInput = DistributiveOmit<ChangesCreateInput, 'author'> & PrivateKeyCommitAuthors;

type ChangesPatchWithoutAttribution = Omit<ChangesPatchInput, 'author' | 'resolutions'>;

/**
 * The REST API still returns the deprecated singular `author` so older clients
 * keep working. The high-level SDK does not: `authors` and `authored_at` are
 * the only attribution it exposes. Raw `@mesadev/rest` results are unchanged.
 */
type WithoutLegacyAuthor<T> = Omit<T, 'author'>;
export type ChangesListResponse = Omit<ListChangesResponse, 'changes'> & {
  changes: Array<WithoutLegacyAuthor<ListChangesResponse['changes'][number]>>;
};
export type ChangesCreateResponse = WithoutLegacyAuthor<CreateChangeResponse>;
export type ChangesGetResponse = WithoutLegacyAuthor<GetChangeResponse>;
export type ChangesPatchResponse = WithoutLegacyAuthor<UpdateChangeResponse>;

function removeLegacyAuthor<T extends { author: unknown }>(change: T): Omit<T, 'author'> {
  const { author: _author, ...result } = change;
  return result;
}

export type PrivateKeyChangesPatchInput =
  | (ChangesPatchWithoutAttribution & { resolutions?: never } & PrivateKeyCommitAuthors)
  | (ChangesPatchWithoutAttribution & {
      resolutions: NonEmptyReadonlyArray<NonNullable<ChangesPatchInput['resolutions']>[number]>;
      authors?: never;
    });

type DiffsGetInput = Omit<GetDiffData['path'], 'org'> & NonNullable<GetDiffData['query']>;

type WebhookTargetsListInput = NonNullable<ListWebhookTargetsData['query']>;
type WebhookTargetsCreateInput = CreateWebhookTargetData['body'];
type WebhookTargetsUpdateInput = Omit<UpdateWebhookTargetData['path'], 'org'> & UpdateWebhookTargetData['body'];
type WebhookTargetsDeleteInput = Omit<DeleteWebhookTargetData['path'], 'org'>;

type RuntimeAttributionInput = {
  author?: unknown;
  authors?: unknown;
};

function prepareCommitRequest(
  input: Record<string, unknown>,
  requestAttribution: RequestAttribution,
  preserveExistingAuthors = false
): { body: Record<string, unknown>; credential?: string } {
  const { author, authors } = input as RuntimeAttributionInput;
  const hasAuthor = author !== undefined;
  const hasAuthors = authors !== undefined;

  const { author: _author, authors: _authors, ...body } = input;
  if (preserveExistingAuthors) {
    if (hasAuthor || hasAuthors) {
      throw new InvalidOptionsError('Conflict-resolution patches preserve the existing commit authors.');
    }
    return { body };
  }

  if (hasAuthor) {
    throw new InvalidOptionsError('The singular `author` option is not supported. Pass `authors` instead.');
  }

  if (!hasAuthors) {
    throw new InvalidOptionsError('Private-key commit operations require a nonempty `authors` option.');
  }

  const normalizedAuthors = normalizeSigningKeyAuthors(authors as readonly SigningKeyAuthorInput[]);
  return { body, credential: requestAttribution.sign(normalizedAuthors) };
}

export function createApiResources({ restClient, orgSlug: org, webhookSecret, requestAttribution }: OrgRequestContext) {
  const webhookListeners: { [K in WebhookEventName]: WebhookHandler<K>[] } = {
    'repo.created': [],
    'repo.updated': [],
    'repo.deleted': [],
    'bookmark.created': [],
    'bookmark.deleted': [],
    'bookmark.moved': [],
    'bookmark.merged': [],
    'change.created': [],
    'change.evolved': [],
    push: [],
    'sync.queued': [],
    'sync.in_progress': [],
    'sync.completed': [],
    'sync.failed': [],
  };

  return {
    org: Object.freeze({
      slug: org,
      get: async (): Promise<GetOrgResponse> => {
        return restClient.request(getOrg, { path: { org } });
      },
    } as const),
    repos: {
      list: async (input: ReposListInput = {}): Promise<ListReposResponse> => {
        const { tags, ...queryInput } = input;
        const query = tags === undefined ? queryInput : { ...queryInput, tags: serializeRepoTagsFilter(tags) };
        return restClient.request(listRepos, { path: { org }, query });
      },
      create: async (input: ReposCreateInput): Promise<CreateRepoResponse> => {
        return restClient.request(createRepo, { path: { org }, body: input });
      },
      get: async (input: ReposGetInput): Promise<GetRepoResponse> => {
        const { repo } = input;
        return restClient.request(getRepo, { path: { org, repo } });
      },
      update: async (input: ReposUpdateInput): Promise<UpdateRepoResponse> => {
        const { repo, ...body } = input;
        return restClient.request(updateRepo, { path: { org, repo }, body });
      },
      delete: async (input: ReposDeleteInput): Promise<DeleteRepoResponse> => {
        const { repo } = input;
        return restClient.request(deleteRepo, { path: { org, repo } });
      },
      syncUpstream: async (input: ReposSyncUpstreamInput): Promise<SyncUpstreamResponse> => {
        const { repo, ...body } = input;
        return restClient.request(syncUpstream, { path: { org, repo }, body });
      },
      getUpstreamSync: async (input: ReposGetUpstreamSyncInput): Promise<GetRepoUpstreamSyncResponse> => {
        const { repo, syncId } = input;
        return restClient.request(getRepoUpstreamSync, { path: { org, repo, syncId } });
      },
      listUpstreamSyncs: async (input: ReposListUpstreamSyncsInput): Promise<ListRepoUpstreamSyncsResponse> => {
        const { repo, ...query } = input;
        return restClient.request(listRepoUpstreamSyncs, { path: { org, repo }, query });
      },
    },
    content: {
      get: async (input: ContentGetInput): Promise<GetContentResponse> => {
        const { repo, ...query } = input;
        return restClient.request(getContent, { path: { org, repo }, query });
      },
    },
    bookmarks: {
      list: async (input: BookmarksListInput): Promise<ListBookmarksResponse> => {
        const { repo, ...query } = input;
        return restClient.request(listBookmarks, { path: { org, repo }, query });
      },
      get: async (input: BookmarksGetInput): Promise<GetBookmarkResponse> => {
        const { repo, bookmark } = input;
        return restClient.request(getBookmark, { path: { org, repo, bookmark } });
      },
      create: async (input: BookmarksCreateInput): Promise<CreateBookmarkResponse> => {
        const { repo, ...body } = input;
        return restClient.request(createBookmark, { path: { org, repo }, body });
      },
      delete: async (input: BookmarksDeleteInput): Promise<DeleteBookmarkResponse> => {
        const { repo, bookmark } = input;
        return restClient.request(deleteBookmark, { path: { org, repo, bookmark } });
      },
      move: async (input: BookmarksMoveInput): Promise<MoveBookmarkResponse> => {
        const { repo, bookmark, ...body } = input;
        return restClient.request(moveBookmark, { path: { org, repo, bookmark }, body });
      },
      merge: async (input: PrivateKeyBookmarksMergeInput): Promise<MergeBookmarkResponse> => {
        const { repo, ...body } = input;
        const prepared = prepareCommitRequest(body, requestAttribution);
        return restClient.request(
          mergeBookmark,
          {
            path: { org, repo },
            body: prepared.body as MergeBookmarkData['body'],
          },
          prepared.credential
        );
      },
    },
    changes: {
      list: async (input: ChangesListInput): Promise<ChangesListResponse> => {
        const { repo, ...query } = input;
        const response = await restClient.request<ListChangesData, ListChangesResponse>(listChanges, {
          path: { org, repo },
          query,
        });
        return { ...response, changes: response.changes.map(removeLegacyAuthor) };
      },
      create: async (input: PrivateKeyChangesCreateInput): Promise<ChangesCreateResponse> => {
        const { repo, ...body } = input;
        const prepared = prepareCommitRequest(body, requestAttribution);
        const response = await restClient.request<CreateChangeData, CreateChangeResponse>(
          createChange,
          { path: { org, repo }, body: prepared.body as CreateChangeData['body'] },
          prepared.credential
        );
        return removeLegacyAuthor(response);
      },
      get: async (input: ChangesGetInput): Promise<ChangesGetResponse> => {
        const { repo, change_id: changeId } = input;
        const response = await restClient.request<GetChangeData, GetChangeResponse>(getChange, {
          path: { org, repo, change_id: changeId },
        });
        return removeLegacyAuthor(response);
      },
      patch: async (input: PrivateKeyChangesPatchInput): Promise<ChangesPatchResponse> => {
        const { repo, change_id: changeId, ...body } = input;
        const preserveExistingAuthors = Array.isArray(body.resolutions) && body.resolutions.length > 0;
        const prepared = prepareCommitRequest(body, requestAttribution, preserveExistingAuthors);
        const response = await restClient.request<UpdateChangeData, UpdateChangeResponse>(
          updateChange,
          {
            path: { org, repo, change_id: changeId },
            body: prepared.body as UpdateChangeData['body'],
          },
          prepared.credential
        );
        return removeLegacyAuthor(response);
      },
    },
    diffs: {
      get: async (input: DiffsGetInput): Promise<GetDiffResponse> => {
        const { repo, ...query } = input;
        return restClient.request(getDiff, { path: { org, repo }, query });
      },
    },
    webhookTargets: {
      list: async (input: WebhookTargetsListInput = {}): Promise<ListWebhookTargetsResponse> => {
        const query = input;
        return restClient.request(listWebhookTargets, { path: { org }, query });
      },
      create: async (input: WebhookTargetsCreateInput): Promise<CreateWebhookTargetResponse> => {
        return restClient.request(createWebhookTarget, { path: { org }, body: input });
      },
      update: async (input: WebhookTargetsUpdateInput): Promise<UpdateWebhookTargetResponse> => {
        const { webhookTargetId, ...body } = input;
        return restClient.request(updateWebhookTarget, { path: { org, webhookTargetId }, body });
      },
      delete: async (input: WebhookTargetsDeleteInput): Promise<DeleteWebhookTargetResponse> => {
        const { webhookTargetId } = input;
        return restClient.request(deleteWebhookTarget, { path: { org, webhookTargetId } });
      },
    },
    webhooks: {
      on<T extends WebhookEventName>(name: T | T[], fn: WebhookHandler<T>): void {
        const names = Array.isArray(name) ? name : [name];
        for (const n of names) {
          webhookListeners[n].push(fn);
        }
      },
      async receive(request: Request): Promise<void> {
        if (!webhookSecret) {
          throw new MissingWebhookSecretError();
        }
        const rawBody = await request.text();
        const signatureHeader = request.headers.get(SIGNATURE_HEADER);
        if (!signatureHeader) {
          throw new MesaWebhookVerificationError('Missing signature header');
        }

        const parts = parseQueryString(signatureHeader, ',', '=');
        const timestamp = Number(parts.t);
        const signature = typeof parts.sha256 === 'string' ? parts.sha256 : undefined;
        if (!timestamp || !signature) {
          throw new MesaWebhookVerificationError('Malformed signature header');
        }

        if (Math.floor(Date.now() / 1000) - timestamp > WEBHOOK_TOLERANCE_SECONDS) {
          throw new MesaWebhookVerificationError('Webhook timestamp outside tolerance window');
        }

        const expected = sign(webhookSecret, timestamp, rawBody);
        const signatureBuffer = Buffer.from(signature, 'hex');
        const expectedBuffer = Buffer.from(expected, 'hex');
        if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
          throw new MesaWebhookVerificationError('Invalid webhook signature');
        }

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          throw new MesaWebhookVerificationError('Could not parse webhook payload as JSON');
        }
        const result = WebhookEventSchema.safeParse(parsedBody);
        if (!result.success) {
          throw new MesaWebhookVerificationError(prettifyError(result.error), { cause: result.error });
        }
        const event = result.data;

        const settled = await Promise.allSettled(
          webhookListeners[event.type].map(async (h) => (h as WebhookHandler)(event))
        );
        const handlerErrors = settled
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason);
        if (handlerErrors.length > 0) {
          throw new AggregateError(handlerErrors);
        }
      },
    },
  };
}

export type ApiResources = ReturnType<typeof createApiResources>;
