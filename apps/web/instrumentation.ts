/**
 * Runs once when the server starts. Importing the database module here turns a
 * missing or unusable `DATABASE_URL` into a startup failure with a clear
 * message, instead of every API route returning an opaque 500 later.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/db');
  }
}
