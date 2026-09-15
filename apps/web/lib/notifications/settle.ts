import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { isPermanentCode, IN_PLAIN_WORDS } from './twilio';

/**
 * Applies what the provider says became of a message it had accepted.
 *
 * One function, because there are two ways to hear it — Twilio posting to
 * the status callback, and the outbox asking Twilio directly — and the queue
 * must read the same whichever way the news arrived. The first real message
 * this system sent was refused by the carrier (toll-free number not verified)
 * while the row sat at `accepted`, because the callback could not reach a
 * machine with no public address. Asking is how that row gets settled.
 */

/** Twilio's terminal statuses, and what each one means for the queue. */
const OUTCOME = {
  delivered: 'sent',
  undelivered: 'failed',
  failed: 'failed',
  canceled: 'abandoned',
} as const;

export type Settled = 'sent' | 'failed' | 'abandoned' | null;

/**
 * Moves the row for `reference` to its outcome. Returns what it became, or
 * `null` when the status settles nothing (queued, sending, sent, accepted —
 * still on its way).
 *
 * `state = 'accepted'` in the WHERE is what makes this safe to hear more than
 * once and out of order: Twilio retries callbacks, and a `sent` can arrive
 * after `delivered`. Only a row still waiting on an outcome can be moved.
 *
 * `undelivered` and `failed` stay put rather than going back in the queue.
 * Twilio has already tried; re-sending the same message risks a second copy
 * if the carrier's report was wrong. A driver waiting on a sign-in code asks
 * for another one, which queues a fresh code — that path exists, is
 * rate-limited, and cannot double-send.
 */
export async function settle(
  reference: string,
  status: string,
  errorCode: string | number | null | undefined,
): Promise<Settled> {
  let outcome: Settled = OUTCOME[status as keyof typeof OUTCOME] ?? null;
  if (!outcome) return null;

  const code = errorCode === null || errorCode === undefined || errorCode === '' ? undefined : Number(errorCode);
  const unsendable = isPermanentCode(code);
  const why = code !== undefined ? IN_PLAIN_WORDS[code] : undefined;
  const detail = code !== undefined
    ? `Twilio reported ${status} (${code})${why ? `: ${why}` : '.'}`
    : `Twilio reported ${status}.`;

  // A number that can never be texted is `abandoned`, the same as when the
  // Messages API says so up front. Two states for one fact would have meant
  // the office reading the queue by which route the bad news arrived.
  if (outcome === 'failed' && unsendable) outcome = 'abandoned';

  await db.execute(sql`
    UPDATE notifications
    SET state = ${outcome}::outbox_state,
        delivered_at = CASE WHEN ${outcome} = 'sent' THEN now() ELSE delivered_at END,
        last_error = CASE WHEN ${outcome} = 'sent' THEN NULL ELSE ${detail} END
    WHERE provider_ref = ${reference} AND state = 'accepted'
  `);
  return outcome;
}
