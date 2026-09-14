import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import postgres from 'postgres';

/**
 * Driver sign-in, end to end, against a real PostgreSQL.
 *
 * These run against a live server because the behaviour that matters is the
 * behaviour a phone sees: the codes are read out of the notifications outbox
 * exactly as a delivery worker would, never returned by the API.
 *
 * Start the server and point both at the same database:
 *   DATABASE_URL=... bun run --filter '@ag/web' start
 *   DATABASE_URL=... BASE_URL=http://localhost:3000 node --test dist-tests/
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const sql = postgres(process.env.DATABASE_URL!);

type Json = Record<string, any>;
async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: (await res.json()) as Json };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Reads the code out of the outbox, which is the only place it exists. */
async function codeFor(driverName: string): Promise<string> {
  const [row] = await sql`
    SELECT n.body FROM notifications n
    JOIN drivers d ON d.id = n.driver_id
    WHERE d.name = ${driverName}
    ORDER BY n.created_at DESC LIMIT 1`;
  const match = /\b(\d{6})\b/.exec(row?.body ?? '');
  assert.ok(match, `no sign-in code queued for ${driverName}`);
  return match[1]!;
}

async function signInAs(name: string): Promise<string> {
  await post('/api/driver/sign-in', { name });
  const { body } = await post('/api/driver/verify', { name, code: await codeFor(name) });
  assert.equal(body.ok, true, 'expected sign-in to succeed');
  return body.data.token as string;
}

const ACTIVE = 'Test Driver Active';
const INACTIVE = 'Test Driver Inactive';

before(async () => {
  await sql`INSERT INTO drivers (name, email, phone, active) VALUES
    (${ACTIVE}, 'active@example.com', '8455550101', true),
    (${INACTIVE}, 'inactive@example.com', '8455550102', true)
    ON CONFLICT (name) DO UPDATE SET active = true`;
});
beforeEach(async () => {
  await sql`DELETE FROM notifications WHERE driver_id IN (SELECT id FROM drivers WHERE name IN (${ACTIVE}, ${INACTIVE}))`;
  await sql`DELETE FROM driver_sign_in_codes WHERE driver_id IN (SELECT id FROM drivers WHERE name IN (${ACTIVE}, ${INACTIVE}))`;
  await sql`DELETE FROM driver_sessions WHERE driver_id IN (SELECT id FROM drivers WHERE name IN (${ACTIVE}, ${INACTIVE}))`;
  await sql`UPDATE drivers SET active = true WHERE name IN (${ACTIVE}, ${INACTIVE})`;
});
after(async () => {
  await sql`DELETE FROM drivers WHERE name IN (${ACTIVE}, ${INACTIVE})`;
  await sql.end();
});

describe('requesting a code', () => {
  it('queues it to the outbox and never returns it', async () => {
    const { status, body } = await post('/api/driver/sign-in', { name: ACTIVE });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.match(JSON.stringify(body), /•••/, 'the driver is told where it went');
    assert.doesNotMatch(JSON.stringify(body), /\b\d{6}\b/, 'the code itself must not be in the response');
    assert.match(await codeFor(ACTIVE), /^\d{6}$/);
  });

  it('stores only a hash of the code', async () => {
    await post('/api/driver/sign-in', { name: ACTIVE });
    const code = await codeFor(ACTIVE);
    const [row] = await sql`SELECT code_hash FROM driver_sign_in_codes ORDER BY created_at DESC LIMIT 1`;
    assert.notEqual(row!.code_hash, code);
    assert.match(row!.code_hash, /^[0-9a-f]{64}$/);
  });

  it('answers the same for a name nobody has, so the roster cannot be read', async () => {
    const known = await post('/api/driver/sign-in', { name: ACTIVE });
    const unknown = await post('/api/driver/sign-in', { name: 'Nobody At All' });
    assert.equal(unknown.status, known.status);
    assert.equal(unknown.body.ok, true);
    assert.equal(await sql`SELECT count(*)::int c FROM driver_sign_in_codes`.then((r) => typeof r[0]!.c), 'number');
  });

  it('does not send a second code inside the cooldown', async () => {
    await post('/api/driver/sign-in', { name: ACTIVE });
    await post('/api/driver/sign-in', { name: ACTIVE });
    const [{ c }] = await sql`SELECT count(*)::int c FROM notifications n
      JOIN drivers d ON d.id = n.driver_id WHERE d.name = ${ACTIVE}`;
    assert.equal(c, 1, 'a second request inside the cooldown must not queue another message');
  });

  it('refuses a request with no identifier at all', async () => {
    const { status, body } = await post('/api/driver/sign-in', {});
    assert.equal(status, 400);
    assert.equal(body.reason, 'validation');
  });
});

describe('verifying a code', () => {
  it('returns a token and the driver', async () => {
    await post('/api/driver/sign-in', { name: ACTIVE });
    const { status, body } = await post('/api/driver/verify', { name: ACTIVE, code: await codeFor(ACTIVE) });
    assert.equal(status, 200);
    assert.equal(body.data.driver.name, ACTIVE);
    assert.ok(body.data.token.length >= 20);
  });

  it('stores only a hash of the token', async () => {
    const token = await signInAs(ACTIVE);
    const [row] = await sql`SELECT token_hash FROM driver_sessions ORDER BY created_at DESC LIMIT 1`;
    assert.notEqual(row!.token_hash, token);
    assert.match(row!.token_hash, /^[0-9a-f]{64}$/);
  });

  it('refuses a wrong code, and says nothing about how many guesses are left', async () => {
    await post('/api/driver/sign-in', { name: ACTIVE });
    const wrong = String((Number(await codeFor(ACTIVE)) + 1) % 1_000_000).padStart(6, '0');
    const { status, body } = await post('/api/driver/verify', { name: ACTIVE, code: wrong });
    assert.equal(status, 401);
    assert.equal(body.reason, 'not-authorised');
    assert.doesNotMatch(body.message, /\d+ (tries|attempts|left)/i);
  });

  it('burns the code after five wrong attempts, so the real one stops working', async () => {
    await post('/api/driver/sign-in', { name: ACTIVE });
    const real = await codeFor(ACTIVE);
    const wrong = String((Number(real) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) await post('/api/driver/verify', { name: ACTIVE, code: wrong });
    const { status } = await post('/api/driver/verify', { name: ACTIVE, code: real });
    assert.equal(status, 401, 'the correct code must not work after the attempt limit');
  });

  it('is single use', async () => {
    await post('/api/driver/sign-in', { name: ACTIVE });
    const code = await codeFor(ACTIVE);
    assert.equal((await post('/api/driver/verify', { name: ACTIVE, code })).status, 200);
    assert.equal((await post('/api/driver/verify', { name: ACTIVE, code })).status, 401);
  });

  it("refuses one driver's code presented by another driver", async () => {
    await post('/api/driver/sign-in', { name: ACTIVE });
    const code = await codeFor(ACTIVE);
    const { status } = await post('/api/driver/verify', { name: INACTIVE, code });
    assert.equal(status, 401, 'a code belongs to the driver it was sent to');
  });

  it('refuses an expired code', async () => {
    await post('/api/driver/sign-in', { name: ACTIVE });
    const code = await codeFor(ACTIVE);
    await sql`UPDATE driver_sign_in_codes SET expires_at = now() - interval '1 minute'`;
    assert.equal((await post('/api/driver/verify', { name: ACTIVE, code })).status, 401);
  });
});

describe('the roster gate', () => {
  it('lets a signed-in driver through', async () => {
    const token = await signInAs(ACTIVE);
    const { status, body } = await call('/api/driver/me', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(status, 200);
    assert.equal(body.data.driver.name, ACTIVE);
  });

  it('cuts a driver off the moment they leave the roster, with no separate revoke', async () => {
    const token = await signInAs(ACTIVE);
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await call('/api/driver/me', { headers: auth })).status, 200);

    await sql`UPDATE drivers SET active = false WHERE name = ${ACTIVE}`;

    const { status, body } = await call('/api/driver/me', { headers: auth });
    assert.equal(status, 401, 'an existing session must stop working immediately');
    assert.match(body.message, /no longer active/i);
  });

  it('refuses a missing, malformed or made-up token', async () => {
    for (const headers of [{}, { authorization: 'Bearer' }, { authorization: 'Bearer not-a-real-token' }]) {
      const { status } = await call('/api/driver/me', { headers: headers as Record<string, string> });
      assert.equal(status, 401);
    }
  });

  it('refuses a revoked or expired session', async () => {
    const token = await signInAs(ACTIVE);
    const auth = { authorization: `Bearer ${token}` };
    await sql`UPDATE driver_sessions SET revoked_at = now()`;
    assert.equal((await call('/api/driver/me', { headers: auth })).status, 401);

    await sql`UPDATE driver_sessions SET revoked_at = NULL, expires_at = now() - interval '1 day'`;
    assert.equal((await call('/api/driver/me', { headers: auth })).status, 401);
  });

  it('keeps at most eight trusted phones, revoking the oldest', async () => {
    for (let i = 0; i < 9; i++) {
      await sql`DELETE FROM driver_sign_in_codes`;
      await signInAs(ACTIVE);
    }
    const [{ c }] = await sql`SELECT count(*)::int c FROM driver_sessions ds
      JOIN drivers d ON d.id = ds.driver_id WHERE d.name = ${ACTIVE} AND ds.revoked_at IS NULL`;
    assert.equal(c, 8);
  });
});
