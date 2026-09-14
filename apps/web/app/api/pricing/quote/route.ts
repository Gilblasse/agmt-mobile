import { pricingDefaults, quote, quoteOptions } from '@ag/rules';
import type { QuoteOptions, Trip } from '@ag/rules/types';

/**
 * POST /api/pricing/quote — `getQuote` in the API contract.
 *
 * Scaffold implementation. It prices from the packaged defaults because the
 * office's saved settings have no store yet; the request and response shapes
 * are the contract's real ones, so callers written against them will not have
 * to change when the store arrives.
 */
export async function POST(request: Request) {
  let body: { trip?: Partial<Trip>; options?: QuoteOptions };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, reason: 'validation', message: 'The request body was not readable JSON.' },
      { status: 400 },
    );
  }

  if (!body || typeof body !== 'object' || !body.trip || typeof body.trip !== 'object') {
    return Response.json(
      { ok: false, reason: 'validation', message: 'Send a trip to price, as { "trip": { ... } }.' },
      { status: 400 },
    );
  }

  const config = pricingDefaults();
  const priced = quote(body.trip, config, body.options ?? {});

  // The rules a dispatcher could still add by hand to this quote.
  const available = quoteOptions(config, priced).map((rule) => rule.key);

  return Response.json({ ok: true, data: { quote: priced, options: available } });
}
