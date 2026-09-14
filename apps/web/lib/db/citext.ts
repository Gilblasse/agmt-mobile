import { customType } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL `citext` — text that compares case-insensitively.
 *
 * Drizzle has no built-in for it, and `drizzle-kit pull` emits
 * `// TODO: failed to parse database type 'citext'` instead. That matters
 * beyond compiling: the case-insensitivity is load-bearing. A driver typing
 * their name or email in any casing has to match the roster row, and
 * `drivers.name` is UNIQUE — under plain `text` the same person could be
 * added twice in different casing.
 *
 * Applied to the generated schema by `bun run db:pull`.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});
