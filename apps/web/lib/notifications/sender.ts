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

let current: Sender = unconfiguredSender;

export function useSender(sender: Sender): void {
  current = sender;
}

export function sender(): Sender {
  return current;
}
