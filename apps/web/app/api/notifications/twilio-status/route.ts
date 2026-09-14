import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { isPermanentCode } from '@/lib/notifications/twilio';
import { signatureMatches } from '@/lib/notifications/twilio-signature';

/**
 * POST /api/notifications/twilio-status — Twilio's delivery updates.
 *
 * The one thing `docs/06-external-services.md` says the old carrier-email
 * "texts" could never give: confirmation that a message arrived. Twilio posts
 * here as a message moves through `queued` → `sent` → `delivered`, or fails.
 *
 * Until this endpoint is configured (`TWILIO_STATUS_CALLBACK_URL`) a message
 * stops at `accepted` and the outbox says so. That is the honest state: the
 * provider has it, nobody knows if the driver does.
 *
 * Twilio is the caller, not one of our apps, so this speaks Twilio's protocol
 * — form-encoded in, a bare status code out — rather than the `Result`
 * envelope the rest of the API uses.
 */

/** Twilio's terminal statuses, and what each one means for the queue. */
const OUTCOME = {
  delivered: 'sent',
  undelivered: 'failed',
  failed: 'failed',
  canceled: 'abandoned',
} as const;

export async function POST(request: Request): Promise<Response> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const callbackUrl = process.env.TWILIO_STATUS_CALLBACK_URL;
  if (!authToken || !callbackUrl) {
    // Nothing was ever told to post here. Refusing is the safe answer: the
    // alternative is an unauthenticated endpoint that edits delivery records.
    return new Response(null, { status: 404 });
  }

  const fields = new URLSearchParams(await request.text());
  if (!signatureMatches(authToken, callbackUrl, fields, request.headers.get('x-twilio-signature'))) {
    return new Response(null, { status: 403 });
  }

  const reference = fields.get('MessageSid') ?? fields.get('SmsSid');
  const status = fields.get('MessageStatus') ?? fields.get('SmsStatus');
  if (!reference || !status) return new Response(null, { status: 400 });

  const outcome = OUTCOME[status as keyof typeof OUTCOME];
  // queued, sending, sent, accepted, scheduled: on their way. Nothing settled
  // yet, and nothing to record.
  if (!outcome) return new Response(null, { status: 204 });

  const errorCode = fields.get('ErrorCode');
  const detail = errorCode
    ? `Twilio reported ${status} (${errorCode})${isPermanentCode(errorCode) ? ' — this number cannot be texted' : ''}.`
    : `Twilio reported ${status}.`;

  // `undelivered` and `failed` stay put rather than going back in the queue.
  // Twilio has already tried; re-sending the same message risks a second copy
  // arriving if the carrier's report was wrong. A driver waiting on a sign-in
  // code asks for another one, which queues a fresh code — that path exists,
  // is rate-limited, and cannot double-send.
  //
  // `state = 'accepted'` in the WHERE is what makes this safe to receive more
  // than once and out of order: Twilio retries callbacks, and a `sent`
  // callback can arrive after `delivered`. Only a row still waiting on an
  // outcome can be moved by one.
  await db.execute(sql`
    UPDATE notifications
    SET state = ${outcome}::outbox_state,
        delivered_at = CASE WHEN ${outcome} = 'sent' THEN now() ELSE delivered_at END,
        last_error = CASE WHEN ${outcome} = 'sent' THEN NULL ELSE ${detail} END
    WHERE provider_ref = ${reference} AND state = 'accepted'
  `);

  // A reference we do not know is not an error worth retrying: it may be a
  // message this database never queued. Take it and say nothing.
  return new Response(null, { status: 204 });
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}
