import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checks that a status callback really came from Twilio.
 *
 * This endpoint is public — Twilio has to be able to reach it — so without
 * this, anyone who guessed the URL could mark a driver's sign-in code
 * delivered, or mark every message failed. Twilio signs each request with the
 * account's auth token: HMAC-SHA1 over the exact URL it posted to, with every
 * form field appended in key order.
 *
 * The URL is the one we *told* Twilio to use, not the one the request appears
 * to have arrived at. Behind a proxy the Host and scheme a handler sees are
 * whatever the proxy set, and an attacker who can influence those could
 * otherwise choose the string being signed.
 */
export function signatureMatches(
  authToken: string,
  callbackUrl: string,
  fields: URLSearchParams,
  signature: string | null,
): boolean {
  if (!signature) return false;

  const keys = [...new Set([...fields.keys()])].sort();
  let base = callbackUrl;
  for (const key of keys) {
    // Twilio concatenates every value it sent for a repeated key, in order.
    for (const value of fields.getAll(key)) base += key + value;
  }

  const expected = createHmac('sha1', authToken).update(Buffer.from(base, 'utf8')).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  // Length has to match before a constant-time compare will run at all.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
