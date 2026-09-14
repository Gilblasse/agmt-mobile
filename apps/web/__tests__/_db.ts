import postgres from 'postgres';

/**
 * The database these tests are allowed to wreck.
 *
 * The suites here delete rows wholesale — the outbox tests empty
 * `notifications` before each case, because the drain is global by design and
 * they need the queue to themselves. Pointed at the office's database that is
 * not a test failure, it is a day's sign-in codes and delivery records gone,
 * with the `DELETE` looking exactly as intended.
 *
 * So the name has to say it is a test database. Set `ALLOW_DESTRUCTIVE_TESTS`
 * deliberately if you have some other convention; nobody does that by
 * accident.
 */
function checked(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. These tests need a database.');
  if (process.env.ALLOW_DESTRUCTIVE_TESTS) return url;

  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('DATABASE_URL is not a URL.');
  }
  if (!/test/i.test(name)) {
    throw new Error(
      `These tests delete rows. They will only run against a database whose name says it is ` +
        `for testing, and "${name}" does not. Use something like "agnext_test", or set ` +
        `ALLOW_DESTRUCTIVE_TESTS=1 if you are certain.`,
    );
  }
  return url;
}

export const sql = postgres(checked());
