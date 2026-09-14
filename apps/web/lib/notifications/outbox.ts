import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sender, type Channel } from './sender';

/**
 * Drains the notification outbox.
 *
 * Nothing in this system sends inline. The old one did, and a driver was
 * sometimes told twice — or not at all, with no record either way. Everything
 * queues into `notifications`, and this is the only thing that takes messages
 * out of it.
 *
 * Three rules shape it:
 *
 *  - **A message is claimed before it is sent.** Two workers, or one worker
 *    run twice, must not both pick up the same row. The claim is an atomic
 *    `UPDATE ... RETURNING` with `SKIP LOCKED`, so a second worker takes the
 *    next row rather than waiting or duplicating.
 *  - **A failure backs off rather than spinning.** `send_after` moves forward,
 *    which is the same field quiet hours would use.
 *  - **Giving up is a state, not a deletion.** An abandoned message stays in
 *    the table with its last error, because "the driver was never told" is
 *    something the office needs to be able to see.
 */

const MAX_ATTEMPTS = 5;
/**
 * How long a claimed message is hidden from other workers.
 *
 * Claiming has to take the row out of the due set, not merely lock it:
 * `SKIP LOCKED` protects a row only while the claiming transaction is open, so
 * once it commits the row is still `pending` and still due, and the next
 * worker sends it again. Ten messages went out twenty-two times before this
 * was a lease.
 *
 * It doubles as crash recovery. A worker that dies mid-send does not strand
 * its messages: the lease lapses and they become due again.
 */
const CLAIM_LEASE_SECONDS = 120;
/** Back-off in seconds by attempt number: about a minute, then ten, then an hour. */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10_800];

export type DrainResult = {
  claimed: number;
  delivered: number;
  failed: number;
  abandoned: number;
  provider: string;
};

type Claimed = {
  id: string;
  channel: Channel;
  recipient: string;
  subject: string | null;
  body: string;
  attempts: number;
};

/**
 * Takes up to `limit` messages that are due, and tries to send each.
 *
 * Returns what happened rather than throwing: a worker that dies on one bad
 * row stops delivering for everyone.
 */
export async function drainOutbox(limit = 20): Promise<DrainResult> {
  const result: DrainResult = {
    claimed: 0,
    delivered: 0,
    failed: 0,
    abandoned: 0,
    provider: sender().describe(),
  };

  // Claim in one statement: count the attempt and push the message out of the
  // due set for the length of the lease. SKIP LOCKED then means a second
  // worker takes different rows rather than blocking on these.
  const claimed = (await db.execute(sql`
    UPDATE notifications
    SET attempts = attempts + 1,
        send_after = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS})
    WHERE id IN (
      SELECT id FROM notifications
      WHERE state = 'pending' AND send_after <= now()
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, channel, recipient, subject, body, attempts
  `)) as unknown as Claimed[];

  result.claimed = claimed.length;

  for (const message of claimed) {
    let sent;
    try {
      sent = await sender().send(message);
    } catch (error) {
      sent = { delivered: false as const, error: String(error) };
    }

    if (sent.delivered) {
      await db.execute(sql`
        UPDATE notifications SET state = 'sent', sent_at = now(), last_error = NULL
        WHERE id = ${message.id}
      `);
      result.delivered++;
      continue;
    }

    // A permanent failure — a number that cannot receive texts — is not worth
    // four more attempts.
    const outOfTries = message.attempts >= MAX_ATTEMPTS || sent.permanent === true;
    if (outOfTries) {
      await db.execute(sql`
        UPDATE notifications SET state = 'abandoned', last_error = ${sent.error}
        WHERE id = ${message.id}
      `);
      result.abandoned++;
      continue;
    }

    const wait = BACKOFF_SECONDS[Math.min(message.attempts - 1, BACKOFF_SECONDS.length - 1)]!;
    await db.execute(sql`
      UPDATE notifications
      SET last_error = ${sent.error}, send_after = now() + make_interval(secs => ${wait})
      WHERE id = ${message.id}
    `);
    result.failed++;
  }

  return result;
}
