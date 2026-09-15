import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { OFFICE_TIME_ZONE } from '@/lib/office-clock';
import { sender, type Channel } from './sender';
import { settle } from './settle';

/**
 * Drains the notification outbox.
 *
 * Nothing in this system sends inline. The old one did, and a driver was
 * sometimes told twice — or not at all, with no record either way.
 *
 * The hard part is not sending; it is making sure a message is sent exactly
 * once when workers overlap, a provider hangs, or a process dies mid-send.
 * Five things do that, and the first version of this file had none of them:
 *
 *  - **A claim is a state, not a timeout.** `sending` with a worker id says
 *    "someone has this". An earlier design stamped one lease across a whole
 *    batch and sent it serially, so the last message of a batch had already
 *    spent its lease before anything was sent to it — and a second worker
 *    re-sent it.
 *  - **The claim is re-stamped for each message, immediately before it is
 *    sent**, so the lease only ever has to cover one send whatever the batch
 *    size, and a row the sweeper has taken back is not sent from memory.
 *  - **Every send is bounded**, and the bound is smaller than the claim, so a
 *    hang can never outlive it.
 *  - **Recording the outcome cannot lose a delivered message, and cannot
 *    invent one.** The write that marks a row is fallible *and* conditional:
 *    if it throws, or if it changes no rows because the claim moved, the row
 *    must not be counted as sent. Counting an `UPDATE` that matched nothing
 *    as a success reported `accepted: 1` for a row left `pending` — which was
 *    then sent a second time.
 *  - **A failure that is not about the message does not consume it.** No
 *    provider, a rotated token, a switch off in the console: the message waits
 *    for the office. But it waits with a back-off, because twenty rows that
 *    can never send are the twenty oldest rows due, and retried every minute
 *    they fill every batch for ever while a driver's sign-in code expires
 *    behind them.
 */

const MAX_ATTEMPTS = 5;
/** Back-off in seconds by attempt: about a minute, then five, fifteen, an hour, three. */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10_800];
/** The same shape for a provider that is down or unconfigured, so it stops crowding the queue. */
const PROVIDER_BACKOFF_SECONDS = [60, 300, 900, 3600, 10_800];

/** How long a claim is honoured before a sweeper may reclaim it. */
export const CLAIM_LEASE_SECONDS = readLeaseSeconds(process.env.OUTBOX_LEASE_SECONDS);
/** A send must finish well inside the claim, so a hang can never outlive it. */
const SEND_TIMEOUT_MS = Math.max(1_000, (CLAIM_LEASE_SECONDS * 1000) / 4);
/** How many messages are in flight at once. Serial sending means one slow provider stalls the queue. */
const CONCURRENCY = 4;
/** After this long with no delivery report, an `accepted` message is worth saying out loud. */
const CONFIRMATION_WINDOW_MINUTES = 15;
/** After this long with no delivery report, ask the provider directly. */
const ASK_AFTER_SECONDS = 60;
/** How many accepted messages to ask about per drain. Bounded, like everything else here. */
const ASK_AT_MOST = 20;

export function readLeaseSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 120;
  const seconds = Number(raw);
  // `Number('2m')` is NaN, and NaN fails every comparison — including the
  // assertion below, which is the one thing standing between this and sending
  // everything twice. It also reaches Postgres as `make_interval(secs => NaN)`
  // and takes every drain down with it. Refuse it here, where the message can
  // name the setting.
  if (!Number.isFinite(seconds) || seconds < 10) {
    throw new Error(
      `OUTBOX_LEASE_SECONDS must be a number of seconds, at least 10. Got: ${JSON.stringify(raw)}`,
    );
  }
  return seconds;
}

if (SEND_TIMEOUT_MS >= CLAIM_LEASE_SECONDS * 1000) {
  // The whole recovery scheme rests on this. Fail at load rather than
  // duplicate messages at three in the morning.
  throw new Error('A send may not be allowed to take longer than a claim lasts.');
}

export type DrainResult = {
  claimed: number;
  /** Handed to the provider. Not the same as delivered; a callback confirms that. */
  accepted: number;
  failed: number;
  abandoned: number;
  /** Given up on because they were no longer worth sending. */
  expired: number;
  /** Sent or not — nobody knows. These need a person, and are never retried blindly. */
  unresolved: number;
  recovered: number;
  /**
   * Accepted a while ago and still unconfirmed. Not an error on its own, but
   * a number that keeps climbing means messages are being filtered or no
   * delivery reports are arriving.
   */
  unconfirmed: number;
  /** Accepted messages whose outcome was learned by asking the provider. */
  settled: number;
  provider: string;
  /** Set when nothing can be sent at all. The reason, in the provider's words. */
  providerProblem: string | null;
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
      AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${CLAIM_LEASE_SECONDS}))
    RETURNING id
  `)) as unknown as unknown[];
  return rows.length;
}

/**
 * Gives up on messages that are no longer worth sending.
 *
 * A sign-in code is good for ten minutes and the back-off runs to three hours.
 * Without this, a provider outage over lunch would text drivers codes that
 * expired before the message left — which is worse than no text at all,
 * because the driver types it in and is told it is wrong.
 *
 * The time in the sentence is the *office's* time. It was the database
 * session's, which is the server's, which is nobody's (CLAUDE.md #3), and it
 * had microseconds and a UTC offset in a line a dispatcher is meant to read.
 */
async function expireOverdue(): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE notifications
    SET state = 'abandoned',
        last_error = 'Not sent in time. This message was only good until '
          || to_char(expires_at AT TIME ZONE ${OFFICE_TIME_ZONE}, 'FMHH12:MI am')
          || ' on ' || to_char(expires_at AT TIME ZONE ${OFFICE_TIME_ZONE}, 'FMDay FMDD FMMonth')
          || '.'
    WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()
    RETURNING id
  `)) as unknown as unknown[];
  return rows.length;
}

/**
 * Asks the provider what became of messages it accepted and never reported on.
 *
 * The status callback is the normal way to learn this, and it needs a public
 * address. This is the other way, and it exists because of the first real
 * message this system sent: the carrier refused it within five seconds, Twilio
 * knew, and the row sat at `accepted` on a machine no callback could reach.
 * The outcome is applied through the same `settle()` the callback uses, so
 * the queue reads identically whichever way the news arrived.
 *
 * A row with no reference can never be asked about; it stays `accepted` and
 * is counted in `unconfirmed`, which is the honest answer for it.
 */
async function askAboutAccepted(): Promise<number> {
  const ask = sender().check;
  if (!ask) return 0;

  const rows = (await db.execute(sql`
    SELECT provider_ref AS reference FROM notifications
    WHERE state = 'accepted' AND provider_ref IS NOT NULL AND delivered_at IS NULL
      AND sent_at < now() - make_interval(secs => ${ASK_AFTER_SECONDS})
    ORDER BY sent_at
    LIMIT ${ASK_AT_MOST}
  `)) as unknown as { reference: string }[];

  let settled = 0;
  for (const { reference } of rows) {
    let answer;
    try {
      answer = await withTimeout(ask(reference), SEND_TIMEOUT_MS);
    } catch (error) {
      answer = { known: false as const, error: String(error) };
    }
    if (!answer.known) continue; // still unconfirmed; it will be asked again next time
    if (await settle(reference, answer.status, answer.errorCode)) settled++;
  }
  return settled;
}

/** Messages the provider took a while ago and has never reported on. */
async function countUnconfirmed(): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM notifications
    WHERE state = 'accepted' AND delivered_at IS NULL
      AND sent_at < now() - make_interval(mins => ${CONFIRMATION_WINDOW_MINUTES})
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
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
    accepted: 0,
    failed: 0,
    abandoned: 0,
    expired: 0,
    unresolved: 0,
    recovered: 0,
    unconfirmed: 0,
    settled: 0,
    provider: sender().describe(),
    providerProblem: null,
  };

  result.recovered = await recoverStaleClaims();
  result.expired = await expireOverdue();

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

  result.settled = await askAboutAccepted();
  result.unconfirmed = await countUnconfirmed();
  return result;
}

/**
 * Re-takes the claim on one message, right before sending it — and checks it
 * is still worth sending.
 *
 * `false` means somebody else now owns this row, or the row stopped being
 * worth sending while the batch ran: the sweeper handed the claim on, or a
 * newer sign-in code superseded this one. Sending it here would be either the
 * duplicate this file exists to prevent, or a text carrying a code that has
 * already been replaced — which a driver cannot tell from the live one.
 */
async function stillOurs(id: string, worker: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE notifications SET claimed_at = now()
    WHERE id = ${id} AND claimed_by = ${worker} AND state = 'sending'
      AND (expires_at IS NULL OR expires_at > now())
    RETURNING id
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** Puts a row that is no longer worth sending out of the queue, with a reason. */
async function standDown(id: string, worker: string): Promise<void> {
  await db.execute(sql`
    UPDATE notifications
    SET state = 'abandoned', claimed_at = NULL, claimed_by = NULL,
        last_error = coalesce(last_error, 'Not sent: it stopped being worth sending before it went out.')
    WHERE id = ${id} AND claimed_by = ${worker} AND state = 'sending'
  `);
}

async function deliver(message: Claimed, worker: string, result: DrainResult): Promise<void> {
  if (!(await stillOurs(message.id, worker))) {
    await standDown(message.id, worker);
    return;
  }

  let sent;
  try {
    sent = await withTimeout(sender().send(message), SEND_TIMEOUT_MS);
  } catch (error) {
    sent =
      error instanceof Deadline
        ? {
            // Our own deadline. Whether the message went is exactly what is not
            // known, so it is not retried blindly.
            accepted: false as const,
            error: `${error.message} This message may or may not have been sent.`,
            cause: 'unresolved' as const,
          }
        : {
            // The sender threw. Every network failure is classified inside the
            // adapter, so an exception escaping it is a fault in our code
            // before a request was made — retryable.
            accepted: false as const,
            error: `The sender failed: ${String(error)}`,
          };
  }

  try {
    if (sent.accepted) {
      // `accepted`, not `sent`: the provider has it. Whether the handset got
      // it arrives on a status callback, which moves the row to `sent`.
      await record(
        message.id,
        worker,
        result,
        'accepted',
        sql`
          UPDATE notifications
          SET state = 'accepted', sent_at = now(), last_error = NULL,
              provider_ref = ${sent.reference ?? null},
              claimed_at = NULL, claimed_by = NULL
          WHERE id = ${message.id} AND claimed_by = ${worker} AND state = 'sending'
          RETURNING id
        `,
      );
      return;
    }

    // Nobody knows whether this was sent. Never retried, never abandoned: it
    // stops here and a person decides. Guessing either way is how a driver
    // gets the same sign-in code twice, or none.
    if (sent.cause === 'unresolved') {
      await record(
        message.id,
        worker,
        result,
        'unresolved',
        sql`
          UPDATE notifications
          SET state = 'unresolved', last_error = ${sent.error}, claimed_at = NULL, claimed_by = NULL
          WHERE id = ${message.id} AND claimed_by = ${worker} AND state = 'sending'
          RETURNING id
        `,
      );
      return;
    }

    // Nothing to do with this message — no provider, a rotated token, a switch
    // off in the console. Hand back the attempt it was charged on claiming,
    // and back off on a count of its own so a queue of unsendable rows does
    // not fill every batch for ever.
    if (sent.cause === 'provider') {
      result.providerProblem ??= sent.error;
      await record(
        message.id,
        worker,
        result,
        'failed',
        sql`
          UPDATE notifications
          SET state = 'pending', last_error = ${sent.error},
              attempts = greatest(attempts - 1, 0),
              config_attempts = config_attempts + 1,
              claimed_at = NULL, claimed_by = NULL,
              send_after = now() + make_interval(secs => ${sql.raw(providerBackoffCase())})
          WHERE id = ${message.id} AND claimed_by = ${worker} AND state = 'sending'
          RETURNING id
        `,
      );
      return;
    }

    // A permanent failure — a number that cannot receive texts — is not worth
    // four more attempts.
    if (message.attempts >= MAX_ATTEMPTS || sent.permanent === true) {
      await record(
        message.id,
        worker,
        result,
        'abandoned',
        sql`
          UPDATE notifications
          SET state = 'abandoned', last_error = ${sent.error}, claimed_at = NULL, claimed_by = NULL
          WHERE id = ${message.id} AND claimed_by = ${worker} AND state = 'sending'
          RETURNING id
        `,
      );
      return;
    }

    const wait = BACKOFF_SECONDS[Math.min(message.attempts - 1, BACKOFF_SECONDS.length - 1)]!;
    // If the next attempt would land after this message stopped being worth
    // sending, there is no next attempt. Decided in SQL so the expiry is read
    // and acted on in the same statement.
    const rows = (await db.execute(sql`
      UPDATE notifications
      SET state = CASE
            WHEN expires_at IS NOT NULL AND expires_at <= now() + make_interval(secs => ${wait})
            THEN 'abandoned'::outbox_state ELSE 'pending'::outbox_state END,
          last_error = ${sent.error}, claimed_at = NULL, claimed_by = NULL,
          send_after = now() + make_interval(secs => ${wait})
      WHERE id = ${message.id} AND claimed_by = ${worker} AND state = 'sending'
      RETURNING state
    `)) as unknown as { state: string }[];
    if (rows.length === 0) result.unresolved++;
    else if (rows[0]!.state === 'abandoned') result.abandoned++;
    else result.failed++;
  } catch (error) {
    // The send may well have happened; we simply could not write down that it
    // did. The row stays `sending` and the sweeper will return it, so this is
    // the one case where a duplicate is still possible — count it so it is
    // visible rather than silent.
    console.error(`[outbox] could not record the outcome for ${message.id}`, error);
    result.unresolved++;
  }
}

/**
 * Applies one outcome and counts it *only if it actually landed*.
 *
 * A conditional `UPDATE` that matches nothing does not throw. Counting it as
 * a success reported a message accepted while leaving the row `pending` for
 * another worker to send again — a silent duplicate, in the one file whose
 * whole job is not having those.
 */
async function record(
  id: string,
  worker: string,
  result: DrainResult,
  outcome: 'accepted' | 'failed' | 'abandoned' | 'unresolved',
  statement: ReturnType<typeof sql>,
): Promise<void> {
  const rows = (await db.execute(statement)) as unknown as unknown[];
  if (rows.length === 0) {
    console.error(`[outbox] the claim on ${id} moved before its outcome (${outcome}) could be written`);
    result.unresolved++;
    return;
  }
  if (outcome === 'accepted') result.accepted++;
  else if (outcome === 'failed') result.failed++;
  else if (outcome === 'abandoned') result.abandoned++;
  else result.unresolved++;
}

/** The provider back-off as a SQL expression over the row's own count. */
function providerBackoffCase(): string {
  // `SET` expressions all see the row as it was before this statement, so the
  // count this arm is choosing for is `config_attempts + 1`. Written as `<`
  // rather than `<= n + 1` to keep that visible: getting it wrong gave two
  // rounds at sixty seconds, which is the starvation this back-off exists to
  // stop.
  const arms = PROVIDER_BACKOFF_SECONDS.map(
    (seconds, index) => `WHEN config_attempts < ${index + 1} THEN ${seconds}`,
  ).join(' ');
  const last = PROVIDER_BACKOFF_SECONDS[PROVIDER_BACKOFF_SECONDS.length - 1];
  return `(CASE ${arms} ELSE ${last} END)`;
}

/** Our own deadline firing — told apart from the sender throwing, which means something else. */
class Deadline extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Deadline(`The provider did not answer within ${ms}ms.`)), ms).unref(),
    ),
  ]);
}
