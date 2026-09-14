import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { trips } from '@/lib/db/schema';
import { authenticateDriver } from '@/lib/auth/driver';
import { fail, ok, PRIVATE, withResult } from '@/lib/api/result';
import { progressToRules, type DriverProgressLabel } from '@/lib/db/enums';
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

  return ok(
    {
      driver: auth.driver,
      date,
      readOnly: which === 'tomorrow',
      trips: ordered.map((trip) => ({
        ...trip,
        progress: progressToRules(trip.driverProgress as DriverProgressLabel),
      })),
      ...serverClock(now),
    },
    PRIVATE,
  );
});
