import type { WhoamiResponse } from '@mesadev/rest';
import { z } from 'zod';
import {
  normalizeSigningKeyAuthors,
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
  type TokensCreatePrivateKeyInput,
  type TokensCreateResponse,
} from './api/resources.js';
import { looksLikePrivateKey } from './api/credentials.js';
import { parsePrivateKey, type PrivateKeyCredential } from './api/signing-key.js';
import { createLayout, type Layout, type LayoutSpec, type Repo } from './fs/layout.js';
import { MesaFileSystem, type MesaFileSystemConfig, type TelemetryConfig } from './fs/mesa-file-system.js';
import { InvalidApiUrlError, InvalidOptionsError, MissingCredentialError, OrgResolutionError } from './lib/errors.js';

const DEFAULT_API_URL = 'https://api.mesa.dev/v1';
const PRIVATE_KEY_ENV_VAR = 'MESA_PRIVATE_KEY';
const ACCESS_TOKEN_ORG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Historical `tokens.create()` default and least-authority MesaFS mount scopes. */
const DEFAULT_TOKEN_SCOPES: ['read', 'write'] = ['read', 'write'];
const authSchema = z.union([
  z.strictObject({ privateKey: z.string().trim().min(1) }),
  z.strictObject({ accessToken: z.string().trim().min(1) }),
]);

type ResolvedCredential =
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
    throw new InvalidOptionsError('Pass only the access token value, without the `Bearer` scheme.');
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

/** Resolve one explicit or environment credential. */
function resolveCredential(options: MesaOptions): ResolvedCredential {
  const explicitCredentialCount = [options.privateKey, options.auth].filter(
    (credential) => credential !== undefined
  ).length;
  if (explicitCredentialCount > 1) {
    throw new InvalidOptionsError('Pass exactly one of `privateKey` or `auth`.');
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

  const environmentPrivateKey = getEnvVar(PRIVATE_KEY_ENV_VAR);
  if (environmentPrivateKey !== undefined) {
    return { kind: 'privateKey', value: parsePrivateKey(environmentPrivateKey) };
  }
  throw new MissingCredentialError(
    'Missing credential. Pass `privateKey` or `auth`, or set `MESA_PRIVATE_KEY` in your environment.'
  );
}

export type MesaAuth = z.infer<typeof authSchema>;

type PrivateKeyAuthors = NonNullable<TokensCreatePrivateKeyInput['authors']>;
type PrivateKeyMesaOptions = { privateKey: string } | { auth: { privateKey: string } };
type AccessTokenMesaOptions = { auth: { accessToken: string } };
type CredentialSpecific<TOptions extends MesaOptions, TPrivateKey, TAccessToken, TDynamic> = [TOptions] extends [
  PrivateKeyMesaOptions,
]
  ? TPrivateKey
  : [TOptions] extends [AccessTokenMesaOptions]
    ? TAccessToken
    : TDynamic;

type PrivateKeyTokens = {
  create: (input: TokensCreatePrivateKeyInput) => Promise<TokensCreateResponse>;
};

type MesaTokens<TOptions extends MesaOptions> = CredentialSpecific<
  TOptions,
  PrivateKeyTokens,
  Omit<ApiResources['tokens'], 'create'>,
  ApiResources['tokens']
>;

type PrivateKeyBookmarks = Omit<ApiResources['bookmarks'], 'merge'> & {
  merge: (input: PrivateKeyBookmarksMergeInput) => ReturnType<ApiResources['bookmarks']['merge']>;
};

type FixedTokenBookmarks = Omit<ApiResources['bookmarks'], 'merge'> & {
  merge: (input: FixedTokenBookmarksMergeInput) => ReturnType<ApiResources['bookmarks']['merge']>;
};

type DynamicBookmarks = Omit<ApiResources['bookmarks'], 'merge'> & {
  merge: PrivateKeyBookmarks['merge'] & FixedTokenBookmarks['merge'];
};

type MesaBookmarks<TOptions extends MesaOptions> = CredentialSpecific<
  TOptions,
  PrivateKeyBookmarks,
  FixedTokenBookmarks,
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
  create: PrivateKeyChanges['create'] & FixedTokenChanges['create'];
  patch: PrivateKeyChanges['patch'] & FixedTokenChanges['patch'];
};

type MesaChanges<TOptions extends MesaOptions> = CredentialSpecific<
  TOptions,
  PrivateKeyChanges,
  FixedTokenChanges,
  DynamicChanges
>;

export interface MesaOptions {
  /** Organization-root Ed25519 private key used to sign REST request JWTs and `tokens.create()` locally. */
  privateKey?: string;
  /** Grouped private-key or signing-key access-token authentication. */
  auth?: MesaAuth;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  webhookSecret?: string;
}

type RejectUnknownMesaOptions<TOptions extends MesaOptions> =
  Exclude<keyof TOptions, keyof MesaOptions> extends never ? [] : [invalidOptions: never];

/** Non-token options accepted by {@link FsLayoutDefinition.mount}. */
export interface FsMountRuntimeOptions {
  cache?: {
    diskCache?: { path: string; maxSizeBytes?: number };
  };
  telemetry?: TelemetryConfig;
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
  mount(options?: FsMountRuntimeOptions): Promise<MesaFileSystem>;
  /**
   * Mint the layout-scoped, least-privilege access token: repositories
   * collected from every declaration and scoped by name, `['read']` when
   * every mode is `'ro'`, `['read', 'write']` otherwise, with the
   * definition's `ttl`.
   */
  token(): Promise<TokensCreateResponse>;
}

type AccessTokenFsLayoutDefinition = Omit<FsLayoutDefinition, 'token'>;
type PrivateKeyFsLayoutOptions = {
  layout: LayoutSpec;
  /**
   * Lifetime of every token the definition mints, in seconds. Private-key
   * clients default to 15 minutes and allow up to four hours. There is no
   * refresh; once the token expires, the mount fails closed.
   */
  ttl?: number;
  authors: PrivateKeyAuthors;
};
type RuntimeFsLayoutOptions = {
  layout: LayoutSpec;
  ttl?: number;
  authors?: PrivateKeyAuthors;
};
type AccessTokenFsLayoutOptions = { layout: LayoutSpec; authors?: never; ttl?: never };

type MesaFs<TOptions extends MesaOptions> = CredentialSpecific<
  TOptions,
  (options: PrivateKeyFsLayoutOptions) => FsLayoutDefinition,
  (options: AccessTokenFsLayoutOptions) => AccessTokenFsLayoutDefinition,
  (options: RuntimeFsLayoutOptions) => FsLayoutDefinition
>;

export class Mesa<const TOptions extends MesaOptions = MesaOptions> {
  readonly apiUrl: string;
  readonly org: ApiResources['org'];
  readonly tokens: MesaTokens<TOptions>;
  /**
   * @deprecated Manage API keys from the dashboard and authenticate new
   * integrations with private keys instead. API keys remain supported for
   * existing integrations.
   */
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
  private cachedWhoAmI: WhoamiResponse | null = null;

  constructor(options: TOptions = {} as TOptions, ..._invalidOptions: RejectUnknownMesaOptions<TOptions>) {
    if ((options as MesaOptions & { authors?: unknown }).authors !== undefined) {
      throw new InvalidOptionsError(
        'The `authors` option is not accepted by the Mesa constructor. Pass authors to the operation instead.'
      );
    }
    if ('apiKey' in (options as MesaOptions & { apiKey?: unknown })) {
      throw new InvalidOptionsError(
        'The `apiKey` option is no longer supported. Use `privateKey` or `auth.accessToken`.'
      );
    }
    const resolvedCredential = resolveCredential(options);
    this.credential = resolvedCredential;

    this.apiUrl = normalizeUrl(options.apiUrl?.trim() || DEFAULT_API_URL);
    if (options.userAgent && looksLikePrivateKey(options.userAgent)) {
      throw new InvalidOptionsError('User-agent metadata must not contain Mesa private key material.');
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

    const orgSlug = resolvedCredential.kind === 'privateKey' ? resolvedCredential.value.org : resolvedCredential.org;
    const resources = createApiResources({
      restClient: this.restClient,
      orgSlug,
      webhookSecret: options.webhookSecret,
      signToken: (input) => this.signToken(input),
      requestAttribution:
        resolvedCredential.kind === 'privateKey'
          ? {
              kind: 'private-key',
              sign: (authors) => signPrivateKeyAccessToken({ credential: resolvedCredential.value, authors }).token,
            }
          : { kind: 'fixed-token' },
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
      const { scopes, repos } = this.deriveLayoutTokenRequest(layout, 'mesa.fs({ layout }).token()');
      const tokenInput = { scopes, repos, ttl_seconds: ttl };
      return resources.tokens.create({ ...tokenInput, authors: authors! });
    };

    const mountLayout = async (
      definitionLayout: Layout,
      ttl: number | undefined,
      authors: PrivateKeyAuthors | undefined,
      options: FsMountRuntimeOptions
    ): Promise<MesaFileSystem> => {
      // Untyped callers migrating from the removed mesa.fs.mount() may still
      // pass definition options here; dropping them silently would shorten
      // the token lifetime (or skip authors) with no warning.
      if ('ttl' in options) {
        throw new InvalidOptionsError(
          'mount() does not accept `ttl`. Set it on the definition: mesa.fs({ layout, ttl })'
        );
      }
      if ('authors' in options) {
        throw new InvalidOptionsError(
          'mount() does not accept `authors`. Set them on the definition: mesa.fs({ layout, authors })'
        );
      }
      const { layout, org, scopes, repos } = this.deriveLayoutTokenRequest(
        definitionLayout,
        'mesa.fs({ layout }).mount()'
      );
      if (this.credential.kind === 'accessToken') {
        return this.createFs(org, options, this.credential.value, layout);
      }

      // Mint a single access token for the mount's whole lifetime. There is
      // no refresh and no credential hot-swap, so when the token expires the
      // mount expires with it.
      const tokenInput = { scopes, repos, ttl_seconds: ttl };
      const token = signPrivateKeyAccessToken({
        credential: this.credential.value,
        authors: authors!,
        scopes: tokenInput.scopes,
        repos: tokenInput.repos,
        ttlSeconds: tokenInput.ttl_seconds,
      }).token;
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
        mount: (options: FsMountRuntimeOptions = {}) => mountLayout(prepared, ttl, authors, options),
        token: () => mintLayoutToken(prepared, ttl, authors),
      };
      return definition;
    };
    this.fs = defineLayout as MesaFs<TOptions>;
  }

  private createFs(org: string, fsOptions: FsMountRuntimeOptions, credential: string, layout: Layout): MesaFileSystem {
    const config: MesaFileSystemConfig = {
      org,
      credential,
      cache: fsOptions.cache,
      apiBaseUrl: this.apiUrl,
      telemetry: fsOptions.telemetry,
      // Layout mounts present exactly the composed workspace, replacing the
      // canonical browse tree.
      repos: [],
      layout,
      mountedRepos: 'all',
    };
    return MesaFileSystem.create(config);
  }

  /**
   * Derive the least-privilege token request for a layout: its repositories
   * collected from every declaration and scoped by name (signed offline, no
   * repository lookup), plus the narrowest scopes the declared modes allow.
   * Shared by the definition's `mount()` and `token()` so the derivation
   * exists exactly once.
   */
  private deriveLayoutTokenRequest(
    layout: Layout,
    caller: string
  ): { layout: Layout; org: string; scopes: string[]; repos: string[] } {
    // The layout carries no organization of its own; the client's
    // organization scopes the token.
    const org = this.org.slug;
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
    // Run the core structural validator before any token is minted or signed,
    // for token() and mount() alike, so a malformed layout fails here with
    // the mount's own error. Repository names resolve only at mount time; a
    // layout naming a nonexistent repository still derives a request and
    // fails at mount.
    MesaFileSystem.validateLayout(layout.toString());
    const repos = [...new Set(declarations.map((declaration) => `${org}/${declaration.name}`))];
    const scopes = declarations.some((declaration) => declaration.mode === 'rw') ? [...DEFAULT_TOKEN_SCOPES] : ['read'];
    return { layout, org, scopes, repos };
  }

  async whoami(): Promise<WhoamiResponse> {
    if (this.cachedWhoAmI) {
      return this.cachedWhoAmI;
    }

    try {
      return await this.fetchWhoAmI();
    } catch (error) {
      throw new OrgResolutionError('Unable to resolve caller identity from /whoami', { cause: error });
    }
  }

  private async fetchWhoAmI(): Promise<WhoamiResponse> {
    const whoami = await this.restClient.whoami();
    this.cachedWhoAmI = whoami;
    return whoami;
  }

  /** Sign an access token locally from the credential this client holds. */
  private async signToken(input: TokensCreateInput | undefined): Promise<TokensCreateResponse> {
    if (this.credential.kind === 'privateKey') {
      if (input?.authors === undefined) {
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

    throw new InvalidOptionsError('Access-token clients cannot mint another access token. Use a private key.');
  }
}
