import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * One connection pool per process. `DATABASE_URL` is required — failing loudly
 * at startup beats every query failing later with a confusing message.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');

const client = postgres(url, { max: 10 });
export const db = drizzle(client, { schema });
export { schema };
