import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import postgres from 'postgres';
import { drainOutbox } from '@/lib/notifications/outbox';
import { unconfiguredSender, useSender, type Message, type Sent } from '@/lib/notifications/sender';

/**
 * The outbox worker, against a real database.
 *
 * No message leaves this process: every test installs its own sender. That is
 * the point of the seam — the queue, its retries and its giving-up are all
 * exercised without a provider, a bill or a real phone.
 */

const sql = postgres(process.env.DATABASE_URL!);

/** A sender that answers however the test says, and records what it saw. */
function fakeSender(answer: (m: Message) => Sent | Promise<Sent>) {
  const seen: Message[] = [];
  useSender({
    describe: () => 'test sender',
    async send(message) {
      seen.push(message);
      return answer(message);
    },
  });
  return seen;
}

const delivers = () => fakeSender(() => ({ delivered: true }));
const failsWith = (error: string, permanent = false) =>
  fakeSender(() => ({ delivered: false, error, permanent }));

async function queue(body = 'hello', sendAfter = 'now()'): Promise<string> {
  const [row] = await sql.unsafe(
    `INSERT INTO notifications (channel, recipient, body, send_after)
     VALUES ('sms', '8455550000', $1, ${sendAfter}) RETURNING id`,
    [body],
  );
  return row!.id as string;
}
const stateOf = async (id: string) =>
  (await sql`SELECT state, attempts, last_error, sent_at, send_after FROM notifications WHERE id = ${id}`)[0]!;

beforeEach(async () => {
  await sql`DELETE FROM notifications WHERE recipient = '8455550000'`;
  // The drain is global by design — it sends whatever is due, whoever queued
  // it. Park anything another suite left behind so these tests count only
  // their own messages.
  await sql`UPDATE notifications SET state = 'sent', sent_at = now()
    WHERE state = 'pending' AND recipient <> '8455550000'`;
  useSender(unconfiguredSender);
});
after(async () => {
  await sql`DELETE FROM notifications WHERE recipient = '8455550000'`;
  useSender(unconfiguredSender);
  await sql.end();
});

describe('draining the outbox', () => {
  it('sends a queued message and marks it sent', async () => {
    const id = await queue('123456 is your code');
    const seen = delivers();

    const result = await drainOutbox();
    assert.equal(result.delivered, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.body, '123456 is your code');
    assert.equal(seen[0]!.channel, 'sms');

    const row = await stateOf(id);
    assert.equal(row.state, 'sent');
    assert.ok(row.sent_at, 'the time it went is recorded');
  });

  it('leaves a message queued when there is no provider', async () => {
    // The default. Nothing is delivered and nothing is lost — the opposite of
    // a system that looks like it works in development.
    const id = await queue();
    const result = await drainOutbox();
    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 1);
    assert.match(result.provider, /no delivery provider/i);

    const row = await stateOf(id);
    assert.equal(row.state, 'pending', 'still queued for when a provider exists');
    assert.match(row.last_error, /provider/i);
  });

  it('backs off rather than retrying immediately', async () => {
    const id = await queue();
    failsWith('the network was busy');
    await drainOutbox();

    const row = await stateOf(id);
    assert.equal(row.attempts, 1);
    assert.ok(new Date(row.send_after).getTime() > Date.now() + 30_000, 'due at least half a minute out');

    // A second drain right away must not pick it up again.
    const again = await drainOutbox();
    assert.equal(again.claimed, 0, 'a backed-off message is not due yet');
  });

  it('gives up after five attempts, and keeps the row', async () => {
    const id = await queue();
    failsWith('still failing');
    for (let attempt = 1; attempt <= 5; attempt++) {
      await sql`UPDATE notifications SET send_after = now() WHERE id = ${id}`;
      await drainOutbox();
    }
    const row = await stateOf(id);
    assert.equal(row.state, 'abandoned');
    assert.equal(row.attempts, 5);
    assert.match(row.last_error, /still failing/, 'why it was never delivered is kept');
  });

  it('gives up at once on a permanent failure', async () => {
    const id = await queue();
    failsWith('that number cannot receive texts', true);
    await drainOutbox();
    const row = await stateOf(id);
    assert.equal(row.state, 'abandoned');
    assert.equal(row.attempts, 1, 'no point trying four more times');
  });

  it('does not send a message that is not due yet', async () => {
    await queue('later', "now() + interval '1 hour'");
    const seen = delivers();
    const result = await drainOutbox();
    assert.equal(result.claimed, 0);
    assert.equal(seen.length, 0);
  });

  it('never sends a message twice, even when workers overlap', async () => {
    // The failure this guards against is a driver told twice — which is
    // exactly what the old system did, and why nothing sends inline any more.
    for (let i = 0; i < 10; i++) await queue(`message ${i}`);
    const seen = delivers();

    await Promise.all([drainOutbox(), drainOutbox(), drainOutbox(), drainOutbox()]);

    assert.equal(seen.length, 10, 'ten messages, ten sends');
    const bodies = seen.map((m) => m.body).sort();
    assert.equal(new Set(bodies).size, 10, 'no message sent twice');

    const [{ c }] = await sql`SELECT count(*)::int c FROM notifications
      WHERE recipient = '8455550000' AND state = 'sent'`;
    assert.equal(c, 10);
  });

  it('keeps going when one message throws', async () => {
    const ok1 = await queue('fine one');
    await queue('explodes');
    const ok2 = await queue('fine two');
    fakeSender((m) => {
      if (m.body === 'explodes') throw new Error('provider blew up');
      return { delivered: true };
    });

    const result = await drainOutbox();
    assert.equal(result.delivered, 2, 'the other two still went');
    assert.equal(result.failed, 1);
    assert.equal((await stateOf(ok1)).state, 'sent');
    assert.equal((await stateOf(ok2)).state, 'sent');
  });

  it('sends the oldest first', async () => {
    await queue('first');
    await sql`UPDATE notifications SET created_at = now() - interval '1 hour'
      WHERE recipient = '8455550000' AND body = 'first'`;
    await queue('second');
    const seen = delivers();
    await drainOutbox();
    assert.deepEqual(seen.map((m) => m.body), ['first', 'second']);
  });
});
