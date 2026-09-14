import { twilioSender } from './twilio';
/**
 * How a message actually leaves the building.
 *
 * Deliberately an interface with a do-nothing default. The old system sent
 * "texts" by emailing a carrier gateway, and docs/06 is explicit that this has
 * to be replaced with a real provider — but which provider is a business
 * decision with a bill attached, and the worker should not wait on it.
 *
 * So the outbox, its retries, its dedupe and its back-off are all built and
 * tested here, and the last inch is a function someone plugs a provider into.
 * Until then nothing is delivered, and `describe()` says so rather than the
 * system quietly looking like it works.
 */

export type Channel = 'sms' | 'email' | 'push';

export type Message = {
  channel: Channel;
  recipient: string;
  subject: string | null;
  body: string;
};

export type Sent = { delivered: true } | { delivered: false; error: string; permanent?: boolean };

export interface Sender {
  describe(): string;
  send(message: Message): Promise<Sent>;
}

/**
 * The default. Records what it *would* have sent and reports failure, so a
 * queued message stays queued and nobody mistakes a development run for
 * working delivery.
 */
/** Enough to tell one recipient from another; not enough to be a phone number. */
function masked(recipient: string): string {
  if (recipient.includes('@')) {
    const [user = '', domain = ''] = recipient.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return `***${recipient.slice(-4)}`;
}

export const unconfiguredSender: Sender = {
  describe: () => 'no delivery provider configured — nothing is being sent',
  async send(message) {
    // Never the body: it carries the sign-in code, and this is the sender
    // production runs until a provider is wired. An earlier version logged
    // both the code and the driver's phone number in clear.
    console.warn(`[outbox] would send ${message.channel} to ${masked(message.recipient)}`);
    return {
      delivered: false,
      error: 'No delivery provider is configured. See docs/06-external-services.md.',
    };
  },
};

let installed: Sender | null = null;

/** Replaces the sender. For tests; production reads the environment. */
export function useSender(sender: Sender): void {
  installed = sender;
}

/** Forgets an explicitly installed sender, so the next call re-reads the environment. */
export function resetSender(): void {
  installed = null;
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
 * into a sender that cannot carry it. A partial configuration is treated as no
 * configuration: half-configured must never look ready.
 */
function fromEnvironment(env: SendingEnv = process.env): Sender {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  if (!accountSid || !authToken || !from) return unconfiguredSender;

  const sms = twilioSender({
    accountSid,
    authToken,
    from,
    defaultCountryCode: env.SMS_DEFAULT_COUNTRY_CODE ?? '1',
    ...(env.TWILIO_BASE_URL ? { baseUrl: env.TWILIO_BASE_URL } : {}),
  });

  const described = `sms: ${sms.describe()}; email: none`;
  return {
    describe: () => described,
    async send(message) {
      if (message.channel !== 'sms') {
        return {
          delivered: false,
          error: `No provider is configured for ${message.channel}. See docs/06-external-services.md.`,
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
    | 'SMS_DEFAULT_COUNTRY_CODE'
    | 'TWILIO_BASE_URL',
    string
  >
> &
  Record<string, string | undefined>;

/** What the environment describes, without installing it. For the startup log. */
export function describeConfiguredSender(env: SendingEnv = process.env): string {
  return fromEnvironment(env).describe();
}
