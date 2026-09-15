import parsePhoneNumber, { isSupportedCountry } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';
import { masked } from './mask';
import type { Checked, Message, Sender, Sent } from './sender';

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
 * 21214 used to be here, described in this file as "'To' is not a valid mobile
 * number". Twilio's own meaning is "'To' phone number cannot be reached",
 * which is not always permanent — so abandoning on it threw away a message
 * that a later attempt would have delivered.
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
  21401, // invalid phone number
  21610, // the recipient replied STOP
  21614, // 'To' is not a mobile number
  21602, // no message body
  21617, // the body is longer than Twilio will take
]);

/**
 * Codes that are about the account or the provider, not about this message.
 *
 * These look like failures and are really settings: a rotated token, a
 * geographic permission left off, a `From` number that cannot text, Twilio
 * having a bad hour. Moving them out of the permanent set was not enough —
 * they still spent the message's retry budget, so a wrong token over one lunch
 * abandoned every queued sign-in code in eighty-one minutes. They must not
 * count at all; the message waits for the office, which is what the paragraph
 * above has always claimed it does.
 */
const NOT_THIS_MESSAGE = new Set([
  20003, // authenticate — the token is wrong or rotated
  20005, // the account is suspended
  20429, // too many requests
  21408, // no permission to send to that region: a console checkbox
  21606, // the 'From' number is not ours, or cannot send texts
  21612, // this sender cannot reach that number
  30001, // queue overflow
  30002, // the account is suspended
  30034, // US A2P 10DLC: this number has no approved campaign — days of registration, not a retry
  30032, // a toll-free From number that has not passed toll-free verification — same story
  21608, // a trial account can only text numbers verified in the console
]);

/**
 * What a permanent refusal means, in words the office can act on.
 *
 * `last_error` is where somebody looks when a driver says they never got a
 * code, and "21610" is not an answer. 21610 in particular is not a fault at
 * all: the driver texted STOP, every future code will be refused the same way,
 * and until somebody talks to them they can never sign in again.
 */
export const IN_PLAIN_WORDS: Record<number, string> = {
  21211: 'that is not a phone number Twilio will take.',
  21401: 'that is not a phone number Twilio will take.',
  21610: 'this driver replied STOP to a text, so Twilio will not send to them. Until they text START back, no code can reach them and they cannot sign in. Somebody has to tell them.',
  21614: 'that number is a landline and cannot receive texts.',
  21602: 'the message had no text in it.',
  21617: 'the message was too long to send.',
  // Not permanent — these are the account's to fix — but they are the ones
  // somebody in the office has to act on, so they need to be readable.
  30032: 'our toll-free number has not passed toll-free verification, so US carriers refuse everything from it. Submit the verification in the Twilio console (Phone Numbers → Active numbers → Regulatory Information). Nothing will be delivered until it is approved. This was the reason the first real message this system sent did not arrive.',
  30034: 'our number is not registered to an approved A2P 10DLC campaign, so US carriers refuse messages from it. Register in the Twilio console; it takes days.',
  21608: 'the Twilio account is still a trial, which can only text numbers verified in its console. Upgrade the account, or verify this number.',
  21408: 'texting this country is switched off for the Twilio account (Messaging → Settings → Geo Permissions).',
  21606: 'our sending number is not an SMS-capable number on this Twilio account.',
  20003: 'Twilio refused our credentials. TWILIO_AUTH_TOKEN is wrong or has been rotated.',
};

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
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(
      `TWILIO_BASE_URL must be https (it carries the auth token and every sign-in code). ` +
        `Plain http is allowed only for a stand-in on this machine. Got: ${raw}`,
    );
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    // The request path is built from the account SID against this address, so
    // a path here is silently discarded: an operator fronting Twilio with a
    // gateway at /twilio-proxy would send the account's auth token to the
    // gateway's root instead, with nothing to say so.
    throw new Error(
      `TWILIO_BASE_URL must be a bare host with no path (the API path is added to it). Got: ${raw}`,
    );
  }
  return url;
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

      const attemptedAt = Date.now();
      let response: Response;
      try {
        response = await call(messagesUrl(), {
          method: 'POST',
          headers: authHeaders(),
          body: form.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // A failure to *connect* says nothing reached Twilio, so trying again
        // is safe. A timeout or a dropped socket says the opposite: the
        // request may well have arrived and the message may well exist. Sending
        // it again is how a driver is texted the same code twice — the thing
        // this whole queue exists to prevent — and it happened with the
        // shipped ten-second default against a provider that answered in
        // eleven. So ask Twilio what it actually has before deciding.
        if (neverLeftThisMachine(error)) {
          return { accepted: false, error: `Could not reach Twilio: ${describe(error)}` };
        }
        return reconcile(to, message.body, attemptedAt, describe(error));
      }

      const body = await readBody(response);

      if (!response.ok) {
        const code = numeric(body?.code);
        const detail =
          (code !== undefined ? IN_PLAIN_WORDS[code] : undefined) ??
          redactNumbers(body?.message ?? `HTTP ${response.status}`);
        return {
          accepted: false,
          error: `Twilio refused the message (${code ?? response.status}): ${detail}`,
          permanent: code !== undefined && CANNOT_EVER_SEND.has(code),
          ...(notThisMessage(code, response.status) ? { cause: 'provider' as const } : {}),
        };
      }

      // A 2xx only means Twilio took it. The body says what it then did with
      // it, and that can already be a refusal.
      const status = body?.status;
      if (status === 'failed' || status === 'undelivered' || status === 'canceled') {
        const code = numeric(body?.error_code);
        const why = code !== undefined ? IN_PLAIN_WORDS[code] : undefined;
        return {
          accepted: false,
          error: `Twilio could not send the message (${status}${code ? `, ${code}` : ''})${why ? `: ${why}` : '.'}`,
          permanent: code !== undefined && CANNOT_EVER_SEND.has(code),
          ...(notThisMessage(code, response.status) ? { cause: 'provider' as const } : {}),
        };
      }

      // Accepted, queued, sending, sent, delivered. Only a status callback
      // — or asking — turns any of these into a confirmed delivery, so say
      // only what is known: Twilio has it, and here is its reference for it.
      return { accepted: true, reference: typeof body?.sid === 'string' ? body.sid : null };
    },

    /**
     * Asks Twilio what became of a message it accepted.
     *
     * The status callback is the cheap way to learn this, and it needs a
     * public address to post to. Without one — a developer's machine, a
     * deployment behind a firewall, a callback URL nobody configured — the
     * row would sit at `accepted` for ever while Twilio already knew. The
     * first real message this system sent was refused by the carrier five
     * seconds after acceptance, and the queue found out only because it asked.
     */
    async check(reference: string): Promise<Checked> {
      if (!/^[A-Za-z0-9]{34}$/.test(reference)) {
        return { known: false, error: `${reference} is not a Twilio message reference.` };
      }
      let response: Response;
      try {
        response = await call(
          new URL(`/2010-04-01/Accounts/${config.accountSid}/Messages/${reference}.json`, base).toString(),
          { method: 'GET', headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) },
        );
      } catch (error) {
        return { known: false, error: `Could not ask Twilio: ${describe(error)}` };
      }
      const body = await readBody(response);
      if (!response.ok || typeof body?.status !== 'string') {
        return {
          known: false,
          error: `Twilio would not say (${numeric(body?.code) ?? response.status}): ${redactNumbers(body?.message ?? '')}`,
        };
      }
      return { known: true, status: body.status, errorCode: numeric(body.error_code) ?? null };
    },
  };

  function messagesUrl(): string {
    return new URL(`/2010-04-01/Accounts/${config.accountSid}/Messages.json`, base).toString();
  }

  function authHeaders(): Record<string, string> {
    return {
      // Basic auth. Never logged: the token is a standing credential.
      authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    };
  }

  /**
   * Asks Twilio whether it already has the message we could not get an answer
   * about.
   *
   * Three outcomes, and the third is the point: if Twilio cannot be asked
   * either, nobody knows whether the driver was texted, and the honest thing
   * is to say so rather than guess. The outbox parks it for a person instead
   * of sending again or giving up.
   */
  async function reconcile(
    to: string,
    body: string,
    attemptedAt: number,
    why: string,
  ): Promise<Sent> {
    const query = new URLSearchParams({ To: to, PageSize: '20' });
    let found: { sid?: unknown; body?: unknown; date_created?: unknown }[] | null = null;
    try {
      const response = await call(`${messagesUrl()}?${query}`, {
        method: 'GET',
        headers: authHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const listed = (await response.json()) as { messages?: unknown };
        if (Array.isArray(listed.messages)) found = listed.messages;
      } else {
        await response.text();
      }
    } catch {
      found = null;
    }

    if (found === null) {
      return {
        accepted: false,
        cause: 'unresolved',
        error:
          `Twilio did not answer (${why}), and asking it what it has did not answer either. ` +
          `This message may or may not have been sent; somebody has to look before it is sent again.`,
      };
    }

    const match = found.find(
      (m) =>
        m.body === body &&
        typeof m.date_created === 'string' &&
        // Bodies repeat — "your trip was cancelled" is the same words every
        // time — so an old message with the same text is not this one.
        Math.abs(Date.parse(m.date_created) - attemptedAt) < 10 * 60_000,
    );
    if (match && typeof match.sid === 'string') {
      return { accepted: true, reference: match.sid };
    }
    return {
      accepted: false,
      error: `Twilio did not answer (${why}), and has no record of the message, so it will be tried again.`,
    };
  }
}

/**
 * Whether a `fetch` failure means the request never left this machine.
 *
 * DNS and a refused connection are safe to retry. A timeout, an abort or a
 * socket that died mid-flight are not: the request may have arrived.
 */
function neverLeftThisMachine(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code
    ?? (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Whether a refusal is about the account or the provider rather than the message. */
function notThisMessage(code: number | undefined, status: number): boolean {
  if (code !== undefined && NOT_THIS_MESSAGE.has(code)) return true;
  // 401/403 is a credential, 429 is a rate limit, 5xx is Twilio. None of them
  // are anything this message did.
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/**
 * Takes phone numbers out of text the provider wrote.
 *
 * Twilio quotes the number back in its own error messages — "The 'To' number
 * +18455559906 is not a valid phone number" — and that string is stored in
 * `notifications.last_error`, which is read by whoever is looking at the
 * queue. Masking the one sentence this file composes itself was not enough.
 */
export function redactNumbers(text: string): string {
  return text.replace(/\+?\d[\d\-. ()]{6,}\d/g, (run) => `***${run.replace(/\D/g, '').slice(-4)}`);
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
