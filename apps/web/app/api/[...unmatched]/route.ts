import { fail } from '@/lib/api/result';

/**
 * Anything under /api that no route matched.
 *
 * Without this, Next answers an unknown API path with its HTML 404 page. A
 * phone that always parses the body as JSON throws on that, and the driver
 * sees a crash instead of a message. Every answer from this API is the
 * envelope, including the ones that say "no such thing".
 */
const noSuchRoute = () => fail('not-found', 'There is nothing at that address.');

export const GET = noSuchRoute;
export const POST = noSuchRoute;
export const PUT = noSuchRoute;
export const PATCH = noSuchRoute;
export const DELETE = noSuchRoute;
export const HEAD = noSuchRoute;
export const OPTIONS = noSuchRoute;
