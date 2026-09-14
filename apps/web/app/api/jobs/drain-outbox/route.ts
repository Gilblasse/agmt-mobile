import { timingSafeEqual } from 'node:crypto';
import { drainOutbox } from '@/lib/notifications/outbox';
import { fail, ok, withResult, onlyPost} from '@/lib/api/result';

/**
 * POST /api/jobs/drain-outbox — sends whatever is queued and due.
 *
 * Meant for a scheduler, every minute or so. It is not public: anyone able to
 * call it can drive delivery attempts, and the messages carry sign-in codes.
 * `CRON_SECRET` gates it, and if that is unset the route refuses rather than
 * defaulting open — an unset secret in production would otherwise be an
 * unauthenticated job runner.
 */
export const POST = withResult(async (request: Request) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('CRON_SECRET is not set; refusing to run the outbox drain');
    return fail('internal', 'This job is not configured.');
  }

  const offered = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!sameSecret(offered, expected)) {
    return fail('not-authorised', 'Not allowed.');
  }

  const result = await drainOutbox();
  // Worth a line in the log even when idle: "the worker is running and the
  // provider is still unconfigured" is the thing someone will need to know.
  if (result.claimed > 0) {
    console.log(
      `[outbox] claimed ${result.claimed}, delivered ${result.delivered}, ` +
        `retrying ${result.failed}, abandoned ${result.abandoned} (${result.provider})`,
    );
  }
  return ok(result);
});

function sameSecret(offered: string, expected: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const { GET, PUT, PATCH, DELETE, OPTIONS } = onlyPost;
