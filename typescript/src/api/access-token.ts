/**
 * Local access-token signing for Ed25519 signing private keys. Tokens are
 * produced entirely offline with no network round trip.
 *
 * This is the SDK-side counterpart to the server implementations in
 * `packages/core/src/auth/signing-key-access-token.ts`. The wire contract lives
 * in `context/auth/signing-key-access-token-protocol.md`. JSON key order does
 * not affect verification.
 *
 * Implemented with `node:crypto` only so the published SDK retains Node 18
 * support without adding a JWT dependency.
 */

import { randomUUID, sign as signEd25519 } from 'node:crypto';
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

/** base64url-nopad encode a UTF-8 string. Node's `base64url` is already unpadded. */
function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
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
