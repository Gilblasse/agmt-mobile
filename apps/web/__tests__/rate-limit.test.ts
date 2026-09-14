import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import postgres from 'postgres';

/**
 * Rate limiting on the endpoints that answer strangers.
 *
 * Each test uses its own `x-forwarded-for` so the buckets cannot collide with
 * each other or with the sign-in suite.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const sql = postgres(process.env.DATABASE_URL!);

const SIGN_IN_LIMIT = 30;
const VERIFY_LIMIT = 30;

type Json = Record<string, any>;
async function post(path: string, body: unknown, ip: string): Promise<{ status: number; body: Json; retryAfter: string | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json, retryAfter: res.headers.get('retry-after') };
}

const DRIVER = 'Rate Limit Victim';

beforeEach(async () => {
  await sql`DELETE FROM rate_limits WHERE bucket LIKE '%:203.0.113.%'`;
  await sql`INSERT INTO drivers (name, email, phone, active)
    VALUES (${DRIVER}, 'rl@example.com', '8455556001', true)
    ON CONFLICT (name) DO UPDATE SET active = true`;
  await sql`DELETE FROM driver_sign_in_codes WHERE driver_id IN (SELECT id FROM drivers WHERE name = ${DRIVER})`;
  await sql`DELETE FROM notifications WHERE driver_id IN (SELECT id FROM drivers WHERE name = ${DRIVER})`;
});
after(async () => {
  await sql`DELETE FROM rate_limits WHERE bucket LIKE '%:203.0.113.%'`;
  await sql`DELETE FROM drivers WHERE name = ${DRIVER}`;
  await sql.end();
});

describe('rate limiting', () => {
  it('cannot be shaken off by rotating a made-up header', async () => {
    // One host, sixty requests, a different invented address each time. The
    // leftmost entry used to be trusted, so this walked straight through.
    let refused = 0;
    for (let i = 0; i < 60; i++) {
      const res = await post('/api/driver/verify', { name: DRIVER, code: '000000' }, `junk-${i}-not-an-ip`);
      if (res.status === 429) refused++;
    }
    assert.ok(refused > 0, 'a caller we cannot place must still be throttled');
  });

  it('cannot lock out someone else by wearing their address', async () => {
    // The header arrives as the caller wrote it, with our own proxy's entry
    // appended on the right. Trusting the left let anyone spend a victim's
    // budget; the rightmost entry is the one a proxy vouches for.
    const victim = '203.0.113.77';
    for (let i = 0; i < 40; i++) {
      await post('/api/driver/sign-in', { name: DRIVER }, `${victim}, 203.0.113.99`);
    }
    const theVictim = await post('/api/driver/sign-in', { name: DRIVER }, victim);
    assert.notEqual(theVictim.status, 429, 'the spoofed address must not carry the attacker\u2019s count');
  });

  it('refuses a caller who floods sign-in, and says when to come back', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < SIGN_IN_LIMIT; i++) {
      const { status } = await post('/api/driver/sign-in', { name: DRIVER }, ip);
      assert.equal(status, 200, `request ${i + 1} should still be allowed`);
    }
    const over = await post('/api/driver/sign-in', { name: DRIVER }, ip);
    assert.equal(over.status, 429);
    assert.equal(over.body.reason, 'busy');
    assert.ok(Number(over.retryAfter) > 0, 'Retry-After should say how long to wait');
  });

  it('refuses a caller who floods verify', async () => {
    const ip = '203.0.113.11';
    for (let i = 0; i < VERIFY_LIMIT; i++) {
      await post('/api/driver/verify', { name: DRIVER, code: '000000' }, ip);
    }
    const over = await post('/api/driver/verify', { name: DRIVER, code: '000000' }, ip);
    assert.equal(over.status, 429);
    assert.equal(over.body.reason, 'busy');
  });

  it('limits each caller separately, so one attacker cannot lock everyone out', async () => {
    const attacker = '203.0.113.12';
    for (let i = 0; i <= SIGN_IN_LIMIT; i++) await post('/api/driver/sign-in', { name: DRIVER }, attacker);
    assert.equal((await post('/api/driver/sign-in', { name: DRIVER }, attacker)).status, 429);

    // A different caller — the real driver, on their own phone — is unaffected.
    const driver = await post('/api/driver/sign-in', { name: DRIVER }, '203.0.113.13');
    assert.equal(driver.status, 200, 'a different caller must not inherit the attacker’s limit');
  });

  it('counts every request when they arrive together', async () => {
    const ip = '203.0.113.14';
    // A read-modify-write counter loses hits under concurrency — the same
    // mistake that made the sign-in attempt limit meaningless.
    await Promise.all(
      Array.from({ length: SIGN_IN_LIMIT + 15 }, () => post('/api/driver/sign-in', { name: DRIVER }, ip)),
    );
    const [row] = await sql`SELECT hits FROM rate_limits WHERE bucket = ${'sign-in:' + ip}`;
    assert.equal(row!.hits, SIGN_IN_LIMIT + 15, 'no hits may be lost');
    assert.equal((await post('/api/driver/sign-in', { name: DRIVER }, ip)).status, 429);
  });

  it('keeps the limits apart for sign-in and verify', async () => {
    const ip = '203.0.113.15';
    for (let i = 0; i <= SIGN_IN_LIMIT; i++) await post('/api/driver/sign-in', { name: DRIVER }, ip);
    assert.equal((await post('/api/driver/sign-in', { name: DRIVER }, ip)).status, 429);
    // Exhausting sign-in must not also block verify: a driver who has a code
    // in hand should still be able to use it.
    const verify = await post('/api/driver/verify', { name: DRIVER, code: '000000' }, ip);
    assert.notEqual(verify.status, 429);
  });
});
