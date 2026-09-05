/**
 * Local access-token signing for Ed25519 signing private keys. Tokens are
 * produced entirely offline with no network round trip.
 *
 * This is the SDK-side counterpart to the server implementation in
 * `packages/core/src/auth/signing-key-access-token.ts`. JSON key order does not
 * affect verification.
 *
 * Implemented with `node:crypto` only so the published SDK retains Node 18
 * support without adding a JWT dependency.
 */

import { randomUUID, sign as signEd25519 } from 'node:crypto';
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
const MAX_SIGNING_KEY_ACCESS_ENTRIES = 250;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const RESERVED_REPOSITORY_NAMES = new Set(['repo', 'repos', 'api-key', 'api-keys']);

function isValidRepositoryName(name: string): boolean {
  if (!REPOSITORY_NAME_PATTERN.test(name) || name === '.' || name === '..') return false;

  const lowerName = name.toLowerCase();
  return !lowerName.endsWith('.git') && !RESERVED_REPOSITORY_NAMES.has(lowerName);
}

const signingKeyAuthorSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: 'Author names must not be blank.' })
    .refine((name) => !/[<>\r\n]/.test(name), {
      error: 'Author names must not contain angle brackets or newlines.',
    })
    .refine((name) => !looksLikePrivateKey(name), {
      error: 'Author names must not contain Mesa private keys.',
    }),
  email: z
    .string()
    .trim()
    .refine((email) => !/[<>\r\n]/.test(email), {
      error: 'Author emails must not contain angle brackets or newlines.',
    })
    .refine((email) => !looksLikePrivateKey(email), {
      error: 'Author emails must not contain Mesa private keys.',
    })
    .nullable()
    .default(null)
    .transform((email) => email || null),
});

const signingKeyAccessRepositorySchema = z
  .string()
  .refine((repo) => !looksLikePrivateKey(repo), {
    error: 'Token access repos must not contain Mesa private keys.',
  })
  .refine((repo) => isValidRepositoryName(repo), {
    error: 'Token access repos must be valid bare repository names.',
  });
const signingKeyAccessLevelSchema = z.enum(['read-repo', 'write-repo']);
type SigningKeyAccessLevel = z.output<typeof signingKeyAccessLevelSchema>;
const signingKeyAccessSchema = z.unknown().transform((access, context) => {
  if (access === null || typeof access !== 'object' || Array.isArray(access)) {
    context.addIssue({ code: 'custom', message: 'Token access must be a repository permission map.' });
    return z.NEVER;
  }

  const entries = Object.entries(access);
  if (entries.length === 0) {
    context.addIssue({ code: 'custom', message: 'Token access must include at least one repository.' });
    return z.NEVER;
  }
  if (entries.length > MAX_SIGNING_KEY_ACCESS_ENTRIES) {
    context.addIssue({
      code: 'custom',
      message: `Token access must include at most ${MAX_SIGNING_KEY_ACCESS_ENTRIES} repositories.`,
    });
    return z.NEVER;
  }

  const parsedEntries: Array<[string, SigningKeyAccessLevel]> = [];
  for (const [repo, level] of entries) {
    const parsedRepo = signingKeyAccessRepositorySchema.safeParse(repo);
    if (!parsedRepo.success) {
      context.addIssue({ code: 'custom', path: [repo], message: parsedRepo.error.issues[0]!.message });
      continue;
    }

    const parsedLevel = signingKeyAccessLevelSchema.safeParse(level);
    if (!parsedLevel.success) {
      context.addIssue({ code: 'custom', path: [repo], message: parsedLevel.error.issues[0]!.message });
      continue;
    }

    parsedEntries.push([parsedRepo.data, parsedLevel.data]);
  }

  return Object.fromEntries(parsedEntries);
});
type NormalizedSigningKeyAccess = z.output<typeof signingKeyAccessSchema>;

const signingKeyAuthorsSchema = z
  .array(signingKeyAuthorSchema)
  .min(1, { error: 'At least one author is required.' })
  .max(MAX_SIGNING_KEY_AUTHORS, { error: `At most ${MAX_SIGNING_KEY_AUTHORS} authors are allowed.` });
const signingKeyTtlSchema = z
  .int()
  .min(1)
  .max(SIGNING_KEY_ACCESS_TOKEN_MAX_TTL_SECONDS)
  .default(SIGNING_KEY_ACCESS_TOKEN_DEFAULT_TTL_SECONDS);

export type SigningKeyAuthorInput = z.input<typeof signingKeyAuthorSchema>;
type SigningKeyAccessInput = Readonly<Record<string, z.input<typeof signingKeyAccessLevelSchema>>>;

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

function normalizeSigningKeyAccess(access: NormalizedSigningKeyAccess): NormalizedSigningKeyAccess {
  const repos = new Map<string, { name: string; level: SigningKeyAccessLevel }>();

  for (const [repo, level] of Object.entries(access)) {
    const key = repo.toLowerCase();
    const existing = repos.get(key);
    if (!existing || level === 'write-repo') {
      repos.set(key, { name: existing?.name ?? repo, level });
    }
  }

  return Object.fromEntries([...repos.values()].map(({ name, level }) => [name, level]));
}

const automaticSigningKeyTokenInputSchema = z.union([
  z.strictObject({
    authors: signingKeyAuthorsSchema.optional(),
    admin: z.literal(true),
    ttlSeconds: signingKeyTtlSchema,
  }),
  z.strictObject({
    authors: signingKeyAuthorsSchema.optional(),
    access: signingKeyAccessSchema,
    ttlSeconds: signingKeyTtlSchema,
  }),
]);

type SignedPrivateKeyAccessToken = {
  token: string;
  /** Exact expiry as an ISO 8601 string. */
  expiresAt: string;
  /** The token's unique id (`jti`), for auditing without re-decoding the JWT. */
  jti: string;
};

type SignAutomaticPrivateKeyAccessTokenInput = {
  privateKey: PrivateKeyCredential;
  authors?: readonly [SigningKeyAuthorInput, ...SigningKeyAuthorInput[]];
  ttlSeconds?: number;
} & ({ admin: true } | { access: SigningKeyAccessInput });

function invalidTokenOptions(error: z.ZodError): InvalidOptionsError {
  const outerIssue = error.issues[0];
  const unionIssues = outerIssue?.code === 'invalid_union' ? outerIssue.errors.flat() : [];
  const issue = unionIssues.find((candidate) => candidate.code === 'custom') ?? unionIssues[0] ?? outerIssue;
  const message = issue?.code === 'invalid_key' ? issue.issues[0]?.message : issue?.message;
  // Repository selectors are user-controlled and may contain private material.
  // Report the field without echoing the invalid map key.
  const path = issue?.path[0] === 'access' ? 'access' : issue?.path.join('.') || 'token options';
  return new InvalidOptionsError(`Invalid ${path}: ${message ?? 'invalid value'}`);
}

/** base64url-nopad encode a UTF-8 string. Node's `base64url` is already unpadded. */
function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signPrivateKeyToken(
  privateKey: PrivateKeyCredential,
  tokenInput: z.output<typeof automaticSigningKeyTokenInputSchema>
): SignedPrivateKeyAccessToken {
  const { authors, ttlSeconds } = tokenInput;
  const authority =
    'admin' in tokenInput ? { admin: true as const } : { access: normalizeSigningKeyAccess(tokenInput.access) };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const jti = randomUUID();
  const header = { alg: 'EdDSA', typ: ACCESS_TOKEN_TYP, jwk: privateKey.publicJwk };
  const payload = {
    iss: privateKey.org,
    aud: ACCESS_TOKEN_AUD,
    ...(authors ? { authors } : {}),
    ...authority,
    iat,
    exp,
    jti,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = signEd25519(null, Buffer.from(signingInput, 'utf8'), privateKey.privateKey).toString('base64url');

  return {
    token: `${signingInput}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    jti,
  };
}

/** Sign an automatic request or MesaFS credential. */
export function signAutomaticPrivateKeyAccessToken(
  input: SignAutomaticPrivateKeyAccessTokenInput
): SignedPrivateKeyAccessToken {
  const { privateKey, ...tokenInput } = input;
  const parsed = automaticSigningKeyTokenInputSchema.safeParse(tokenInput);
  if (!parsed.success) {
    throw invalidTokenOptions(parsed.error);
  }
  return signPrivateKeyToken(privateKey, parsed.data);
}
