import { and, desc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { driverSignInCodes, drivers, notifications } from '@/lib/db/schema';
import { fail, ok, readJson, tooBusy, UNREADABLE, withResult, onlyPost} from '@/lib/api/result';
import { callerKey, consume } from '@/lib/api/rate-limit';
import { hashCode, newSignInCode } from '@/lib/auth/tokens';

/**
 * POST /api/driver/sign-in — `driverSignIn` in the API contract.
 *
 * A driver identifies themselves and a six-digit code goes to the contact
 * details already on the roster. The code is never in the response; it goes to
 * the `notifications` outbox, the single path everything the office sends
 * takes (docs/06-external-services.md).
 *
 * **Every path returns exactly `{ sent: true }`.** Not "sent to •••-•••-0001",
 * not a different answer for a name nobody has, not an error for a driver with
 * no phone number on file. Any of those turns this endpoint — which needs no
 * authentication at all — into a way to ask "is this person one of your
 * drivers?", and the answer is a list of real people. An earlier version
 * returned the masked phone number, which also handed out the last four digits
 * to anyone who asked.
 */

const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;

const SignIn = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(200).optional(),
    phone: z.string().trim().min(7).max(40).optional(),
  })
  .refine((v) => v.name || v.email || v.phone, {
    message: 'Give a name, an email address or a phone number.',
  });

/** The same answer for everyone, whatever happened behind it. */
const SENT = { sent: true } as const;

export const POST = withResult(async (request: Request) => {
  // Before anything else, and before touching the database for a lookup: this
  // endpoint answers strangers by design, so it is the one that has to be
  // cheap to refuse.
  // 30 in ten minutes. A depot full of drivers shares one public IP over the
  // building's WiFi, so this has to clear a whole crew starting a shift while
  // still stopping a sustained sweep. Per-driver flooding is already bounded
  // by the 60-second cooldown; this limit is about the caller, not the driver.
  const within = await consume(`sign-in:${callerKey(request)}`, 30, 600);
  if (!within.allowed) return tooBusy(within.retryAfterSeconds);

  const body = await readJson(request);
  if (body === UNREADABLE) return fail('validation', 'The request body was not readable JSON.');

  const parsed = SignIn.safeParse(body);
  if (!parsed.success) {
    return fail('validation', parsed.error.issues[0]?.message ?? 'That request was not understood.');
  }
  const { name, email, phone } = parsed.data;

  const matches = [
    name ? eq(drivers.name, name) : undefined,
    email ? eq(drivers.email, email) : undefined,
    phone ? eq(sql`regexp_replace(${drivers.phone}, '\\D', '', 'g')`, phone.replace(/\D/g, '')) : undefined,
  ].filter(Boolean);

  const [driver] = await db
    .select()
    .from(drivers)
    .where(and(eq(drivers.active, true), or(...matches)))
    // Without an order this resolves by physical row order, which shifts as
    // rows are updated. Two identifiers naming different drivers must at least
    // pick the same one every time.
    .orderBy(drivers.createdAt, drivers.id)
    .limit(1);

  // Everything from here happens under a lock on the driver's row, so the
  // cooldown check and the insert cannot interleave with another request.
  // Checking first and inserting afterwards was not enough: twelve requests
  // arriving together all read "no recent code" before any of them had
  // inserted one, and the driver got a burst of text messages.
  //
  // The work runs whether or not a driver matched, so the time taken does not
  // reveal the answer either.
  if (!driver) {
    await db.execute(sql`SELECT pg_sleep(0)`);
    return ok(SENT);
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM drivers WHERE id = ${driver.id} FOR UPDATE`);

    // Deliberately the most recent code of any kind, not the most recent
    // *live* one. A code that has been used or burned through its attempt
    // limit still starts the clock — otherwise five wrong guesses would clear
    // the cooldown and let an attacker pull a fresh code immediately.
    const recent = await tx
      .select({ createdAt: driverSignInCodes.createdAt })
      .from(driverSignInCodes)
      .where(eq(driverSignInCodes.driverId, driver.id))
      .orderBy(desc(driverSignInCodes.createdAt))
      .limit(1);

    const last = recent[0]?.createdAt;
    if (last && Date.now() - new Date(last).getTime() < RESEND_COOLDOWN_SECONDS * 1000) return;

    const channel = driver.phone ? 'sms' : driver.email ? 'email' : null;
    const recipient = driver.phone ?? driver.email;
    if (!channel || !recipient) {
      // On the roster but unreachable. The office has to fix the record — but
      // saying so here would tell an anonymous caller this driver exists.
      console.warn(`driver ${driver.id} has no phone or email on file and cannot be sent a code`);
      return;
    }

    const code = newSignInCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();

    // Any earlier unused code stops working the moment a new one is sent; the
    // partial unique index makes "one live code" the database's rule.
    await tx
      .update(driverSignInCodes)
      .set({ consumedAt: new Date().toISOString() })
      .where(and(eq(driverSignInCodes.driverId, driver.id), sql`consumed_at IS NULL`));

    // And any text still waiting to go out carries one of those dead codes.
    // Sending it would give the driver a code that cannot sign them in — they
    // would try it, be told it is wrong, and have no way to know which of the
    // two texts is the live one. Under a provider outage there could be
    // several queued at once.
    await tx.execute(sql`
      UPDATE notifications
      SET state = 'abandoned', last_error = 'A newer sign-in code was sent before this went out.'
      WHERE driver_id = ${driver.id}
        AND state = 'pending'
        AND dedupe_key LIKE 'driver-sign-in:%'
    `);

    const [row] = await tx
      .insert(driverSignInCodes)
      .values({ driverId: driver.id, codeHash: hashCode(code), sentTo: recipient, expiresAt })
      .returning({ id: driverSignInCodes.id });

    await tx.insert(notifications).values({
      channel,
      recipient,
      driverId: driver.id,
      subject: channel === 'email' ? `${code} is your Amazing Grace sign-in code` : null,
      // Plain punctuation and no link: some carrier gateways treat a link as
      // spam and start dropping everything from the sender.
      body: `${code} is your Amazing Grace sign-in code. It expires in ${CODE_TTL_MINUTES} minutes.`,
      // Keyed on the code row, so two codes can never collide on this.
      dedupeKey: `driver-sign-in:${row!.id}`,
      // The retry back-off runs to three hours; this code is good for ten
      // minutes. Past that the outbox gives up rather than delivering a code
      // that expired while it was queued.
      expiresAt,
    });
  });

  return ok(SENT);
});

export const { GET, PUT, PATCH, DELETE, OPTIONS } = onlyPost;
