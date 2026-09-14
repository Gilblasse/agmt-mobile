import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canAdvance, stampFieldFor } from '@ag/rules';
import { db } from '@/lib/db';
import { tripEvents, trips } from '@/lib/db/schema';
import { authorizeDriverForTrip, refusalMessage } from '@/lib/auth/driver';
import { fail, ok, PRIVATE, readJson, UNREADABLE, withResult } from '@/lib/api/result';
import { isDriverProgress, progressToDb, progressToRules, type DriverProgressLabel } from '@/lib/db/enums';
import { officeToday } from '@/lib/office-clock';

/**
 * POST /api/driver/trips/:id/progress — `setDriverProgress` in the contract.
 *
 * This is the endpoint the whole rebuild is judged on. CLAUDE.md,
 * non-negotiable #2: a driver's tap is never lost and never applied twice.
 * Three separate rules make that true, and all three are enforced here rather
 * than on the phone, because the phone is the thing that might be underground:
 *
 *  1. **The nonce.** Every tap carries one. A re-send from the offline queue
 *     carries the same one, and the unique index on `trip_events` refuses it —
 *     the answer is success, not an error, because from the driver's point of
 *     view the tap did land.
 *  2. **The guard.** A tap may only ever raise a trip's progress. A stale tap
 *     drained from a queue hours later must not drag a completed trip back to
 *     "in route".
 *  3. **The clock.** The stamp written is the server's, never the phone's.
 *     What the phone believed is kept alongside, for the audit trail only.
 *
 * A driver may only tap today. Tomorrow is visible so they can plan; it is not
 * theirs to change, and that is enforced here rather than trusted to the app.
 */

const Tap = z.object({
  progress: z.string().refine(isDriverProgress, 'That is not a step a driver can tap.'),
  idempotencyKey: z.string().trim().min(8).max(200),
  /** What the phone's clock said. Recorded, never used to decide anything. */
  tappedAt: z.string().datetime().optional(),
});

export const POST = withResult(async (request: Request) => {
  const tripId = new URL(request.url).pathname.split('/').at(-2) ?? '';

  const body = await readJson(request);
  if (body === UNREADABLE) return fail('validation', 'The request body was not readable JSON.');
  const parsed = Tap.safeParse(body);
  if (!parsed.success) {
    return fail('validation', parsed.error.issues[0]?.message ?? 'That request was not understood.');
  }
  const { progress, idempotencyKey, tappedAt } = parsed.data;

  const access = await authorizeDriverForTrip(request, tripId);
  if (!access.ok) {
    return fail(access.reason === 'not-found' || access.reason === 'not-yours' ? 'not-found' : 'not-authorised',
      refusalMessage(access.reason));
  }
  const { driver, trip } = access;

  if (trip.serviceDate !== officeToday()) {
    return fail('validation', 'You can only update today’s trips.');
  }

  const current = progressToRules(trip.driverProgress as DriverProgressLabel);

  // The guard, before anything is written. A tap that would move the trip
  // backwards is not an error the driver has to deal with — they tapped
  // correctly, the news simply arrived late — so it reports what is already
  // true and changes nothing.
  if (!canAdvance(current, progress)) {
    return ok({ trip: { ...trip, progress: current }, applied: false, alreadyApplied: true }, PRIVATE);
  }

  const stampField = stampFieldFor(progress);
  const now = new Date().toISOString();

  const applied = await db.transaction(async (tx) => {
    // The nonce goes in first. If this tap has been seen before, the unique
    // index refuses it here and nothing else in the transaction happens.
    // `DO NOTHING` rather than catching a unique violation: a raised
    // error aborts the whole transaction in Postgres, so the rest of this
    // block could not run and the commit itself would fail. An empty
    // result here means the nonce has been seen before.
    const [event] = await tx
      .insert(tripEvents)
      .values({
        tripId: trip.id,
        kind: 'driver_tap',
        value: progressToDb(progress),
        actor: `driver:${driver.id}`,
        // The office's clock decides when this happened. `tappedAt` is what
        // the phone believed and is kept only so the trail shows the gap.
        occurredAt: now,
        payload: tappedAt ? { tappedAt } : null,
        idempotencyKey,
      })
      // The unique index is partial (`WHERE idempotency_key IS NOT NULL`), so
      // the conflict target has to carry the same predicate to match it.
      .onConflictDoNothing({
        target: tripEvents.idempotencyKey,
        where: sql`idempotency_key is not null`,
      })
      .returning({ id: tripEvents.id });
    if (!event) return null;

    const [updated] = await tx
      .update(trips)
      .set({
        driverProgress: progressToDb(progress),
        ...(stampField ? { [stampField]: now } : {}),
        updatedAt: now,
      })
      // Re-check the guard in the write itself, so two taps racing cannot both
      // pass the check above and apply out of order.
      .where(and(eq(trips.id, trip.id), sql`driver_progress = ${progressToDb(current)}`))
      .returning();

    return updated ?? null;
  });

  if (!applied) {
    // Either the nonce was a repeat, or another tap won the race. Both mean
    // the driver's tap is accounted for; read back what is true now.
    const [fresh] = await db.select().from(trips).where(eq(trips.id, trip.id)).limit(1);
    return ok(
      {
        trip: { ...fresh!, progress: progressToRules(fresh!.driverProgress as DriverProgressLabel) },
        applied: false,
        alreadyApplied: true,
      },
      PRIVATE,
    );
  }

  return ok(
    {
      trip: { ...applied, progress: progressToRules(applied.driverProgress as DriverProgressLabel) },
      applied: true,
      alreadyApplied: false,
    },
    PRIVATE,
  );
});

