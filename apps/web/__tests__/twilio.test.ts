import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkBaseUrl, toE164, twilioSender } from '@/lib/notifications/twilio';
import { describeConfiguredSender, resetSender, useSender } from '@/lib/notifications/sender';
import type { Message, Sent } from '@/lib/notifications/sender';

/** Narrows a result to a refusal, failing the test if the message was accepted. */
function refusal(result: Sent): Extract<Sent, { accepted: false }> {
  assert.equal(result.accepted, false, 'expected a refusal, not an acceptance');
  return result as Extract<Sent, { accepted: false }>;
}

/**
 * The Twilio adapter, driven through a fake transport.
 *
 * Nothing here reaches the network. What is being checked is the part that
 * decides a driver's fate: which number a message goes to, whether a failure
 * is permanent, and whether "Twilio took it" is allowed to be recorded as
 * "the driver got it". Each of those has been wrong once, and each wrong
 * answer is a sign-in code somebody else received, threw away, or never had.
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
      : answer.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const queued = () =>
  new Response(JSON.stringify({ sid: 'SM123', status: 'queued' }), { status: 201 });
const refused = (code: number | string, message: string, status = 400) =>
  new Response(JSON.stringify({ code, message }), { status });

describe('turning a stored number into one Twilio will take', () => {
  it('reads a local number as belonging to the region the office is in', () => {
    assert.equal(toE164('8455550101'), '+18455550101');
    assert.equal(toE164('(845) 555-0101'), '+18455550101');
    assert.equal(toE164('845-555-0101'), '+18455550101');
  });

  it('leaves a number that already says where it is alone', () => {
    // Prefixing a country code onto an international number would send the
    // message somewhere else entirely.
    assert.equal(toE164('+442079460101'), '+442079460101');
    assert.equal(toE164('+1 845 555 0101'), '+18455550101');
  });

  it('takes a region, not a dialling prefix', () => {
    // A prefix cannot do this job, and the arithmetic version proved it: a
    // London number written the way Londoners write it — 2079460101 — became
    // +12079460101, which is a real number in Maine, and a stranger received
    // a driver's sign-in code. The 11-digit rule was worse still: it only
    // worked at all for a one-character country code, so setting the prefix
    // to 44 applied it twice.
    assert.equal(toE164('2079460101', 'GB'), '+442079460101');
    assert.equal(toE164('07911123456', 'GB'), '+447911123456');
    assert.equal(toE164('+447911123456', 'GB'), '+447911123456');
  });

  it('refuses digits that are not a number in that region', () => {
    // 13800138000 is a Chinese mobile written without its country code. The
    // arithmetic version made it +13800138000 — a real number in Ohio.
    assert.equal(toE164('13800138000'), null);
    for (const bad of ['', 'ask the office', '12345', '000', '845555010']) {
      assert.equal(toE164(bad), null, `${bad} should be refused`);
    }
  });

  it('does not dial the extension', () => {
    // Stripping punctuation and keeping every digit turned "x12" into two
    // more digits on the end, which is a different number.
    assert.equal(toE164('845-555-0101 x12'), '+18455550101');
    assert.equal(toE164('(845) 555-0101 ext. 12'), '+18455550101');
  });
});

describe('where the messages are sent', () => {
  const config = { accountSid: 'AC', authToken: 't', from: '+15550001111' };

  it('refuses to carry the token and the codes over plain http', () => {
    // How the review environment was actually configured. Every request holds
    // the account's standing auth token and every message holds a sign-in code.
    assert.throws(() => checkBaseUrl('http://api.example.com'), /must be https/);
    assert.throws(() => checkBaseUrl('not a url'), /not a URL/);
    assert.throws(
      () => twilioSender({ ...config, baseUrl: 'http://api.example.com' }),
      /must be https/,
    );
  });

  it('allows a stand-in on this machine', () => {
    // Exercising the whole path without a Twilio account is worth keeping.
    assert.equal(checkBaseUrl('http://127.0.0.1:4010').hostname, '127.0.0.1');
    assert.equal(checkBaseUrl('http://localhost:4010').hostname, 'localhost');
    assert.equal(checkBaseUrl('https://api.au1.twilio.com').hostname, 'api.au1.twilio.com');
  });

  it('refuses a base address with a path, rather than dropping it', () => {
    // The API path is built against this address, so a path here is silently
    // discarded — an operator fronting Twilio with a gateway at /twilio-proxy
    // would send the account's auth token to the gateway's root instead.
    assert.throws(() => checkBaseUrl('https://gw.example.com/twilio-proxy'), /no path/);
    assert.throws(() => checkBaseUrl('https://gw.example.com/?x=1'), /no path/);
    assert.equal(checkBaseUrl('https://api.twilio.com/').pathname, '/');
  });

  it('refuses a region that is not a country', () => {
    assert.throws(() => twilioSender({ ...config, defaultRegion: '44' }), /two-letter country/);
    assert.throws(() => twilioSender({ ...config, defaultRegion: 'ZZ' }), /two-letter country/);
  });
});

describe('sending a text', () => {
  it('posts the message to the account, with the body and the number', async () => {
    const { calls, fetchImpl } = fakeTwilio(queued());
    const result = await twilioSender({
      accountSid: 'AC_test', authToken: 'secret', from: '+15550001111', fetch: fetchImpl,
    }).send(text);

    assert.deepEqual(result, { accepted: true, reference: 'SM123' });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /Accounts\/AC_test\/Messages\.json$/);
    assert.equal(calls[0]!.body.get('To'), '+18455550101');
    assert.equal(calls[0]!.body.get('From'), '+15550001111');
    assert.equal(calls[0]!.body.get('Body'), text.body);
  });

  it('uses a messaging service when given one instead of a number', async () => {
    const service = 'MG' + 'a'.repeat(32);
    const { calls, fetchImpl } = fakeTwilio(queued());
    await twilioSender({
      accountSid: 'AC_test', authToken: 'secret', from: service, fetch: fetchImpl,
    }).send(text);
    assert.equal(calls[0]!.body.get('MessagingServiceSid'), service);
    assert.equal(calls[0]!.body.get('From'), null);
  });

  it('treats an alphanumeric sender id as a sender, not a service', async () => {
    // "MGTransport" is a perfectly ordinary alphanumeric sender ID. Matching
    // on the first two letters sent it as a Messaging Service SID, which
    // Twilio rejects — so every message failed and nobody could see why.
    const { calls, fetchImpl } = fakeTwilio(queued());
    await twilioSender({
      accountSid: 'AC_test', authToken: 'secret', from: 'MGTransport', fetch: fetchImpl,
    }).send(text);
    assert.equal(calls[0]!.body.get('From'), 'MGTransport');
    assert.equal(calls[0]!.body.get('MessagingServiceSid'), null);
  });

  it('asks Twilio to report back when there is somewhere to report to', async () => {
    const { calls, fetchImpl } = fakeTwilio(queued());
    const twilio = twilioSender({
      accountSid: 'AC', authToken: 't', from: '+15550001111', fetch: fetchImpl,
      statusCallbackUrl: 'https://agmt.example/api/notifications/twilio-status',
    });
    await twilio.send(text);
    assert.equal(
      calls[0]!.body.get('StatusCallback'),
      'https://agmt.example/api/notifications/twilio-status',
    );
    assert.match(twilio.describe(), /delivery confirmed/);
  });

  it('says plainly when nothing will ever confirm a delivery', async () => {
    const { fetchImpl } = fakeTwilio(queued());
    const twilio = twilioSender({ accountSid: 'AC', authToken: 't', from: '+1555', fetch: fetchImpl });
    assert.match(twilio.describe(), /no status callback/);
  });

  it('never puts the credentials anywhere but the auth header', async () => {
    const { calls, fetchImpl } = fakeTwilio(queued());
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

describe('accepted is not delivered', () => {
  const twilio = (fetchImpl: typeof fetch) =>
    twilioSender({ accountSid: 'AC', authToken: 't', from: '+15550001111', fetch: fetchImpl });

  it('reports only that Twilio has the message, and its reference', async () => {
    const { fetchImpl } = fakeTwilio(queued());
    assert.deepEqual(await twilio(fetchImpl).send(text), { accepted: true, reference: 'SM123' });
  });

  it('does not call a 201 a success when the body says it failed', async () => {
    // Twilio answers 201 the moment it takes the message, and the body of that
    // 201 can already say the carrier refused it. Reading `response.ok` as
    // success recorded a message nobody received as a clean delivery — which
    // is the exact failure docs/06 gives for abandoning the carrier gateways:
    // no delivery confirmation.
    for (const status of ['failed', 'undelivered', 'canceled']) {
      const { fetchImpl } = fakeTwilio(
        new Response(JSON.stringify({ sid: 'SM1', status, error_code: 21610 }), { status: 201 }),
      );
      const result = await twilio(fetchImpl).send(text);
      assert.equal(result.accepted, false, `a 201 saying "${status}" is not a delivery`);
    }
  });

  it('classifies a failure reported inside a 201 the same as any other', async () => {
    const stopped = new Response(
      JSON.stringify({ sid: 'SM1', status: 'failed', error_code: 21610 }), { status: 201 },
    );
    const busy = new Response(
      JSON.stringify({ sid: 'SM1', status: 'failed', error_code: 30001 }), { status: 201 },
    );
    assert.equal(refusal(await twilio(fakeTwilio(stopped).fetchImpl).send(text)).permanent, true);
    assert.notEqual(refusal(await twilio(fakeTwilio(busy).fetchImpl).send(text)).permanent, true);
  });
});

describe('deciding whether to try again', () => {
  const twilio = (fetchImpl: typeof fetch) =>
    twilioSender({ accountSid: 'AC', authToken: 't', from: '+15550001111', fetch: fetchImpl });

  it('gives up only when this message can never be sent', async () => {
    // Abandoning means the driver never gets the message. It is only right
    // when trying again could not possibly help.
    for (const [code, why] of [
      [21211, 'not a valid number'],
      [21610, 'the driver replied STOP'],
      [21614, 'a landline'],
      [21617, 'the body is too long'],
    ] as const) {
      const { fetchImpl } = fakeTwilio(refused(code, why));
      assert.equal(refusal(await twilio(fetchImpl).send(text)).permanent, true, `${code} should be permanent`);
    }
  });

  it('does not give up on a number that merely could not be reached', async () => {
    // 21214 was described in this file as "not a valid mobile number". Twilio
    // means "cannot be reached", which is often a moment, not a fact — and
    // abandoning threw away a message a later attempt would have delivered.
    const { fetchImpl } = fakeTwilio(refused(21214, 'To phone number cannot be reached'));
    assert.notEqual(refusal(await twilio(fetchImpl).send(text)).permanent, true);
  });

  it('says why in words the office can act on, not just a number', async () => {
    // last_error is where somebody looks when a driver says no code arrived.
    const { fetchImpl } = fakeTwilio(refused(21610, 'unsubscribed'));
    const { error } = refusal(await twilio(fetchImpl).send(text));
    assert.match(error, /replied STOP/);
    assert.match(error, /cannot sign in/, 'and what it means for the driver');
  });

  it('does not spend the message on something the account did', async () => {
    // Moving these out of the permanent set was not enough: they still burned
    // the retry budget, so a wrong token over one lunch abandoned every queued
    // sign-in code in eighty-one minutes.
    const cases: [number, number][] = [
      [20003, 401], [21606, 400], [21408, 400], [20429, 429], [0, 503],
    ];
    for (const [code, status] of cases) {
      const answer = code
        ? refused(code, 'not this message', status)
        : new Response('{"message":"service unavailable"}', { status });
      const { fetchImpl } = fakeTwilio(answer);
      const result = refusal(await twilio(fetchImpl).send(text));
      assert.equal(result.cause, 'provider', `${code || status} is the account's problem, not the message's`);
    }
  });

  it('does not write Twilio’s own quoting of the number into the record', async () => {
    // Masking the one sentence this file composes was not enough — Twilio
    // quotes the number back inside its own message.
    const { fetchImpl } = fakeTwilio(
      refused(30007, "The 'To' number +18455550101 was blocked by the carrier."),
    );
    const { error } = refusal(await twilio(fetchImpl).send(text));
    assert.doesNotMatch(error, /18455550101/);
    assert.match(error, /\*\*\*/);
  });

  it('keeps the message when the problem is a setting somebody can switch on', async () => {
    // These read like the recipient's fault and are not: both are account
    // settings in the Twilio console. Listed as permanent, one switch left off
    // abandoned every queued message on its first attempt — every driver's
    // sign-in code thrown away over something fixable in a minute.
    for (const [code, why] of [
      [21408, 'no permission to send to that region'],
      [21612, 'this sender cannot reach that number'],
      [21606, 'the From number cannot send texts'],
      [21214, 'To phone number cannot be reached'],
    ] as const) {
      const { fetchImpl } = fakeTwilio(refused(code, why));
      assert.notEqual(refusal(await twilio(fetchImpl).send(text)).permanent, true, `${code} must stay retryable`);
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
      assert.notEqual(refusal(await twilio(fetchImpl).send(text)).permanent, true, `${code} must stay retryable`);
    }
  });

  it('reads an error code whether it arrives as a number or as text', async () => {
    // Twilio sends numbers from the Messages API and strings on a status
    // callback. A Set of numbers matched one and not the other, so half the
    // permanent failures quietly looked unclassified and were retried five
    // times.
    const { fetchImpl } = fakeTwilio(refused('21610', 'unsubscribed'));
    assert.equal(refusal(await twilio(fetchImpl).send(text)).permanent, true);
  });

  it('keeps the message when the request never left this machine', async () => {
    // Refused, or a name that does not resolve: nothing arrived at Twilio, so
    // trying again cannot duplicate anything.
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      const fetchImpl = (async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
      }) as unknown as typeof fetch;
      const result = refusal(await twilio(fetchImpl).send(text));
      assert.notEqual(result.permanent, true, 'an outage is not the message’s fault');
      assert.notEqual(result.cause, 'unresolved', `${code} is unambiguous`);
      assert.match(result.error, /Could not reach Twilio/);
    }
  });
  it('refuses a recipient it cannot dial, without calling Twilio', async () => {
    const { calls, fetchImpl } = fakeTwilio(queued());
    const result = refusal(await twilio(fetchImpl).send({ ...text, recipient: 'ask the office' }));
    assert.equal(result.permanent, true);
    assert.equal(calls.length, 0, 'no point asking');
  });

  it('does not write the driver’s number into the error it stores', async () => {
    // That string goes into notifications.last_error, which is read by
    // whoever is looking at the queue.
    const { fetchImpl } = fakeTwilio(queued());
    const { error } = refusal(await twilio(fetchImpl).send({ ...text, recipient: '845555010' }));
    assert.doesNotMatch(error, /845555010/, 'the number itself is not in the record');
    // Enough to tell one recipient from another, and no more. The previous
    // assertion here matched `***`, which masked() always emits, so it could
    // not fail.
    assert.match(error, /\*\*\*5010\b/);
  });

  it('does not try to send an email through a text provider', async () => {
    const { calls, fetchImpl } = fakeTwilio(queued());
    const result = await twilio(fetchImpl).send({ ...text, channel: 'email', recipient: 'a@b.com' });
    assert.equal(result.accepted, false);
    assert.equal(calls.length, 0);
  });
});

describe('when Twilio does not answer', () => {
  /**
   * The shipped ten-second timeout against a provider that answers in eleven.
   * `AbortSignal.timeout` fires on this side; the POST has already arrived and
   * Twilio has already created the message. Retrying is how a driver is texted
   * the same sign-in code twice, which is the thing this whole queue exists to
   * prevent — so the adapter asks Twilio what it actually has.
   */
  function timesOutThenLists(messages: unknown[] | 'unreachable') {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if ((init?.method ?? 'GET') === 'POST') {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      }
      if (messages === 'unreachable') throw new Error('and the lookup failed too');
      return new Response(JSON.stringify({ messages }), { status: 200 });
    }) as unknown as typeof fetch;
    return {
      seen,
      twilio: twilioSender({
        accountSid: 'AC', authToken: 't', from: '+15550001111', fetch: fetchImpl,
      }),
    };
  }

  it('does not send again when Twilio turns out to have the message', async () => {
    const { seen, twilio } = timesOutThenLists([
      { sid: 'SM_already', body: text.body, date_created: new Date().toISOString() },
    ]);
    const result = await twilio.send(text);
    assert.deepEqual(result, { accepted: true, reference: 'SM_already' });
    assert.match(seen[1] ?? '', /^GET .*Messages\.json\?To=%2B18455550101/);
  });

  it('does send again when Twilio has no record of it', async () => {
    const { twilio } = timesOutThenLists([]);
    const result = refusal(await twilio.send(text));
    assert.notEqual(result.cause, 'unresolved');
    assert.match(result.error, /no record/);
  });

  it('is not fooled by an older message with the same words', async () => {
    // "Your trip was cancelled" is the same text every time.
    const { twilio } = timesOutThenLists([
      { sid: 'SM_old', body: text.body, date_created: new Date(Date.now() - 3 * 3600_000).toISOString() },
    ]);
    const result = refusal(await twilio.send(text));
    assert.match(result.error, /no record/);
  });

  it('refuses to guess when it cannot ask either', async () => {
    // Neither sent nor not sent. Retrying texts the driver twice; giving up
    // texts them not at all. The row stops and a person decides.
    const { twilio } = timesOutThenLists('unreachable');
    const result = refusal(await twilio.send(text));
    assert.equal(result.cause, 'unresolved');
    assert.match(result.error, /may or may not have been sent/);
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

  it('says what is wrong instead of taking the process down', async () => {
    const configured = {
      TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550001111',
      TWILIO_BASE_URL: 'http://api.example.com',
    };
    assert.match(describeConfiguredSender(configured), /misconfigured.*https/is);
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
    useSender({ describe: () => 'explicit', send: async () => ({ accepted: true as const }) });
    assert.equal(sender().describe(), 'explicit');
    resetSender();
  });

  it('refuses to redirect production’s messages', async () => {
    // useSender is a module-level global that silently diverts every message
    // in the process, exported from a file production imports.
    const was = process.env.NODE_ENV;
    try {
      Object.assign(process.env, { NODE_ENV: 'production' });
      assert.throws(() => useSender(unreachable()), /test seam/);
      assert.throws(() => resetSender(), /test seam/);
    } finally {
      Object.assign(process.env, { NODE_ENV: was });
    }
  });
});

function unreachable() {
  return {
    describe: () => 'should never be installed',
    send: async () => ({ accepted: false as const, error: 'no' }),
  };
}

describe('asking what became of a message', () => {
  const twilio = (fetchImpl: typeof fetch) =>
    twilioSender({ accountSid: 'AC', authToken: 't', from: '+15550001111', fetch: fetchImpl });
  const reference = 'SM' + 'a'.repeat(32);

  it('reads the status and the error code back', async () => {
    const { calls, fetchImpl } = fakeTwilio(
      new Response(JSON.stringify({ sid: reference, status: 'undelivered', error_code: 30032 }), { status: 200 }),
    );
    const answer = await twilio(fetchImpl).check!(reference);
    assert.deepEqual(answer, { known: true, status: 'undelivered', errorCode: 30032 });
    assert.match(calls[0]!.url, new RegExp(`/Messages/${reference}\.json$`));
    assert.match(calls[0]!.auth ?? '', /^Basic /);
  });

  it('says it does not know rather than guessing when Twilio will not answer', async () => {
    const { fetchImpl } = fakeTwilio(refused(20003, 'authenticate', 401));
    const answer = await twilio(fetchImpl).check!(reference);
    assert.equal(answer.known, false);
  });

  it('refuses to put a stored value it does not recognise into a URL', async () => {
    // provider_ref is a column; a value that is not a message SID must not
    // become part of a request path against the account.
    const { calls, fetchImpl } = fakeTwilio(queued());
    const answer = await twilio(fetchImpl).check!('../Accounts/AC_other/Messages');
    assert.equal(answer.known, false);
    assert.equal(calls.length, 0);
  });
});
