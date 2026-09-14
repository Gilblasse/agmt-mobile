import type { Result } from '@ag/rules/api';

/**
 * Every endpoint answers with the contract's `Result` envelope. `FailureReason`
 * is a closed union, so a typo in a reason is a compile error rather than
 * something a client discovers at runtime.
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

export function ok<T>(data: T, init?: ResponseInit): Response {
  const body: Result<T> = { ok: true, data };
  return Response.json(body, init);
}

/** `message` is read by a dispatcher or a driver, so it is plain English. */
export function fail(reason: Failure['reason'], message: string, status?: number): Response {
  const body: Result<never> = { ok: false, reason, message };
  return Response.json(body, { status: status ?? STATUS[reason] });
}

/**
 * Wraps a handler so nothing escapes as an HTML error page or an empty 500.
 *
 * Anything that reaches a phone has to be the envelope, because that is all
 * the client knows how to read. A unique-violation from two requests racing,
 * a dropped connection mid-transaction — the driver gets a sentence, and the
 * detail goes to the server log rather than over the wire.
 */
export function withResult(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      console.error(`${request.method} ${new URL(request.url).pathname} failed`, error);
      return fail('internal', 'Something went wrong at our end. Please try again.');
    }
  };
}

export const UNREADABLE = Symbol('unreadable-body');

export async function readJson(request: Request): Promise<unknown | typeof UNREADABLE> {
  try {
    return await request.json();
  } catch {
    return UNREADABLE;
  }
}

/** Too many requests from one caller. `Retry-After` tells them when to come back. */
export function tooBusy(retryAfterSeconds: number): Response {
  const body: Result<never> = {
    ok: false,
    reason: 'busy',
    message: 'Too many attempts. Please wait a moment and try again.',
  };
  return Response.json(body, {
    status: 429,
    headers: { 'retry-after': String(retryAfterSeconds) },
  });
}

/** Authenticated replies carry personal data and must never sit in a shared cache. */
export const PRIVATE: ResponseInit = {
  headers: { 'cache-control': 'no-store, private', vary: 'authorization' },
};

/**
 * The other verbs on a route that only answers one.
 *
 * The framework's own 405 has an empty body and no content-type, which a
 * client that always parses JSON chokes on. Spread this into a route so every
 * method answers the envelope:
 *
 *   export const { GET, PUT, PATCH, DELETE } = onlyPost;
 */
function wrongMethod(allow: string) {
  return () => {
    // `Allow` is required on a 405, and without an explicit OPTIONS the
    // framework advertised every verb these objects export — actively wrong
    // discovery data on a POST-only endpoint.
    const body: Result<never> = {
      ok: false,
      reason: 'not-found',
      message: 'That is not something you can do at this address.',
    };
    return Response.json(body, { status: 405, headers: { allow } });
  };
}

function allowed(allow: string) {
  return () => new Response(null, { status: 204, headers: { allow } });
}

const POST_ONLY = 'POST, OPTIONS';
const GET_ONLY = 'GET, HEAD, OPTIONS';

export const onlyPost = {
  GET: wrongMethod(POST_ONLY),
  PUT: wrongMethod(POST_ONLY),
  PATCH: wrongMethod(POST_ONLY),
  DELETE: wrongMethod(POST_ONLY),
  OPTIONS: allowed(POST_ONLY),
};
export const onlyGet = {
  POST: wrongMethod(GET_ONLY),
  PUT: wrongMethod(GET_ONLY),
  PATCH: wrongMethod(GET_ONLY),
  DELETE: wrongMethod(GET_ONLY),
  OPTIONS: allowed(GET_ONLY),
};
