import { createHash, randomInt, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Secrets are stored hashed, so a copy of the database is not a set of working
 * credentials. The two kinds of secret here get different treatment, because
 * they are protected by different things.
 *
 * A **session token** is 160 bits of randomness. There is nothing to guess, so
 * a slow hash buys nothing — and it is checked on every request, where the
 * cost would be real. SHA-256.
 *
 * A **sign-in code** is six digits: a million candidates. That is exactly the
 * regime where a slow hash earns its keep. A code lives for ten minutes, and
 * any per-guess cost above roughly a millisecond puts a full offline sweep
 * beyond that window, where SHA-256 would take seconds. So codes get scrypt.
 * It runs once per verification attempt, which is rare.
 */

const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 2 ** 14; // ~50ms per guess — far past a code's ten minutes.

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** `scrypt$<salt hex>$<derived hex>` — the salt travels with the digest. */
export function hashCode(code: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(code, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function equalHex(a: string, b: string): boolean {
  // Buffer.from(..., 'hex') truncates silently at the first invalid pair, so a
  // malformed stored hash would otherwise compare equal to a valid prefix.
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function tokenMatches(token: string, storedHash: string): boolean {
  return equalHex(hashToken(token), storedHash);
}

export function codeMatches(code: string, storedHash: string): boolean {
  const [scheme, salt, derived] = storedHash.split('$');
  if (scheme !== 'scrypt' || !salt || !derived || !/^[0-9a-f]+$/i.test(salt)) return false;
  const actual = scryptSync(code, Buffer.from(salt, 'hex'), SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return equalHex(actual.toString('hex'), derived);
}

/** Six digits, full range: `007193` stays `007193`. */
export function newSignInCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 160 bits, URL-safe. Never shown to a person, so readability does not matter. */
export function newSessionToken(): string {
  return randomBytes(20).toString('base64url');
}
