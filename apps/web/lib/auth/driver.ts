import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { driverSessions, drivers, trips } from '@/lib/db/schema';
import { hashToken } from './tokens';

/** How long a trusted phone stays trusted before it needs a fresh code. */
export const SESSION_TTL_DAYS = 90;
/** Oldest sessions are revoked past this, so a driver churning phones does not accumulate keys. */
export const MAX_SESSIONS_PER_DRIVER = 8;
/** How stale `last_used_at` may get before it is worth another write. */
const LAST_USED_RESOLUTION_MS = 5 * 60_000;

export type Driver = typeof drivers.$inferSelect;

export type DriverAuth =
  | { ok: true; driver: Driver; sessionId: string }
  | { ok: false; reason: 'no-token' | 'not-signed-in' | 'off-roster' };

/**
 * Resolves the bearer token on a request to a driver, or explains why not.
 *
 * The roster is re-checked here on **every** call, not just at sign-in. Taking
 * a driver off the roster, or marking them inactive, has to cut off their
 * phone within minutes without anyone performing a separate revoke step — so
 * `active` is part of the lookup, and a session alone is never enough.
 *
 * The three failures are kept apart because the app does different things with
 * them: a driver with no token signs in, a driver whose token has expired is
 * sent for a fresh code without forgetting who they are, and a driver who is
 * off the roster is told plainly rather than sent round a loop they cannot
 * complete.
 */
export async function authenticateDriver(request: Request): Promise<DriverAuth> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, reason: 'no-token' };

  const now = new Date().toISOString();
  const [row] = await db
    .select({ session: driverSessions, driver: drivers })
    .from(driverSessions)
    .innerJoin(drivers, eq(drivers.id, driverSessions.driverId))
    .where(
      and(
        eq(driverSessions.tokenHash, hashToken(token)),
        isNull(driverSessions.revokedAt),
        gt(driverSessions.expiresAt, now),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: 'not-signed-in' };
  // Still a session, but no longer a driver we let in.
  if (!row.driver.active) return { ok: false, reason: 'off-roster' };

  // `last_used_at` is for the office to see which phones are still in use, so
  // minute-accuracy is plenty. The driver app polls every few seconds; writing
  // on every request put a steady stream of updates — and dead tuples — on a
  // table carrying a unique index, for no one's benefit. Not awaited: a slow
  // write should never hold up a driver's request.
  const lastUsed = row.session.lastUsedAt ? new Date(row.session.lastUsedAt).getTime() : 0;
  if (Date.now() - lastUsed > LAST_USED_RESOLUTION_MS) {
    void db
      .update(driverSessions)
      .set({ lastUsedAt: now })
      .where(eq(driverSessions.id, row.session.id))
      .catch((error) => console.error('could not record session use', error));
  }

  return { ok: true, driver: row.driver, sessionId: row.session.id };
}

/**
 * Keeps a driver to a fixed number of trusted phones by revoking the oldest
 * beyond the limit. Revoking rather than deleting keeps the audit trail: we
 * can still say which device did what, and when it stopped being trusted.
 */
export async function revokeSessionsBeyondLimit(driverId: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE driver_sessions SET revoked_at = now()
    WHERE id IN (
      SELECT id FROM driver_sessions
      WHERE driver_id = ${driverId} AND revoked_at IS NULL
      -- id breaks ties so two sessions created in the same instant still have
      -- a defined order, and the same one is always the survivor.
      ORDER BY created_at DESC, id DESC
      OFFSET ${MAX_SESSIONS_PER_DRIVER}
    )
    RETURNING id
  `);
  return result.length;
}

export type TripAccess =
  | { ok: true; driver: Driver; trip: typeof trips.$inferSelect }
  | { ok: false; reason: 'no-token' | 'not-signed-in' | 'off-roster' | 'not-found' | 'not-yours' };

/**
 * Resolves the caller AND the trip they are acting on, and refuses unless the
 * trip is theirs.
 *
 * Knowing who someone is says nothing about what they may touch. The old
 * system's gate matched a driver's name against the trip's free-text driver
 * field, which let `Lee` match `Ashleen` — one driver could see and complete
 * another's trips (docs/02 §1.5). Names are gone here; the trip carries a
 * driver id, and it has to be this driver's.
 *
 * An unassigned trip is refused too. It belongs to the office, not to whoever
 * asks first — the old code let any signed-in driver work a trip with an empty
 * driver cell, and that is expressly called out as wrong (docs/02 §1.7).
 */
export async function authorizeDriverForTrip(request: Request, tripId: string): Promise<TripAccess> {
  const auth = await authenticateDriver(request);
  if (!auth.ok) return auth;

  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  // "Not yours" and "does not exist" are the same answer on purpose: otherwise
  // a driver could learn which trip ids are real by trying them.
  if (!trip || trip.driverId !== auth.driver.id) {
    return { ok: false, reason: trip ? 'not-yours' : 'not-found' };
  }
  return { ok: true, driver: auth.driver, trip };
}

/** What to tell a driver whose request was refused, in words they can act on. */
export function refusalMessage(reason: Exclude<TripAccess, { ok: true }>['reason']): string {
  switch (reason) {
    case 'off-roster':
      return 'This account is no longer active. Ask the office.';
    case 'not-found':
    case 'not-yours':
      return 'That trip is not on your schedule any more. Pull down to refresh.';
    default:
      return 'Please sign in again.';
  }
}
