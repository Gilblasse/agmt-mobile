import { masked } from './mask';
import { twilioSender } from './twilio';

/**
 * How a message actually leaves the building.
 *
 * Deliberately an interface with a do-nothing default. The outbox, its
 * retries, its dedupe and its giving-up are all built and tested here, and the
 * last inch is a function a provider plugs into. Until one is configured
 * nothing is delivered, and `describe()` says so rather than the system
 * quietly looking like it works.
 */

export type Channel = 'sms' | 'email' | 'push';

export type Message = {
  channel: Channel;
  recipient: string;
  subject: string | null;
  body: string;
};

/**
 * What a provider can truthfully report the moment it answers.
 *
 * `accepted` — not `delivered`. A provider answering "I have it" is the only
 * thing knowable synchronously; whether a handset ever received it arrives
 * later, on a status callback, or never. Calling that field `delivered` is how
 * a carrier-rejected message came to be recorded as a success.
 *
 * `cause: 'configuration'` marks a failure that has nothing to do with this
 * message — no provider configured, a bad API address. The outbox must not
 * spend the message's retry budget on those, or an afternoon with the
 * credentials unset would abandon the whole queue.
 */
export type Sent =
  | { accepted: true; reference?: string | null }
  | { accepted: false; error: string; permanent?: boolean; cause?: 'configuration' };

export interface Sender {
  describe(): string;
  send(message: Message): Promise<Sent>;
}

/**
 * The default. Records what it *would* have sent and reports failure, so a
 * queued message stays queued and nobody mistakes a development run for
 * working delivery.
 */
export const unconfiguredSender: Sender = {
  describe: () => 'no delivery provider configured — nothing is being sent',
  async send(message) {
    // Never the body: it carries the sign-in code, and this is the sender
    // production runs until a provider is wired. An earlier version logged
    // both the code and the driver's phone number in clear.
    console.warn(`[outbox] would send ${message.channel} to ${masked(message.recipient)}`);
    return {
      accepted: false,
      error: 'No delivery provider is configured. See docs/06-external-services.md.',
      cause: 'configuration',
    };
  },
};

let installed: Sender | null = null;

/**
 * Replaces the sender. Tests only.
 *
 * Refuses to work in production. It is a module-level global that silently
 * redirects every message in the process, exported from a file production
 * imports; a stray call would divert real sign-in codes with nothing in the
 * logs to say so.
 */
export function useSender(sender: Sender): void {
  refuseInProduction('useSender');
  installed = sender;
}

/** Forgets an explicitly installed sender, so the next call re-reads the environment. */
export function resetSender(): void {
  refuseInProduction('resetSender');
  installed = null;
}

function refuseInProduction(name: string): void {
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_SENDER_OVERRIDE) {
    throw new Error(`${name}() is a test seam and must not be called in production.`);
  }
}

/**
 * The sender to use now.
 *
 * Resolved on first use rather than installed at boot. Next bundles
 * `instrumentation.ts` separately from route handlers, so a sender assigned to
 * a module variable during startup is simply not there when a route runs — the
 * startup log said Twilio while the drain reported no provider and sent
 * nothing. Reading the environment where it is needed is correct under any
 * bundling.
 */
export function sender(): Sender {
  if (!installed) installed = fromEnvironment();
  return installed;
}

/**
 * Builds the sender described by the environment.
 *
 * Text messages go to Twilio, per `docs/06-external-services.md`. Email has no
 * provider yet, so an email message says so plainly rather than disappearing
 * into a sender that cannot carry it — a real gap, not a design: the sign-in
 * code delivery `[must]` in `docs/07-feature-checklist.md:182` covers
 * "whichever channel(s) are actually available for that driver", and a driver
 * on the roster with an email address and no phone cannot be sent a code
 * today. A partial configuration is treated as no configuration: half
 * configured must never look ready.
 */
function fromEnvironment(env: SendingEnv = process.env): Sender {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  if (!accountSid || !authToken || !from) return unconfiguredSender;

  let sms: Sender;
  try {
    sms = twilioSender({
      accountSid,
      authToken,
      from,
      defaultRegion: env.SMS_DEFAULT_REGION ?? 'US',
      ...(env.TWILIO_BASE_URL ? { baseUrl: env.TWILIO_BASE_URL } : {}),
      ...(env.TWILIO_STATUS_CALLBACK_URL ? { statusCallbackUrl: env.TWILIO_STATUS_CALLBACK_URL } : {}),
    });
  } catch (error) {
    // A bad setting must not take the process down mid-shift, and must not
    // spend anyone's retry budget either. Say what is wrong, keep the queue.
    const why = error instanceof Error ? error.message : String(error);
    return {
      describe: () => `Twilio is misconfigured: ${why}`,
      async send() {
        return { accepted: false, error: why, cause: 'configuration' };
      },
    };
  }

  const described = `sms: ${sms.describe()}; email: none`;
  return {
    describe: () => described,
    async send(message) {
      if (message.channel !== 'sms') {
        return {
          accepted: false,
          error: `No provider is configured for ${message.channel}. See docs/06-external-services.md.`,
          cause: 'configuration',
        };
      }
      return sms.send(message);
    },
  };
}

export type SendingEnv = Partial<
  Record<
    | 'TWILIO_ACCOUNT_SID'
    | 'TWILIO_AUTH_TOKEN'
    | 'TWILIO_FROM'
    | 'TWILIO_BASE_URL'
    | 'TWILIO_STATUS_CALLBACK_URL'
    | 'SMS_DEFAULT_REGION',
    string
  >
> &
  Record<string, string | undefined>;

/** What the environment describes, without installing it. For the startup log. */
export function describeConfiguredSender(env: SendingEnv = process.env): string {
  return fromEnvironment(env).describe();
}

export { masked };
