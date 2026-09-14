import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sender, type Channel } from './sender';

/**
 * Drains the notification outbox.
 *
 * Nothing in this system sends inline. The old one did, and a driver was
 * sometimes told twice — or not at all, with no record either way.
 *
 * The hard part is not sending; it is making sure a message is sent exactly
 * once when workers overlap, a provider hangs, or a process dies mid-send.
 * Three things do that, and the first version of this file had none of them:
 *
 *  - **A claim is a state, not a timeout.** `sending` with a worker id says
 *    "someone has this". An earlier design stamped one lease across a whole
 *    batch and sent it serially, so the last message of a batch had already
 *    spent its lease before anything was sent to it — and a second worker
 *    re-sent it.
 *  - **Every send is bounded.** A provider that hangs must not outlive the
 *    claim, or the row becomes due again while the first send is still in
 *    flight. Recovery-by-timeout is only safe when the work cannot outlast
 *    the timeout, so the timeout is enforced here rather than assumed.
 *  - **Recording the outcome cannot lose a delivered message.** The write
 *    that marks a row sent is itself fallible; if it throws, the row must not
 *    silently return to the queue.
 */

const MAX_ATTEMPTS = 5;
/** Back-off in seconds by attempt: about a minute, then five, fifteen, an hour, three. */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10_800];

/** How long a claim is honoured before a sweeper may reclaim it. */
export const CLAIM_LEASE_SECONDS = Number(process.env.OUTBOX_LEASE_SECONDS ?? '120');
/** A send must finish well inside the claim, so a hang can never outlive it. */
const SEND_TIMEOUT_MS = Math.max(1_000, (CLAIM_LEASE_SECONDS * 1000) / 4);
/** How many messages are in flight at once. Serial sending means one slow provider stalls the queue. */
const CONCURRENCY = 4;

export type DrainResult = {
  claimed: number;
  delivered: number;
  failed: number;
  abandoned: number;
  /** Delivered or not, we could not record the outcome. These need a human. */
  unresolved: number;
  recovered: number;
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

/** Returns claims whose worker never came back, so their messages are not stranded. */
async function recoverStaleClaims(): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE notifications SET state = 'pending', claimed_at = NULL, claimed_by = NULL
    WHERE state = 'sending'
      AND claimed_at < now() - make_interval(secs => ${CLAIM_LEASE_SECONDS})
    RETURNING id
  `)) as unknown as unknown[];
  return rows.length;
}

/**
 * Sends whatever is due, at most `limit` messages.
 *
 * Returns what happened rather than throwing: a worker that dies on one bad
 * row stops delivering for everyone.
 */
export async function drainOutbox(limit = 20): Promise<DrainResult> {
  const worker = randomUUID();
  const result: DrainResult = {
    claimed: 0,
    delivered: 0,
    failed: 0,
    abandoned: 0,
    unresolved: 0,
    recovered: 0,
    provider: sender().describe(),
  };

  result.recovered = await recoverStaleClaims();

  // Claim and mark in one statement. SKIP LOCKED means a second worker takes
  // different rows rather than blocking on these, and `state = 'sending'`
  // takes them out of the due set for good — not merely until a lease lapses.
  const claimed = (await db.execute(sql`
    UPDATE notifications
    SET state = 'sending', claimed_at = now(), claimed_by = ${worker},
        attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM notifications
      WHERE state = 'pending' AND send_after <= now()
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, channel, recipient, subject, body, attempts
  `)) as unknown as Claimed[];

  result.claimed = claimed.length;

  // Bounded concurrency: strictly serial meant one hanging provider held up
  // every message behind it, and the scheduler's request with it.
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let message = queue.shift(); message; message = queue.shift()) {
      await deliver(message, worker, result);
    }
  });
  await Promise.all(workers);

  return result;
}

async function deliver(message: Claimed, worker: string, result: DrainResult): Promise<void> {
  let sent;
  try {
    sent = await withTimeout(sender().send(message), SEND_TIMEOUT_MS);
  } catch (error) {
    sent = { delivered: false as const, error: String(error) };
  }

  try {
    if (sent.delivered) {
      await db.execute(sql`
        UPDATE notifications
        SET state = 'sent', sent_at = now(), last_error = NULL, claimed_at = NULL, claimed_by = NULL
        WHERE id = ${message.id} AND claimed_by = ${worker}
      `);
      result.delivered++;
      return;
    }

    // A permanent failure — a number that cannot receive texts — is not worth
    // four more attempts.
    if (message.attempts >= MAX_ATTEMPTS || sent.permanent === true) {
      await db.execute(sql`
        UPDATE notifications
        SET state = 'abandoned', last_error = ${sent.error}, claimed_at = NULL, claimed_by = NULL
        WHERE id = ${message.id} AND claimed_by = ${worker}
      `);
      result.abandoned++;
      return;
    }

    const wait = BACKOFF_SECONDS[Math.min(message.attempts - 1, BACKOFF_SECONDS.length - 1)]!;
    await db.execute(sql`
      UPDATE notifications
      SET state = 'pending', last_error = ${sent.error}, claimed_at = NULL, claimed_by = NULL,
          send_after = now() + make_interval(secs => ${wait})
      WHERE id = ${message.id} AND claimed_by = ${worker}
    `);
    result.failed++;
  } catch (error) {
    // The send may well have happened; we simply could not write down that it
    // did. The row stays `sending` and the sweeper will return it, so this is
    // the one case where a duplicate is still possible — count it so it is
    // visible rather than silent.
    console.error(`[outbox] could not record the outcome for ${message.id}`, error);
    result.unresolved++;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`the provider did not answer within ${ms}ms`)), ms).unref(),
    ),
  ]);
}
