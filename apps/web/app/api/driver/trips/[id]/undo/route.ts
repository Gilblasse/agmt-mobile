import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { stampFieldFor, undoTarget } from '@ag/rules';
import { db } from '@/lib/db';
import { tripEvents, trips } from '@/lib/db/schema';
import { authorizeDriverForTrip, refusalMessage } from '@/lib/auth/driver';
import { fail, ok, PRIVATE, readJson, UNREADABLE, withResult } from '@/lib/api/result';
import { progressToDb, progressToRules, toLabel } from '@/lib/db/enums';
import { tappability } from '@/lib/office-clock';

/**
 * POST /api/driver/trips/:id/undo — `undoDriverProgress` in the contract.
 *
 * The phone gives a driver a few seconds to take back a mistaken tap. Two
 * things make that safe, and neither was here before.
 *
 * It is bounded in time. Without a window this was a ratchet in reverse:
 * six calls stripped a completed trip back to nothing and blanked all four
 * timestamps — the record payroll and invoices are read from — hours later,
 * for anyone holding the phone. The app offers six seconds; the server allows
 * a minute, which is generous for a bad connection and still an undo rather
 * than a rewrite.
 *
 * It is decided under a lock. The event used to be written before the update
 * was known to have applied, so an undo that changed nothing still recorded
 * that it had, and answered success. `trip_events` is "what actually
 * happened"; it must not contain things that did not.
 */

const Undo = z.object({ idempotencyKey: z.string().trim().min(8).max(200) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long after a tap the server will still take it back. */
const UNDO_WINDOW_SECONDS = 60;

export const POST = withResult(async (request: Request) => {
  const tripId = new URL(request.url).pathname.split('/').at(-2) ?? '';
  if (!UUID.test(tripId)) return fail('not-found', refusalMessage('not-found'));

  const access = await authorizeDriverForTrip(request, tripId);
  if (!access.ok) {
    return fail(
      access.reason === 'not-found' || access.reason === 'not-yours' ? 'not-found' : 'not-authorised',
      refusalMessage(access.reason),
    );
  }
  const { driver, trip } = access;

  const body = await readJson(request);
  if (body === UNREADABLE) return fail('validation', 'The request body was not readable JSON.');
  const parsed = Undo.safeParse(body);
  if (!parsed.success) return fail('validation', 'An undo needs its own key.');

  const day = tappability(trip.serviceDate, trip.driverProgress);
  if (day === 'not-yet') return fail('validation', 'You can only update today\u2019s trips.');
  if (day === 'closed') {
    return fail('day-locked', 'That day is closed. Ask the office to change it.');
  }

  const outcome = await db.transaction(async (tx) => {
    const locked = (await tx.execute(
      sql`SELECT driver_progress FROM trips WHERE id = ${trip.id} FOR UPDATE`,
    )) as unknown as Array<{ driver_progress: string }>;
    if (!locked[0]) return { kind: 'gone' } as const;

    const current = progressToRules(toLabel(locked[0].driver_progress));
    if (current === '') return { kind: 'nothing-to-undo' } as const;

    // Only the tap just made. Anything older is history, not a slip.
    const [lastTap] = await tx
      .select({ occurredAt: tripEvents.occurredAt })
      .from(tripEvents)
      .where(sql`${tripEvents.tripId} = ${trip.id} AND ${tripEvents.kind} = 'driver_tap'`)
      .orderBy(desc(tripEvents.occurredAt))
      .limit(1);
    const tappedAgo = lastTap ? Date.now() - new Date(lastTap.occurredAt).getTime() : Infinity;
    if (tappedAgo > UNDO_WINDOW_SECONDS * 1000) return { kind: 'too-late' } as const;

    const [event] = await tx
      .insert(tripEvents)
      .values({
        tripId: trip.id,
        kind: 'driver_undo',
        value: progressToDb(undoTarget(current)),
        actor: `driver:${driver.id}`,
        occurredAt: new Date().toISOString(),
        idempotencyKey: `undo:${parsed.data.idempotencyKey}`,
      })
      .onConflictDoNothing({
        target: [tripEvents.tripId, tripEvents.idempotencyKey],
        where: sql`idempotency_key is not null`,
      })
      .returning({ id: tripEvents.id });
    if (!event) return { kind: 'duplicate' } as const;

    const now = new Date().toISOString();
    // The stamp belonging to the step being taken back is cleared as well as
    // the step. Left behind, it put the step back on the next read.
    const stampField = stampFieldFor(current);
    const [updated] = await tx
      .update(trips)
      .set({
        driverProgress: progressToDb(undoTarget(current)),
        ...(stampField ? { [stampField]: null } : {}),
        updatedAt: now,
      })
      .where(eq(trips.id, trip.id))
      .returning();

    return { kind: 'undone', trip: updated } as const;
  });

  if (outcome.kind === 'gone') return fail('not-found', refusalMessage('not-found'));
  if (outcome.kind === 'too-late') {
    return fail('conflict', 'That is too long ago to undo. Ask the office to change it.');
  }

  if (outcome.kind === 'undone') {
    return ok({ ...withProgress(outcome.trip), undone: true }, PRIVATE);
  }

  // Nothing to undo, or this undo has already been applied. Either way, tell
  // the phone what is true now rather than what was true before the lock.
  const [fresh] = await db.select().from(trips).where(eq(trips.id, trip.id)).limit(1);
  if (!fresh) return fail('not-found', refusalMessage('not-found'));
  return ok({ ...withProgress(fresh), undone: false }, PRIVATE);
});

function withProgress<T extends { driverProgress: string }>(trip: T) {
  return { ...trip, progress: progressToRules(toLabel(trip.driverProgress)) };
}
