import { createHash, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secrets are stored hashed, so a copy of the database is not a set of working
 * credentials.
 *
 * Both a sign-in code and a session token are hashed with plain SHA-256 rather
 * than a slow KDF, for different reasons:
 *
 * - A session token is 160 bits of randomness. There is nothing to guess, so a
 *   slow hash buys nothing — and this one is checked on *every* request, where
 *   the cost would be real.
 * - A sign-in code is only six digits, so a slow hash would not save it either:
 *   a million candidates is trivial to sweep whatever the cost per guess. What
 *   protects the code is that it dies after ten minutes, after five wrong
 *   attempts, or on first use — whichever comes first.
 *
 * If codes ever become long-lived, this reasoning stops holding and they need
 * a real KDF.
 */

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Compares two hex digests without leaking where they first differ. */
export function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * A six-digit code. The old system bumped a leading zero to a 1 because its
 * display code dropped it; we keep the full range and format it as a string,
 * so `007193` stays `007193`.
 */
export function newSignInCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 160 bits, base32-ish: unambiguous to read aloud down a bad phone line. */
export function newSessionToken(): string {
  return randomBytes(20).toString('base64url');
}
