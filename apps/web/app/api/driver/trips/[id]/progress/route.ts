import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canAdvance, stampFieldFor } from '@ag/rules';
import { DRIVER_STEP_RANK } from '@ag/rules/types';
import { db } from '@/lib/db';
import { tripEvents, trips } from '@/lib/db/schema';
import { authorizeDriverForTrip, refusalMessage } from '@/lib/auth/driver';
import { fail, ok, PRIVATE, readJson, UNREADABLE, withResult, onlyPost} from '@/lib/api/result';
import { isDriverStep, progressToDb, progressToRules, toLabel } from '@/lib/db/enums';
import { tappability } from '@/lib/office-clock';

/**
 * POST /api/driver/trips/:id/progress — `setDriverProgress` in the contract.
 *
 * The endpoint the rebuild is judged on. CLAUDE.md, non-negotiable #2: a
 * driver's tap is never lost and never applied twice.
 *
 * Everything that decides the outcome happens inside one transaction, holding
 * a lock on the trip row. An earlier version read the trip's current step
 * *before* the transaction and wrote the nonce unconditionally: when two taps
 * arrived together the loser's `UPDATE ... WHERE driver_progress = <stale>`
 * matched nothing, yet its nonce was spent and it was answered "success". The
 * step was gone, its timestamp never written, and the re-send could never
 * apply it. That is a lost tap, produced by the ordinary pattern of an offline
 * queue draining two taps back to back.
 *
 * So: lock, re-read, decide, and only then spend the nonce.
 */

const Tap = z.object({
  progress: z.string().refine(isDriverStep, 'That is not a step a driver can tap.'),
  idempotencyKey: z.string().trim().min(8).max(200),
  /** What the phone's clock said. Recorded, never used to decide anything. */
  tappedAt: z.string().datetime().optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withResult(async (request: Request) => {
  const tripId = new URL(request.url).pathname.split('/').at(-2) ?? '';
  // A mangled id is "no such trip of yours", not a database error.
  if (!UUID.test(tripId)) {
    return fail('not-found', refusalMessage('not-found'));
  }

  // Authenticate before reading a body: an anonymous caller should not be able
  // to make the server buffer and parse whatever it likes.
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
  const parsed = Tap.safeParse(body);
  if (!parsed.success) {
    return fail('validation', parsed.error.issues[0]?.message ?? 'That request was not understood.');
  }
  const { progress, idempotencyKey, tappedAt } = parsed.data;

  // A trip that began before midnight is still the trip the driver is inside.
  // Refusing it stranded overnight runs — a dialysis return or a late hospital
  // discharge — with their drop-off never stamped and the tap discarded,
  // because `validation` is not a reason a client retries.
  const day = tappability(trip.serviceDate, trip.driverProgress);
  if (day === 'not-yet') return fail('validation', 'You can only update today\u2019s trips.');
  if (day === 'closed') {
    return fail('day-locked', 'That day is closed. Ask the office to record this one.');
  }

  const outcome = await db.transaction(async (tx) => {
    // The lock is the whole point. Everything below reads the trip as it is
    // right now, and no other tap can move it until this commits.
    const locked = (await tx.execute(
      sql`SELECT driver_progress FROM trips WHERE id = ${trip.id} FOR UPDATE`,
    )) as unknown as Array<{ driver_progress: string }>;
    if (!locked[0]) return { kind: 'gone' } as const;

    const current = progressToRules(toLabel(locked[0].driver_progress));

    // A tap may only ever raise a trip's progress. A stale tap draining from a
    // queue hours later reports what is already true and changes nothing — the
    // driver tapped correctly, the news simply arrived late.
    if (!canAdvance(current, progress)) return { kind: 'stale', current } as const;

    const [event] = await tx
      .insert(tripEvents)
      .values({
        tripId: trip.id,
        kind: 'driver_tap',
        value: progressToDb(progress),
        actor: `driver:${driver.id}`,
        // The office's clock decides when this happened. `tappedAt` is what
        // the phone believed and is kept only so the trail shows the gap.
        occurredAt: new Date().toISOString(),
        payload: tappedAt ? { tappedAt } : null,
        // Namespaced by operation: a phone that reuses one key for the tap
        // and the undo of that tap means two different things by it, and the
        // undo must not be mistaken for a replay of the tap.
        idempotencyKey: `tap:${idempotencyKey}`,
      })
      // The nonce is unique within this trip. An empty result means this exact
      // tap has been seen before; nothing else in the transaction runs.
      .onConflictDoNothing({
        target: [tripEvents.tripId, tripEvents.idempotencyKey],
        where: sql`idempotency_key is not null`,
      })
      .returning({ id: tripEvents.id });
    if (!event) return { kind: 'duplicate', current } as const;

    // A driver who forgets a step and taps the next one is not stopped — the
    // live system allows any forward move and the rules are parity-checked
    // against it. But the skipped stamps are what a wait time is billed from,
    // so the gap is recorded rather than left for someone to notice later.
    const skipped = stepsBetween(current, progress);
    if (skipped.length > 0) {
      await tx.insert(tripEvents).values({
        tripId: trip.id,
        kind: 'note',
        value: `steps not tapped: ${skipped.join(', ')}`,
        actor: `driver:${driver.id}`,
        occurredAt: new Date().toISOString(),
      });
    }

    const now = new Date().toISOString();
    const stampField = stampFieldFor(progress);
    const [updated] = await tx
      .update(trips)
      .set({
        driverProgress: progressToDb(progress),
        ...(stampField ? { [stampField]: now } : {}),
        updatedAt: now,
      })
      .where(eq(trips.id, trip.id))
      .returning();

    return { kind: 'applied', trip: updated } as const;
  });

  if (outcome.kind === 'gone') return fail('not-found', refusalMessage('not-found'));

  if (outcome.kind === 'applied') {
    return ok(
      { trip: withProgress(outcome.trip), applied: true, alreadyApplied: false },
      PRIVATE,
    );
  }

  // Stale or duplicate: the step is accounted for either way. Read the trip
  // back rather than echoing the snapshot taken before the lock, so the phone
  // is told what is actually true now.
  const [fresh] = await db.select().from(trips).where(eq(trips.id, trip.id)).limit(1);
  if (!fresh) return fail('not-found', refusalMessage('not-found'));
  return ok({ trip: withProgress(fresh), applied: false, alreadyApplied: true }, PRIVATE);
});

function withProgress<T extends { driverProgress: string }>(trip: T) {
  return { ...trip, progress: progressToRules(toLabel(trip.driverProgress)) };
}

/** The steps a driver passed over by tapping `to` while the trip was at `from`. */
function stepsBetween(from: string, to: string): string[] {
  const rank = DRIVER_STEP_RANK as Record<string, number>;
  const a = rank[from] ?? 0;
  const b = rank[to] ?? 0;
  return Object.keys(rank).filter((step) => {
    const r = rank[step]!;
    return r > a && r < b;
  });
}

export const { GET, PUT, PATCH, DELETE } = onlyPost;
