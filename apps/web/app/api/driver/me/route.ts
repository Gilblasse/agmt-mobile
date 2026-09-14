import { authenticateDriver } from '@/lib/auth/driver';
import { fail, ok, PRIVATE, withResult, onlyGet} from '@/lib/api/result';

/**
 * GET /api/driver/me — who this phone is signed in as.
 *
 * Small on purpose: it exists so the sign-in slice is demonstrable end to end,
 * and so there is one place showing how every driver endpoint should begin.
 *
 * Note for the endpoints that follow: this one only asks *who* the caller is.
 * Anything that reads or changes a trip must also ask whether that trip is
 * theirs — docs/02 §1.7 is the rule, and the old system let one driver
 * complete another's trip because a name match was treated as enough.
 */
export const GET = withResult(async (request: Request) => {
  const auth = await authenticateDriver(request);
  if (!auth.ok) {
    const message =
      auth.reason === 'off-roster'
        ? 'This account is no longer active. Ask the office.'
        : 'Please sign in again.';
    return fail('not-authorised', message);
  }
  return ok({ driver: auth.driver }, PRIVATE);
});

export const { POST, PUT, PATCH, DELETE, OPTIONS } = onlyGet;
