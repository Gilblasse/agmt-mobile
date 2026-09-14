import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { driverSessions, driverSignInCodes, drivers } from '@/lib/db/schema';
import { fail, ok, PRIVATE, readJson, UNREADABLE, withResult } from '@/lib/api/result';
import { codeMatches, hashToken, newSessionToken } from '@/lib/auth/tokens';
import { revokeSessionsBeyondLimit, SESSION_TTL_DAYS } from '@/lib/auth/driver';

/**
 * POST /api/driver/verify — `driverVerify` in the API contract.
 *
 * DELIBERATE DEVIATION FROM THE CONTRACT. `contract.ts` types this as
 * `driverVerify({ code })` — the code alone, with no indication of who is
 * presenting it. Implemented that way, every code in flight shares one
 * six-digit space. This endpoint asks who you are as well, which is what the
 * live system does (`driverVerifyCode(name, code)`, docs/02 §1.3). Recorded in
 * .agile/decisions.md.
 *
 * There is at most one live code per driver — the database enforces it — so
 * there is exactly one candidate to check, and the driver's genuine code can
 * never be refused because a stale row was consulted instead.
 */

const MAX_ATTEMPTS = 5;

const Verify = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/, 'A sign-in code is six digits.'),
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(200).optional(),
    phone: z.string().trim().min(7).max(40).optional(),
  })
  .refine((v) => v.name || v.email || v.phone, {
    message: 'Say who you are as well as giving the code.',
  });

/** One message for every way a code can be refused, so none of them is a probe. */
const REFUSED = 'That code is wrong or has expired. Ask for a new one.';

export const POST = withResult(async (request: Request) => {
  const body = await readJson(request);
  if (body === UNREADABLE) return fail('validation', 'The request body was not readable JSON.');

  const parsed = Verify.safeParse(body);
  if (!parsed.success) {
    return fail('validation', parsed.error.issues[0]?.message ?? 'That request was not understood.');
  }
  const { code, name, email, phone } = parsed.data;

  const matches = [
    name ? eq(drivers.name, name) : undefined,
    email ? eq(drivers.email, email) : undefined,
    phone ? eq(sql`regexp_replace(${drivers.phone}, '\\D', '', 'g')`, phone.replace(/\D/g, '')) : undefined,
  ].filter(Boolean);

  const [driver] = await db
    .select()
    .from(drivers)
    .where(and(eq(drivers.active, true), or(...matches)))
    .orderBy(drivers.createdAt, drivers.id)
    .limit(1);
  if (!driver) return fail('not-authorised', REFUSED);

  const [candidate] = await db
    .select()
    .from(driverSignInCodes)
    .where(
      and(
        eq(driverSignInCodes.driverId, driver.id),
        isNull(driverSignInCodes.consumedAt),
        gt(driverSignInCodes.expiresAt, new Date().toISOString()),
      ),
    )
    .limit(1);
  if (!candidate) return fail('not-authorised', REFUSED);

  if (!codeMatches(code, candidate.codeHash)) {
    // One statement, so the count is the database's and not a stale read. The
    // previous read-modify-write lost updates under load: forty simultaneous
    // guesses cost a single attempt, which left the limit meaningless.
    await db.execute(sql`
      UPDATE driver_sign_in_codes
      SET attempts = attempts + 1,
          consumed_at = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN now() ELSE NULL END
      WHERE id = ${candidate.id} AND consumed_at IS NULL
    `);
    return fail('not-authorised', REFUSED);
  }

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();

  // Consuming the code and minting the session in one transaction means a code
  // replayed over a flaky connection cannot yield two sessions. The loser of
  // that race is told the code is spent rather than shown an error it cannot
  // act on.
  const minted = await db.transaction(async (tx) => {
    const consumed = await tx
      .update(driverSignInCodes)
      .set({ consumedAt: new Date().toISOString() })
      .where(and(eq(driverSignInCodes.id, candidate.id), isNull(driverSignInCodes.consumedAt)))
      .returning({ id: driverSignInCodes.id });
    if (consumed.length === 0) return false;

    await tx.insert(driverSessions).values({
      driverId: driver.id,
      tokenHash: hashToken(token),
      userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
      expiresAt,
    });
    return true;
  });

  if (!minted) return fail('not-authorised', REFUSED);

  await revokeSessionsBeyondLimit(driver.id);

  return ok({ token, driver }, PRIVATE);
});
