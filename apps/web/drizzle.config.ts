import { defineConfig } from 'drizzle-kit';

/**
 * The raw SQL in `db/migrations/` is the source of truth for the schema, and
 * `db/smoke.sql` is what proves it still honours the non-negotiables. This
 * config exists to *introspect* that schema into Drizzle types — never to
 * generate migrations from TypeScript. See docs/04-data-model.md.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/db/schema.ts',
  out: './lib/db',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  introspect: { casing: 'camel' },
});
