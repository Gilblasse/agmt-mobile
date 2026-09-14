import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

/**
 * The driver's day and the tap flow — the part docs/08 says not to ship
 * without. Every check runs against a real PostgreSQL and a real server,
 * because the guarantees here are enforced by database constraints as much as
 * by application code.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const sql = postgres(process.env.DATABASE_URL!);

let caller = 0;
const nextCaller = () => `198.51.100.${(caller++ % 250) + 1}`;

type Json = Record<string, any>;
async function call(path: string, token: string | null, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': nextCaller(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string>),
    },
  });
  return { status: res.status, body: (await res.json()) as Json };
}
const tap = (token: string, tripId: string, body: unknown) =>
  call(`/api/driver/trips/${tripId}/progress`, token, { method: 'POST', body: JSON.stringify(body) });

const MINE = 'Day Driver Mine';
const OTHER = 'Day Driver Other';
let mineId = '';
let otherId = '';
let mineToken = '';
let otherToken = '';

async function signIn(name: string): Promise<string> {
  await call('/api/driver/sign-in', null, { method: 'POST', body: JSON.stringify({ name }) });
  const [row] = await sql`SELECT n.body FROM notifications n JOIN drivers d ON d.id = n.driver_id
    WHERE d.name = ${name} ORDER BY n.created_at DESC LIMIT 1`;
  const code = /\b(\d{6})\b/.exec(row!.body)![1];
  const { body } = await call('/api/driver/verify', null, { method: 'POST', body: JSON.stringify({ name, code }) });
  return body.data.token as string;
}

/** Today, as the office reckons it — not as this machine's clock does. */
async function officeToday(): Promise<string> {
  const [row] = await sql`SELECT to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') d`;
  return row!.d;
}

async function makeTrip(driverId: string | null, date: string, time = '09:00'): Promise<string> {
  const [row] = await sql`INSERT INTO trips (service_date, scheduled_time, passenger_name, pickup, driver_id)
    VALUES (${date}, ${time}, 'Test Passenger', '1 Test Street', ${driverId})
    RETURNING id`;
  return row!.id as string;
}

before(async () => {
  for (const [name, phone] of [[MINE, '8455557001'], [OTHER, '8455557002']] as const) {
    await sql`INSERT INTO drivers (name, phone, active) VALUES (${name}, ${phone}, true)
      ON CONFLICT (name) DO UPDATE SET active = true`;
  }
  [{ id: mineId }] = await sql`SELECT id FROM drivers WHERE name = ${MINE}` as any;
  [{ id: otherId }] = await sql`SELECT id FROM drivers WHERE name = ${OTHER}` as any;
});

beforeEach(async () => {
  await sql`DELETE FROM rate_limits WHERE bucket LIKE '%:198.51.100.%'`;
  await sql`DELETE FROM trips WHERE driver_id IN (${mineId}, ${otherId}) OR passenger_name = 'Test Passenger'`;
  await sql`DELETE FROM driver_sign_in_codes WHERE driver_id IN (${mineId}, ${otherId})`;
  await sql`DELETE FROM notifications WHERE driver_id IN (${mineId}, ${otherId})`;
  await sql`DELETE FROM driver_sessions WHERE driver_id IN (${mineId}, ${otherId})`;
  mineToken = await signIn(MINE);
  otherToken = await signIn(OTHER);
});

after(async () => {
  await sql`DELETE FROM trips WHERE driver_id IN (${mineId}, ${otherId}) OR passenger_name = 'Test Passenger'`;
  await sql`DELETE FROM drivers WHERE name IN (${MINE}, ${OTHER})`;
  await sql`DELETE FROM rate_limits WHERE bucket LIKE '%:198.51.100.%'`;
  await sql.end();
});

describe('the driver’s day', () => {
  it('shows only this driver’s trips for today', async () => {
    const today = await officeToday();
    await makeTrip(mineId, today);
    await makeTrip(otherId, today);
    await makeTrip(null, today); // unassigned: belongs to the office

    const { status, body } = await call('/api/driver/day?which=today', mineToken);
    assert.equal(status, 200);
    assert.equal(body.data.trips.length, 1, 'one trip, not three');
    assert.equal(body.data.date, today);
  });

  it('carries the office clock so the phone can correct its own', async () => {
    const { body } = await call('/api/driver/day?which=today', mineToken);
    assert.match(body.data.serverNow, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(body.data.serverClock, /^\d{2}:\d{2}$/);
    assert.equal(body.data.timeZone, 'America/New_York');
  });

  it('sorts an untimed trip last, not at midnight', async () => {
    const today = await officeToday();
    await makeTrip(mineId, today, '14:00');
    const [row] = await sql`INSERT INTO trips (service_date, passenger_name, pickup, driver_id)
      VALUES (${today}, 'Test Passenger', 'No time set', ${mineId}) RETURNING id`;
    await makeTrip(mineId, today, '08:00');

    const { body } = await call('/api/driver/day?which=today', mineToken);
    assert.equal(body.data.trips.length, 3);
    assert.equal(body.data.trips.at(-1).id, row!.id, 'the trip with no time goes last');
    assert.equal(body.data.trips[0].scheduledTime, '08:00:00');
  });

  it('shows tomorrow, marked read-only', async () => {
    const [row] = await sql`SELECT to_char(((now() AT TIME ZONE 'America/New_York') + interval '1 day')::date, 'YYYY-MM-DD') d`;
    await makeTrip(mineId, row!.d);
    const { body } = await call('/api/driver/day?which=tomorrow', mineToken);
    assert.equal(body.data.trips.length, 1);
    assert.equal(body.data.readOnly, true);
  });

  it('refuses without a token', async () => {
    assert.equal((await call('/api/driver/day?which=today', null)).status, 401);
  });
});

describe('tapping through a trip', () => {
  it('walks the five steps and stamps each with the server’s clock', async () => {
    const today = await officeToday();
    const trip = await makeTrip(mineId, today);
    const steps = ['IN ROUTE', 'PICKUP LOCATION', 'INTRANSIT', 'DROPOFF LOCATION', 'COMPLETE'];

    for (const progress of steps) {
      const { status, body } = await tap(mineToken, trip, { progress, idempotencyKey: randomUUID() });
      assert.equal(status, 200, `${progress} should be accepted`);
      assert.equal(body.data.applied, true);
      assert.equal(body.data.trip.progress, progress);
    }

    const [row] = await sql`SELECT driver_progress, pickup_arrival_at, pickup_departure_at,
      dropoff_arrival_at, dropoff_departure_at FROM trips WHERE id = ${trip}`;
    assert.equal(row!.driver_progress, 'complete');
    for (const stamp of ['pickup_arrival_at', 'pickup_departure_at', 'dropoff_arrival_at', 'dropoff_departure_at']) {
      assert.ok(row![stamp], `${stamp} should have been written`);
    }
  });

  it('never applies the same tap twice, however many times it is re-sent', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    const key = randomUUID();

    const first = await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: key });
    assert.equal(first.body.data.applied, true);

    // The offline queue re-sends the very same tap. It must read as success —
    // the driver did tap — but must not be applied again.
    for (let i = 0; i < 4; i++) {
      const again = await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: key });
      assert.equal(again.status, 200);
      assert.equal(again.body.data.applied, false);
      assert.equal(again.body.data.alreadyApplied, true);
    }

    const [{ c }] = await sql`SELECT count(*)::int c FROM trip_events WHERE trip_id = ${trip} AND kind = 'driver_tap'`;
    assert.equal(c, 1, 'one tap, one event');
  });

  it('counts a simultaneous re-send once', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: key })),
    );
    assert.equal(results.filter((r) => r.body.data?.applied).length, 1, 'exactly one should apply');
    assert.ok(results.every((r) => r.status === 200), 'the rest are success, not errors');
    const [{ c }] = await sql`SELECT count(*)::int c FROM trip_events WHERE trip_id = ${trip}`;
    assert.equal(c, 1);
  });

  it('never moves a trip backwards, however late a tap arrives', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    for (const progress of ['IN ROUTE', 'PICKUP LOCATION', 'INTRANSIT']) {
      await tap(mineToken, trip, { progress, idempotencyKey: randomUUID() });
    }

    // A tap made half an hour ago, drained from the queue now.
    const stale = await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    assert.equal(stale.status, 200, 'a late tap is not the driver’s problem');
    assert.equal(stale.body.data.applied, false);
    assert.equal(stale.body.data.trip.progress, 'INTRANSIT', 'the trip stays where it got to');
  });

  it('records what the phone believed without acting on it', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    const phoneTime = '2020-01-01T00:00:00.000Z'; // a badly wrong device clock
    await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID(), tappedAt: phoneTime });

    const [row] = await sql`SELECT occurred_at, payload FROM trip_events WHERE trip_id = ${trip}`;
    assert.equal(row!.payload.tappedAt, phoneTime, 'the phone’s claim is kept for the trail');
    assert.ok(
      new Date(row!.occurred_at).getTime() > Date.parse('2024-01-01'),
      'but the stamp is the server’s clock, not the phone’s',
    );
  });

  it('refuses a step that is not a real step', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    const { status, body } = await tap(mineToken, trip, { progress: 'TELEPORTED', idempotencyKey: randomUUID() });
    assert.equal(status, 400);
    assert.equal(body.reason, 'validation');
  });

  it('refuses a tap with no nonce', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    assert.equal((await tap(mineToken, trip, { progress: 'IN ROUTE' })).status, 400);
  });
});

describe('whose trip it is', () => {
  it("refuses another driver's trip", async () => {
    const trip = await makeTrip(otherId, await officeToday());
    const { status, body } = await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    assert.equal(status, 404, 'not yours reads the same as not found');
    assert.equal(body.ok, false);
    const [row] = await sql`SELECT driver_progress FROM trips WHERE id = ${trip}`;
    assert.equal(row!.driver_progress, 'none', "the other driver's trip is untouched");
  });

  it('refuses an unassigned trip — it belongs to the office, not whoever asks', async () => {
    const trip = await makeTrip(null, await officeToday());
    assert.equal((await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() })).status, 404);
  });

  it('refuses a trip that does not exist, in the same words', async () => {
    const theirs = await makeTrip(otherId, await officeToday());
    const nothing = await tap(mineToken, randomUUID(), { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    const someoneElses = await tap(mineToken, theirs, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    assert.equal(nothing.status, someoneElses.status);
    assert.equal(nothing.body.message, someoneElses.body.message, 'no way to probe which ids are real');
  });

  it('stops a driver the moment they leave the roster, mid-trip', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    assert.equal((await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() })).status, 200);
    await sql`UPDATE drivers SET active = false WHERE id = ${mineId}`;
    const after = await tap(mineToken, trip, { progress: 'PICKUP LOCATION', idempotencyKey: randomUUID() });
    assert.equal(after.status, 401);
    await sql`UPDATE drivers SET active = true WHERE id = ${mineId}`;
  });

  it("refuses tomorrow's trips, so tomorrow is read-only by construction", async () => {
    const [row] = await sql`SELECT to_char(((now() AT TIME ZONE 'America/New_York') + interval '1 day')::date, 'YYYY-MM-DD') d`;
    const trip = await makeTrip(mineId, row!.d);
    const { status, body } = await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    assert.equal(status, 400);
    assert.match(body.message, /today/i);
  });
});

describe('undoing a tap', () => {
  it('clears the step AND its stamp', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    await tap(mineToken, trip, { progress: 'PICKUP LOCATION', idempotencyKey: randomUUID() });

    const before = await sql`SELECT pickup_arrival_at FROM trips WHERE id = ${trip}`;
    assert.ok(before[0]!.pickup_arrival_at, 'the stamp was written');

    const { status, body } = await call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    assert.equal(status, 200);
    assert.equal(body.data.progress, 'IN ROUTE', 'steps back exactly one place');

    const [row] = await sql`SELECT driver_progress, pickup_arrival_at FROM trips WHERE id = ${trip}`;
    assert.equal(row!.driver_progress, 'in_route');
    // Leaving the stamp behind let the step re-assert itself on the next read.
    assert.equal(row!.pickup_arrival_at, null, 'the stamp must be cleared too');
  });

  it('is idempotent, like a tap', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    const key = randomUUID();
    const undo = () => call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: key }),
    });
    assert.equal((await undo()).body.data.progress, '');
    assert.equal((await undo()).body.data.progress, '', 'a re-sent undo changes nothing further');
  });

  it("refuses to undo another driver's trip", async () => {
    const trip = await makeTrip(otherId, await officeToday());
    const { status } = await call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    assert.equal(status, 404);
  });
});
