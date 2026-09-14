import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { stampFieldFor, undoTarget } from '@ag/rules';
import { db } from '@/lib/db';
import { tripEvents, trips } from '@/lib/db/schema';
import { authorizeDriverForTrip, refusalMessage } from '@/lib/auth/driver';
import { fail, ok, PRIVATE, readJson, UNREADABLE, withResult } from '@/lib/api/result';
import { progressToDb, progressToRules, type DriverProgressLabel } from '@/lib/db/enums';
import { officeToday } from '@/lib/office-clock';

/**
 * POST /api/driver/trips/:id/undo — `undoDriverProgress` in the contract.
 *
 * The phone gives a driver a few seconds to take back a mistaken tap. The
 * contract is explicit that this must clear the stamp **and** the progress:
 * leaving the timestamp behind was a real failure, because the next read put
 * the step back again from a stamp that should no longer exist.
 *
 * This is the one write that deliberately moves a trip backwards, so it does
 * not go through the monotonic guard — it steps back exactly one place, to
 * whatever `undoTarget` says precedes the current step.
 */

const Undo = z.object({ idempotencyKey: z.string().trim().min(8).max(200) });

export const POST = withResult(async (request: Request) => {
  const tripId = new URL(request.url).pathname.split('/').at(-2) ?? '';

  const body = await readJson(request);
  if (body === UNREADABLE) return fail('validation', 'The request body was not readable JSON.');
  const parsed = Undo.safeParse(body);
  if (!parsed.success) return fail('validation', 'An undo needs its own key.');

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
  if (current === '') {
    return ok({ ...trip, progress: current }, PRIVATE);
  }

  const target = undoTarget(current);
  const now = new Date().toISOString();
  // The stamp belonging to the step being taken back — cleared, not left
  // behind to re-assert itself on the next read.
  const stampField = stampFieldFor(current);

  const reverted = await db.transaction(async (tx) => {
    // `DO NOTHING` rather than catching a unique violation: a raised
    // error aborts the whole transaction in Postgres, so the rest of this
    // block could not run and the commit itself would fail. An empty
    // result here means the nonce has been seen before.
    const [event] = await tx
      .insert(tripEvents)
      .values({
        tripId: trip.id,
        kind: 'driver_undo',
        value: progressToDb(target),
        actor: `driver:${driver.id}`,
        occurredAt: now,
        idempotencyKey: parsed.data.idempotencyKey,
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
        driverProgress: progressToDb(target),
        ...(stampField ? { [stampField]: null } : {}),
        updatedAt: now,
      })
      .where(and(eq(trips.id, trip.id), sql`driver_progress = ${progressToDb(current)}`))
      .returning();

    return updated ?? null;
  });

  const [fresh] = reverted
    ? [reverted]
    : await db.select().from(trips).where(eq(trips.id, trip.id)).limit(1);

  return ok(
    { ...fresh!, progress: progressToRules(fresh!.driverProgress as DriverProgressLabel) },
    PRIVATE,
  );
});

