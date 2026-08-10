import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { InvalidOptionsError } from '../lib/errors.js';
import { MESA_PRIVATE_KEY_PREFIX } from './credentials.js';

const MESA_PRIVATE_KEY_BODY_PATTERN = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)_([A-Za-z0-9_-]+)$/;

type MesaPublicJwk = {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
};

export type PrivateKeyCredential = {
  org: string;
  privateKey: KeyObject;
  publicJwk: MesaPublicJwk;
};

/** Parse and validate a Mesa Ed25519 private key once for repeated local signing. */
export function parsePrivateKey(privateKey: string): PrivateKeyCredential {
  const input = privateKey.trim();
  if (!input.startsWith(MESA_PRIVATE_KEY_PREFIX)) {
    throw new InvalidOptionsError('Expected a private key beginning with `mesa_private_key_`.');
  }

  const match = MESA_PRIVATE_KEY_BODY_PATTERN.exec(input.slice(MESA_PRIVATE_KEY_PREFIX.length));
  if (!match) {
    throw new InvalidOptionsError('Expected `mesa_private_key_<organization>_<key>`.');
  }
  const [, org, encodedKey] = match;
  const keyBytes = Buffer.from(encodedKey, 'base64url');

  let parsedPrivateKey: KeyObject;
  try {
    parsedPrivateKey = createPrivateKey({ key: keyBytes, format: 'der', type: 'pkcs8' });
  } catch {
    throw new InvalidOptionsError('The private key is not a valid Ed25519 key.');
  }
  if (parsedPrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new InvalidOptionsError('The private key must use Ed25519.');
  }
  if (!parsedPrivateKey.export({ format: 'der', type: 'pkcs8' }).equals(keyBytes)) {
    throw new InvalidOptionsError('The private key must use canonical Ed25519 PKCS#8 DER encoding.');
  }

  const { x } = createPublicKey(parsedPrivateKey).export({ format: 'jwk' });

  return {
    org,
    privateKey: parsedPrivateKey,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: x! },
  };
}
