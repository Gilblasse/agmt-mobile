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

  if (!row || row.hits <= limit) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, row.retry_after) };
}

/**
 * Who is calling, as well as we can tell behind a proxy.
 *
 * `x-forwarded-for` is caller-controlled unless a trusted proxy rewrites it,
 * so this is a throttling hint and never an identity. The leftmost entry is
 * the original client where the chain is trustworthy.
 */
export function callerKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  return ip.slice(0, 100);
}
