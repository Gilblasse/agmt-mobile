import { settle } from '@/lib/notifications/settle';
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

  // queued, sending, sent, accepted, scheduled settle nothing; settle() says
  // so by returning null, and there is nothing to record.
  await settle(reference, status, fields.get('ErrorCode'));

  // A reference we do not know is not an error worth retrying: it may be a
  // message this database never queued. Take it and say nothing.
  return new Response(null, { status: 204 });
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}
