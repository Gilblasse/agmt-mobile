import type { DriverProgress } from '@ag/rules/types';

/**
 * Translation between the database's enum labels and the strings the rules
 * package uses.
 *
 * The rules were ported from the live Apps Script and are checked against it
 * on every CI run, so they speak the spreadsheet's vocabulary — `'IN ROUTE'`,
 * `'INTRANSIT'`, and `''` for "not started". The schema uses tidy snake_case
 * labels instead. Neither side should bend: changing the rules would break
 * parity with the system still invoicing real money, and changing the schema
 * would carry the spreadsheet's spelling into a fresh database for no reason.
 *
 * So the mapping lives here, at the boundary, and it is written out in full.
 * `'INTRANSIT'` is not `'in_transit'` under any mechanical transformation, and
 * a clever one would silently mistranslate exactly that value.
 */

export type DriverProgressLabel =
  | 'none'
  | 'in_route'
  | 'pickup_location'
  | 'in_transit'
  | 'dropoff_location'
  | 'complete';

const TO_RULES: Readonly<Record<DriverProgressLabel, DriverProgress>> = {
  none: '',
  in_route: 'IN ROUTE',
  pickup_location: 'PICKUP LOCATION',
  in_transit: 'INTRANSIT',
  dropoff_location: 'DROPOFF LOCATION',
  complete: 'COMPLETE',
};

const TO_DB = Object.fromEntries(
  Object.entries(TO_RULES).map(([label, progress]) => [progress, label]),
) as Readonly<Record<DriverProgress, DriverProgressLabel>>;

export function progressToRules(label: DriverProgressLabel): DriverProgress {
  return TO_RULES[label];
}

export function progressToDb(progress: DriverProgress): DriverProgressLabel {
  return TO_DB[progress];
}

/** Every step a driver can tap, in order, as the phone would name them. */
export const DRIVER_STEPS: readonly DriverProgress[] = [
  'IN ROUTE',
  'PICKUP LOCATION',
  'INTRANSIT',
  'DROPOFF LOCATION',
  'COMPLETE',
];

export function isDriverProgress(value: unknown): value is DriverProgress {
  return typeof value === 'string' && value in TO_DB;
}
