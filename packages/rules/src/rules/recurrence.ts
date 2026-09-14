/**
 * Standing orders — a trip that repeats.
 *
 * The old system generated every day's trip up front and capped the run at 183
 * days. Keep the cap (make it a setting); keep the identity separate from any
 * one day's trip, which the old system did NOT do — its `recurringId` was the
 * trip key of whichever day happened to be created first, so deleting that day
 * orphaned the order.
 */

import { addDays, parseDateKey, weekdayToken } from './time.js';
import { STANDING_ORDER_MAX_DAYS, type DateKey, type WeekdayToken } from '../types/index.js';

export interface RecurrencePattern {
  startDate: DateKey;
  endDate?: DateKey | null;
  /** Empty means every day. */
  days?: WeekdayToken[];
  /** Hard stop. Defaults to the historical 183. */
  maxDays?: number;
}

/**
 * The dates a standing order runs on.
 *
 * Dates are walked one calendar day at a time — never by adding 24-hour blocks,
 * which lands an hour out on the two days a year the clocks change and drops or
 * doubles a day.
 */
export function expandPattern(p: RecurrencePattern, cap = STANDING_ORDER_MAX_DAYS): DateKey[] {
  const out: DateKey[] = [];
  if (!parseDateKey(p.startDate)) return out;
  const wanted = new Set((p.days ?? []).map((d) => String(d).toUpperCase()));
  const limit = Math.max(1, Math.min(cap, p.maxDays ?? cap));
  let cursor = p.startDate;
  for (let i = 0; i < limit * 2 && out.length < limit; i++) {
    if (p.endDate && cursor > p.endDate) break;
    const tok = weekdayToken(cursor);
    if (tok && (wanted.size === 0 || wanted.has(tok))) out.push(cursor);
    const next = addDays(cursor, 1);
    if (next === cursor) break;
    cursor = next;
  }
  return out;
}

/** Convenience: the common shortcuts the form offers. */
export function daysForFrequency(freq: 'DAILY' | 'WEEKDAYS' | 'WEEKENDS'): WeekdayToken[] {
  if (freq === 'WEEKDAYS') return ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  if (freq === 'WEEKENDS') return ['SAT', 'SUN'];
  return [];
}

/**
 * Which fields of a one-day edit may be copied across the rest of the order.
 *
 * Moving one day is a single-trip action and must never ask. A driver's own
 * progress and the day's own timestamps belong to that day alone.
 */
export function spreadableFields(changed: string[], blocked: readonly string[]): string[] {
  return changed.filter((f) => !blocked.includes(f));
}
