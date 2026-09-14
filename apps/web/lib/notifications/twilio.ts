import parsePhoneNumber, { isSupportedCountry } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';
import { masked } from './mask';
import type { Message, Sender, Sent } from './sender';

/**
 * Sends text messages through Twilio.
 *
 * `docs/06-external-services.md` calls for this directly: the old system sent
 * "texts" by emailing a carrier gateway, several carriers have switched those
 * off, and messages to Verizon were already being dropped. The reason given
 * for leaving those gateways is worth keeping in view while reading this file
 * — *no delivery confirmation*.
 *
 * No SDK. The Messages API is a single authenticated form POST, and calling it
 * with `fetch` keeps the dependency surface small and lets the tests drive a
 * real request/response without a network.
 *
 * Two things here decide a driver's fate, and both have been got wrong once:
 *
 *  - **Accepted is not delivered.** Twilio answers 201 the moment it takes the
 *    message, and the body of that 201 can say `"status":"failed"`. Reading
 *    `response.ok` as success recorded a message the carrier rejected as a
 *    clean delivery — the same blindness the carrier gateways were abandoned
 *    for. Delivery is confirmed by a status callback, later, or not at all.
 *  - **Only the recipient being wrong is permanent.** The outbox abandons a
 *    message it is told is permanent, and a wrongly abandoned message is one
 *    the driver never receives. Bad credentials, a rate limit, an outage, a
 *    setting switched off in the console — those are the office's to fix, and
 *    the message waits for them.
 */

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** A Twilio number in E.164, or a Messaging Service SID (`MG` + 32 hex). */
  from: string;
  /**
   * Region assumed for a roster number written without a country code — an
   * ISO country like `US` or `GB`, not a dialling prefix. A prefix cannot do
   * this job: `+1` glued onto any ten digits turns a London number written
   * locally into a real number in Maine, and the code goes to a stranger.
   */
  defaultRegion?: string;
  /**
   * Where the API lives. Twilio has regional endpoints
   * (`api.au1.twilio.com`, `api.ie1.twilio.com`) for data-residency, and a
   * local stand-in is useful for exercising the whole path without an account.
   */
  baseUrl?: string;
  /**
   * Public URL Twilio should post delivery updates to. Without it nothing is
   * ever confirmed delivered — messages stop at `accepted`, honestly.
   */
  statusCallbackUrl?: string;
  /** Injectable for tests; defaults to the global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Twilio error codes where this message can never be sent, so retrying is
 * only delay before the same answer.
 *
 * Two kinds qualify: the number is not one we can text, or the message itself
 * is malformed. Note what is deliberately *absent*.
 *
 * `21408` (no permission to send to that region) and `21612` (this sender
 * cannot reach that number) read like the recipient's fault and are not: both
 * are account settings, toggled in the Twilio console. Listing them as
 * permanent meant one switch left off abandoned every queued message on its
 * first attempt — every driver's sign-in code thrown away, with the office
 * able to fix the cause in a minute.
 *
 * Also absent: 20003 bad credentials, 429 too many requests, any 5xx, and
 * 21606 (the `From` number is not ours or cannot text) — all recoverable.
 */
const CANNOT_EVER_SEND = new Set([
  21211, // 'To' is not a valid phone number
  21214, // 'To' is not a valid mobile number
  21401, // invalid phone number
  21610, // the recipient replied STOP
  21614, // 'To' is not a mobile number
  21602, // no message body
  21617, // the body is longer than Twilio will take
]);

/** A Messaging Service SID, as opposed to an alphanumeric sender ID like `MGTransport`. */
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;

/**
 * Turns a stored number into E.164.
 *
 * The roster holds numbers as they were typed — `8455550101`, `(845) 555-0101`,
 * `845-555-0101 x12`. A real phone-number library does this, because the
 * arithmetic version does not work: counting to ten digits and prefixing `+1`
 * sent a driver's sign-in code to a stranger in Maine, and the outbox recorded
 * it as a success. `region` is a country, and the number is only accepted if
 * it is actually a valid number in that country.
 */
export function toE164(raw: string, region = 'US'): string | null {
  let parsed;
  try {
    parsed = parsePhoneNumber(raw, region as CountryCode);
  } catch {
    // An unknown region, or input the parser refuses outright.
    return null;
  }
  if (!parsed || !parsed.isValid()) return null;
  // `.number` is E.164 without the extension. An extension cannot be dialled
  // by SMS, and appending its digits to the number — which the arithmetic
  // version did — makes a different number entirely.
  return parsed.number;
}

/**
 * Checks the API address before anything is sent to it.
 *
 * Every request carries the account's standing auth token, and every text
 * carries a sign-in code. Over `http://` both go out in clear — which is how
 * this was actually configured while being tested. Plain HTTP is allowed only
 * for a stand-in on this machine.
 */
export function checkBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`TWILIO_BASE_URL is not a URL: ${raw}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && local) return url;
  throw new Error(
    `TWILIO_BASE_URL must be https (it carries the auth token and every sign-in code). ` +
      `Plain http is allowed only for a stand-in on this machine. Got: ${raw}`,
  );
}

export function twilioSender(config: TwilioConfig): Sender {
  const call = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const usingService = MESSAGING_SERVICE_SID.test(config.from);
  const base = checkBaseUrl(config.baseUrl ?? 'https://api.twilio.com');
  const region = config.defaultRegion ?? 'US';
  if (!isSupportedCountry(region)) {
    // Caught at startup rather than turning every roster number written
    // without a country code into "not a phone number we can send to".
    throw new Error(
      `SMS_DEFAULT_REGION must be a two-letter country like US or GB, not "${region}".`,
    );
  }
  const confirms = Boolean(config.statusCallbackUrl);

  return {
    describe: () =>
      `Twilio (account ${config.accountSid.slice(0, 6)}…, ` +
      `${usingService ? 'messaging service' : 'from ' + config.from}, ` +
      `${confirms ? 'delivery confirmed by status callback' : 'no status callback — delivery is never confirmed'})`,

    async send(message: Message): Promise<Sent> {
      if (message.channel !== 'sms') {
        return {
          accepted: false,
          error: `Twilio is configured for text messages; this one is ${message.channel}.`,
          // Not the recipient's fault and not retryable either — but marking it
          // permanent stops the outbox retrying something that cannot work.
          permanent: true,
        };
      }

      const to = toE164(message.recipient, region);
      if (!to) {
        return {
          accepted: false,
          // Masked: this string is stored in notifications.last_error.
          error: `${masked(message.recipient)} is not a phone number we can send to (read as ${region}).`,
          permanent: true,
        };
      }

      const form = new URLSearchParams({ To: to, Body: message.body });
      if (usingService) form.set('MessagingServiceSid', config.from);
      else form.set('From', config.from);
      if (config.statusCallbackUrl) form.set('StatusCallback', config.statusCallbackUrl);

      let response: Response;
      try {
        response = await call(
          new URL(`/2010-04-01/Accounts/${config.accountSid}/Messages.json`, base).toString(),
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
        return { accepted: false, error: `Could not reach Twilio: ${String(error)}` };
      }

      const body = await readBody(response);

      if (!response.ok) {
        const code = numeric(body?.code);
        const detail = body?.message ?? `HTTP ${response.status}`;
        return {
          accepted: false,
          error: `Twilio refused the message (${code ?? response.status}): ${detail}`,
          permanent: code !== undefined && CANNOT_EVER_SEND.has(code),
        };
      }

      // A 2xx only means Twilio took it. The body says what it then did with
      // it, and that can already be a refusal.
      const status = body?.status;
      if (status === 'failed' || status === 'undelivered' || status === 'canceled') {
        const code = numeric(body?.error_code);
        return {
          accepted: false,
          error: `Twilio could not send the message (${status}${code ? `, ${code}` : ''}).`,
          permanent: code !== undefined && CANNOT_EVER_SEND.has(code),
        };
      }

      // Accepted, queued, sending, sent, delivered. Only a status callback
      // turns any of these into a confirmed delivery, so say only what is
      // known: Twilio has it, and here is its reference for it.
      return { accepted: true, reference: typeof body?.sid === 'string' ? body.sid : null };
    },
  };
}

type TwilioBody = {
  sid?: unknown;
  status?: unknown;
  code?: unknown;
  error_code?: unknown;
  message?: string;
};

/**
 * Reads the JSON body, whatever the status.
 *
 * Always read it, even when it is not going to be used: an undrained body
 * holds the connection open in Node's fetch until it is garbage-collected.
 */
async function readBody(response: Response): Promise<TwilioBody | null> {
  try {
    return (await response.json()) as TwilioBody;
  } catch {
    return null;
  }
}

/**
 * Twilio's error codes come back as numbers from the Messages API and as
 * strings on a status callback. A `Set` of numbers matches one and not the
 * other, which quietly made every callback failure look unclassified.
 */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Whether a code on a status callback means this message can never be sent. */
export function isPermanentCode(code: unknown): boolean {
  const n = numeric(code);
  return n !== undefined && CANNOT_EVER_SEND.has(n);
}
