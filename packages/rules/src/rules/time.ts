/**
 * Clocks and calendars.
 *
 * Two rules run through all of this:
 *   1. The office's clock decides what day it is, not the device's.
 *   2. A blank time is blank. The old system wrote 23:58 to mean "nothing was
 *      typed"; that sentinel must die on import and never be written again.
 */

import type { ClockTime, DateKey } from '../types/index.js';

/** What the old system wrote when no time was typed. Treat as blank. */
export const BLANK_TIME_SENTINEL = '23:58';

/**
 * Read a time out of anything the old system might hold: a Date, `"14:30"`,
 * `"2:30 PM"`, `"2:30pm"`, an ISO string, or one of Google's 1899 date stamps.
 *
 * `\bPM\b` needs a word break before the P, and "2:30pm" has a digit there — so
 * the commonest way a dispatcher types it was read as half past two in the
 * MORNING, and trips were dispatched twelve hours early. This form covers
 * "2:30 PM", "2:30pm", "2:30P.M." and "7:05PM".
 */
export function hhmm(value: unknown): ClockTime | null {
  if (value instanceof Date) {
    return String(value.getHours()).padStart(2, '0') + ':' + String(value.getMinutes()).padStart(2, '0');
  }
  const text = String(value == null ? '' : value);
  const m = /(?:T|^|\s)(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const up = text.toUpperCase();
  if (/P\.?M\.?(?![A-Z])/.test(up) && h < 12) h += 12;
  if (/A\.?M\.?(?![A-Z])/.test(up) && h === 12) h = 0;
  if (h > 23) return null;
  return String(h).padStart(2, '0') + ':' + m[2];
}

/**
 * Read a time, but treat the old blank-sentinel as blank.
 * Use this on import and anywhere a stored time is read back.
 */
export function hhmmOrNull(value: unknown): ClockTime | null {
  const t = hhmm(value);
  if (t == null) return null;
  return t === BLANK_TIME_SENTINEL ? null : t;
}

/** True if this value is the old "no time typed" stand-in. */
export function isBlankTimeSentinel(value: unknown): boolean {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return true;
  if (/^11:58\s*PM$/i.test(raw)) return true;
  return hhmm(raw) === BLANK_TIME_SENTINEL;
}

/**
 * A sort key for a trip's time. A trip with no time sorts LAST, not first —
 * an untimed trip at the top of the board was read as the next job to run.
 */
export function timeSortValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const t = hhmm(value);
  return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : Number.MAX_SAFE_INTEGER;
}

/** Minutes since midnight, or null. */
export function minutesOfDay(value: unknown): number | null {
  const t = hhmm(value);
  if (!t) return null;
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
}

/** `yyyy-mm-dd` for a Date, in whatever timezone that Date is already in. */
export function dateKeyOf(date: Date): DateKey {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

/**
 * The office's today. Pass the office timezone; never call this without one and
 * never fall back to the server's own timezone silently.
 */
export function officeDateKey(now: Date, timeZone: string): DateKey {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Is `dateKey` a Saturday or Sunday? Parsed as a plain calendar date, not UTC. */
export function isWeekend(dateKey: DateKey): boolean {
  const d = parseDateKey(dateKey);
  if (!d) return false;
  const day = d.getDay();
  return day === 0 || day === 6;
}

/** `yyyy-mm-dd` to a local Date at midnight. Returns null if it isn't one. */
export function parseDateKey(dateKey: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || '').slice(0, 10));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** Add days to a date key without ever touching UTC or a DST boundary. */
export function addDays(dateKey: DateKey, days: number): DateKey {
  const d = parseDateKey(dateKey);
  if (!d) return dateKey;
  d.setDate(d.getDate() + days);
  return dateKeyOf(d);
}

/** Day-of-week token for a date key. */
export function weekdayToken(dateKey: DateKey): 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | null {
  const d = parseDateKey(dateKey);
  if (!d) return null;
  return (['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const)[d.getDay()]!;
}

/**
 * Is this time inside the after-hours window? The window wraps midnight:
 * 19:00 to 06:00 means the evening AND the small hours.
 */
export function isAfterHours(mins: number | null, from: ClockTime, to: ClockTime): boolean {
  if (mins == null) return false;
  const a = minutesOfDay(from), b = minutesOfDay(to);
  if (a == null || b == null) return false;
  return a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b);
}

/**
 * The maximum a live timer is allowed to show. Past this, something did not get
 * tapped and the number is meaningless — show nothing rather than "191h 37m".
 */
export const MAX_LIVE_WAIT_MS = 12 * 60 * 60 * 1000;

/** How far either side of its own day a trip may still show a live timer. */
export const MIDNIGHT_GRACE_MINUTES = 30;

/**
 * Should this trip show a live timer right now?
 * `nowMs` must be the OFFICE clock, not the device's.
 */
export function liveWaitMs(
  since: number | null,
  nowMs: number,
  tripDateKey: DateKey,
  officeToday: DateKey,
): number | null {
  if (since == null || !isFinite(since)) return null;
  const elapsed = nowMs - since;
  if (elapsed < 0) return null;
  if (elapsed > MAX_LIVE_WAIT_MS) return null;
  if (tripDateKey !== officeToday && Math.abs((nowMs - since) / 60000) > MIDNIGHT_GRACE_MINUTES) return null;
  return elapsed;
}
