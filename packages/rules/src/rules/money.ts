/**
 * Money. Two functions, both of which exist because of a real invoice that went
 * out wrong.
 */

/**
 * Read a number the office typed, with a fallback for "they left it blank".
 *
 * `Number('')` is 0 and `isFinite(0)` is true, so a blank box used to read as a
 * real zero and the fallback never fired. A cleared base-fare box then quoted
 * every trip at nothing.
 */
export function num(v: unknown, fallback = 0): number {
  const s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '').trim();
  if (s === '' || s === '-' || s === '.' || s === '-.') return fallback;
  const n = Number(s);
  return isFinite(n) ? n : fallback;
}

/**
 * Round to cents, half up, in both directions.
 *
 * `Math.round(1.005 * 100)` is 100.4999…, so half a cent used to be lost, and
 * negatives rounded the other way — discounts drifted one way and charges the
 * other, and a breakdown stopped adding up to its own total. Round the
 * magnitude, then put the sign back.
 */
export function money(n: unknown): number {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  const cents = Math.round(Math.abs(v) * 100 + 1e-9);
  return (v < 0 ? -cents : cents) / 100;
}

/** Format for a human. Never used for arithmetic. */
export function dollars(n: number): string {
  const v = money(n);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
}
