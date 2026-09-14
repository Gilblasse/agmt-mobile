import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { driverSessions, drivers } from '@/lib/db/schema';
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
