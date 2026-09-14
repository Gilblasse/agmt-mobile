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
  // The running-late limit is keyed on the driver, not the address, so the
  // per-request address rotation above does not clear it.
  await sql`DELETE FROM rate_limits WHERE bucket LIKE ${'eta:%'}`;
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
  // The running-late limit is keyed on the driver, not the address, so the
  // per-request address rotation above does not clear it.
  await sql`DELETE FROM rate_limits WHERE bucket LIKE ${'eta:%'}`;
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
    // Two steps up, so a re-sent undo actually reaches the nonce check. From
    // one step up the trip lands on '' and the early return answers instead,
    // which made this test pass with the idempotency handling deleted.
    await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    await tap(mineToken, trip, { progress: 'PICKUP LOCATION', idempotencyKey: randomUUID() });

    const key = randomUUID();
    const undo = () => call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: key }),
    });
    assert.equal((await undo()).body.data.progress, 'IN ROUTE');
    assert.equal((await undo()).body.data.progress, 'IN ROUTE', 'a re-sent undo steps back no further');

    const [{ c }] = await sql`SELECT count(*)::int c FROM trip_events
      WHERE trip_id = ${trip} AND kind = 'driver_undo'`;
    assert.equal(c, 1, 'one undo recorded, not two');
  });

  it("refuses to undo another driver's trip", async () => {
    const trip = await makeTrip(otherId, await officeToday());
    const { status } = await call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    assert.equal(status, 404);
  });
});

/**
 * The cases an independent review found the first version of this suite could
 * not see. Every one of them passed against code that was losing taps.
 */
describe('the ways a tap can be lost', () => {
  it('applies both taps when two arrive together on one trip', async () => {
    // The ordinary offline-queue drain pattern: commit one tap, send the next
    // immediately. The loser used to spend its nonce, fail its update, and be
    // answered "success" — the step gone, its stamp never written, its
    // re-send permanently refused.
    for (let round = 0; round < 6; round++) {
      const trip = await makeTrip(mineId, await officeToday());
      await Promise.all([
        tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() }),
        tap(mineToken, trip, { progress: 'PICKUP LOCATION', idempotencyKey: randomUUID() }),
      ]);
      const [row] = await sql`SELECT driver_progress, pickup_arrival_at FROM trips WHERE id = ${trip}`;
      assert.equal(row!.driver_progress, 'pickup_location', `round ${round}: both taps must land`);
      assert.ok(row!.pickup_arrival_at, `round ${round}: the stamp must be written`);
    }
  });

  it('keeps one trip’s nonce out of another trip’s way', async () => {
    const today = await officeToday();
    const a = await makeTrip(mineId, today);
    const b = await makeTrip(mineId, today);
    const shared = 'a-phone-numbering-taps-per-trip';

    const first = await tap(mineToken, a, { progress: 'IN ROUTE', idempotencyKey: shared });
    const second = await tap(mineToken, b, { progress: 'IN ROUTE', idempotencyKey: shared });

    assert.equal(first.body.data.applied, true);
    assert.equal(second.body.data.applied, true, "the second trip's tap must not be swallowed");
    const [rowB] = await sql`SELECT driver_progress FROM trips WHERE id = ${b}`;
    assert.equal(rowB!.driver_progress, 'in_route');
  });

  it('does not let an undo borrow a tap’s nonce', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    const key = 'shared-between-tap-and-undo';
    await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: key });
    await tap(mineToken, trip, { progress: 'PICKUP LOCATION', idempotencyKey: randomUUID() });

    const { body } = await call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: key }),
    });
    assert.equal(body.data.undone, true, 'the undo must not be mistaken for the earlier tap');
    assert.equal(body.data.progress, 'IN ROUTE');
  });

  it('records a skipped step rather than losing the gap silently', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await tap(mineToken, trip, { progress: 'COMPLETE', idempotencyKey: randomUUID() });
    const notes = await sql`SELECT value FROM trip_events WHERE trip_id = ${trip} AND kind = 'note'`;
    assert.equal(notes.length, 1, 'the skipped steps are flagged for the office');
    assert.match(notes[0]!.value, /IN ROUTE/);
  });
});

describe('steps that are not steps', () => {
  for (const bogus of ['', 'constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
    it(`refuses ${JSON.stringify(bogus)} instead of calling it already done`, async () => {
      const trip = await makeTrip(mineId, await officeToday());
      const { status, body } = await tap(mineToken, trip, { progress: bogus, idempotencyKey: randomUUID() });
      assert.equal(status, 400, 'a step that does not exist is a validation error');
      assert.equal(body.reason, 'validation');
    });
  }

  it('refuses a mangled trip id as "not yours", not a server error', async () => {
    for (const id of ['hello', '123', 'not-a-uuid-at-all']) {
      const { status, body } = await tap(mineToken, id, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
      assert.equal(status, 404, `${id} should read as not found`);
      assert.equal(body.ok, false);
    }
  });
});

describe('a trip that crosses midnight', () => {
  it('can still be tapped the next morning while it is unfinished', async () => {
    const [row] = await sql`SELECT to_char(((now() AT TIME ZONE 'America/New_York') - interval '1 day')::date, 'YYYY-MM-DD') d`;
    const trip = await makeTrip(mineId, row!.d, '23:45');
    await sql`UPDATE trips SET driver_progress = 'in_transit' WHERE id = ${trip}`;

    const { status, body } = await tap(mineToken, trip, { progress: 'COMPLETE', idempotencyKey: randomUUID() });
    assert.equal(status, 200, 'the driver is physically inside this trip');
    assert.equal(body.data.applied, true);
    const [after] = await sql`SELECT dropoff_departure_at FROM trips WHERE id = ${trip}`;
    assert.ok(after!.dropoff_departure_at, 'the drop-off must be stamped');
  });

  it('closes the day once that trip is finished', async () => {
    const [row] = await sql`SELECT to_char(((now() AT TIME ZONE 'America/New_York') - interval '1 day')::date, 'YYYY-MM-DD') d`;
    const trip = await makeTrip(mineId, row!.d);
    await sql`UPDATE trips SET driver_progress = 'complete' WHERE id = ${trip}`;
    const { status, body } = await tap(mineToken, trip, { progress: 'COMPLETE', idempotencyKey: randomUUID() });
    assert.equal(status, 409);
    assert.equal(body.reason, 'day-locked', 'a reason the phone can act on, not a silent discard');
  });
});

describe('undo is bounded', () => {
  it('refuses once the moment has passed, rather than erasing the record', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    for (const progress of ['IN ROUTE', 'PICKUP LOCATION', 'INTRANSIT', 'DROPOFF LOCATION', 'COMPLETE']) {
      await tap(mineToken, trip, { progress, idempotencyKey: randomUUID() });
    }
    // Age the taps past the window: the driver's six seconds are long gone.
    await sql`UPDATE trip_events SET occurred_at = now() - interval '10 minutes'
      WHERE trip_id = ${trip} AND kind = 'driver_tap'`;

    const { status, body } = await call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    assert.equal(status, 409);
    assert.equal(body.reason, 'conflict');

    const [row] = await sql`SELECT driver_progress, pickup_arrival_at, dropoff_departure_at
      FROM trips WHERE id = ${trip}`;
    assert.equal(row!.driver_progress, 'complete', 'the completed trip stands');
    assert.ok(row!.pickup_arrival_at && row!.dropoff_departure_at, 'every stamp survives');
  });

  it('does not record an undo that did not happen', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    await sql`UPDATE trip_events SET occurred_at = now() - interval '10 minutes' WHERE trip_id = ${trip}`;
    await call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    const [{ c }] = await sql`SELECT count(*)::int c FROM trip_events WHERE trip_id = ${trip} AND kind = 'driver_undo'`;
    assert.equal(c, 0, 'trip_events is what actually happened');
  });
});

describe("the office's column is not the driver's", () => {
  it('leaves dispatch_status untouched by a tap and an undo', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await sql`UPDATE trips SET dispatch_status = 'ready', dispatch_status_at = now(),
      dispatch_status_by = 'office@example.com' WHERE id = ${trip}`;
    const [before] = await sql`SELECT dispatch_status, dispatch_status_at, dispatch_status_by FROM trips WHERE id = ${trip}`;

    await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    await call(`/api/driver/trips/${trip}/undo`, mineToken, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });

    const [after] = await sql`SELECT dispatch_status, dispatch_status_at, dispatch_status_by FROM trips WHERE id = ${trip}`;
    assert.deepEqual(after, before, "the office's call on the trip is theirs alone");
  });
});

describe('telling dispatch you are running late', () => {
  const eta = (token: string, tripId: string, body: unknown) =>
    call(`/api/driver/trips/${tripId}/eta`, token, { method: 'POST', body: JSON.stringify(body) });

  it('turns the driver’s "minutes away" into a time on the office clock', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    const { status, body } = await eta(mineToken, trip, { minutesFromNow: 15, reason: 'Traffic' });
    assert.equal(status, 200);
    assert.equal(body.data.noted, true);
    // The phone sent a relative offset and never a clock time; the office
    // worked out the time. A phone an hour out cannot write a wrong arrival.
    assert.match(body.data.arriving, /^\d{1,2}:\d{2} (AM|PM)$/);

    const [row] = await sql`SELECT notes FROM trips WHERE id = ${trip}`;
    assert.match(row!.notes, /DRIVER RUNNING LATE: arriving about \d{1,2}:\d{2} (AM|PM) - Traffic/);
  });

  it('keeps whatever the office had already written on the trip', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await sql`UPDATE trips SET notes = 'Passenger uses a walker' WHERE id = ${trip}`;
    await eta(mineToken, trip, { minutesFromNow: 5 });
    const [row] = await sql`SELECT notes FROM trips WHERE id = ${trip}`;
    assert.match(row!.notes, /Passenger uses a walker/, 'the office note survives');
    assert.match(row!.notes, /DRIVER RUNNING LATE/);
  });

  it('does not stack identical warnings when the driver taps twice at once', async () => {
    // Sequentially, this passed against an implementation with no dedupe
    // transaction at all. Eight simultaneous taps left seven extra lines on
    // the dispatcher's note, and told seven callers it had not been flagged.
    const trip = await makeTrip(mineId, await officeToday());
    await Promise.all(
      Array.from({ length: 8 }, () => eta(mineToken, trip, { minutesFromNow: 10 })),
    );
    const [row] = await sql`SELECT notes FROM trips WHERE id = ${trip}`;
    assert.equal(
      (row!.notes.match(/DRIVER RUNNING LATE/g) ?? []).length,
      1,
      'one warning on the board however many taps arrive together',
    );
  });

  it('does not stack identical warnings when the driver taps twice', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await eta(mineToken, trip, { minutesFromNow: 10 });
    const second = await eta(mineToken, trip, { minutesFromNow: 20 });
    assert.equal(second.body.data.alreadyFlagged, true);

    const [row] = await sql`SELECT notes FROM trips WHERE id = ${trip}`;
    assert.equal(row!.notes.match(/DRIVER RUNNING LATE/g).length, 1, 'one warning on the board');

    // But both reports are in the trail, so "they told us twice" is answerable.
    const [{ c }] = await sql`SELECT count(*)::int c FROM trip_events
      WHERE trip_id = ${trip} AND kind = 'note'`;
    assert.equal(c, 2);
  });

  it('strips anything that is not words, everywhere it is stored', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await eta(mineToken, trip, { minutesFromNow: 5, reason: 'Traffic <script>x</script> & "stuff"' });
    const [row] = await sql`SELECT notes FROM trips WHERE id = ${trip}`;
    assert.doesNotMatch(row!.notes, /[<>&"]/, 'the note is words only');
    assert.match(row!.notes, /Traffic/);

    // The same untrusted string is stored twice, and the event payload is
    // served to the office through getTripActivity. It was going in raw.
    const [event] = await sql`SELECT payload FROM trip_events
      WHERE trip_id = ${trip} AND kind = 'note' ORDER BY occurred_at DESC LIMIT 1`;
    assert.doesNotMatch(JSON.stringify(event!.payload), /[<>]/, 'the payload is sanitised too');
  });

  it('keeps a newline from gluing two words together', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    await eta(mineToken, trip, { minutesFromNow: 5, reason: 'Route 9\nwill be slow' });
    const [row] = await sql`SELECT notes FROM trips WHERE id = ${trip}`;
    assert.match(row!.notes, /Route 9 will be slow/, 'the words stay separate');
  });

  it("is not silenced by an office note that happens to say the words", async () => {
    // A substring search of trips.notes suppressed a genuine notice and told
    // the driver dispatch had been informed. Dispatch had not.
    const trip = await makeTrip(mineId, await officeToday());
    await sql`UPDATE trips SET notes = 'Call office if DRIVER RUNNING LATE' WHERE id = ${trip}`;
    const { body } = await eta(mineToken, trip, { minutesFromNow: 12 });
    assert.equal(body.data.alreadyFlagged, false, 'the office note is not a driver report');
    const [row] = await sql`SELECT notes FROM trips WHERE id = ${trip}`;
    assert.match(row!.notes, /arriving about/, 'the real notice reached the note');
  });

  it('refuses a flood of notices rather than filling the trip', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    const results = [];
    for (let i = 0; i < 9; i++) results.push(await eta(mineToken, trip, { minutesFromNow: i }));
    assert.ok(results.some((r) => r.status === 429), 'a ceiling exists');
  });

  it('refuses a nonsense offset', async () => {
    const trip = await makeTrip(mineId, await officeToday());
    for (const minutesFromNow of [-5, 1000, 'soon']) {
      const { status } = await eta(mineToken, trip, { minutesFromNow });
      assert.equal(status, 400, `${minutesFromNow} should be refused`);
    }
  });

  it("refuses another driver's trip", async () => {
    const trip = await makeTrip(otherId, await officeToday());
    assert.equal((await eta(mineToken, trip, { minutesFromNow: 5 })).status, 404);
  });
});

describe('every answer is the envelope', () => {
  it('answers an unknown /api path with JSON, not an HTML error page', async () => {
    // A phone that always parses the body as JSON throws on Next's HTML 404,
    // and the driver sees a crash instead of a message.
    const res = await fetch(`${BASE}/api/nothing/here`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await res.json() as Json).reason, 'not-found');
  });

  it('answers the wrong method with JSON, not an empty 405', async () => {
    for (const [path, method] of [['/api/driver/sign-in', 'GET'], ['/api/driver/day', 'POST']] as const) {
      const res = await fetch(`${BASE}${path}`, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.equal((await res.json() as Json).ok, false);
    }
  });
});

describe('the day version', () => {
  it('stays put while nothing changes, and moves when something does', async () => {
    const today = await officeToday();
    const trip = await makeTrip(mineId, today);

    const first = await call('/api/driver/day?which=today', mineToken);
    const unchanged = await call('/api/driver/day?which=today', mineToken);
    assert.ok(first.body.data.version, 'a version is sent');
    assert.equal(unchanged.body.data.version, first.body.data.version, 'nothing moved');

    await tap(mineToken, trip, { progress: 'IN ROUTE', idempotencyKey: randomUUID() });
    const afterTap = await call('/api/driver/day?which=today', mineToken);
    assert.notEqual(afterTap.body.data.version, first.body.data.version, 'a tap moves it');

    await makeTrip(mineId, today, '15:00');
    const afterAdd = await call('/api/driver/day?which=today', mineToken);
    assert.notEqual(afterAdd.body.data.version, afterTap.body.data.version, 'a new trip moves it');
  });
});
