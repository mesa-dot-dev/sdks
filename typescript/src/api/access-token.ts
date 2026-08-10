/**
 * Local access-token signing for API keys and Ed25519 signing private keys.
 * Both formats are produced entirely offline with no network round trip.
 *
 * This is the SDK-side counterpart to the server implementations in
 * `packages/core/src/auth/access-token-legacy.ts` and
 * `packages/core/src/auth/signing-key-access-token.ts`. Their wire contracts
 * live in `context/auth/legacy-access-token-protocol.md` and
 * `context/auth/signing-key-access-token-protocol.md`. JSON key order does not
 * affect verification; each implementation may emit claims in any order.
 *
 * Secret derivation:
 *   secret = base64url_nopad(SHA-256(utf8(raw_api_key)))
 * This is byte-identical to the value stored in the server's `apikey.key`
 * column. The HMAC key is the UTF-8 bytes of this base64url string.
 *
 * Legacy HS256 tokens carry no org or user info. The server derives both from
 * the API key row at verification time and clamps the requested scopes/repos
 * to the key's current permissions. New callers should use canonical
 * `repo_ids`; the backward-compatible `repos` claim carries full `org/repo`
 * names.
 *
 * Implemented with `node:crypto` only so the published SDK retains Node 18
 * support without adding a JWT dependency.
 */

import { createHash, createHmac, randomUUID, sign as signEd25519 } from 'node:crypto';
import type { CreateApiKeyData } from '@mesadev/rest';
import { z } from 'zod';
import { InvalidOptionsError } from '../lib/errors.js';
import { looksLikePrivateKey } from './credentials.js';
import type { PrivateKeyCredential } from './signing-key.js';

/** Audience claim: access tokens are only valid when presented to the Mesa API. */
// Protocol values mirror packages/core/src/auth/constants.ts. The published SDK
// cannot import the private server package at runtime.
const ACCESS_TOKEN_AUD = 'mesa-api';
/** JOSE `typ` header (RFC 9068 style) distinguishing access tokens. */
const ACCESS_TOKEN_TYP = 'mesa-at+jwt';
/** JWA algorithm: HMAC-SHA256, keyed by the per-key derived secret. */
const ACCESS_TOKEN_ALG = 'HS256';
/**
 * Secret-derivation version, encoded into the `kid` header as
 * `<api_key_id>.<version>`. Bump on the server and here together if the
 * derivation ever changes.
 */
const ACCESS_TOKEN_DERIVATION_VERSION = 'v1';

/** Default token lifetime when the caller does not request one. */
const ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
/** Hard cap on token lifetime; the server rejects anything longer at verify time. */
const ACCESS_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60; // 24 hours
/** Default and maximum lifetimes accepted by the signing-key verifier. */
const SIGNING_KEY_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 15 * 60; // 15 minutes
const SIGNING_KEY_ACCESS_TOKEN_MAX_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const MAX_SIGNING_KEY_AUTHORS = 100;

type TokenScope = NonNullable<CreateApiKeyData['body']['scopes']>[number];
const SIGNING_KEY_TOKEN_SCOPES = ['read', 'write', 'admin'] as const satisfies readonly TokenScope[];

const signingKeyAuthorSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: 'Author names must not be blank.' })
    .refine((name) => !/[<>\r\n]/.test(name), {
      error: 'Author names must not contain angle brackets or newlines.',
    }),
  email: z
    .string()
    .trim()
    .refine((email) => !/[<>\r\n]/.test(email), {
      error: 'Author emails must not contain angle brackets or newlines.',
    })
    .nullable()
    .default(null)
    .transform((email) => email || null),
});

const signingKeyAuthorsSchema = z
  .array(signingKeyAuthorSchema)
  .min(1, {
    error: 'At least one author is required.',
  })
  .max(MAX_SIGNING_KEY_AUTHORS, { error: `At most ${MAX_SIGNING_KEY_AUTHORS} authors are allowed.` });

export type SigningKeyAuthorInput = z.input<typeof signingKeyAuthorSchema>;

export function normalizeSigningKeyAuthors(
  authors: readonly SigningKeyAuthorInput[]
): readonly [z.output<typeof signingKeyAuthorSchema>, ...z.output<typeof signingKeyAuthorSchema>[]] {
  const parsed = signingKeyAuthorsSchema.safeParse(authors);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `.${issue.path.join('.')}` : '';
    throw new InvalidOptionsError(`Invalid authors${path}: ${issue?.message ?? 'invalid value'}`);
  }

  return parsed.data as [z.output<typeof signingKeyAuthorSchema>, ...z.output<typeof signingKeyAuthorSchema>[]];
}

const signingKeyTokenInputSchema = z
  .object({
    authors: signingKeyAuthorsSchema.optional(),
    scopes: z
      .array(z.enum(SIGNING_KEY_TOKEN_SCOPES))
      .min(1)
      .transform((scopes) => [...new Set(scopes)])
      .default(['admin']),
    repos: z
      .array(
        z
          .string()
          .min(1)
          .refine((repo) => !looksLikePrivateKey(repo), {
            error: 'Token repos must not contain Mesa private keys.',
          })
      )
      .nullable()
      .optional(),
    repoIds: z.array(z.string().min(1)).max(250).nullable().optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(1)
      .max(SIGNING_KEY_ACCESS_TOKEN_MAX_TTL_SECONDS)
      .default(SIGNING_KEY_ACCESS_TOKEN_DEFAULT_TTL_SECONDS),
  })
  .refine((input) => input.repos === undefined || input.repoIds === undefined, {
    error: 'Token repos and repoIds restrictions are mutually exclusive.',
  });

export type RepositoryNameRestriction<NameField extends string = 'repos', IdField extends string = 'repoIds'> = {
  [Key in NameField]: string[] | null;
} & {
  [Key in IdField]?: never;
};

export type RepositoryIdRestriction<NameField extends string = 'repos', IdField extends string = 'repoIds'> = {
  [Key in NameField]?: never;
} & {
  [Key in IdField]: string[] | null;
};

export type RepositoryRestriction<NameField extends string = 'repos', IdField extends string = 'repoIds'> =
  | RepositoryNameRestriction<NameField, IdField>
  | RepositoryIdRestriction<NameField, IdField>;

export type OptionalRepositoryRestriction<NameField extends string, IdField extends string> =
  | Partial<RepositoryNameRestriction<NameField, IdField>>
  | RepositoryIdRestriction<NameField, IdField>;

export type ApiRepositoryRestriction = OptionalRepositoryRestriction<'repos', 'repo_ids'>;

type SignAccessTokenInput = RepositoryRestriction & {
  /** The API key ID that signs this token; encoded into the `kid` header. */
  apiKeyId: string;
  /** The raw API key (`mesa_...`) the client holds; the signing secret is derived from it. */
  rawApiKey: string;
  /** Requested scopes; clamped to the key's current scopes at verify time. */
  scopes: string[];
  /** Repository restrictions are supplied by the mutually exclusive `repos` or `repoIds` fields. */
  /** Token lifetime in seconds. Defaults to {@link ACCESS_TOKEN_DEFAULT_TTL_SECONDS}. */
  ttlSeconds?: number;
};

type SignedAccessToken = {
  token: string;
  /** Exact expiry as an ISO 8601 string. */
  expiresAt: string;
  /** Effective scopes encoded into the token. */
  scopes: string[];
  /** Backward-compatible name restriction, when used. */
  repos?: string[] | null;
  /** Canonical repository-ID restriction, when used. */
  repoIds?: string[] | null;
  /** The token's unique id (`jti`), for auditing without re-decoding the JWT. */
  jti: string;
};

type SignPrivateKeyAccessTokenInput = OptionalRepositoryRestriction<'repos', 'repoIds'> & {
  credential: PrivateKeyCredential;
  authors?: readonly [SigningKeyAuthorInput, ...SigningKeyAuthorInput[]];
  /** Defaults to organization-root admin authority. */
  scopes?: string[];
  ttlSeconds?: number;
};

/** Convert the public snake-case token fields to the signer restriction. */
export function toSignerRepositoryRestriction(input: ApiRepositoryRestriction): RepositoryRestriction {
  if (input.repos !== undefined && input.repo_ids !== undefined) {
    throw new InvalidOptionsError('Token repos and repo_ids restrictions are mutually exclusive');
  }

  return input.repo_ids !== undefined ? { repoIds: input.repo_ids } : { repos: input.repos ?? null };
}

/** Convert signer metadata back to the public snake-case token fields. */
export function toApiRepositoryRestriction(
  input: Pick<SignedAccessToken, 'repos' | 'repoIds'>
): RepositoryRestriction<'repos', 'repo_ids'> {
  return input.repoIds !== undefined ? { repo_ids: input.repoIds } : { repos: input.repos ?? null };
}

/**
 * Derive the HMAC signing secret from a raw API key. Byte-identical to the
 * value stored in the server's `apikey.key` column. The HMAC key is the UTF-8
 * bytes of the returned base64url-nopad string.
 */
export function deriveAccessTokenSigningSecret(rawApiKey: string): string {
  return createHash('sha256').update(rawApiKey, 'utf8').digest('base64url');
}

/** The `kid` header: `<api_key_id>.<derivation_version>`. */
function buildKid(apiKeyId: string): string {
  return `${apiKeyId}.${ACCESS_TOKEN_DERIVATION_VERSION}`;
}

/** base64url-nopad encode a UTF-8 string. Node's `base64url` is already unpadded. */
function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Sign an access token with HS256 entirely client-side. The `iss` claim is the
 * minting API key id (mirrors the `kid` header). JSON key order is not
 * semantically meaningful because the server verifies the signature, not a byte-exact
 * string.
 */
export function signAccessToken(input: SignAccessTokenInput): SignedAccessToken {
  const ttlSeconds = input.ttlSeconds ?? ACCESS_TOKEN_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > ACCESS_TOKEN_MAX_TTL_SECONDS) {
    throw new InvalidOptionsError(`Token TTL must be an integer between 1 and ${ACCESS_TOKEN_MAX_TTL_SECONDS} seconds`);
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const jti = randomUUID();

  if (input.repos !== undefined && input.repoIds !== undefined) {
    throw new InvalidOptionsError('Token repos and repoIds restrictions are mutually exclusive');
  }

  const repoRestriction = input.repoIds !== undefined ? { repo_ids: input.repoIds } : { repos: input.repos ?? null };
  const header = { alg: ACCESS_TOKEN_ALG, typ: ACCESS_TOKEN_TYP, kid: buildKid(input.apiKeyId) };
  const payload = {
    iss: input.apiKeyId,
    aud: ACCESS_TOKEN_AUD,
    scopes: input.scopes,
    ...repoRestriction,
    iat,
    exp,
    jti,
  };

  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const secret = deriveAccessTokenSigningSecret(input.rawApiKey);
  const signature = createHmac('sha256', secret).update(signingInput, 'utf8').digest('base64url');
  const token = `${signingInput}.${signature}`;

  return {
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
    scopes: input.scopes,
    ...(input.repoIds !== undefined ? { repoIds: input.repoIds } : { repos: input.repos ?? null }),
    jti,
  };
}

/** Sign the minimal Ed25519 access-token contract accepted by the server. */
export function signPrivateKeyAccessToken(input: SignPrivateKeyAccessTokenInput): SignedAccessToken {
  const parsed = signingKeyTokenInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InvalidOptionsError(
      `Invalid ${issue?.path.join('.') || 'token options'}: ${issue?.message ?? 'invalid value'}`
    );
  }
  const { authors, scopes, repos, repoIds, ttlSeconds } = parsed.data;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const jti = randomUUID();
  const repoRestriction = repoIds !== undefined ? { repo_ids: repoIds } : { repos: repos ?? null };
  const header = { alg: 'EdDSA', typ: ACCESS_TOKEN_TYP, jwk: input.credential.publicJwk };
  const payload = {
    iss: input.credential.org,
    aud: ACCESS_TOKEN_AUD,
    ...(authors === undefined ? {} : { author: authors.map(({ name, email }) => [name, email] as const) }),
    scopes,
    ...repoRestriction,
    iat,
    exp,
    jti,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = signEd25519(null, Buffer.from(signingInput, 'utf8'), input.credential.privateKey).toString(
    'base64url'
  );

  return {
    token: `${signingInput}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    scopes,
    ...(repoIds !== undefined ? { repoIds } : { repos: repos ?? null }),
    jti,
  };
}
