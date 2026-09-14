import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, beforeEach, describe, it } from 'node:test';
import { POST } from '@/app/api/notifications/twilio-status/route';
import { sql } from './_db';

/**
 * Twilio's delivery reports.
 *
 * This is the one thing `docs/06-external-services.md` says the carrier-email
 * "texts" could never give, and the reason the adapter must not call Twilio's
 * 201 a delivery. The endpoint is public — Twilio has to reach it — so the
 * signature check is the whole of its security, and the tests here are mostly
 * about refusing.
 */

const TOKEN = 'the-account-auth-token';
const CALLBACK = 'https://agmt.example/api/notifications/twilio-status';

/**
 * Twilio's scheme, written out here rather than imported: a test that signs
 * with the same code it is checking proves only that the code agrees with
 * itself.
 */
function sign(url: string, fields: Record<string, string>, token = TOKEN): string {
  let base = url;
  for (const key of Object.keys(fields).sort()) base += key + fields[key];
  return createHmac('sha1', token).update(base).digest('base64');
}

function post(fields: Record<string, string>, signature?: string): Promise<Response> {
  return POST(
    new Request(CALLBACK, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature ?? sign(CALLBACK, fields),
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

async function accepted(reference: string): Promise<string> {
  const [row] = await sql`
    INSERT INTO notifications (channel, recipient, body, state, provider_ref, sent_at)
    VALUES ('sms', '8455550000', 'a code', 'accepted', ${reference}, now())
    RETURNING id`;
  return row!.id as string;
}
const stateOf = async (id: string) =>
  (await sql`SELECT state, last_error, delivered_at FROM notifications WHERE id = ${id}`)[0]!;

const was = { token: process.env.TWILIO_AUTH_TOKEN, url: process.env.TWILIO_STATUS_CALLBACK_URL };
beforeEach(async () => {
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.TWILIO_STATUS_CALLBACK_URL = CALLBACK;
  await sql`DELETE FROM notifications WHERE recipient = '8455550000'`;
});
after(async () => {
  Object.assign(process.env, { TWILIO_AUTH_TOKEN: was.token, TWILIO_STATUS_CALLBACK_URL: was.url });
  await sql`DELETE FROM notifications WHERE recipient = '8455550000'`;
  await sql.end();
});

describe('taking a delivery report from Twilio', () => {
  it('records a delivery against the message it is about', async () => {
    const id = await accepted('SM_delivered');
    const response = await post({ MessageSid: 'SM_delivered', MessageStatus: 'delivered' });
    assert.equal(response.status, 204);

    const row = await stateOf(id);
    assert.equal(row.state, 'sent', 'now it really was sent');
    assert.ok(row.delivered_at, 'and when');
    assert.equal(row.last_error, null);
  });

  it('records a failure, with the reason the office can act on', async () => {
    const id = await accepted('SM_failed');
    await post({ MessageSid: 'SM_failed', MessageStatus: 'undelivered', ErrorCode: '30006' });

    const row = await stateOf(id);
    assert.equal(row.state, 'failed');
    assert.match(row.last_error, /undelivered.*30006/);
    assert.equal(row.delivered_at, null);
  });

  it('says plainly when the number itself cannot be texted, and gives up on it', async () => {
    const id = await accepted('SM_landline');
    await post({ MessageSid: 'SM_landline', MessageStatus: 'failed', ErrorCode: '21614' });
    const row = await stateOf(id);
    assert.match(row.last_error, /cannot be texted/);
    // `abandoned`, the same as when the Messages API says so up front. Two
    // states for one fact would mean reading the queue by which route the bad
    // news arrived.
    assert.equal(row.state, 'abandoned');
  });

  it('ignores the statuses that only say it is on its way', async () => {
    const id = await accepted('SM_moving');
    for (const status of ['queued', 'sending', 'sent', 'accepted']) {
      const response = await post({ MessageSid: 'SM_moving', MessageStatus: status });
      assert.equal(response.status, 204);
      assert.equal((await stateOf(id)).state, 'accepted', `"${status}" settles nothing`);
    }
  });

  it('cannot be replayed into moving a settled message backwards', async () => {
    // Twilio retries callbacks, and they arrive out of order: a "sent" can
    // follow a "delivered". Only a message still waiting on an outcome may be
    // moved by one.
    const id = await accepted('SM_order');
    await post({ MessageSid: 'SM_order', MessageStatus: 'delivered' });
    await post({ MessageSid: 'SM_order', MessageStatus: 'failed', ErrorCode: '30008' });
    assert.equal((await stateOf(id)).state, 'sent', 'a late failure does not undo a delivery');
  });

  it('takes a reference it has never heard of without complaining', async () => {
    const response = await post({ MessageSid: 'SM_stranger', MessageStatus: 'delivered' });
    assert.equal(response.status, 204, 'not ours; nothing to retry');
  });
});

describe('refusing everybody else', () => {
  it('refuses a report that is not signed', async () => {
    const id = await accepted('SM_unsigned');
    const response = await POST(
      new Request(CALLBACK, {
        method: 'POST',
        body: new URLSearchParams({ MessageSid: 'SM_unsigned', MessageStatus: 'delivered' }).toString(),
      }),
    );
    assert.equal(response.status, 403);
    assert.equal((await stateOf(id)).state, 'accepted', 'untouched');
  });

  it('refuses a report signed with the wrong token', async () => {
    const id = await accepted('SM_wrong_token');
    const fields = { MessageSid: 'SM_wrong_token', MessageStatus: 'delivered' };
    const response = await post(fields, sign(CALLBACK, fields, 'not-the-token'));
    assert.equal(response.status, 403);
    assert.equal((await stateOf(id)).state, 'accepted');
  });

  it('refuses a report whose fields were changed after it was signed', async () => {
    const id = await accepted('SM_tampered');
    const signature = sign(CALLBACK, { MessageSid: 'SM_tampered', MessageStatus: 'queued' });
    const response = await post({ MessageSid: 'SM_tampered', MessageStatus: 'delivered' }, signature);
    assert.equal(response.status, 403);
    assert.equal((await stateOf(id)).state, 'accepted');
  });

  it('refuses a signature that is not even base64 of the right length', async () => {
    const fields = { MessageSid: 'SM_short', MessageStatus: 'delivered' };
    assert.equal((await post(fields, '')).status, 403);
    assert.equal((await post(fields, 'AAAA')).status, 403);
    assert.equal((await post(fields, '!!!not base64!!!')).status, 403);
  });

  it('refuses garbage that happens to be the right length', async () => {
    // A length check is not a comparison. These decode to exactly the twenty
    // bytes of a SHA-1, so they get past the guard and have to be rejected by
    // the compare itself.
    const id = await accepted('SM_right_length');
    const fields = { MessageSid: 'SM_right_length', MessageStatus: 'delivered' };
    for (const guess of ['A'.repeat(27) + '=', Buffer.alloc(20).toString('base64')]) {
      assert.equal(Buffer.from(guess, 'base64').length, 20, 'the length guard would let this through');
      assert.equal((await post(fields, guess)).status, 403);
    }
    assert.equal((await stateOf(id)).state, 'accepted', 'untouched');
  });

  it('checks the signature against the address we gave Twilio, not the one the request claims', async () => {
    // Behind a proxy, the Host and scheme a handler sees are whatever the
    // proxy set. Signing the URL the request appears to have arrived at would
    // let somebody who can influence those choose the string being signed.
    const id = await accepted('SM_proxy');
    const fields = { MessageSid: 'SM_proxy', MessageStatus: 'delivered' };
    const spoofed = 'https://attacker.example/api/notifications/twilio-status';

    // Signed for the address the request pretends to have arrived at: refused.
    const wrong = await POST(
      new Request(spoofed, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': sign(spoofed, fields),
          host: 'attacker.example',
          'x-forwarded-proto': 'https',
        },
        body: new URLSearchParams(fields).toString(),
      }),
    );
    assert.equal(wrong.status, 403);
    assert.equal((await stateOf(id)).state, 'accepted');

    // Signed for the configured address, arriving at the spoofed one: taken.
    const right = await POST(
      new Request(spoofed, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': sign(CALLBACK, fields),
        },
        body: new URLSearchParams(fields).toString(),
      }),
    );
    assert.equal(right.status, 204);
    assert.equal((await stateOf(id)).state, 'sent');
  });

  it('is not there at all until Twilio has been told to post to it', async () => {
    // An unauthenticated endpoint that edits delivery records, with no token
    // to check against, is worse than no endpoint.
    delete process.env.TWILIO_STATUS_CALLBACK_URL;
    assert.equal((await post({ MessageSid: 'SM1', MessageStatus: 'delivered' })).status, 404);
  });
});
