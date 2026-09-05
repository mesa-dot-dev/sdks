import type { WhoamiResponse } from '@mesadev/rest';
import {
  normalizeSigningKeyAuthors,
  signAutomaticPrivateKeyAccessToken,
  type SigningKeyAuthorInput,
} from './api/access-token.js';
import { createRestClient, type RestClient } from './api/client.js';
import { type ApiResources, createApiResources } from './api/resources.js';
import { looksLikePrivateKey } from './api/credentials.js';
import { parsePrivateKey, type PrivateKeyCredential } from './api/signing-key.js';
import { createLayout, type Layout, type LayoutSpec, type Repo } from './fs/layout.js';
import { MesaFileSystem, type MesaFileSystemConfig, type TelemetryConfig } from './fs/mesa-file-system.js';
import { InvalidApiUrlError, InvalidOptionsError, MissingCredentialError, OrgResolutionError } from './lib/errors.js';

const DEFAULT_API_URL = 'https://api.mesa.dev/v1';
const PRIVATE_KEY_ENV_VAR = 'MESA_PRIVATE_KEY';

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

/** Resolve an explicit private key or the environment fallback. */
function resolvePrivateKey(privateKey: string | undefined): PrivateKeyCredential {
  if (privateKey !== undefined) {
    if (typeof privateKey !== 'string') {
      throw new InvalidOptionsError('The Mesa constructor accepts only a private key string.');
    }
    return parsePrivateKey(privateKey);
  }

  const environmentPrivateKey = getEnvVar(PRIVATE_KEY_ENV_VAR);
  if (environmentPrivateKey !== undefined) {
    return parsePrivateKey(environmentPrivateKey);
  }
  throw new MissingCredentialError('Missing credential. Pass a private key or set `MESA_PRIVATE_KEY`.');
}

/** Commit attribution carried by a layout-scoped access token. */
export type FsLayoutAuthor = SigningKeyAuthorInput;

type PrivateKeyAuthors = readonly [FsLayoutAuthor, ...FsLayoutAuthor[]];

export interface MesaOptions {
  /** Organization-root Ed25519 private key used to sign request and filesystem credentials locally. */
  privateKey?: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  webhookSecret?: string;
}

/** Non-token options accepted by {@link FilesystemDefinition.mount}. */
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
export interface FilesystemDefinition {
  /** The prepared layout, built from the raw path map the definition was given. */
  layout(): Layout;
  /**
   * Mount this layout as the complete namespace, accepting the non-token
   * mount options (`cache`, `telemetry`). The mount's token lifetime is the
   * definition's `ttl`.
   */
  mount(options?: FsMountRuntimeOptions): Promise<MesaFileSystem>;
  /**
   * Mint the layout-scoped, least-privilege access token. Repository names map
   * to `read-repo` or `write-repo` according to each declaration's mode, and
   * the token uses the definition's `ttl`.
   */
  token(): Promise<AccessToken>;
}

export type AccessToken = {
  token: string;
  /** Exact expiry as an ISO 8601 string. */
  expires_at: string;
};

type FsLayoutOptions = {
  layout: LayoutSpec;
  /**
   * Lifetime of every token the definition mints, in seconds. Defaults to
   * 15 minutes and allows up to four hours. There is no refresh; once the
   * token expires, the mount fails closed.
   */
  ttl?: number;
  authors: PrivateKeyAuthors;
};
type RuntimeFsLayoutOptions = {
  layout: LayoutSpec;
  ttl?: number;
  authors?: PrivateKeyAuthors;
};

export class Mesa {
  readonly apiUrl: string;
  readonly org: ApiResources['org'];
  readonly repos: ApiResources['repos'];
  readonly content: ApiResources['content'];
  readonly bookmarks: ApiResources['bookmarks'];
  readonly changes: ApiResources['changes'];
  readonly diffs: ApiResources['diffs'];
  readonly webhookTargets: ApiResources['webhookTargets'];
  readonly webhooks: ApiResources['webhooks'];
  readonly fs: (options: FsLayoutOptions) => FilesystemDefinition;

  private readonly credential: PrivateKeyCredential;
  private readonly restClient: RestClient;
  private cachedWhoAmI: WhoamiResponse | null = null;

  constructor(options: MesaOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new InvalidOptionsError('The Mesa constructor accepts an options object.');
    }
    if ('auth' in options || 'accessToken' in options) {
      throw new InvalidOptionsError('The Mesa constructor accepts only `privateKey`; access tokens are not supported.');
    }
    if ((options as MesaOptions & { authors?: unknown }).authors !== undefined) {
      throw new InvalidOptionsError(
        'The `authors` option is not accepted by the Mesa constructor. Pass authors to the operation instead.'
      );
    }
    const credential = resolvePrivateKey(options.privateKey);
    this.credential = credential;

    this.apiUrl = normalizeUrl(options.apiUrl?.trim() || DEFAULT_API_URL);
    if (options.userAgent && looksLikePrivateKey(options.userAgent)) {
      throw new InvalidOptionsError('User-agent metadata must not contain Mesa private key material.');
    }
    this.restClient = createRestClient({
      credential: () => signAutomaticPrivateKeyAccessToken({ privateKey: credential, admin: true }).token,
      apiUrl: this.apiUrl,
      fetch: options.fetch,
      userAgent: options.userAgent,
    });

    const resources = createApiResources({
      restClient: this.restClient,
      orgSlug: credential.org,
      webhookSecret: options.webhookSecret,
      requestAttribution: {
        sign: (authors) => signAutomaticPrivateKeyAccessToken({ privateKey: credential, authors, admin: true }).token,
      },
    });

    this.org = resources.org;
    this.repos = resources.repos;
    this.content = resources.content;
    this.bookmarks = resources.bookmarks;
    this.changes = resources.changes;
    this.diffs = resources.diffs;
    this.webhookTargets = resources.webhookTargets;
    this.webhooks = resources.webhooks;

    // Layout minting and mounting are reachable only through a definition;
    // the layout carries no organization, so the client's org scopes both.
    const mintLayoutToken = async (
      layout: Layout,
      ttl: number | undefined,
      authors: PrivateKeyAuthors
    ): Promise<AccessToken> => {
      const { access } = this.deriveLayoutTokenRequest(layout, 'mesa.fs({ layout }).token()');
      // The layout definition is the only public mint path; it signs through
      // the client's private signer and can never request `admin`.
      const signed = signAutomaticPrivateKeyAccessToken({
        privateKey: this.credential,
        authors,
        access,
        ttlSeconds: ttl,
      });
      return { token: signed.token, expires_at: signed.expiresAt };
    };

    const mountLayout = async (
      definitionLayout: Layout,
      ttl: number | undefined,
      authors: PrivateKeyAuthors,
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
      const { layout, org, access } = this.deriveLayoutTokenRequest(definitionLayout, 'mesa.fs({ layout }).mount()');
      // Mint a single access token for the mount's whole lifetime. There is
      // no refresh and no credential hot-swap, so when the token expires the
      // mount expires with it.
      const token = signAutomaticPrivateKeyAccessToken({
        privateKey: this.credential,
        authors,
        access,
        ttlSeconds: ttl,
      }).token;
      return this.createFs(org, options, token, layout);
    };

    const defineLayout = ({ layout, ttl, authors: authorsInput }: RuntimeFsLayoutOptions): FilesystemDefinition => {
      if (layout === undefined) {
        // Catches untyped callers passing a bare path map instead of options.
        throw new InvalidOptionsError("mesa.fs() requires a 'layout'");
      }
      const authors = authorsInput === undefined ? undefined : normalizeSigningKeyAuthors(authorsInput);
      if (authors === undefined) {
        throw new InvalidOptionsError('Private-key layout definitions require a nonempty `authors` option.');
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
    this.fs = defineLayout;
  }

  private createFs(
    org: string,
    fsOptions: FsMountRuntimeOptions,
    credential: string,
    layout: Layout
  ): Promise<MesaFileSystem> {
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
    };
    return MesaFileSystem.createAsync(config);
  }

  /**
   * Derive the least-privilege token request for a layout: its repositories
   * collected from every declaration and scoped by name (signed offline, no
   * repository lookup), plus the narrowest access each declared mode allows.
   * Shared by the definition's `mount()` and `token()` so the derivation
   * exists exactly once.
   */
  private deriveLayoutTokenRequest(
    layout: Layout,
    caller: string
  ): { layout: Layout; org: string; access: Record<string, 'read-repo' | 'write-repo'> } {
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
    // Repository names are user-controlled. A null prototype keeps a valid
    // repository named `__proto__` from invoking Object's legacy setter.
    const access = Object.create(null) as Record<string, 'read-repo' | 'write-repo'>;
    for (const declaration of declarations) {
      if (declaration.name === '*') {
        throw new InvalidOptionsError(`${caller} requires exact repository names`);
      }
      const level = declaration.mode === 'rw' ? 'write-repo' : 'read-repo';
      if (level === 'write-repo' || access[declaration.name] === undefined) {
        access[declaration.name] = level;
      }
    }
    return { layout, org, access };
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
}
