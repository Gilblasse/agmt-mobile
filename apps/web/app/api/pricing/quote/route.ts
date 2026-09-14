import { pricingDefaults, quote, quoteOptions } from '@ag/rules';
import type { Result } from '@ag/rules/api';
import type { Quote, QuoteOptions, Trip } from '@ag/rules/types';

/**
 * POST /api/pricing/quote — `getQuote` in the API contract.
 *
 * Scaffold implementation. It prices from the packaged defaults because the
 * office's saved settings have no store yet; the request and response shapes
 * are the contract's real ones, so callers written against them will not have
 * to change when the store arrives.
 *
 * This handler is the trust boundary. The pricing engine is typed, pure and
 * proven against the live system, but it trusts its inputs — hand it a
 * `miles` of "twelve" and it silently drops the mileage line and still reports
 * the quote as complete. A price that cannot be worked out has to say so in
 * words; it must never quietly become a smaller number. So every field is
 * checked here, before the engine sees it.
 */

type QuoteData = { quote: Quote; options: string[] };

function fail(
  reason: Extract<Result<QuoteData>, { ok: false }>['reason'],
  message: string,
  status: number,
): Response {
  const body: Result<QuoteData> = { ok: false, reason, message };
  return Response.json(body, { status });
}

/** A count of miles, or null for "not known". Anything else is a bad request. */
function readMiles(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return 'invalid';
  const miles = Number(value);
  if (!Number.isFinite(miles) || miles < 0) return 'invalid';
  return miles;
}

function readRuleKeys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : [];
}

export async function POST(request: Request) {
  let body: { trip?: unknown; options?: unknown };

  try {
    body = await request.json();
  } catch {
    return fail('validation', 'The request body was not readable JSON.', 400);
  }

  const trip = body?.trip;
  if (!trip || typeof trip !== 'object' || Array.isArray(trip)) {
    return fail('validation', 'Send a trip to price, as { "trip": { ... } }.', 400);
  }

  const sent = (body.options ?? {}) as Record<string, unknown>;
  if (typeof sent !== 'object' || Array.isArray(sent)) {
    return fail('validation', 'Pricing options must be an object.', 400);
  }

  const miles = readMiles(sent.miles);
  if (miles === 'invalid') {
    return fail('validation', 'Miles must be a number of no less than zero, or left out entirely.', 400);
  }

  const options: QuoteOptions = {
    miles,
    manual: readRuleKeys(sent.manual),
    dropped: readRuleKeys(sent.dropped),
  };
  if (typeof sent.today === 'string') options.today = sent.today;
  if (typeof sent.timeHm === 'string') options.timeHm = sent.timeHm;

  try {
    const config = pricingDefaults();
    const priced = quote(trip as Partial<Trip>, config, options);
    // The rules a dispatcher could still add to this quote by hand.
    const available = quoteOptions(config, priced).map((rule) => rule.key);

    const ok: Result<QuoteData> = { ok: true, data: { quote: priced, options: available } };
    return Response.json(ok);
  } catch {
    return fail('internal', 'The price could not be worked out.', 500);
  }
}
