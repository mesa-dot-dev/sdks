export const MESA_PRIVATE_KEY_PREFIX = 'mesa_private_key_';

/** Recognize private-key formats before a value reaches an outbound request. */
export function looksLikePrivateKey(input: string): boolean {
  const value = input.trim();
  return (
    value.toLowerCase().includes(MESA_PRIVATE_KEY_PREFIX) ||
    /^-----(?:BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----$/im.test(value)
  );
}
