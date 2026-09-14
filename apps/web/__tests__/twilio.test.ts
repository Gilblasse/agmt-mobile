import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { twilioSender, toE164 } from '@/lib/notifications/twilio';
import { describeConfiguredSender, resetSender, useSender } from '@/lib/notifications/sender';
import type { Message } from '@/lib/notifications/sender';

/**
 * The Twilio adapter, driven through a fake transport.
 *
 * Nothing here reaches the network. What is being checked is the part that
 * decides a driver's fate: whether a failure is permanent. The outbox
 * *abandons* a message it is told is permanent, so a wrong verdict here is a
 * sign-in code the driver never receives.
 */

const text: Message = {
  channel: 'sms',
  recipient: '8455550101',
  subject: null,
  body: '123456 is your Amazing Grace sign-in code.',
};

/** A fake Twilio that answers however the test says, and records the request. */
function fakeTwilio(answer: Response | ((req: Request) => Response | Promise<Response>)) {
  const calls: { url: string; body: URLSearchParams; auth: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      body: new URLSearchParams(String(init?.body ?? '')),
      auth: headers.get('authorization'),
    });
    return typeof answer === 'function'
      ? answer(new Request(String(url), init as RequestInit))
      : answer;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const accepted = () => new Response(JSON.stringify({ sid: 'SM123', status: 'queued' }), { status: 201 });
const refused = (code: number, message: string, status = 400) =>
  new Response(JSON.stringify({ code, message }), { status });

describe('turning a stored number into one Twilio will take', () => {
  it('assumes the local country for a plain ten-digit number', () => {
    assert.equal(toE164('8455550101'), '+18455550101');
    assert.equal(toE164('(845) 555-0101'), '+18455550101');
    assert.equal(toE164('845-555-0101'), '+18455550101');
  });

  it('leaves a number that already says where it is alone', () => {
    // Prefixing a country code onto an international number would send the
    // message somewhere else entirely.
    assert.equal(toE164('+447700900123'), '+447700900123');
    assert.equal(toE164('+1 845 555 0101'), '+18455550101');
  });

  it('accepts a country code other than the default', () => {
    assert.equal(toE164('07700900123', '44'), null, 'eleven digits not starting with 44');
    assert.equal(toE164('7700900123', '44'), '+447700900123');
  });

  it('refuses what is not a number rather than guessing', () => {
    for (const bad of ['', 'ask the office', '12345', '000']) {
      assert.equal(toE164(bad), null, `${bad} should be refused`);
    }
  });
});

describe('sending a text', () => {
  it('posts the message to the account, with the body and the number', async () => {
    const { calls, fetchImpl } = fakeTwilio(accepted());
    const result = await twilioSender({
      accountSid: 'AC_test', authToken: 'secret', from: '+15550001111', fetch: fetchImpl,
    }).send(text);

    assert.deepEqual(result, { delivered: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /Accounts\/AC_test\/Messages\.json$/);
    assert.equal(calls[0]!.body.get('To'), '+18455550101');
    assert.equal(calls[0]!.body.get('From'), '+15550001111');
    assert.equal(calls[0]!.body.get('Body'), text.body);
  });

  it('uses a messaging service when given one instead of a number', async () => {
    const { calls, fetchImpl } = fakeTwilio(accepted());
    await twilioSender({
      accountSid: 'AC_test', authToken: 'secret', from: 'MG_service', fetch: fetchImpl,
    }).send(text);
    assert.equal(calls[0]!.body.get('MessagingServiceSid'), 'MG_service');
    assert.equal(calls[0]!.body.get('From'), null);
  });

  it('never puts the credentials anywhere but the auth header', async () => {
    const { calls, fetchImpl } = fakeTwilio(accepted());
    const twilio = twilioSender({
      accountSid: 'AC_test', authToken: 'super-secret-token', from: '+15550001111', fetch: fetchImpl,
    });
    await twilio.send(text);
    assert.match(calls[0]!.auth ?? '', /^Basic /);
    assert.doesNotMatch(calls[0]!.body.toString(), /super-secret-token/);
    assert.doesNotMatch(calls[0]!.url, /super-secret-token/);
    // The description goes into logs and drain results.
    assert.doesNotMatch(twilio.describe(), /super-secret-token/);
  });
});

describe('deciding whether to try again', () => {
  const twilio = (fetchImpl: typeof fetch) =>
    twilioSender({ accountSid: 'AC', authToken: 't', from: '+15550001111', fetch: fetchImpl });

  it('gives up only when the number itself is wrong', async () => {
    // Abandoning means the driver never gets the message. It is only right
    // when trying again could not possibly help.
    for (const [code, why] of [
      [21211, 'not a valid number'],
      [21610, 'the driver replied STOP'],
      [21614, 'a landline'],
      [21408, 'region not enabled'],
    ] as const) {
      const { fetchImpl } = fakeTwilio(refused(code, why));
      const result = await twilio(fetchImpl).send(text);
      assert.equal(result.delivered, false);
      assert.equal(result.permanent, true, `${code} should be permanent`);
    }
  });

  it('keeps the message when the problem is ours, not the driver’s', async () => {
    // A rotated token must not throw away every queued sign-in code.
    for (const [code, status, why] of [
      [20003, 401, 'authentication failed'],
      [20429, 429, 'too many requests'],
      [20500, 500, 'internal error'],
    ] as const) {
      const { fetchImpl } = fakeTwilio(refused(code, why, status));
      const result = await twilio(fetchImpl).send(text);
      assert.equal(result.delivered, false);
      assert.notEqual(result.permanent, true, `${code} must stay retryable`);
    }
  });

  it('keeps the message when Twilio cannot be reached at all', async () => {
    const fetchImpl = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const result = await twilio(fetchImpl).send(text);
    assert.equal(result.delivered, false);
    assert.notEqual(result.permanent, true, 'an outage is not the message’s fault');
    assert.match(result.error, /Could not reach Twilio/);
  });

  it('refuses a recipient it cannot dial, without calling Twilio', async () => {
    const { calls, fetchImpl } = fakeTwilio(accepted());
    const result = await twilio(fetchImpl).send({ ...text, recipient: 'ask the office' });
    assert.equal(result.delivered, false);
    assert.equal(result.permanent, true);
    assert.equal(calls.length, 0, 'no point asking');
  });

  it('does not try to send an email through a text provider', async () => {
    const { calls, fetchImpl } = fakeTwilio(accepted());
    const result = await twilio(fetchImpl).send({ ...text, channel: 'email', recipient: 'a@b.com' });
    assert.equal(result.delivered, false);
    assert.equal(calls.length, 0);
  });
});

describe('choosing a provider from the environment', () => {
  it('uses Twilio when it is configured', () => {
    const described = describeConfiguredSender({
      TWILIO_ACCOUNT_SID: 'AC_abcdef123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550001111',
    });
    assert.match(described, /Twilio/);
    assert.doesNotMatch(described, /tok/, 'the token is not in the description');
  });

  it('falls back to sending nothing when it is not, rather than half-configured', () => {
    // A partial configuration is the dangerous case: it must not look ready.
    for (const partial of [
      { TWILIO_ACCOUNT_SID: 'AC' },
      { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'tok' },
      { TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+1555' },
      {},
    ]) {
      assert.match(describeConfiguredSender(partial), /no delivery provider configured/);
    }
  });

  it('says plainly that email has no provider', async () => {
    // Built from the environment, not installed globally: the sender is
    // resolved where it is used, because a value set at boot does not reach a
    // route handler's bundle.
    const configured = {
      TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550001111',
    };
    assert.match(describeConfiguredSender(configured), /email: none/);
  });

  it('reads the environment lazily, not once at import', async () => {
    // The bug this guards against: the startup log said Twilio while the drain
    // reported no provider and sent nothing, because they are different bundles.
    resetSender();
    const { sender } = await import('@/lib/notifications/sender');
    const before = sender().describe();
    assert.match(before, /no delivery provider configured/, 'nothing configured in this environment');
    resetSender();
    useSender({ describe: () => 'explicit', send: async () => ({ delivered: true as const }) });
    assert.equal(sender().describe(), 'explicit');
    resetSender();
  });
});
