import { authenticateDriver } from '@/lib/auth/driver';
import { fail, ok } from '@/lib/api/result';

/**
 * GET /api/driver/me — who this phone is signed in as.
 *
 * Small on purpose: it exists so the sign-in slice is demonstrable end to end,
 * and so there is one place showing how every driver endpoint should begin.
 */
export async function GET(request: Request) {
  const auth = await authenticateDriver(request);
  if (!auth.ok) {
    const message =
      auth.reason === 'off-roster'
        ? 'This account is no longer active. Ask the office.'
        : 'Please sign in again.';
    return fail('not-authorised', message);
  }
  return ok({ driver: auth.driver });
}
