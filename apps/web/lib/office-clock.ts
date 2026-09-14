import { addDays, officeDateKey } from '@ag/rules';

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
  // Adding 24 hours in milliseconds is wrong across a daylight-saving change:
  // on a 23-hour local day it lands on the day after tomorrow, so on the
  // Saturday evening before the clocks go forward a driver checking ahead saw
  // Monday's trips and Sunday's shift disappeared. `addDays` walks date keys
  // and never touches UTC or a DST boundary.
  return addDays(officeToday(now), 1);
}

/** Yesterday, for a trip that began before midnight and is still running. */
export function officeYesterday(now = new Date()) {
  return addDays(officeToday(now), -1);
}

/**
 * May a driver still tap this trip?
 *
 * Today, always. Yesterday, only while the trip is unfinished — a 23:45 pickup
 * is still the trip the driver is physically inside at 00:10, and refusing it
 * left overnight runs with their drop-off never stamped and the tap thrown
 * away. Anything older belongs to the office.
 */
export function tappability(
  serviceDate: string,
  driverProgress: string,
  now = new Date(),
): 'ok' | 'not-yet' | 'closed' {
  const today = officeToday(now);
  if (serviceDate === today) return 'ok';
  if (serviceDate > today) return 'not-yet';
  if (serviceDate === officeYesterday(now) && driverProgress !== 'complete') return 'ok';
  return 'closed';
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
