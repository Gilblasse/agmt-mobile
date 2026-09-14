import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { driverSessions, driverSignInCodes, drivers } from '@/lib/db/schema';
import { fail, ok, readJson, UNREADABLE } from '@/lib/api/result';
import { hashSecret, newSessionToken, secretMatches } from '@/lib/auth/tokens';
import { revokeSessionsBeyondLimit, SESSION_TTL_DAYS } from '@/lib/auth/driver';

/**
 * POST /api/driver/verify — `driverVerify` in the API contract.
 *
 * DELIBERATE DEVIATION FROM THE CONTRACT. `contract.ts` types this as
 * `driverVerify({ code })` — the code alone, with no indication of who is
 * presenting it. Implemented that way, every code in flight shares one
 * six-digit space: a caller guessing 000000 is guessing against *every*
 * driver signing in at that moment, and the five-attempt limit protects an
 * individual code while doing nothing about the space as a whole.
 *
 * So this endpoint asks who you are as well. That is also what the live
 * system does (`driverVerifyCode(name, code)` — see docs/02-driver-app.md
 * §1.3), which has been in production for years. The contract is an
 * unimplemented sketch and CLAUDE.md says to expect it to change; this change
 * is recorded in .agile/decisions.md.
 *
 * A wrong code is counted against that code, and the fifth wrong attempt
 * burns it — the driver asks for a new one rather than being told how many
 * guesses remain.
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

export async function POST(request: Request) {
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

  if (!secretMatches(code, candidate.codeHash)) {
    const attempts = candidate.attempts + 1;
    await db
      .update(driverSignInCodes)
      .set({
        attempts,
        // Out of attempts: burn it rather than leave it open to more guessing.
        consumedAt: attempts >= MAX_ATTEMPTS ? new Date().toISOString() : null,
      })
      .where(eq(driverSignInCodes.id, candidate.id));
    return fail('not-authorised', REFUSED);
  }

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();

  await db.transaction(async (tx) => {
    // Single use. Consuming it in the same transaction that mints the session
    // means a code replayed against a slow network cannot yield two sessions.
    const consumed = await tx
      .update(driverSignInCodes)
      .set({ consumedAt: new Date().toISOString() })
      .where(and(eq(driverSignInCodes.id, candidate.id), isNull(driverSignInCodes.consumedAt)))
      .returning({ id: driverSignInCodes.id });
    if (consumed.length === 0) throw new Error('code already consumed');

    await tx.insert(driverSessions).values({
      driverId: driver.id,
      tokenHash: hashSecret(token),
      userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
      expiresAt,
    });
  });

  await revokeSessionsBeyondLimit(driver.id);

  return ok({ token, driver });
}
