import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { drainOutbox } from '@/lib/notifications/outbox';
import { unconfiguredSender, useSender, type Message, type Sent } from '@/lib/notifications/sender';
import { twilioSender } from '@/lib/notifications/twilio';
import { sql } from './_db';

/**
 * The outbox worker, against a real database.
 *
 * No message leaves this process: every test installs its own sender. That is
 * the point of the seam — the queue, its retries and its giving-up are all
 * exercised without a provider, a bill or a real phone.
 */


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

const delivers = () => fakeSender(() => ({ accepted: true }));
const failsWith = (error: string, permanent = false) =>
  fakeSender(() => ({ accepted: false, error, permanent }));

async function queue(body = 'hello', sendAfter = 'now()'): Promise<string> {
  const [row] = await sql.unsafe(
    `INSERT INTO notifications (channel, recipient, body, send_after)
     VALUES ('sms', '8455550000', $1, ${sendAfter}) RETURNING id`,
    [body],
  );
  return row!.id as string;
}
const stateOf = async (id: string) =>
  (await sql`SELECT state, attempts, last_error, sent_at, send_after, provider_ref FROM notifications WHERE id = ${id}`)[0]!;

beforeEach(async () => {
  // The drain is global by design — it sends whatever is due, whoever queued
  // it — so these tests need the queue to themselves. Earlier suites' rows are
  // *deleted* rather than marked sent: marking them recorded a delivery that
  // never happened, which is the one thing this table must never claim.
  await sql`DELETE FROM notifications`;
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
    assert.equal(result.accepted, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.body, '123456 is your code');
    assert.equal(seen[0]!.channel, 'sms');

    const row = await stateOf(id);
    assert.equal(row.state, 'accepted', 'Twilio has it; a callback confirms delivery');
    assert.ok(row.sent_at, 'the time it went is recorded');
  });

  it('leaves a message queued when there is no provider', async () => {
    // The default. Nothing is delivered and nothing is lost — the opposite of
    // a system that looks like it works in development.
    const id = await queue();
    const result = await drainOutbox();
    assert.equal(result.accepted, 0);
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
    for (let i = 0; i < 10; i++) await queue(`message ${i}`);
    const seen = delivers();

    await Promise.all([drainOutbox(), drainOutbox(), drainOutbox(), drainOutbox()]);

    assert.equal(seen.length, 10, 'ten messages, ten sends');
    assert.equal(new Set(seen.map((m) => m.body)).size, 10, 'no message sent twice');
  });

  it('never sends a message twice when the provider is SLOW', async () => {
    // The version of this test above cannot fail for the bug that mattered:
    // its sender returns in microseconds, so no claim can ever go stale while
    // a send is still in flight. A provider that takes longer than the claim
    // is exactly when a second worker used to pick the message up and send it
    // again — a driver told twice.
    for (let i = 0; i < 6; i++) await queue(`slow ${i}`);
    const seen = fakeSender(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { accepted: true };
    });

    // Overlapping workers, and a sweeper pass in the middle of the sends.
    const drains = Promise.all([drainOutbox(), drainOutbox()]);
    await new Promise((r) => setTimeout(r, 150));
    await drainOutbox();
    await drains;

    assert.equal(new Set(seen.map((m) => m.body)).size, seen.length, 'no message sent twice');
    assert.equal(seen.length, 6, 'six messages, six sends');
  });

  it('gives up on a provider that never answers, instead of hanging the queue', async () => {
    // Serial sending with no timeout meant one hanging provider held up every
    // message behind it, and the scheduler's request with it.
    await queue('hangs');
    await queue('behind it');
    let finished = 0;
    useSender({
      describe: () => 'hanging sender',
      async send(message) {
        if (message.body === 'hangs') await new Promise((r) => setTimeout(r, 60_000).unref?.());
        finished++;
        return { accepted: true };
      },
    });

    const result = await Promise.race([
      drainOutbox(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('drain hung')), 40_000).unref()),
    ]) as Awaited<ReturnType<typeof drainOutbox>>;

    assert.equal(finished, 1, 'the message behind the hang still went');
    assert.equal(result.accepted, 1);
    assert.equal(result.failed, 1, 'the hanging one is retried later, not lost');
  });

  it('returns a message whose worker never came back', async () => {
    const id = await queue('stranded');
    // A worker claimed it and died: state 'sending', claim long stale.
    await sql`UPDATE notifications SET state = 'sending',
      claimed_at = now() - interval '1 hour', claimed_by = 'a worker that died'
      WHERE id = ${id}`;
    const seen = delivers();
    const result = await drainOutbox();
    assert.equal(result.recovered, 1, 'the stale claim was returned to the queue');
    assert.equal(seen.length, 1, 'and then sent');
    assert.equal((await stateOf(id)).state, 'accepted');
  });

  it('keeps going when one message throws', async () => {
    const ok1 = await queue('fine one');
    await queue('explodes');
    const ok2 = await queue('fine two');
    fakeSender((m) => {
      if (m.body === 'explodes') throw new Error('provider blew up');
      return { accepted: true };
    });

    const result = await drainOutbox();
    assert.equal(result.accepted, 2, 'the other two still went');
    assert.equal(result.failed, 1);
    assert.equal((await stateOf(ok1)).state, 'accepted');
    assert.equal((await stateOf(ok2)).state, 'accepted');
  });

  it('takes the oldest first', async () => {
    await queue('first');
    await sql`UPDATE notifications SET created_at = now() - interval '1 hour'
      WHERE recipient = '8455550000' AND body = 'first'`;
    await queue('second');
    const seen = delivers();

    // One at a time, because that is the only ordering the outbox actually
    // promises. Messages are *claimed* oldest first, but four are sent at
    // once, so which of those four reaches the provider first is a race — and
    // asserting on send order with a batch of two was only ever passing by
    // accident. What matters is that a message is never passed over: queue
    // one behind another and the older one goes on the earlier drain.
    await drainOutbox(1);
    await drainOutbox(1);

    // Only this test's own messages: asserting on everything the sender saw
    // made this flake whenever another suite left a row behind.
    const mine = seen.map((m) => m.body).filter((b) => b === 'first' || b === 'second');
    assert.deepEqual(mine, ['first', 'second']);
  });
});

describe('with Twilio behind the outbox', () => {
  /** A stand-in for Twilio's HTTP endpoint. Everything up to it is the real thing. */
  function twilioAnswering(reply: () => Response) {
    const requests: URLSearchParams[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(new URLSearchParams(String(init?.body ?? '')));
      return reply();
    }) as unknown as typeof fetch;
    useSender(
      twilioSender({
        accountSid: 'AC_test',
        authToken: 'secret',
        from: '+15550001111',
        fetch: fetchImpl,
      }),
    );
    return requests;
  }

  it('sends a queued sign-in code as a text and marks it sent', async () => {
    const id = await queue('123456 is your Amazing Grace sign-in code.');
    const requests = twilioAnswering(() => new Response('{"sid":"SM1"}', { status: 201 }));

    const result = await drainOutbox();
    assert.equal(result.accepted, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.get('To'), '+18455550000', 'the stored number became E.164');
    assert.match(requests[0]!.get('Body') ?? '', /123456/);
    assert.equal((await stateOf(id)).state, 'accepted');
  });

  it('keeps the message when Twilio is having a bad day', async () => {
    const id = await queue('keep me');
    twilioAnswering(() => new Response('{"code":20500,"message":"internal error"}', { status: 500 }));

    await drainOutbox();
    const row = await stateOf(id);
    assert.equal(row.state, 'pending', 'queued for a retry, not thrown away');
    assert.match(row.last_error, /20500/);
  });

  it('stops trying when the driver has replied STOP', async () => {
    const id = await queue('they unsubscribed');
    twilioAnswering(() => new Response('{"code":21610,"message":"unsubscribed"}', { status: 400 }));

    await drainOutbox();
    const row = await stateOf(id);
    assert.equal(row.state, 'abandoned', 'no point retrying four more times');
    assert.equal(row.attempts, 1);
    // The office needs to be able to find out why a driver was never told.
    assert.match(row.last_error, /21610/);
  });
});

describe('not spending the budget on things that are not the message’s fault', () => {
  it('does not charge an attempt when there is no provider at all', async () => {
    // Every drain used to charge the message an attempt on claiming it,
    // whatever came back. With the credentials unset that is five drains —
    // about four and a half hours — to abandon every sign-in code in the
    // queue, for a reason that has nothing to do with any of them.
    const id = await queue('nobody to send me');
    useSender(unconfiguredSender);
    for (let drain = 0; drain < 7; drain++) {
      await sql`UPDATE notifications SET send_after = now() WHERE id = ${id}`;
      await drainOutbox();
    }
    const row = await stateOf(id);
    assert.equal(row.state, 'pending', 'still waiting for a provider, not thrown away');
    assert.equal(row.attempts, 0, 'none of that was this message’s doing');
  });

  it('still gives up on a message the provider keeps refusing', async () => {
    // The other half of the same rule: a real failure does count.
    const id = await queue('genuinely refused');
    failsWith('the carrier said no');
    for (let attempt = 1; attempt <= 5; attempt++) {
      await sql`UPDATE notifications SET send_after = now() WHERE id = ${id}`;
      await drainOutbox();
    }
    assert.equal((await stateOf(id)).state, 'abandoned');
  });
});

describe('messages that stop being worth sending', () => {
  const expiring = async (body: string, expiresAt: string) => {
    const id = await queue(body);
    await sql.unsafe(`UPDATE notifications SET expires_at = ${expiresAt} WHERE id = $1`, [id]);
    return id;
  };

  it('does not send a sign-in code that expired while it was queued', async () => {
    // A code is good for ten minutes; the back-off runs to three hours. A text
    // arriving with a dead code is worse than no text: the driver types it in
    // and is told it is wrong.
    const id = await expiring('123456 is your code', "now() - interval '1 minute'");
    const seen = delivers();

    const result = await drainOutbox();
    assert.equal(result.expired, 1);
    assert.equal(seen.length, 0, 'nothing was sent');
    const row = await stateOf(id);
    assert.equal(row.state, 'abandoned');
    assert.match(row.last_error, /only good until/);
  });

  it('does not schedule a retry for after the code dies', async () => {
    // The first back-off is a minute. A code with thirty seconds left has no
    // next attempt, so the row is finished with now rather than waking up to
    // send something useless.
    const id = await expiring('nearly dead', "now() + interval '30 seconds'");
    failsWith('the network was busy');
    await drainOutbox();
    assert.equal((await stateOf(id)).state, 'abandoned');
  });

  it('leaves a message with time left alone', async () => {
    const id = await expiring('plenty of time', "now() + interval '2 hours'");
    failsWith('the network was busy');
    await drainOutbox();
    assert.equal((await stateOf(id)).state, 'pending');
  });
});

describe('a claim taken back mid-batch', () => {
  it('does not send a message the sweeper handed to somebody else', async () => {
    // A batch is claimed all at once and sent a few at a time, so the last
    // messages of a batch sit claimed while the earlier ones are in flight. At
    // twenty per batch, four at a time, five sends of up to thirty seconds
    // each, that wait outlasts a two-minute lease — and the sweeper returns a
    // row this worker is still holding in memory and about to send.
    //
    // Here the batch is five with four in flight, and the fifth row's claim is
    // aged by hand: the same situation, without waiting two minutes for it.
    for (let i = 0; i < 4; i++) await queue(`ahead ${i}`);
    const last = await queue('last in the batch');
    const seen = fakeSender(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { accepted: true };
    });

    const batch = drainOutbox(5);
    await new Promise((r) => setTimeout(r, 80));
    await sql`UPDATE notifications SET claimed_at = now() - interval '1 hour' WHERE id = ${last}`;
    // A second worker sweeps, takes the stale claim and sends it.
    await drainOutbox(5);
    await batch;

    const mine = seen.filter((m) => m.body === 'last in the batch');
    assert.equal(mine.length, 1, 'the last message of the batch went exactly once');
  });
});

describe('what Twilio says inside a 201', () => {
  it('keeps a message Twilio accepted but immediately failed', async () => {
    const id = await queue('refused on the way in');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sid: 'SM9', status: 'failed', error_code: 30001 }), {
        status: 201,
      })) as unknown as typeof fetch;
    useSender(
      twilioSender({ accountSid: 'AC', authToken: 't', from: '+15550001111', fetch: fetchImpl }),
    );

    const result = await drainOutbox();
    assert.equal(result.accepted, 0, 'a 201 that says "failed" is not an acceptance');
    assert.equal((await stateOf(id)).state, 'pending', 'queued for another try');
  });

  it('keeps Twilio’s reference, so a delivery report can find the row', async () => {
    const id = await queue('find me later');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sid: 'SMabc', status: 'queued' }), {
        status: 201,
      })) as unknown as typeof fetch;
    useSender(
      twilioSender({ accountSid: 'AC', authToken: 't', from: '+15550001111', fetch: fetchImpl }),
    );

    await drainOutbox();
    const row = await stateOf(id);
    assert.equal(row.state, 'accepted');
    assert.equal(row.provider_ref, 'SMabc');
  });
});
