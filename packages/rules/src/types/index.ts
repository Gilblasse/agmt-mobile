/**
 * Amazing Grace Mobile Transport — the whole data model, as types.
 *
 * Every field here exists in the live Google Sheets system today. Where a name
 * differs from the old one, the old one is named in the comment so you can
 * follow it back. Where a field carries a trap, the trap is written down.
 *
 * Source of truth: docs/04-data-model.md.
 */

// ---------------------------------------------------------------------------
// The two status fields. These are NOT the same thing and never were.
// ---------------------------------------------------------------------------

/**
 * The dispatcher's call on a trip. Lives in DISPATCH column E, read back as
 * `dispatchStatus`. ONLY the office writes this.
 *
 * For years the board writer put the driver's progress in here on every save,
 * silently wiping whatever the dispatcher had set. Keep the two apart.
 */
export type DispatchStatus =
  | ''
  | 'READY'
  | 'NOT CONFIRMED'
  | 'REASSIGN'
  | 'UPDATE TIME'
  | 'COMPLETE'
  | 'CANCEL'
  | 'NO SHOW';

export const DISPATCH_STATUSES: readonly DispatchStatus[] = [
  '', 'READY', 'NOT CONFIRMED', 'REASSIGN', 'UPDATE TIME', 'COMPLETE', 'CANCEL', 'NO SHOW',
] as const;

/** Dispatch statuses that end a trip and get a `dispatchStatusAt` stamp. */
export const DISPATCH_TERMINAL: readonly DispatchStatus[] = ['NO SHOW', 'CANCEL', 'REASSIGN'] as const;

/**
 * The driver's physical progress. Lives in DISPATCH column Q, read back as
 * `status`. ONLY the driver app writes this.
 */
export type DriverProgress =
  | ''
  | 'IN ROUTE'
  | 'PICKUP LOCATION'
  | 'INTRANSIT'
  | 'DROPOFF LOCATION'
  | 'COMPLETE';

export const DRIVER_PROGRESS: readonly DriverProgress[] = [
  '', 'IN ROUTE', 'PICKUP LOCATION', 'INTRANSIT', 'DROPOFF LOCATION', 'COMPLETE',
] as const;

/**
 * Rank for the monotonic guard. A tap may only ever raise a trip's progress.
 * A stale re-send from a phone that was underground must not move it back.
 */
export const DRIVER_STEP_RANK: Readonly<Record<DriverProgress, number>> = {
  '': 0,
  'IN ROUTE': 1,
  'PICKUP LOCATION': 2,
  'INTRANSIT': 3,
  'DROPOFF LOCATION': 4,
  'COMPLETE': 5,
};

/** What actually became of a trip, once both fields are taken together. */
export type TripOutcome = 'in progress' | 'no-show' | 'cancelled' | 'reassigned' | 'completed';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** What the dispatcher types. Free text in the old system, with a datalist. */
export type TransportLabel = 'Taxi' | 'Ambulatory' | 'Wheelchair' | 'Stretcher' | (string & {});

/** What pricing resolves that free text into. */
export type TransportKey = 'ambulatory' | 'wheelchair' | 'stretcher' | 'taxi' | 'other';

export const TRANSPORT_KEYS: readonly TransportKey[] = [
  'ambulatory', 'wheelchair', 'stretcher', 'taxi', 'other',
] as const;

// ---------------------------------------------------------------------------
// The trip
// ---------------------------------------------------------------------------

/**
 * A `yyyy-mm-dd` service date. The whole system is keyed on this string, in the
 * office's timezone — never on a UTC instant and never on the browser's clock.
 */
export type DateKey = string;

/** A `HH:mm` clock time, 24-hour, office timezone. */
export type ClockTime = string;

/** An ISO 8601 instant. */
export type Instant = string;

export interface Trip {
  /** Stable identity. The old system's `tripKeyID`. Never the composite `id`. */
  id: string;

  /** `yyyy-mm-dd`, office timezone. Old: `date` / column A. */
  serviceDate: DateKey;

  /**
   * Scheduled pickup time, `HH:mm`. Old: `time` / column C.
   * TRAP: the old system writes `23:58` when no time was typed. Import that as
   * NULL. Never write a sentinel time again.
   */
  scheduledTime: ClockTime | null;

  /**
   * When the driver should set off. Old: `startTime` / column B.
   * TRAP: the same `23:58` sentinel was used here for "blank" for years.
   */
  startTime: ClockTime | null;

  passengerId: string | null;
  /** Denormalised on purpose: the name as it was written on the day. */
  passengerName: string;
  phone: string | null;
  medicaidNo: string | null;
  invoiceNo: string | null;

  transport: TransportLabel | null;

  pickup: string;
  dropoff: string | null;
  pickupNotes: string | null;
  dropoffNotes: string | null;
  notes: string | null;

  driverId: string | null;
  /** The name as written on the trip. The old system had no real key here. */
  driverName: string | null;
  vehicleId: string | null;
  vehicleLabel: string | null;

  /** Column E. Office only. */
  dispatchStatus: DispatchStatus;
  dispatchStatusAt: Instant | null;

  /** Column Q. Driver app only. */
  driverProgress: DriverProgress;

  /** The four taps. Old: columns Z, AA, AB, AC. */
  pickupArrivalAt: Instant | null;
  pickupDepartureAt: Instant | null;
  dropoffArrivalAt: Instant | null;
  dropoffDepartureAt: Instant | null;

  /** The outbound leg this is the return of. Old: `returnOf` / column AE. */
  returnOfTripId: string | null;
  /** The standing order this belongs to. Old: `recurringId` / column AF. */
  standingOrderId: string | null;

  privatePay: boolean;
  /** Dispatcher-typed mileage that overrides the Maps lookup. */
  milesOverride: number | null;
  /** Dispatcher-typed empty-run mileage. Nothing measures it. */
  deadheadMiles: number | null;

  /**
   * The agreed total. NULL is not zero: NULL means "could not be priced",
   * zero means "quoted at nothing". Collapsing the two under-bills.
   */
  quotedTotal: number | null;
  /** Why there is no total, in words the office can read. */
  unpricedReason: string | null;

  createdAt: Instant;
  updatedAt: Instant;
}

/** A trip as the board renders it, with the derived bits filled in. */
export interface BoardTrip extends Trip {
  outcome: TripOutcome;
  /** Minutes past the scheduled time with nobody on the way. */
  lateByMinutes: number | null;
  /** Live wait in ms, or null when nothing is waiting. */
  waitingMs: number | null;
  charges?: TripCharge[];
}

// ---------------------------------------------------------------------------
// People, vehicles
// ---------------------------------------------------------------------------

export interface Passenger {
  id: string;
  name: string;
  phone: string | null;
  medicaidNo: string | null;
  defaultTransport: TransportLabel | null;
  defaultPickup: string | null;
  defaultDropoff: string | null;
  notes: string | null;
  blacklisted: boolean;
  /** Required to blacklist. Not required to clear it. */
  blacklistReason: string | null;
  blacklistSetBy: string | null;
  blacklistSetAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
}

/** Mobile carrier, for the email-to-SMS gateway the old system used. */
export type Carrier = 'verizon' | 'att' | 'tmobile' | 'sprint' | 'boost' | 'cricket' | 'metropcs' | 'uscellular' | (string & {});

export interface Driver {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  carrier: Carrier | null;
  active: boolean;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface Vehicle {
  id: string;
  label: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Standing orders
// ---------------------------------------------------------------------------

export type WeekdayToken = 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';

export const WEEKDAY_TOKENS: readonly WeekdayToken[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export interface StandingOrder {
  id: string;
  title: string | null;
  startDate: DateKey;
  endDate: DateKey | null;
  /** Which days of the week it runs. Empty means every day. */
  days: WeekdayToken[];
  active: boolean;
  createdAt: Instant;
  updatedAt: Instant;
}

/**
 * Fields a mass edit across a standing order must never copy.
 * A date or a driver's own progress belongs to one day, not to the order.
 */
export const STANDING_ORDER_BLOCKED_FIELDS: readonly string[] = [
  'serviceDate', 'id', 'driverProgress', 'dispatchStatusAt',
  'returnOfTripId', 'standingOrderId',
  'pickupArrivalAt', 'pickupDepartureAt', 'dropoffArrivalAt', 'dropoffDepartureAt',
] as const;

/** The old system capped generation at 183 days. Keep a cap; make it a setting. */
export const STANDING_ORDER_MAX_DAYS = 183;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type PricingMode = 'auto' | 'optional' | 'off';
export type PricingKind = 'fixed' | 'percent';

export type PricingRuleKey =
  | 'afterHours' | 'weekend' | 'holiday' | 'sameDay' | 'shortNotice'
  | 'doorToDoor' | 'doorThrough' | 'stairs' | 'attendant' | 'companion' | 'extraPax'
  | 'bariatric' | 'oxygen' | 'powerChair' | 'equipment'
  | 'extraStop' | 'waitReturn'
  | 'tolls' | 'parking'
  | 'cleaning' | 'custom'
  | 'recurring' | 'facility' | 'otherDisc';

export type PricingGroup =
  | 'Scheduling' | 'Assistance' | 'Equipment' | 'Trip' | 'Pass-through' | 'Other' | 'Discounts';

export interface PricingRuleDef {
  key: PricingRuleKey;
  group: PricingGroup;
  label: string;
  /** Whether the system can work this out for itself. */
  auto: boolean;
  discount?: boolean;
}

export interface PricingRuleSetting {
  mode: PricingMode;
  kind: PricingKind;
  amount: number;
}

export interface PricingConfig {
  version: number;
  updatedAt: string;
  updatedBy: string;
  base: Record<TransportKey, number>;
  mileage: { mode: PricingMode; includedMiles: number; perMile: number; minimumFare: number };
  /** The empty run out to the passenger. Dispatcher-typed miles only. */
  deadhead: { mode: PricingMode; includedMiles: number; perMile: number };
  wait: { mode: PricingMode; graceMin: number; intervalMin: number; rate: number };
  /** Wraps midnight: 19:00 to 06:00 is the evening and the small hours. */
  afterHoursFrom: ClockTime;
  afterHoursTo: ClockTime;
  /** Explicit `yyyy-mm-dd` list. The operator maintains it. */
  holidays: DateKey[];
  rules: Record<PricingRuleKey, PricingRuleSetting>;
}

export interface QuoteLine {
  key: PricingRuleKey | 'base' | 'mileage' | 'minimum' | 'minimumFloor' | 'deadhead' | 'wait';
  label: string;
  /** The sentence the office reads back to a customer. */
  detail: string;
  amount: number;
  source: 'auto' | 'manual';
}

export interface Quote {
  total: number;
  /** True when the price is not safe to invoice. Never hide this. */
  incomplete: boolean;
  lines: QuoteLine[];
  transport: TransportKey;
  miles: number | null;
  deadheadMiles: number;
  configVersion: number;
  manual: string[];
  dropped: string[];
  quotedAt: string;
}

export interface QuoteOptions {
  /** Loaded mileage. null means "not known" — which makes the quote incomplete. */
  miles?: number | null;
  /** `HH:mm` used for the after-hours test. For a return leg this is the OUTBOUND leg's time. */
  timeHm?: ClockTime;
  /** Today, in the office's timezone, for the same-day test. Passed in, never read from a clock. */
  today?: DateKey;
  manual?: string[];
  dropped?: string[];
  deadheadMiles?: number | string | null;
  now?: string;
  /**
   * A no-show or a cancellation, and when the office called it. The driver was
   * at the door, so their wait runs to that moment rather than to a departure
   * stamp that will never come.
   */
  endedOutcome?: string;
  endedAt?: string | null;
  /** Set by the engine when it could not finish. */
  incompleteQuote?: boolean;
}

/** A stored charge line. One row per line — never a JSON blob. */
export interface TripCharge {
  id: string;
  tripId: string;
  ruleKey: string;
  label: string;
  detail: string;
  amount: number;
  quantity: number | null;
  unitAmount: number | null;
  passThrough: boolean;
  isDiscount: boolean;
  source: 'auto' | 'manual';
  pricedVersion: number;
  createdAt: Instant;
}

/** Charge keys kept out of every percentage base — money passed on, not earned. */
export const PASS_THROUGH_KEYS: readonly string[] = ['deadhead', 'wait', 'tolls', 'parking'] as const;

// ---------------------------------------------------------------------------
// Events, notifications, locking
// ---------------------------------------------------------------------------

export type TripEventKind =
  | 'created' | 'updated' | 'deleted'
  | 'dispatch_status_set'
  | 'driver_tap' | 'driver_undo'
  | 'driver_assigned' | 'driver_unassigned'
  | 'priced'
  | 'note';

export interface TripEvent {
  id: string;
  tripId: string;
  kind: TripEventKind;
  value: string | null;
  /** `office:<user>` or `driver:<id>` or `system`. */
  actor: string;
  occurredAt: Instant;
  recordedAt: Instant;
  /** The phone's nonce. A re-send carries the same one and is refused. */
  idempotencyKey: string | null;
  payload?: unknown;
}

export type NotificationChannel = 'sms' | 'email' | 'push';
export type OutboxState = 'pending' | 'sent' | 'failed' | 'abandoned';

export interface Notification {
  id: string;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string;
  tripId: string | null;
  driverId: string | null;
  /** The same alert must never go out twice. */
  dedupeKey: string | null;
  state: OutboxState;
  attempts: number;
  lastError: string | null;
  sendAfter: Instant;
  sentAt: Instant | null;
  createdAt: Instant;
}

/** A day the office has closed out. Nothing on it may change afterwards. */
export interface SubmittedDay {
  serviceDate: DateKey;
  submittedBy: string;
  submittedAt: Instant;
}
