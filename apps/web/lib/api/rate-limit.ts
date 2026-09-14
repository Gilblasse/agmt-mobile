import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

/**
 * A fixed-window counter, per caller, per endpoint.
 *
 * This exists for the endpoints that cannot ask who is calling. A driver who
 * has lost their phone has no token to present, so sign-in has to answer
 * strangers — which means a stranger who knows a driver's name can request
 * codes and burn them as fast as the per-driver rules allow, and keep that
 * driver out of their shift. The per-driver cooldown bounds the rate; only a
 * per-caller limit separates the driver from whoever is attacking them.
 *
 * Fixed windows allow a burst across a boundary (up to 2× the limit over two
 * adjacent windows). That is a known and accepted property: the limits here
 * are set to stop sustained abuse, not to meter precisely, and the cost of the
 * simpler thing is one extra window's worth of requests.
 */

export type RateLimit = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Counts a hit and says whether it is within the limit.
 *
 * One statement: read-modify-write here would lose counts under exactly the
 * concurrency the limit exists to stop — the same mistake that made the
 * sign-in attempt limit meaningless.
 */
export async function consume(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimit> {
  const [row] = (await db.execute(sql`
    INSERT INTO rate_limits (bucket, window_started, hits)
    VALUES (${bucket}, now(), 1)
    ON CONFLICT (bucket) DO UPDATE
      SET hits = CASE
            WHEN rate_limits.window_started < now() - make_interval(secs => ${windowSeconds})
            THEN 1
            ELSE rate_limits.hits + 1
          END,
          window_started = CASE
            WHEN rate_limits.window_started < now() - make_interval(secs => ${windowSeconds})
            THEN now()
            ELSE rate_limits.window_started
          END
    RETURNING hits, EXTRACT(EPOCH FROM (window_started + make_interval(secs => ${windowSeconds}) - now()))::int AS retry_after
  `)) as unknown as Array<{ hits: number; retry_after: number }>;

  void sweepOccasionally();

  if (!row || row.hits <= limit) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, row.retry_after) };
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;

function isAddress(value: string): boolean {
  if (IPV4.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  return IPV6.test(value) && value.includes(':');
}

/**
 * How many proxies of our own sit in front of the app. Each appends one entry
 * to `x-forwarded-for`, so this says how far from the right the real client is.
 */
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? '1');

/**
 * Who is calling, as well as we can tell behind a proxy.
 *
 * **The rightmost entries are the trustworthy ones.** An earlier version took
 * the leftmost, which is whatever the caller sent: one host rotating a made-up
 * header made sixty requests without ever being refused, and spoofing someone
 * else's address locked *them* out for ten minutes — turning the control meant
 * to protect a driver into the cheapest way to keep them out of their shift.
 *
 * The common proxy idiom (`$proxy_add_x_forwarded_for`) *appends* the peer it
 * saw, so entry `n` from the right is the client as far as our own proxies can
 * vouch for it. Anything further left was supplied by the caller.
 *
 * Nothing here is an identity. It is a throttling hint, and a caller who
 * cannot be placed shares one bucket rather than getting a free pass.
 */
export function callerKey(request: Request): string {
  const chain = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(isAddress);

  const candidate = chain[Math.max(0, chain.length - TRUSTED_PROXY_HOPS)];
  if (candidate) return candidate.slice(0, 45);

  const real = request.headers.get('x-real-ip')?.trim();
  if (real && isAddress(real)) return real.slice(0, 45);

  // Unplaceable callers share a bucket. That is deliberate: a free pass here
  // would be the bypass, and a bucket per unknown shape is how the table fills.
  return 'unplaced';
}

/**
 * Drops windows that have long since closed.
 *
 * Migration 0003 said a sweep could do this; nothing ran one, so every fresh
 * bucket was a row that stayed forever. Called opportunistically rather than
 * scheduled, because there is no scheduler yet and an unbounded table is worse
 * than an occasional extra statement.
 */
async function sweepOccasionally(): Promise<void> {
  if (Math.random() > 0.01) return;
  try {
    await db.execute(sql`DELETE FROM rate_limits WHERE window_started < now() - interval '1 hour'`);
  } catch (error) {
    console.error('could not sweep rate limits', error);
  }
}
