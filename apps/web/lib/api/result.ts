import type { Result } from '@ag/rules/api';

/**
 * Every endpoint answers with the contract's `Result` envelope and never
 * throws past the handler. `FailureReason` is a closed union, so a typo in a
 * reason is a compile error rather than something a client discovers at
 * runtime.
 */
type Failure = Extract<Result<never>, { ok: false }>;

const STATUS: Record<Failure['reason'], number> = {
  'not-found': 404,
  'day-locked': 409,
  conflict: 409,
  blacklisted: 409,
  duplicate: 409,
  'not-authorised': 401,
  validation: 400,
  busy: 429,
  upstream: 502,
  internal: 500,
};

export function ok<T>(data: T, status = 200): Response {
  const body: Result<T> = { ok: true, data };
  return Response.json(body, { status });
}

/** `message` is read by a dispatcher or a driver, so it is plain English. */
export function fail(reason: Failure['reason'], message: string, status?: number): Response {
  const body: Result<never> = { ok: false, reason, message };
  return Response.json(body, { status: status ?? STATUS[reason] });
}

export async function readJson(request: Request): Promise<unknown | typeof UNREADABLE> {
  try {
    return await request.json();
  } catch {
    return UNREADABLE;
  }
}

export const UNREADABLE = Symbol('unreadable-body');
