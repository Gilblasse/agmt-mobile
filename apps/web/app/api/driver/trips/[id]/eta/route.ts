import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { tripEvents, trips } from '@/lib/db/schema';
import { authorizeDriverForTrip, refusalMessage } from '@/lib/auth/driver';
import { fail, ok, onlyPost, PRIVATE, readJson, tooBusy, UNREADABLE, withResult } from '@/lib/api/result';
import { consume } from '@/lib/api/rate-limit';
import { OFFICE_TIME_ZONE, tappability } from '@/lib/office-clock';

/**
 * POST /api/driver/trips/:id/eta — `reportEta` in the contract.
 *
 * The driver tells dispatch they are running late. The phone sends how many
 * minutes away it is and never a clock time: the office's own clock turns the
 * offset into a time on the board, so a phone an hour out cannot write a wrong
 * arrival into a note nobody can later question.
 *
 * Two things here were got wrong first time and are worth naming:
 *
 *  - **The decision is made under a lock.** Reading the trip, deciding whether
 *    it is already flagged, and writing were three separate steps, so two taps
 *    arriving together both decided "not flagged yet" and both wrote. Eight
 *    simultaneous taps left seven extra lines on the dispatcher's note. This
 *    is the same shape as the tap flow's race, and the same fix.
 *  - **Whether dispatch has been told is not inferred from prose.** It used to
 *    be a substring search of `trips.notes`, which the office also writes into
 *    — so an ordinary dispatcher note reading "Call office if DRIVER RUNNING
 *    LATE" silently swallowed a genuine notice while telling the driver it had
 *    been sent. The trail is the source of truth; the note is a rendering of it.
 */

const MARKER = 'DRIVER RUNNING LATE';
/** Two reports inside this window are the same report. */
const REPEAT_WINDOW_MINUTES = 30;
/** Enough for a driver to correct themselves; not enough to flood the trail. */
const REPORTS_PER_WINDOW = 6;
const REPORT_WINDOW_SECONDS = 600;

const Eta = z.object({
  minutesFromNow: z.number().int().min(0).max(240),
  reason: z.string().max(120).optional(),
  note: z.string().max(120).optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The driver's own words, made safe for a note the office reads.
 *
 * Anything outside the set becomes a space rather than vanishing, so
 * "Route 9\nwill be late" does not become "Route 9will be late". Still
 * ASCII-only, which is a real limitation for non-English speakers and is
 * recorded as such.
 */
function plainWords(value: string): string {
  return value.replace(/[^A-Za-z0-9 ,.:()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
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

  // Keyed on the driver, not the address: a phone moves between networks all
  // day. Each call writes an unbounded row, so this one needs a ceiling.
  const within = await consume(`eta:${driver.id}`, REPORTS_PER_WINDOW, REPORT_WINDOW_SECONDS);
  if (!within.allowed) return tooBusy(within.retryAfterSeconds);

  const body = await readJson(request);
  if (body === UNREADABLE) return fail('validation', 'The request body was not readable JSON.');
  const parsed = Eta.safeParse(body);
  if (!parsed.success) return fail('validation', 'Say roughly how many minutes away you are.');
  const { minutesFromNow, reason, note } = parsed.data;

  const day = tappability(trip.serviceDate, trip.driverProgress);
  if (day === 'not-yet') return fail('validation', 'You can only do that for today’s trips.');
  if (day === 'closed') return fail('day-locked', 'That day is closed. Ask the office to record this one.');

  // The office's clock, never the phone's. The date rides along when the
  // arrival crosses midnight, because "about 12:15 AM" on a permanent note is
  // ambiguous on an overnight run.
  const arrivingAt = new Date(Date.now() + minutesFromNow * 60_000);
  const sameDay =
    dayKey(arrivingAt) === dayKey(new Date());
  const arriving = new Intl.DateTimeFormat('en-US', {
    timeZone: OFFICE_TIME_ZONE,
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(arrivingAt);

  const cleanReason = reason ? plainWords(reason) : '';
  const cleanNote = note ? plainWords(note) : '';
  const stamp = [`${MARKER}: arriving about ${arriving}`, cleanReason, cleanNote]
    .filter(Boolean)
    .join(' - ');

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM trips WHERE id = ${trip.id} FOR UPDATE`);

    // The trail, not the note text. An office note that happens to contain the
    // words must not be mistaken for the driver having already reported.
    const recent = (await tx.execute(sql`
      SELECT 1 FROM trip_events
      WHERE trip_id = ${trip.id} AND kind = 'note'
        AND value LIKE ${MARKER + ':%'}
        AND occurred_at > now() - make_interval(mins => ${REPEAT_WINDOW_MINUTES})
      LIMIT 1
    `)) as unknown as unknown[];
    const alreadyFlagged = recent.length > 0;

    if (!alreadyFlagged) {
      // Appended, not replaced: whatever the office wrote on this trip stays.
      await tx
        .update(trips)
        .set({
          notes: sql`coalesce(nullif(${trips.notes}, '') || E'\n', '') || ${stamp}`,
        })
        .where(eq(trips.id, trip.id));
    }

    // Every report is recorded, even one the note does not repeat, so "they
    // told us twice" is answerable.
    await tx.insert(tripEvents).values({
      tripId: trip.id,
      kind: 'note',
      value: stamp,
      actor: `driver:${driver.id}`,
      occurredAt: new Date().toISOString(),
      // Sanitised here too. This row is served to the office through
      // `getTripActivity`, and it is the same untrusted string.
      payload: { minutesFromNow, reason: cleanReason || null, note: cleanNote || null },
    });

    return { alreadyFlagged };
  });

  return ok({ noted: true as const, arriving, alreadyFlagged: outcome.alreadyFlagged }, PRIVATE);
});

function dayKey(when: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_TIME_ZONE }).format(when);
}

export const { GET, PUT, PATCH, DELETE, OPTIONS } = onlyPost;
