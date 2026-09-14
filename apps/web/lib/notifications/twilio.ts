import type { Message, Sender, Sent } from './sender';

/**
 * Sends text messages through Twilio.
 *
 * `docs/06-external-services.md` calls for this directly: the old system sent
 * "texts" by emailing a carrier gateway, several carriers have switched those
 * off, and messages to Verizon were already being dropped.
 *
 * No SDK. The Messages API is a single authenticated form POST, and calling it
 * with `fetch` keeps the dependency surface small and lets the tests drive a
 * real request/response without a network.
 *
 * The important behaviour here is not sending — it is classifying a failure.
 * The outbox abandons a message it is told is permanent, and a wrongly
 * abandoned message is one a driver never receives. So only the *recipient*
 * being wrong is permanent. Bad credentials, a rate limit or an outage are the
 * office's problem to fix, and the message must wait for them rather than be
 * thrown away.
 */

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** A Twilio number in E.164, or a Messaging Service SID (`MG...`). */
  from: string;
  /** Country code assumed for a local number with no `+`. */
  defaultCountryCode?: string;
  /**
   * Where the API lives. Twilio has regional endpoints
   * (`api.au1.twilio.com`, `api.ie1.twilio.com`) for data-residency, and a
   * local stand-in is useful for exercising the whole path without an account.
   */
  baseUrl?: string;
  /** Injectable for tests; defaults to the global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Twilio error codes where the number itself is the problem. Retrying cannot
 * help, so the outbox should stop and record why.
 *
 * Everything else — 20003 bad credentials, 429 too many requests, any 5xx —
 * is deliberately *not* here. Those are recoverable, and abandoning a driver's
 * sign-in code because a token was rotated would be the worse failure.
 */
const RECIPIENT_IS_WRONG = new Set([
  21211, // 'To' is not a valid phone number
  21214, // 'To' is not a valid mobile number
  21401, // invalid phone number
  21408, // not permitted to send to this region
  21610, // the recipient replied STOP
  21612, // this number cannot receive messages from that sender
  21614, // 'To' is not a mobile number
]);

/**
 * Turns a stored number into E.164.
 *
 * The roster holds numbers as they were typed — `8455550101`, `(845) 555-0101`.
 * Twilio needs `+18455550101`. A number that already carries a `+` is trusted
 * as written, so an international driver is not mangled into a US number.
 */
export function toE164(raw: string, countryCode = '1'): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 8 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+${countryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(countryCode)) return `+${digits}`;
  return null;
}

export function twilioSender(config: TwilioConfig): Sender {
  const call = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const usingService = config.from.startsWith('MG');

  return {
    describe: () =>
      `Twilio (account ${config.accountSid.slice(0, 6)}…, ${usingService ? 'messaging service' : 'from ' + config.from})`,

    async send(message: Message): Promise<Sent> {
      if (message.channel !== 'sms') {
        return {
          delivered: false,
          error: `Twilio is configured for text messages; this one is ${message.channel}.`,
          // Not the recipient's fault and not retryable either — but marking it
          // permanent stops the outbox retrying something that cannot work.
          permanent: true,
        };
      }

      const to = toE164(message.recipient, config.defaultCountryCode ?? '1');
      if (!to) {
        return {
          delivered: false,
          error: `"${message.recipient}" is not a phone number we can send to.`,
          permanent: true,
        };
      }

      const form = new URLSearchParams({ To: to, Body: message.body });
      if (usingService) form.set('MessagingServiceSid', config.from);
      else form.set('From', config.from);

      let response: Response;
      try {
        response = await call(
          `${config.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              // Basic auth. Never logged: the token is a standing credential.
              authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: form.toString(),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      } catch (error) {
        // A network failure says nothing about the message. Try again later.
        return { delivered: false, error: `Could not reach Twilio: ${String(error)}` };
      }

      if (response.ok) return { delivered: true };

      const detail = (await readError(response)) ?? { message: `HTTP ${response.status}` };
      return {
        delivered: false,
        error: `Twilio refused the message (${detail.code ?? response.status}): ${detail.message}`,
        permanent: detail.code !== undefined && RECIPIENT_IS_WRONG.has(detail.code),
      };
    },
  };
}

async function readError(response: Response): Promise<{ code?: number; message: string } | null> {
  try {
    const body = (await response.json()) as { code?: number; message?: string };
    return { code: body.code, message: body.message ?? `HTTP ${response.status}` };
  } catch {
    return null;
  }
}
