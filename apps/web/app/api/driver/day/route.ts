import { createHash } from 'node:crypto';
import type { Api, Result } from '@ag/rules/api';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { trips } from '@/lib/db/schema';
import { authenticateDriver } from '@/lib/auth/driver';
import { fail, ok, PRIVATE, withResult, onlyGet} from '@/lib/api/result';
import { progressToRules, toLabel } from '@/lib/db/enums';
import { officeToday, officeTomorrow, serverClock } from '@/lib/office-clock';
import { timeSortValue } from '@ag/rules';

/**
 * GET /api/driver/day?which=today|tomorrow — `getDriverDay` in the contract.
 *
 * One driver, one day, their trips only. Tomorrow is readable so a driver can
 * plan, but carries no taps — the progress endpoint refuses any day but today,
 * so tomorrow is read-only by construction rather than by the phone's good
 * behaviour.
 *
 * Every payload carries the server's clock. The phone uses it to correct its
 * own, and must never compute "how long have I been waiting" from the device
 * clock alone.
 */
export const GET = withResult(async (request: Request) => {
  const auth = await authenticateDriver(request);
  if (!auth.ok) {
    return fail(
      'not-authorised',
      auth.reason === 'off-roster'
        ? 'This account is no longer active. Ask the office.'
        : 'Please sign in again.',
    );
  }

  const which = new URL(request.url).searchParams.get('which') ?? 'today';
  if (which !== 'today' && which !== 'tomorrow') {
    return fail('validation', "Ask for either today's trips or tomorrow's.");
  }

  const now = new Date();
  const date = which === 'today' ? officeToday(now) : officeTomorrow(now);

  const rows = await db
    .select()
    .from(trips)
    .where(and(eq(trips.driverId, auth.driver.id), eq(trips.serviceDate, date)))
    .orderBy(asc(trips.scheduledTime), asc(trips.id));

  // A trip with no time set sorts last rather than first — the old system
  // wrote 23:58 to mean "nobody typed a time", and an untimed trip is not a
  // midnight trip. `timeSortValue` carries that rule.
  const ordered = [...rows].sort(
    (a, b) => timeSortValue(a.scheduledTime) - timeSortValue(b.scheduledTime),
  );

  // A digest of the whole set, not the newest stamp in it. `max(updated_at)`
  // looked equivalent and was not: a long office transaction commits a row
  // stamped when that transaction *began*, so an edit could land with a
  // timestamp older than one already seen and the token would not move — the
  // phone skips the redraw and the driver keeps the old pickup address. A
  // digest moves whenever any row's stamp changes in either direction.
  const version = createHash('sha256')
    .update(rows.map((trip) => `${trip.id}:${trip.updatedAt}`).join(','))
    .digest('hex')
    .slice(0, 16);

  // Bound to the contract, so a payload that drifts from `Api` is a compile
  // error rather than something a client discovers. Nothing checked this
  // before: `ok<T>` infers T from its argument, so any shape type-checked.
  const payload: DayPayload = {
      driver: auth.driver,
      date,
      version,
      readOnly: which === 'tomorrow',
      // Named rather than spread: a driver gets what they need to do the trip.
      // Spreading the row also handed the phone the Medicaid number, the
      // quoted price and an office email.
      trips: ordered.map((trip) => ({
        id: trip.id,
        serviceDate: trip.serviceDate,
        scheduledTime: trip.scheduledTime,
        startTime: trip.startTime,
        passengerName: trip.passengerName,
        phone: trip.phone,
        transport: trip.transport,
        pickup: trip.pickup,
        dropoff: trip.dropoff,
        pickupNotes: trip.pickupNotes,
        dropoffNotes: trip.dropoffNotes,
        notes: trip.notes,
        dispatchStatus: trip.dispatchStatus as DayPayload['trips'][number]['dispatchStatus'],
        progress: progressToRules(toLabel(trip.driverProgress)),
        pickupArrivalAt: trip.pickupArrivalAt,
        pickupDepartureAt: trip.pickupDepartureAt,
        dropoffArrivalAt: trip.dropoffArrivalAt,
        dropoffDepartureAt: trip.dropoffDepartureAt,
      })),
      ...serverClock(now),
  };

  return ok(payload, PRIVATE);
});

type DayPayload =
  Awaited<ReturnType<Api['getDriverDay']>> extends Result<infer D> ? D : never;

export const { POST, PUT, PATCH, DELETE, OPTIONS } = onlyGet;
