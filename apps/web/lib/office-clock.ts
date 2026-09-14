import { officeDateKey } from '@ag/rules';

/**
 * The office's timezone decides what day it is — never the phone's, never the
 * server's own locale.
 *
 * A test phone an hour behind once froze every timer in the system at 00:00,
 * silently (CLAUDE.md, non-negotiable #3). So the server tells the phone what
 * time it is on every payload, and the phone corrects against it rather than
 * trusting its own clock.
 */
export const OFFICE_TIME_ZONE = process.env.OFFICE_TIME_ZONE ?? 'America/New_York';

export function officeToday(now = new Date()) {
  return officeDateKey(now, OFFICE_TIME_ZONE);
}

export function officeTomorrow(now = new Date()) {
  return officeDateKey(new Date(now.getTime() + 86_400_000), OFFICE_TIME_ZONE);
}

/** What the phone needs to correct its own clock: the instant, and the wall time here. */
export function serverClock(now = new Date()) {
  return {
    serverNow: now.toISOString(),
    serverClock: new Intl.DateTimeFormat('en-GB', {
      timeZone: OFFICE_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now),
    timeZone: OFFICE_TIME_ZONE,
  };
}
