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
export const unconfiguredSender: Sender = {
  describe: () => 'no delivery provider configured — nothing is being sent',
  async send(message) {
    console.warn(
      `[outbox] would send ${message.channel} to ${message.recipient}: ${message.body.slice(0, 60)}`,
    );
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
