import type { WhoamiResponse } from '@mesadev/rest';
import { z } from 'zod';
import {
  normalizeSigningKeyAuthors,
  signAccessToken,
  signPrivateKeyAccessToken,
  toApiRepositoryRestriction,
  toSignerRepositoryRestriction,
} from './api/access-token.js';
import { createRestClient, type RestClient } from './api/client.js';
import {
  type ApiResources,
  createApiResources,
  type FixedTokenBookmarksMergeInput,
  type FixedTokenChangesCreateInput,
  type FixedTokenChangesPatchInput,
  type PrivateKeyBookmarksMergeInput,
  type PrivateKeyChangesCreateInput,
  type PrivateKeyChangesPatchInput,
  type TokensCreateInput,
  type TokensCreateLegacyInput,
  type TokensCreatePrivateKeyInput,
  type TokensCreateResponse,
} from './api/resources.js';
import { looksLikePrivateKey } from './api/credentials.js';
import { parsePrivateKey, type PrivateKeyCredential } from './api/signing-key.js';
import { createLayout, type Layout, type LayoutSpec, type Repo } from './fs/layout.js';
import {
  MesaFileSystem,
  type MesaFileSystemConfig,
  type RepoConfig,
  type TelemetryConfig,
} from './fs/mesa-file-system.js';
import { InvalidApiUrlError, InvalidOptionsError, MissingCredentialError, OrgResolutionError } from './lib/errors.js';

const DEFAULT_API_URL = 'https://api.mesa.dev/v1';
const API_KEY_ENV_VAR = 'MESA_API_KEY';
const PRIVATE_KEY_ENV_VAR = 'MESA_PRIVATE_KEY';
const ACCESS_TOKEN_ORG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Historical `tokens.create()` default and least-authority MesaFS mount scopes. */
const DEFAULT_TOKEN_SCOPES: ['read', 'write'] = ['read', 'write'];
const authSchema = z.union([
  z.strictObject({ privateKey: z.string().trim().min(1) }),
  z.strictObject({ accessToken: z.string().trim().min(1) }),
]);

type ResolvedCredential =
  | { kind: 'apiKey'; value: string }
  | { kind: 'privateKey'; value: PrivateKeyCredential }
  | {
      kind: 'accessToken';
      value: string;
      org: string;
    };

function getEnvVar(name: string): string | undefined {
  if (typeof process === 'undefined') {
    return undefined;
  }

  return process.env[name]?.trim();
}

function normalizeUrl(input: string): string {
  if (looksLikePrivateKey(input)) {
    throw new InvalidApiUrlError('Mesa private keys cannot be used as URLs');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new InvalidApiUrlError(input);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InvalidApiUrlError(input);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function normalizeBearerCredential(credential: string): string {
  const normalized = credential.trim();
  if (normalized.length === 0) {
    throw new InvalidOptionsError('Bearer credentials must be non-empty strings.');
  }
  if (looksLikePrivateKey(normalized)) {
    throw new InvalidOptionsError(
      'Received a Mesa private key where a bearer credential was expected. Configure it with `privateKey` or `auth.privateKey`.'
    );
  }
  if (/^Bearer\s+/i.test(normalized)) {
    throw new InvalidOptionsError('Pass only the token or API key value, without the `Bearer` scheme.');
  }
  return normalized;
}

function getAccessTokenOrg(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error();

    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { iss?: unknown };
    if (typeof payload.iss !== 'string' || !ACCESS_TOKEN_ORG_PATTERN.test(payload.iss)) throw new Error();
    return payload.iss;
  } catch {
    throw new InvalidOptionsError('Access tokens must be compact JWTs with a valid organization `iss` claim.');
  }
}

/**
 * Resolve one explicit or environment credential. Explicit credentials never
 * combine, and the existing API-key environment variable remains authoritative
 * during migration when both environment variables are set.
 */
function resolveCredential(options: MesaOptions): ResolvedCredential {
  const explicitCredentialCount = [options.apiKey, options.privateKey, options.auth].filter(
    (credential) => credential !== undefined
  ).length;
  if (explicitCredentialCount > 1) {
    throw new InvalidOptionsError('Pass exactly one of `apiKey`, `privateKey`, or `auth`.');
  }

  if (options.auth !== undefined) {
    const parsed = authSchema.safeParse(options.auth);
    if (!parsed.success) {
      throw new InvalidOptionsError('`auth` accepts exactly one non-empty `privateKey` or `accessToken`.');
    }
    if ('privateKey' in parsed.data) {
      return { kind: 'privateKey', value: parsePrivateKey(parsed.data.privateKey) };
    }
    const value = normalizeBearerCredential(parsed.data.accessToken);
    return {
      kind: 'accessToken',
      value,
      org: getAccessTokenOrg(value),
    };
  }

  if (options.privateKey !== undefined) {
    return { kind: 'privateKey', value: parsePrivateKey(options.privateKey) };
  }

  if (options.apiKey !== undefined) {
    return { kind: 'apiKey', value: normalizeBearerCredential(options.apiKey) };
  }

  const environmentApiKey = getEnvVar(API_KEY_ENV_VAR);
  if (environmentApiKey !== undefined) {
    return { kind: 'apiKey', value: normalizeBearerCredential(environmentApiKey) };
  }

  const environmentPrivateKey = getEnvVar(PRIVATE_KEY_ENV_VAR);
  if (environmentPrivateKey !== undefined) {
    return { kind: 'privateKey', value: parsePrivateKey(environmentPrivateKey) };
  }
  throw new MissingCredentialError(API_KEY_ENV_VAR, PRIVATE_KEY_ENV_VAR);
}

export type MesaAuth = z.infer<typeof authSchema>;

type PrivateKeyAuthors = NonNullable<TokensCreatePrivateKeyInput['authors']>;
type PrivateKeyMesaOptions = { privateKey: string } | { auth: { privateKey: string } };
type AccessTokenMesaOptions = { auth: { accessToken: string } };
type ApiKeyMesaOptions = { apiKey: string };
type CredentialSpecific<TOptions extends MesaOptions, TPrivateKey, TAccessToken, TApiKey, TDynamic> = [
  TOptions,
] extends [PrivateKeyMesaOptions]
  ? TPrivateKey
  : [TOptions] extends [AccessTokenMesaOptions]
    ? TAccessToken
    : [TOptions] extends [ApiKeyMesaOptions]
      ? TApiKey
      : TDynamic;

type PrivateKeyTokens = {
  create: (input: TokensCreatePrivateKeyInput) => Promise<TokensCreateResponse>;
};

type ApiKeyTokens = {
  create: (input?: TokensCreateLegacyInput) => Promise<TokensCreateResponse>;
};

type MesaTokens<TOptions extends MesaOptions> = CredentialSpecific<
  TOptions,
  PrivateKeyTokens,
  Omit<ApiResources['tokens'], 'create'>,
  ApiKeyTokens,
  ApiResources['tokens']
>;

type PrivateKeyBookmarks = Omit<ApiResources['bookmarks'], 'merge'> & {
  merge: (input: PrivateKeyBookmarksMergeInput) => ReturnType<ApiResources['bookmarks']['merge']>;
};

type FixedTokenBookmarks = Omit<ApiResources['bookmarks'], 'merge'> & {
  merge: (input: FixedTokenBookmarksMergeInput) => ReturnType<ApiResources['bookmarks']['merge']>;
};

type DynamicBookmarks = Omit<ApiResources['bookmarks'], 'merge'> & {
  merge: ApiResources['bookmarks']['merge'] & PrivateKeyBookmarks['merge'];
};

type MesaBookmarks<TOptions extends MesaOptions> = CredentialSpecific<
  TOptions,
  PrivateKeyBookmarks,
  FixedTokenBookmarks,
  ApiResources['bookmarks'],
  DynamicBookmarks
>;

type PrivateKeyChanges = Omit<ApiResources['changes'], 'create' | 'patch'> & {
  create: (input: PrivateKeyChangesCreateInput) => ReturnType<ApiResources['changes']['create']>;
  patch: (input: PrivateKeyChangesPatchInput) => ReturnType<ApiResources['changes']['patch']>;
};

type FixedTokenChanges = Omit<ApiResources['changes'], 'create' | 'patch'> & {
  create: (input: FixedTokenChangesCreateInput) => ReturnType<ApiResources['changes']['create']>;
  patch: (input: FixedTokenChangesPatchInput) => ReturnType<ApiResources['changes']['patch']>;
};

type DynamicChanges = Omit<ApiResources['changes'], 'create' | 'patch'> & {
  create: ApiResources['changes']['create'] & PrivateKeyChanges['create'];
  patch: ApiResources['changes']['patch'] & PrivateKeyChanges['patch'];
};

type MesaChanges<TOptions extends MesaOptions> = CredentialSpecific<
  TOptions,
  PrivateKeyChanges,
  FixedTokenChanges,
  ApiResources['changes'],
  DynamicChanges
>;

export interface MesaOptions {
  /** Long-lived API key (`mesa_...`) used directly for requests and to sign short-lived access tokens locally. */
  apiKey?: string;
  /** Organization-root Ed25519 private key used to sign REST request JWTs and `tokens.create()` locally. */
  privateKey?: string;
  /** Grouped private-key or signing-key access-token authentication. */
  auth?: MesaAuth;
  apiUrl?: string;
  vcsUrl?: string;
  org?: string;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  webhookSecret?: string;
}

interface FsMountBaseOptions {
  cache?: {
    diskCache?: { path: string; maxSizeBytes?: number };
  };
  telemetry?: TelemetryConfig;
  /**
   * Lifetime of the mount token, in seconds. API-key clients default to one
   * hour and allow up to 24 hours. Private-key clients default to 15 minutes
   * and allow up to four hours. There is no refresh; once the token expires,
   * the mount fails closed.
   */
  ttl?: number;
}

/**
 * Canonical mount profile: present exactly the listed repositories at their
 * `/org/repo` paths — no custom namespace, no whole-org enumeration. Tokens
 * are name-scoped and signed fully offline (no resolution round-trips
 * before the mount), and per-repo `mode: 'ro'` is enforced by the daemon.
 * Layouts mount through a definition instead: `mesa.fs({ layout }).mount()`.
 */
export interface FsMountReposOptions extends FsMountBaseOptions {
  /** Repos to mount at their canonical `/org/repo` paths. */
  repos: RepoConfig[];
  layout?: never;
}

/**
 * A layout definition bundle produced by calling `mesa.fs({ layout, ttl })`:
 * the prepared layout plus its scoped operations. The definition is the only
 * way to mount a layout or mint its token; its `ttl` is the lifetime of
 * every token minted from it, whether by `token()` or under the hood by
 * `mount()`.
 */
export interface FsLayoutDefinition {
  /** The prepared layout, built from the raw path map the definition was given. */
  layout(): Layout;
  /**
   * Mount this layout as the complete namespace, accepting the non-token
   * mount options (`cache`, `telemetry`). The mount's token lifetime is the
   * definition's `ttl`.
   */
  mount(options?: Omit<FsMountReposOptions, 'repos' | 'layout' | 'ttl'>): Promise<MesaFileSystem>;
  /**
   * Mint the layout-scoped, least-privilege access token: repositories
   * collected from every declaration and scoped by name, `['read']` when
   * every mode is `'ro'`, `['read', 'write']` otherwise, with the
   * definition's `ttl`.
   */
  token(): Promise<TokensCreateResponse>;
}

type AccessTokenFsLayoutDefinition = Omit<FsLayoutDefinition, 'token'>;
type PrivateKeyFsMountReposOptions = FsMountReposOptions & { authors: PrivateKeyAuthors };
type RuntimeFsMountReposOptions = FsMountReposOptions & { authors?: PrivateKeyAuthors };
type PrivateKeyFsLayoutOptions = { layout: LayoutSpec; ttl?: number; authors: PrivateKeyAuthors };
type RuntimeFsLayoutOptions = { layout: LayoutSpec; ttl?: number; authors?: PrivateKeyAuthors };
type AccessTokenFsLayoutOptions = { layout: LayoutSpec; authors?: never; ttl?: never };

type MesaFs<TOptions extends MesaOptions> = CredentialSpecific<
  TOptions,
  {
    (options: PrivateKeyFsLayoutOptions): FsLayoutDefinition;
    mount: (options: PrivateKeyFsMountReposOptions) => Promise<MesaFileSystem>;
  },
  {
    (options: AccessTokenFsLayoutOptions): AccessTokenFsLayoutDefinition;
    mount: (options: Omit<FsMountReposOptions, 'ttl'>) => Promise<MesaFileSystem>;
  },
  {
    (options: { layout: LayoutSpec; ttl?: number; authors?: never }): FsLayoutDefinition;
    mount: (options: FsMountReposOptions & { authors?: never }) => Promise<MesaFileSystem>;
  },
  {
    (options: RuntimeFsLayoutOptions): FsLayoutDefinition;
    mount: (options: RuntimeFsMountReposOptions) => Promise<MesaFileSystem>;
  }
>;

export class Mesa<const TOptions extends MesaOptions = MesaOptions> {
  /** The API key this client was constructed with, if it is an API-key client. */
  readonly apiKey: string | undefined;
  readonly apiUrl: string;
  readonly vcsUrl: string;
  readonly org: ApiResources['org'];
  readonly tokens: MesaTokens<TOptions>;
  readonly apiKeys: ApiResources['apiKeys'];
  readonly repos: ApiResources['repos'];
  readonly content: ApiResources['content'];
  readonly bookmarks: MesaBookmarks<TOptions>;
  readonly changes: MesaChanges<TOptions>;
  readonly diffs: ApiResources['diffs'];
  readonly webhookTargets: ApiResources['webhookTargets'];
  readonly webhooks: ApiResources['webhooks'];
  readonly fs: MesaFs<TOptions>;

  private readonly credential: ResolvedCredential;
  private readonly restClient: RestClient;
  private readonly orgResolutionPromise: Promise<string>;
  private readonly whoAmIResolutionPromise: Promise<WhoamiResponse> | null;
  private cachedOrgSlug: string | null = null;
  private cachedWhoAmI: WhoamiResponse | null = null;
  private cachedKeyId: string | null = null;
  private keyIdResolutionPromise: Promise<string> | null = null;

  constructor(options: TOptions = {} as TOptions) {
    if ((options as MesaOptions & { authors?: unknown }).authors !== undefined) {
      throw new InvalidOptionsError(
        'The `authors` option is not accepted by the Mesa constructor. Pass authors to the operation instead.'
      );
    }
    const resolvedCredential = resolveCredential(options);
    this.credential = resolvedCredential;

    this.apiKey = resolvedCredential.kind === 'apiKey' ? resolvedCredential.value : undefined;
    this.apiUrl = normalizeUrl(options.apiUrl?.trim() || DEFAULT_API_URL);
    this.vcsUrl = normalizeUrl(options.vcsUrl?.trim() || new URL(this.apiUrl).origin);
    if (options.userAgent && looksLikePrivateKey(options.userAgent)) {
      throw new InvalidOptionsError('User-agent metadata must not contain Mesa private key material.');
    }
    const providedOrg = options.org?.trim();
    if (providedOrg && looksLikePrivateKey(providedOrg)) {
      throw new InvalidOptionsError('Organization options must not contain Mesa private key material.');
    }
    if (resolvedCredential.kind === 'privateKey' && providedOrg && providedOrg !== resolvedCredential.value.org) {
      throw new InvalidOptionsError('The `org` option must match the organization encoded in the private key.');
    }
    if (resolvedCredential.kind === 'accessToken' && providedOrg && providedOrg !== resolvedCredential.org) {
      throw new InvalidOptionsError('The `org` option must match the organization encoded in the access token.');
    }

    this.restClient = createRestClient({
      credential:
        resolvedCredential.kind === 'privateKey'
          ? () => signPrivateKeyAccessToken({ credential: resolvedCredential.value }).token
          : resolvedCredential.value,
      apiUrl: this.apiUrl,
      fetch: options.fetch,
      userAgent: options.userAgent,
    });

    if (resolvedCredential.kind === 'privateKey') {
      this.cachedOrgSlug = resolvedCredential.value.org;
      this.orgResolutionPromise = Promise.resolve(resolvedCredential.value.org);
      this.whoAmIResolutionPromise = null;
    } else if (resolvedCredential.kind === 'accessToken') {
      this.cachedOrgSlug = resolvedCredential.org;
      this.orgResolutionPromise = Promise.resolve(resolvedCredential.org);
      this.whoAmIResolutionPromise = null;
    } else if (providedOrg) {
      this.cachedOrgSlug = providedOrg;
      this.orgResolutionPromise = Promise.resolve(providedOrg);
      this.whoAmIResolutionPromise = null;
    } else {
      const whoAmIPromise = this.fetchWhoAmI();
      this.whoAmIResolutionPromise = whoAmIPromise;
      this.orgResolutionPromise = this.resolveOrgFromWhoAmI(whoAmIPromise);
      this.orgResolutionPromise.catch(() => undefined);
    }

    const resources = createApiResources({
      restClient: this.restClient,
      resolveOrg: (org) => this.resolveOrg(org),
      webhookSecret: options.webhookSecret,
      signToken: (input) => this.signToken(input),
      requestAttribution:
        resolvedCredential.kind === 'privateKey'
          ? {
              kind: 'private-key',
              sign: (authors) => signPrivateKeyAccessToken({ credential: resolvedCredential.value, authors }).token,
            }
          : resolvedCredential.kind === 'accessToken'
            ? { kind: 'fixed-token' }
            : { kind: 'request' },
    });

    this.org = resources.org;
    this.tokens = resources.tokens as MesaTokens<TOptions>;
    this.apiKeys = resources.apiKeys;
    this.repos = resources.repos;
    this.content = resources.content;
    this.bookmarks = resources.bookmarks as MesaBookmarks<TOptions>;
    this.changes = resources.changes as MesaChanges<TOptions>;
    this.diffs = resources.diffs;
    this.webhookTargets = resources.webhookTargets;
    this.webhooks = resources.webhooks;

    // Layout minting and mounting are reachable only through a definition;
    // the layout carries no organization, so the client's org scopes both.
    const mintLayoutToken = async (
      layout: Layout,
      ttl: number | undefined,
      authors: PrivateKeyAuthors | undefined
    ): Promise<TokensCreateResponse> => {
      // Run the core structural validator before minting so a malformed
      // layout fails here with the mount's own error. Repository names
      // resolve only at mount time — a layout naming a nonexistent
      // repository still mints a token and fails at mount.
      MesaFileSystem.validateLayout(layout.toString());
      const { org, scopes, repos } = await this.deriveLayoutTokenRequest(layout, 'mesa.fs({ layout }).token()');
      const tokenInput = { org, scopes, repos, ttl_seconds: ttl };
      return resources.tokens.create(
        this.credential.kind === 'privateKey' ? { ...tokenInput, authors: authors! } : tokenInput
      );
    };

    const mountLayout = async (
      definitionLayout: Layout,
      ttl: number | undefined,
      authors: PrivateKeyAuthors | undefined,
      options: Omit<FsMountReposOptions, 'repos' | 'layout' | 'ttl'>
    ): Promise<MesaFileSystem> => {
      const { layout, org, scopes, repos } = await this.deriveLayoutTokenRequest(
        definitionLayout,
        'mesa.fs({ layout }).mount()'
      );
      if (this.credential.kind === 'accessToken') {
        return this.createFs(org, options, this.credential.value, layout);
      }

      // Mint a single access token for the mount's whole lifetime. There is
      // no refresh and no credential hot-swap, so when the token expires the
      // mount expires with it.
      const tokenInput = { org, scopes, repos, ttl_seconds: ttl };
      const token =
        this.credential.kind === 'privateKey'
          ? signPrivateKeyAccessToken({
              credential: this.credential.value,
              authors: authors!,
              scopes: tokenInput.scopes,
              repos: tokenInput.repos,
              ttlSeconds: tokenInput.ttl_seconds,
            }).token
          : (await resources.tokens.create(tokenInput)).token;
      return this.createFs(org, options, token, layout);
    };

    const defineLayout = ({ layout, ttl, authors: authorsInput }: RuntimeFsLayoutOptions): FsLayoutDefinition => {
      if (layout === undefined) {
        // Catches untyped callers passing a bare path map instead of options.
        throw new InvalidOptionsError("mesa.fs() requires a 'layout'");
      }
      const authors = authorsInput === undefined ? undefined : normalizeSigningKeyAuthors(authorsInput);
      if (this.credential.kind === 'privateKey' && authors === undefined) {
        throw new InvalidOptionsError('Private-key layout definitions require a nonempty `authors` option.');
      }
      if (this.credential.kind !== 'privateKey' && authors !== undefined) {
        throw new InvalidOptionsError('Layout authors require a private-key client.');
      }
      if (this.credential.kind === 'accessToken' && ttl !== undefined) {
        throw new InvalidOptionsError('The lifetime of an existing access token cannot be changed.');
      }
      // Built eagerly, so an invalid record fails here at definition time.
      const prepared = createLayout(layout);
      const definition = {
        layout: () => prepared,
        mount: (options = {}) => mountLayout(prepared, ttl, authors, options),
        token: () => mintLayoutToken(prepared, ttl, authors),
      };
      return definition;
    };
    this.fs = Object.assign(defineLayout, {
      /**
       * Canonical mount profile: mount exactly the listed repositories at
       * their `/org/repo` paths with explicit repo visibility, a name-scoped
       * token, and offline signing with no name→id resolution round-trip.
       * Layouts mount through a definition: `mesa.fs({ layout }).mount()`.
       */
      mount: async (fsOptions: RuntimeFsMountReposOptions): Promise<MesaFileSystem> => {
        const authors = fsOptions.authors === undefined ? undefined : normalizeSigningKeyAuthors(fsOptions.authors);
        if (this.credential.kind === 'privateKey' && authors === undefined) {
          throw new InvalidOptionsError('Private-key mounts require a nonempty `authors` option.');
        }
        if (this.credential.kind !== 'privateKey' && authors !== undefined) {
          throw new InvalidOptionsError('Mount authors require a private-key client.');
        }
        const canonicalRepos = fsOptions.repos;
        if (canonicalRepos === undefined) {
          // Untyped callers may still pass the retired layout form.
          throw new InvalidOptionsError(
            'mesa.fs.mount() mounts the canonical repos profile; mount a layout with mesa.fs({ layout }).mount()'
          );
        }
        if (canonicalRepos.length === 0) {
          throw new InvalidOptionsError('mesa.fs.mount() requires at least one repo');
        }
        const org = await this.resolveOrg();
        if (this.credential.kind === 'accessToken') {
          if (fsOptions.ttl !== undefined) {
            throw new InvalidOptionsError(
              'The lifetime of an existing access token cannot be changed by `fs.mount()`.'
            );
          }
          return this.createFs(org, fsOptions, this.credential.value);
        }
        const tokenInput = {
          org,
          scopes: DEFAULT_TOKEN_SCOPES,
          repos: canonicalRepos.map((r) => `${org}/${r.name}`),
          ttl_seconds: fsOptions.ttl,
        };
        const token =
          this.credential.kind === 'privateKey'
            ? signPrivateKeyAccessToken({
                credential: this.credential.value,
                authors: authors!,
                scopes: tokenInput.scopes,
                repos: tokenInput.repos,
                ttlSeconds: tokenInput.ttl_seconds,
              }).token
            : (await resources.tokens.create(tokenInput)).token;
        return this.createFs(org, fsOptions, token);
      },
    }) as MesaFs<TOptions>;
  }

  private createFs(
    org: string,
    fsOptions: Omit<FsMountReposOptions, 'repos'> & { repos?: RepoConfig[] },
    credential: string,
    layout?: Layout
  ): MesaFileSystem {
    const base = {
      org,
      credential,
      cache: fsOptions.cache,
      apiBaseUrl: this.apiUrl,
      vcsUrl: this.vcsUrl,
      telemetry: fsOptions.telemetry,
    };
    // The canonical repos profile keeps explicit repo visibility; the layout
    // profile presents exactly the composed workspace, replacing the
    // canonical browse tree, so per-repo visibility does not apply.
    const config: MesaFileSystemConfig =
      layout !== undefined
        ? { ...base, repos: [], layout, mountedRepos: 'all' }
        : { ...base, repos: fsOptions.repos ?? [], mountedRepos: (fsOptions.repos ?? []).map((repo) => repo.name) };
    return MesaFileSystem.create(config);
  }

  /**
   * Derive the least-privilege token request for a layout: its repositories
   * collected from every declaration and scoped by name (signed offline, no
   * repository lookup), plus the narrowest scopes the declared modes allow.
   * Shared by the definition's `mount()` and `token()` so the derivation
   * exists exactly once.
   */
  private async deriveLayoutTokenRequest(
    layout: Layout,
    caller: string
  ): Promise<{ layout: Layout; org: string; scopes: string[]; repos: string[] }> {
    // The layout carries no organization of its own; the client's
    // organization scopes the token.
    const org = await this.resolveOrg();
    const declarations: Repo[] = [];
    const visit = (entries: Record<string, Repo | Repo[]>): void => {
      for (const entry of Object.values(entries)) {
        for (const declaration of Array.isArray(entry) ? entry : [entry]) {
          declarations.push(declaration);
          if (declaration.subPaths) visit(declaration.subPaths);
        }
      }
    };
    // The spec is a pure path map: every key is a declaration entry.
    visit(layout.spec as Record<string, Repo | Repo[]>);
    if (declarations.length === 0) {
      throw new InvalidOptionsError(`${caller} requires at least one layout repository`);
    }
    const repos = [...new Set(declarations.map((declaration) => `${org}/${declaration.name}`))];
    const scopes = declarations.some((declaration) => declaration.mode === 'rw') ? [...DEFAULT_TOKEN_SCOPES] : ['read'];
    return { layout, org, scopes, repos };
  }

  async resolveOrg(org?: string): Promise<string> {
    const requestedOrg = org?.trim();
    if (requestedOrg && looksLikePrivateKey(requestedOrg)) {
      throw new InvalidOptionsError('Organization options must not contain Mesa private key material.');
    }
    if (this.credential.kind === 'privateKey') {
      if (requestedOrg && requestedOrg !== this.credential.value.org) {
        throw new InvalidOptionsError('Private-key clients are bound to the organization encoded in the key.');
      }
      return this.credential.value.org;
    }
    if (this.credential.kind === 'accessToken') {
      if (requestedOrg && requestedOrg !== this.credential.org) {
        throw new InvalidOptionsError('Access-token clients are bound to the organization encoded in the token.');
      }
      return this.credential.org;
    }
    if (requestedOrg) {
      return requestedOrg;
    }

    if (this.cachedOrgSlug) {
      return this.cachedOrgSlug;
    }

    return this.orgResolutionPromise;
  }

  async whoami(): Promise<WhoamiResponse> {
    if (this.cachedWhoAmI) {
      return this.cachedWhoAmI;
    }

    try {
      const promise = this.whoAmIResolutionPromise ?? this.fetchWhoAmI();
      return await promise;
    } catch (error) {
      throw new OrgResolutionError('Unable to resolve caller identity from /whoami', { cause: error });
    }
  }

  private async fetchWhoAmI(): Promise<WhoamiResponse> {
    const whoami = await this.restClient.whoami();
    this.cachedWhoAmI = whoami;
    this.cachedOrgSlug = whoami.org.slug;
    if (whoami.key_id) {
      this.cachedKeyId = whoami.key_id;
    }
    return whoami;
  }

  /**
   * Resolve and cache this client's API key id, needed to build the access
   * token `kid` header. Sourced from GET /whoami, which returns the id of the
   * key the request authenticated with. Lazily fetched and cached for the life
   * of the client.
   */
  private async resolveKeyId(): Promise<string> {
    if (this.cachedKeyId) {
      return this.cachedKeyId;
    }

    // Dedupe concurrent signs: without this, each in-flight call would kick off
    // its own /whoami. Reuse the constructor's whoami when present (no explicit
    // org), otherwise share a single lazy fetch across all callers.
    this.keyIdResolutionPromise ??= (this.whoAmIResolutionPromise ?? this.fetchWhoAmI())
      .then((whoami) => {
        if (!whoami.key_id) {
          throw new OrgResolutionError('Unable to resolve API key id from /whoami; cannot sign access tokens.');
        }
        this.cachedKeyId = whoami.key_id;
        return whoami.key_id;
      })
      .catch((error) => {
        // Allow a later sign to retry rather than caching the failure forever.
        this.keyIdResolutionPromise = null;
        throw error;
      });

    return this.keyIdResolutionPromise;
  }

  /** Sign an access token locally from the credential this client holds. */
  private async signToken(input: TokensCreateInput): Promise<TokensCreateResponse> {
    if (this.credential.kind === 'privateKey') {
      if (input.authors === undefined) {
        throw new InvalidOptionsError('Private-key tokens require a nonempty `authors` option.');
      }
      const signed = signPrivateKeyAccessToken({
        credential: this.credential.value,
        authors: input.authors,
        scopes: input.scopes ?? [...DEFAULT_TOKEN_SCOPES],
        ttlSeconds: input.ttl_seconds,
        ...toSignerRepositoryRestriction(input),
      });
      return {
        token: signed.token,
        expires_at: signed.expiresAt,
        scopes: signed.scopes,
        ...toApiRepositoryRestriction(signed),
      };
    }

    if (this.credential.kind === 'accessToken') {
      throw new InvalidOptionsError(
        'Access-token clients cannot mint another access token. Use an API key or private key.'
      );
    }

    if (input.authors !== undefined) {
      throw new InvalidOptionsError('Private-key access tokens can only be minted with a private key.');
    }
    const keyId = await this.resolveKeyId();
    const repositoryRestriction = toSignerRepositoryRestriction(input);
    const signed = signAccessToken({
      apiKeyId: keyId,
      rawApiKey: this.credential.value,
      scopes: input.scopes ?? [...DEFAULT_TOKEN_SCOPES],
      ttlSeconds: input.ttl_seconds,
      ...repositoryRestriction,
    });

    return {
      token: signed.token,
      expires_at: signed.expiresAt,
      scopes: signed.scopes,
      ...toApiRepositoryRestriction(signed),
    };
  }

  private async resolveOrgFromWhoAmI(whoAmIPromise: Promise<WhoamiResponse>): Promise<string> {
    try {
      const whoami = await whoAmIPromise;
      return whoami.org.slug;
    } catch (error) {
      throw new OrgResolutionError(
        'Unable to resolve default organization from /whoami. Provide `org` per call or verify your credential scopes.',
        { cause: error }
      );
    }
  }
}
