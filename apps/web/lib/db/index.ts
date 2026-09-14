import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * One connection pool per process.
 *
 * This module is imported lazily by each route, so a missing `DATABASE_URL`
 * would otherwise surface as an opaque failure on the first API call rather
 * than at startup. `instrumentation.ts` imports this at boot so the process
 * fails immediately and says why.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and point it at your database.');
}

const client = postgres(url, {
  max: 10,
  // Hand idle connections back rather than holding them for the life of the
  // process. It frees server slots, and it stops a short-lived process being
  // kept alive by a pool it has finished with.
  idle_timeout: 20,
});
export const db = drizzle(client, { schema });
export { schema };

/**
 * Closes the pool.
 *
 * Only tests need this. A long-lived server keeps its connections open for as
 * long as it runs, but a test process with an open pool never exits — which
 * looks exactly like a hung test, and cost an afternoon finding out.
 */
export async function closeDb(): Promise<void> {
  await client.end();
}
