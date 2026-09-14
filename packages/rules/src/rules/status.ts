/**
 * Status. The single most expensive piece of confusion in the old system.
 *
 * There are TWO fields. The dispatcher owns one, the driver owns the other, and
 * they are never the same thing:
 *   dispatchStatus  — the office's call on the trip   (old column E)
 *   driverProgress  — where the driver physically is  (old column Q)
 */

import {
  DISPATCH_TERMINAL,
  DRIVER_STEP_RANK,
  type DispatchStatus,
  type DriverProgress,
  type Trip,
  type TripOutcome,
} from '../types/index.js';

const squash = (s: unknown) => String(s || '').toLowerCase().replace(/\s+/g, '');

/**
 * What the card shows, given both fields.
 *
 * Calling a trip off is the dispatcher's decision and it has to be visible
 * whatever the driver is doing. Cancel and No Show used to be hidden the moment
 * a driver tapped a step, so a cancelled trip went on looking like a live job
 * and the dispatcher was left thinking the cancel had not worked.
 *
 * Reassign belongs with them: the driver's phone already treats it as over, and
 * nothing ever clears the driver's progress, so a board that kept showing
 * progress would read "In Transit" under the OLD driver's name for ever.
 *
 * Ready, Not Confirmed and Update Time describe a trip that has not started, so
 * those still give way to where the driver actually is.
 */
export function resolveTripStatus(driverProgress: string, dispatchStatus: string): string {
  const topDriverStatuses = ['pickuplocation', 'dropofflocation', 'complete', 'intransit', 'inroute'];
  const dispatcherOverrides = ['reassign', 'notconfirmed', 'ready', 'updatetime', 'noshow', 'cancel'];
  const terminalOverrides = ['cancel', 'noshow', 'reassign'];

  const d = squash(driverProgress);
  const o = squash(dispatchStatus);

  if (terminalOverrides.includes(o)) return o;
  if (d === 'complete' || o === 'complete') return 'complete';
  if (dispatcherOverrides.includes(o) && !topDriverStatuses.includes(d)) return o;
  return d;
}

/**
 * What actually became of the trip. The dispatcher's word wins: a no-show
 * declared by the office stands even if the driver had tapped all the way
 * through.
 */
export function tripOutcome(trip: Pick<Trip, 'dispatchStatus' | 'driverProgress' | 'dropoffDepartureAt'>): TripOutcome {
  const o = squash(trip.dispatchStatus);
  if (o === 'noshow') return 'no-show';
  if (o === 'cancel' || o === 'canceled' || o === 'cancelled') return 'cancelled';
  if (o === 'reassign') return 'reassigned';
  if (squash(trip.driverProgress) === 'complete' || trip.dropoffDepartureAt) return 'completed';
  return 'in progress';
}

/** Is this trip over, one way or another? */
export function isFinished(trip: Pick<Trip, 'dispatchStatus' | 'driverProgress' | 'dropoffDepartureAt'>): boolean {
  return tripOutcome(trip) !== 'in progress';
}

/** Does this dispatch status get a timestamp when it is set? */
export function isTerminalDispatchStatus(value: string): boolean {
  return (DISPATCH_TERMINAL as readonly string[]).includes(String(value || '').toUpperCase());
}

/**
 * The monotonic guard on driver taps.
 *
 * A phone that was underground re-sends old taps when it surfaces. Applying one
 * would walk a finished trip backwards. A tap may raise a trip's progress and
 * never lower it — this check belongs on the SERVER, inside the same lock as
 * the row read, not on the phone.
 */
export function canAdvance(current: DriverProgress, next: DriverProgress): boolean {
  const a = DRIVER_STEP_RANK[current] ?? 0;
  const b = DRIVER_STEP_RANK[next] ?? 0;
  return b > a;
}

/**
 * Which timestamp column a driver tap writes. One tap, one stamp — and the
 * stamp is the office's clock, never the phone's.
 */
export function stampFieldFor(progress: DriverProgress):
  'pickupArrivalAt' | 'pickupDepartureAt' | 'dropoffArrivalAt' | 'dropoffDepartureAt' | null {
  switch (progress) {
    case 'PICKUP LOCATION': return 'pickupArrivalAt';
    case 'INTRANSIT': return 'pickupDepartureAt';
    case 'DROPOFF LOCATION': return 'dropoffArrivalAt';
    case 'COMPLETE': return 'dropoffDepartureAt';
    default: return null;
  }
}

/**
 * Undo must clear the stamp AND the progress AND anything the phone remembered
 * about having advanced. An undo that left the advanced step in the phone's
 * memory was the direct cause of skipped timestamps for months: the phone
 * refused to re-send the step it thought it had already done.
 */
export function undoTarget(progress: DriverProgress): DriverProgress {
  const order: DriverProgress[] = ['', 'IN ROUTE', 'PICKUP LOCATION', 'INTRANSIT', 'DROPOFF LOCATION', 'COMPLETE'];
  const i = order.indexOf(progress);
  return i <= 0 ? '' : order[i - 1]!;
}

/**
 * Is this trip overdue — past its time with nobody on the way?
 *
 * An overdue trip that nobody has dealt with STAYS on the live board however
 * late it gets. That looks like a bug and is not: the operator was asked and
 * chose it, so that a missed pickup cannot quietly disappear.
 */
export function isOverdue(
  trip: Pick<Trip, 'scheduledTime' | 'dispatchStatus' | 'driverProgress' | 'dropoffDepartureAt'>,
  minutesNow: number,
  graceMinutes = 0,
): boolean {
  if (isFinished(trip)) return false;
  if (squash(trip.driverProgress) !== '') return false;
  if (!trip.scheduledTime) return false;
  const mins = Number(trip.scheduledTime.slice(0, 2)) * 60 + Number(trip.scheduledTime.slice(3));
  return minutesNow > mins + graceMinutes;
}

export function isKnownDispatchStatus(value: string): value is DispatchStatus {
  return (['', 'READY', 'NOT CONFIRMED', 'REASSIGN', 'UPDATE TIME', 'COMPLETE', 'CANCEL', 'NO SHOW'] as string[])
    .includes(String(value || '').toUpperCase());
}
