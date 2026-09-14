import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { driverSignInCodes, drivers, notifications } from '@/lib/db/schema';
import { fail, ok, readJson, UNREADABLE } from '@/lib/api/result';
import { hashSecret, newSignInCode } from '@/lib/auth/tokens';

/**
 * POST /api/driver/sign-in — `driverSignIn` in the API contract.
 *
 * A driver identifies themselves and we send a six-digit code to the contact
 * details already on the roster. The code never comes back in the response;
 * it goes to the `notifications` outbox, which is the single path everything
 * the office sends takes. Nothing is delivered inline — see
 * docs/06-external-services.md, which replaces the old carrier-email trick
 * with a real provider.
 *
 * The reply is deliberately the same whether or not the name matches anyone.
 * Telling an unknown caller "no such driver" would turn this endpoint into a
 * way to read the roster, and the roster is a list of real people.
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

/** What the driver is told, so they know which phone or inbox to check. */
function mask(contact: string, channel: 'sms' | 'email'): string {
  if (channel === 'email') {
    const [user = '', domain = ''] = contact.split('@');
    return `${user.slice(0, 3)}•••@${domain}`;
  }
  const digits = contact.replace(/\D/g, '');
  return `•••-•••-${digits.slice(-4)}`;
}

export async function POST(request: Request) {
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
    .limit(1);

  // Nobody matched, or they are off the roster. Same answer either way.
  if (!driver) return ok({ sent: true });

  // One code in flight at a time. Asking again inside the cooldown is not an
  // error the driver has to act on — it just does not send a second message.
  const [pending] = await db
    .select({ createdAt: driverSignInCodes.createdAt })
    .from(driverSignInCodes)
    .where(
      and(
        eq(driverSignInCodes.driverId, driver.id),
        isNull(driverSignInCodes.consumedAt),
        gt(driverSignInCodes.createdAt, new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000).toISOString()),
      ),
    )
    .limit(1);
  if (pending) return ok({ sent: true });

  const channel = driver.phone ? 'sms' : driver.email ? 'email' : null;
  const recipient = driver.phone ?? driver.email;
  if (!channel || !recipient) {
    // On the roster but unreachable. The office has to fix the record; saying
    // "sent" would leave the driver waiting for a message that cannot arrive.
    return fail('validation', 'There is no phone number or email address on file for you. Ask the office to add one.');
  }

  const code = newSignInCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();

  await db.transaction(async (tx) => {
    // Any earlier unused code stops working the moment a new one is sent.
    await tx
      .update(driverSignInCodes)
      .set({ consumedAt: new Date().toISOString() })
      .where(and(eq(driverSignInCodes.driverId, driver.id), isNull(driverSignInCodes.consumedAt)));

    await tx.insert(driverSignInCodes).values({
      driverId: driver.id,
      codeHash: hashSecret(code),
      sentTo: recipient,
      expiresAt,
    });

    await tx.insert(notifications).values({
      channel,
      recipient,
      driverId: driver.id,
      subject: channel === 'email' ? `${code} is your Amazing Grace sign-in code` : null,
      // Plain punctuation and no link: some carrier gateways treat a link as
      // spam and start dropping everything from the sender.
      body: `${code} is your Amazing Grace sign-in code. It expires in ${CODE_TTL_MINUTES} minutes.`,
      dedupeKey: `driver-sign-in:${driver.id}:${expiresAt}`,
    });
  });

  return ok({ sent: true, via: channel, sentTo: mask(recipient, channel) });
}
