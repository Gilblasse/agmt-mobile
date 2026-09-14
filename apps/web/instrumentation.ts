/**
 * Runs once when the server starts.
 *
 * Importing the database module here turns a missing or unusable
 * `DATABASE_URL` into a startup failure with a clear message, instead of every
 * API route returning an opaque 500 later.
 *
 * The notifications line is for the operator: it says which provider this
 * process will use. It only *reports* — the sender itself is resolved where it
 * is used, because a value assigned here does not reach a route handler's
 * bundle, and an earlier version that installed it at boot printed "Twilio"
 * while the drain sent nothing.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  await import('./lib/db');

  const { describeConfiguredSender } = await import('./lib/notifications/sender');
  console.log(`[notifications] ${describeConfiguredSender()}`);
}
