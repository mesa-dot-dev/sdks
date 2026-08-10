import { createHmac, timingSafeEqual } from 'node:crypto';
import { parse as parseQueryString } from 'node:querystring';
import {
  type CreateApiKeyData,
  type CreateApiKeyResponse,
  type CreateBookmarkData,
  type CreateBookmarkResponse,
  type CreateChangeData,
  type CreateChangeResponse,
  type CreateRepoData,
  type CreateRepoResponse,
  type CreateWebhookTargetData,
  type CreateWebhookTargetResponse,
  createApiKey,
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
  type ListApiKeysResponse,
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
  listApiKeys,
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
  type RevokeApiKeyData,
  type RevokeApiKeyResponse,
  revokeApiKey,
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
import {
  type ApiRepositoryRestriction,
  normalizeSigningKeyAuthors,
  type RepositoryRestriction,
  type SigningKeyAuthorInput,
} from './access-token.js';
import type { RestClient } from './client.js';
import { serializeRepoTagsFilter, type RepoTagFilter } from './repo-tag-filter.js';

const SIGNATURE_HEADER = 'x-mesa-signature';
const WEBHOOK_TOLERANCE_SECONDS = 300;

function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

type ResolveOrg = (org?: string) => Promise<string>;

type NormalizedSigningKeyAuthors = ReturnType<typeof normalizeSigningKeyAuthors>;

type RequestAttribution =
  | { kind: 'request' }
  | { kind: 'fixed-token' }
  | { kind: 'private-key'; sign: (authors: NormalizedSigningKeyAuthors) => string };

type OrgRequestContext = {
  restClient: RestClient;
  resolveOrg: ResolveOrg;
  webhookSecret?: string;
  /** Sign an access token locally with the configured API key or private key. */
  signToken: (input: TokensCreateInput) => Promise<TokensCreateResponse>;
  requestAttribution: RequestAttribution;
};

/** @deprecated Part of the API-key management surface; prefer private keys created in the dashboard. */
type ApiKeysListInput = { org?: string };
/** @deprecated Part of the API-key management surface; prefer private keys created in the dashboard. */
type ApiKeysCreateInput = CreateApiKeyData['body'] & { org?: string };
/** @deprecated Part of the API-key management surface; prefer private keys created in the dashboard. */
type ApiKeysRevokeInput = Omit<RevokeApiKeyData['path'], 'org'> & { org?: string };

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/** Commit attribution carried by a private-key access token. */
export type TokensCreateAuthor = SigningKeyAuthorInput;

type TokensCreateBase = ApiRepositoryRestriction & {
  /** Requested scopes. Defaults to read and write. */
  scopes?: string[];
  /** @deprecated Ignored for locally signed tokens; retained for source compatibility. */
  org?: string;
};

/**
 * Existing `tokens.create()` input for API-key clients. Applies only to the
 * deprecated API-key path; private-key clients use
 * {@link TokensCreatePrivateKeyInput}.
 */
export type TokensCreateLegacyInput = TokensCreateBase & {
  /** Token lifetime in seconds (1..86400). Defaults to 3600. */
  ttl_seconds?: number;
  authors?: never;
};

/** `tokens.create()` input for private-key clients. */
export type TokensCreatePrivateKeyInput = TokensCreateBase & {
  /** Ordered, nonempty commit attribution encoded into the token. */
  authors: NonEmptyReadonlyArray<TokensCreateAuthor>;
  /** Token lifetime in seconds (1..14400). Defaults to 900. */
  ttl_seconds?: number;
};

export type TokensCreateInput = TokensCreateLegacyInput | TokensCreatePrivateKeyInput;

/** Result of `tokens.create()`. */
export type TokensCreateResponse = RepositoryRestriction<'repos', 'repo_ids'> & {
  token: string;
  /** Exact expiry as an ISO 8601 string. */
  expires_at: string;
  scopes: string[];
};

type ReposListInput = Omit<NonNullable<ListReposData['query']>, 'tags'> & {
  org?: string;
  /** Structured tag filter object. Legacy strings are accepted for existing callers. */
  tags?: RepoTagFilter | string;
};
type ReposCreateInput = CreateRepoData['body'] & { org?: string };
type ReposGetInput = Omit<GetRepoData['path'], 'org'> & { org?: string };
type ReposUpdateInput = Omit<UpdateRepoData['path'], 'org'> & UpdateRepoData['body'] & { org?: string };
type ReposDeleteInput = Omit<DeleteRepoData['path'], 'org'> & { org?: string };
type SyncRefGlobsInput = { branches: string; tags?: string } | { branches?: string; tags: string };
type ReposSyncUpstreamInput = Omit<SyncUpstreamData['path'], 'org'> &
  Omit<SyncUpstreamData['body'], 'ref_globs'> & { org?: string; ref_globs?: SyncRefGlobsInput | undefined };
type ReposGetUpstreamSyncInput = Omit<GetRepoUpstreamSyncData['path'], 'org'> & { org?: string };
type ReposListUpstreamSyncsInput = Omit<ListRepoUpstreamSyncsData['path'], 'org'> &
  NonNullable<ListRepoUpstreamSyncsData['query']> & { org?: string };

type ContentGetInput = Omit<GetContentData['path'], 'org'> &
  NonNullable<GetContentData['query']> & {
    org?: string;
  };

type BookmarksListInput = Omit<ListBookmarksData['path'], 'org'> &
  NonNullable<ListBookmarksData['query']> & {
    org?: string;
  };
type BookmarksGetInput = Omit<GetBookmarkData['path'], 'org'> & { org?: string };
type BookmarksCreateInput = Omit<CreateBookmarkData['path'], 'org'> &
  CreateBookmarkData['body'] & {
    org?: string;
  };
type BookmarksDeleteInput = Omit<DeleteBookmarkData['path'], 'org'> & { org?: string };
type BookmarksMoveInput = Omit<MoveBookmarkData['path'], 'org'> &
  MoveBookmarkData['body'] & {
    org?: string;
  };
export type BookmarksMergeInput = Omit<MergeBookmarkData['path'], 'org'> &
  MergeBookmarkData['body'] & {
    org?: string;
  };

type SigningKeyCommitAttribution =
  | {
      /** @deprecated Use `authors` for ordered commit attribution. */
      author: SigningKeyAuthorInput;
      authors?: never;
    }
  | {
      author?: never;
      /** Ordered, nonempty commit attribution signed into this request's token. */
      authors: NonEmptyReadonlyArray<SigningKeyAuthorInput>;
    };

type NoCommitAttribution = {
  author?: never;
  authors?: never;
};

export type PrivateKeyBookmarksMergeInput = BookmarksMergeInput & SigningKeyCommitAttribution;
export type FixedTokenBookmarksMergeInput = BookmarksMergeInput & NoCommitAttribution;

type ChangesListInput = Omit<ListChangesData['path'], 'org'> &
  NonNullable<ListChangesData['query']> & {
    org?: string;
  };

/**
 * Base fields shared by all `changes.create()` calls.
 */
type ChangesCreateBase = Omit<CreateChangeData['path'], 'org'> &
  Pick<CreateChangeData['body'], 'base_change_id' | 'committer'> & {
    org?: string;
  };

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
type ChangesGetInput = Omit<GetChangeData['path'], 'org'> & { org?: string };
export type ChangesPatchInput = Omit<UpdateChangeData['path'], 'org'> &
  UpdateChangeData['body'] & {
    org?: string;
  };

type DistributiveOmit<T, TKey extends PropertyKey> = T extends unknown ? Omit<T, TKey> : never;

export type PrivateKeyChangesCreateInput = DistributiveOmit<ChangesCreateInput, 'author'> & SigningKeyCommitAttribution;
export type FixedTokenChangesCreateInput = DistributiveOmit<ChangesCreateInput, 'author'> & NoCommitAttribution;

type ChangesPatchWithoutAttribution = Omit<ChangesPatchInput, 'author' | 'resolutions'>;

export type PrivateKeyChangesPatchInput =
  | (ChangesPatchWithoutAttribution & { resolutions?: never } & SigningKeyCommitAttribution)
  | (ChangesPatchWithoutAttribution & {
      resolutions: NonEmptyReadonlyArray<NonNullable<ChangesPatchInput['resolutions']>[number]>;
      author?: never;
      authors?: never;
    });
export type FixedTokenChangesPatchInput = Omit<ChangesPatchInput, 'author'> & NoCommitAttribution;

type DiffsGetInput = Omit<GetDiffData['path'], 'org'> & NonNullable<GetDiffData['query']> & { org?: string };

type WebhookTargetsListInput = NonNullable<ListWebhookTargetsData['query']> & { org?: string };
type WebhookTargetsCreateInput = CreateWebhookTargetData['body'] & {
  org?: string;
};
type WebhookTargetsUpdateInput = Omit<UpdateWebhookTargetData['path'], 'org'> &
  UpdateWebhookTargetData['body'] & {
    org?: string;
  };
type WebhookTargetsDeleteInput = Omit<DeleteWebhookTargetData['path'], 'org'> & { org?: string };

type OrgGetInput = { org?: string };

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

  if (hasAuthor && hasAuthors) {
    throw new InvalidOptionsError('Pass exactly one of `author` or `authors`.');
  }

  if (requestAttribution.kind === 'request') {
    if (hasAuthors) {
      throw new InvalidOptionsError('Ordered `authors` require a private-key client.');
    }
    return { body: input };
  }

  if (requestAttribution.kind === 'fixed-token') {
    if (hasAuthor || hasAuthors) {
      throw new InvalidOptionsError('Access-token authors are fixed when the token is minted.');
    }
    return { body: input };
  }

  const { author: _author, authors: _authors, ...body } = input;
  if (preserveExistingAuthors) {
    if (hasAuthor || hasAuthors) {
      throw new InvalidOptionsError('Conflict-resolution patches preserve the existing commit authors.');
    }
    return { body };
  }

  if (!hasAuthor && !hasAuthors) {
    throw new InvalidOptionsError('Private-key commit operations require exactly one of `author` or `authors`.');
  }

  const normalizedAuthors = hasAuthors
    ? normalizeSigningKeyAuthors(authors as readonly SigningKeyAuthorInput[])
    : normalizeSigningKeyAuthors([author as SigningKeyAuthorInput]);
  return { body, credential: requestAttribution.sign(normalizedAuthors) };
}

export function createApiResources({
  restClient,
  resolveOrg,
  webhookSecret,
  signToken,
  requestAttribution,
}: OrgRequestContext) {
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
    org: {
      get: async (input: OrgGetInput = {}): Promise<GetOrgResponse> => {
        const org = await resolveOrg(input.org);
        return restClient.request(getOrg, { path: { org } });
      },
    },
    tokens: {
      /** Sign locally with an API key or private key. Static access-token clients cannot mint another token. */
      create: (input: TokensCreateInput = {}) => signToken(input),
    },
    /**
     * @deprecated Manage API keys from the dashboard and authenticate new
     * integrations with private keys instead. API keys remain supported for
     * existing integrations.
     */
    apiKeys: {
      /** @deprecated Prefer private keys created in the dashboard. */
      list: async (input: ApiKeysListInput = {}): Promise<ListApiKeysResponse> => {
        const org = await resolveOrg(input.org);
        return restClient.request(listApiKeys, { path: { org } });
      },
      /** @deprecated Prefer private keys created in the dashboard. */
      create: async (input: ApiKeysCreateInput): Promise<CreateApiKeyResponse> => {
        const { org: overrideOrg, ...body } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(createApiKey, { path: { org }, body });
      },
      /** @deprecated Prefer private keys created in the dashboard. */
      revoke: async (input: ApiKeysRevokeInput): Promise<RevokeApiKeyResponse> => {
        const { id, org: overrideOrg } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(revokeApiKey, { path: { id, org } });
      },
    },
    repos: {
      list: async (input: ReposListInput = {}): Promise<ListReposResponse> => {
        const { org: overrideOrg, tags, ...queryInput } = input;
        const query = tags === undefined ? queryInput : { ...queryInput, tags: serializeRepoTagsFilter(tags) };
        const org = await resolveOrg(overrideOrg);
        return restClient.request(listRepos, { path: { org }, query });
      },
      create: async (input: ReposCreateInput): Promise<CreateRepoResponse> => {
        const { org: overrideOrg, ...body } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(createRepo, { path: { org }, body });
      },
      get: async (input: ReposGetInput): Promise<GetRepoResponse> => {
        const { org: overrideOrg, repo } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(getRepo, { path: { org, repo } });
      },
      update: async (input: ReposUpdateInput): Promise<UpdateRepoResponse> => {
        const { org: overrideOrg, repo, ...body } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(updateRepo, { path: { org, repo }, body });
      },
      delete: async (input: ReposDeleteInput): Promise<DeleteRepoResponse> => {
        const { org: overrideOrg, repo } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(deleteRepo, { path: { org, repo } });
      },
      syncUpstream: async (input: ReposSyncUpstreamInput): Promise<SyncUpstreamResponse> => {
        const { org: overrideOrg, repo, ...body } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(syncUpstream, { path: { org, repo }, body });
      },
      getUpstreamSync: async (input: ReposGetUpstreamSyncInput): Promise<GetRepoUpstreamSyncResponse> => {
        const { org: overrideOrg, repo, syncId } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(getRepoUpstreamSync, { path: { org, repo, syncId } });
      },
      listUpstreamSyncs: async (input: ReposListUpstreamSyncsInput): Promise<ListRepoUpstreamSyncsResponse> => {
        const { org: overrideOrg, repo, ...query } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(listRepoUpstreamSyncs, { path: { org, repo }, query });
      },
    },
    content: {
      get: async (input: ContentGetInput): Promise<GetContentResponse> => {
        const { org: overrideOrg, repo, ...query } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(getContent, { path: { org, repo }, query });
      },
    },
    bookmarks: {
      list: async (input: BookmarksListInput): Promise<ListBookmarksResponse> => {
        const { org: overrideOrg, repo, ...query } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(listBookmarks, { path: { org, repo }, query });
      },
      get: async (input: BookmarksGetInput): Promise<GetBookmarkResponse> => {
        const { org: overrideOrg, repo, bookmark } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(getBookmark, { path: { org, repo, bookmark } });
      },
      create: async (input: BookmarksCreateInput): Promise<CreateBookmarkResponse> => {
        const { org: overrideOrg, repo, ...body } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(createBookmark, { path: { org, repo }, body });
      },
      delete: async (input: BookmarksDeleteInput): Promise<DeleteBookmarkResponse> => {
        const { org: overrideOrg, repo, bookmark } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(deleteBookmark, { path: { org, repo, bookmark } });
      },
      move: async (input: BookmarksMoveInput): Promise<MoveBookmarkResponse> => {
        const { org: overrideOrg, repo, bookmark, ...body } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(moveBookmark, { path: { org, repo, bookmark }, body });
      },
      merge: async (input: BookmarksMergeInput): Promise<MergeBookmarkResponse> => {
        const { org: overrideOrg, repo, ...body } = input;
        const prepared = prepareCommitRequest(body, requestAttribution);
        const org = await resolveOrg(overrideOrg);
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
      list: async (input: ChangesListInput): Promise<ListChangesResponse> => {
        const { org: overrideOrg, repo, ...query } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(listChanges, { path: { org, repo }, query });
      },
      create: async (input: ChangesCreateInput): Promise<CreateChangeResponse> => {
        const { org: overrideOrg, repo, ...body } = input;
        const prepared = prepareCommitRequest(body, requestAttribution);
        const org = await resolveOrg(overrideOrg);
        return restClient.request(
          createChange,
          { path: { org, repo }, body: prepared.body as CreateChangeData['body'] },
          prepared.credential
        );
      },
      get: async (input: ChangesGetInput): Promise<GetChangeResponse> => {
        const { org: overrideOrg, repo, change_id: changeId } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(getChange, { path: { org, repo, change_id: changeId } });
      },
      patch: async (input: ChangesPatchInput): Promise<UpdateChangeResponse> => {
        const { org: overrideOrg, repo, change_id: changeId, ...body } = input;
        const preserveExistingAuthors = Array.isArray(body.resolutions) && body.resolutions.length > 0;
        const prepared = prepareCommitRequest(body, requestAttribution, preserveExistingAuthors);
        const org = await resolveOrg(overrideOrg);
        return restClient.request(
          updateChange,
          {
            path: { org, repo, change_id: changeId },
            body: prepared.body as UpdateChangeData['body'],
          },
          prepared.credential
        );
      },
    },
    diffs: {
      get: async (input: DiffsGetInput): Promise<GetDiffResponse> => {
        const { org: overrideOrg, repo, ...query } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(getDiff, { path: { org, repo }, query });
      },
    },
    webhookTargets: {
      list: async (input: WebhookTargetsListInput = {}): Promise<ListWebhookTargetsResponse> => {
        const { org: overrideOrg, ...query } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(listWebhookTargets, { path: { org }, query });
      },
      create: async (input: WebhookTargetsCreateInput): Promise<CreateWebhookTargetResponse> => {
        const { org: overrideOrg, ...body } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(createWebhookTarget, { path: { org }, body });
      },
      update: async (input: WebhookTargetsUpdateInput): Promise<UpdateWebhookTargetResponse> => {
        const { org: overrideOrg, webhookTargetId, ...body } = input;
        const org = await resolveOrg(overrideOrg);
        return restClient.request(updateWebhookTarget, { path: { org, webhookTargetId }, body });
      },
      delete: async (input: WebhookTargetsDeleteInput): Promise<DeleteWebhookTargetResponse> => {
        const { org: overrideOrg, webhookTargetId } = input;
        const org = await resolveOrg(overrideOrg);
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
