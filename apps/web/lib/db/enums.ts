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
  const progress = TO_RULES[label];
  // An unmapped label would otherwise return undefined, and undefined walks
  // straight through `canAdvance` as rank 0 — every tap would look like an
  // advance and the guard would be gone. Better to fail loudly than to lose
  // taps quietly if the enum ever grows a value this map does not know.
  if (progress === undefined) {
    throw new Error(`Unknown driver_progress label from the database: ${String(label)}`);
  }
  return progress;
}

/** Narrows a raw database string to a label, refusing anything unmapped. */
export function toLabel(value: string): DriverProgressLabel {
  if (!(Object.prototype.hasOwnProperty.call(TO_RULES, value))) {
    throw new Error(`Unknown driver_progress label from the database: ${value}`);
  }
  return value as DriverProgressLabel;
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

/**
 * Is this one of the five steps a driver can actually tap?
 *
 * `value in TO_DB` looked equivalent and was not: `in` walks the prototype
 * chain, so `'constructor'`, `'toString'` and `'__proto__'` all passed as
 * steps and the server answered a phone that a step which does not exist had
 * already landed — quietly dropping a corrupted queue item instead of
 * reporting it. `''` is a real `DriverProgress` but is not something anyone
 * taps, so it does not belong here either.
 */
export function isDriverStep(value: unknown): value is DriverProgress {
  return typeof value === 'string' && DRIVER_STEPS.includes(value as DriverProgress);
}
