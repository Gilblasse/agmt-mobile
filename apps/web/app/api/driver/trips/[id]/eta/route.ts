import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { tripEvents, trips } from '@/lib/db/schema';
import { authorizeDriverForTrip, refusalMessage } from '@/lib/auth/driver';
import { fail, ok, PRIVATE, readJson, UNREADABLE, withResult, onlyPost} from '@/lib/api/result';
import { OFFICE_TIME_ZONE, tappability } from '@/lib/office-clock';

/**
 * POST /api/driver/trips/:id/eta — `reportEta` in the contract.
 *
 * The driver tells dispatch they are running late. The contract says this
 * carries "a relative offset in minutes, never an absolute time", and that is
 * the whole point: the phone says "about fifteen minutes away", and the
 * office's own clock turns that into a time on the board. A phone an hour out
 * would otherwise write a wrong arrival time into a permanent note, and
 * nobody reading the board later would know.
 *
 * The note lands in two places, as it did in the live system: the trip's own
 * notes, which is what a dispatcher sees, and the trip's event trail. It is
 * deduplicated — a driver tapping twice, or the app retrying, must not leave
 * the board with a column of identical warnings.
 */

const MARKER = 'DRIVER RUNNING LATE';

/** The reasons the app offers. Anything else is recorded as the driver's own words. */
const Eta = z.object({
  minutesFromNow: z.number().int().min(0).max(240),
  reason: z.string().max(60).optional(),
  note: z.string().max(200).optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The old code stripped anything outside this set before the text reached a
 * shared sheet. Keep it: this string is written into a note the office reads,
 * and it should not be able to carry anything but words.
 */
function plainWords(value: string): string {
  return value.replace(/[^A-Za-z0-9 ,.:()-]/g, '').trim().slice(0, 120);
}

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
  const parsed = Eta.safeParse(body);
  if (!parsed.success) {
    return fail('validation', 'Say roughly how many minutes away you are.');
  }
  const { minutesFromNow, reason, note } = parsed.data;

  const day = tappability(trip.serviceDate, trip.driverProgress);
  if (day !== 'ok') return fail('validation', 'You can only do that for today’s trips.');

  // The office's clock, never the phone's.
  const arriving = new Date(Date.now() + minutesFromNow * 60_000);
  const clockTime = new Intl.DateTimeFormat('en-US', {
    timeZone: OFFICE_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(arriving);

  const parts = [`${MARKER}: arriving about ${clockTime}`];
  if (reason) parts.push(plainWords(reason));
  if (note) parts.push(plainWords(note));
  const stamp = parts.filter(Boolean).join(' - ');

  const alreadyFlagged = (trip.notes ?? '').includes(MARKER);

  await db.transaction(async (tx) => {
    if (!alreadyFlagged) {
      // Appended, not replaced: whatever the office wrote on this trip stays.
      await tx
        .update(trips)
        .set({
          notes: sql`coalesce(nullif(${trips.notes}, '') || E'\n', '') || ${stamp}`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(trips.id, trip.id));
    }

    // The trail records every report, even the ones the note does not repeat,
    // so "they told us twice" is answerable.
    await tx.insert(tripEvents).values({
      tripId: trip.id,
      kind: 'note',
      value: stamp,
      actor: `driver:${driver.id}`,
      occurredAt: new Date().toISOString(),
      payload: { minutesFromNow, reason: reason ?? null },
    });
  });

  return ok({ noted: true, arriving: clockTime, alreadyFlagged }, PRIVATE);
});

export const { GET, PUT, PATCH, DELETE } = onlyPost;
