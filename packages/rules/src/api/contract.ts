/**
 * The API contract — every call the two apps make, as types.
 *
 * Each entry names the Apps Script function it replaces, so you can follow any
 * endpoint back into docs/03-server-api.md and then into the live code.
 *
 * Nothing here is implemented. This is the shape to build against, and the
 * thing to hand a front end so the two halves can be written at once.
 */

import type {
  BoardTrip, DateKey, DispatchStatus, Driver, DriverProgress, Notification,
  Passenger, PricingConfig, Quote, QuoteOptions, StandingOrder, Trip, TripEvent, Vehicle,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * Every write answers with one of these. A failure is never an exception the
 * client has to guess at — it carries a reason it can act on, and `partial`
 * says whether anything was written before it stopped.
 */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FailureReason; message: string; partial?: boolean };

export type FailureReason =
  | 'not-found'
  | 'day-locked'          // the office has submitted that day
  | 'conflict'            // someone else changed it first
  | 'blacklisted'
  | 'duplicate'
  | 'not-authorised'
  | 'validation'
  | 'busy'                // contention; retrying is reasonable
  | 'upstream'            // Maps, mail, SMS
  | 'internal';

/** Optimistic concurrency. Send back the `updatedAt` you were shown. */
export interface IfUnchanged { ifUpdatedAt?: string }

export interface Paged<T> { items: T[]; nextCursor?: string | null }

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export interface BoardQuery {
  /** The day to show. Defaults to the office's today. */
  date?: DateKey;
  /** Include the following day, which the old board always did. */
  includeTomorrow?: boolean;
}

export interface BoardResponse {
  date: DateKey;
  trips: BoardTrip[];
  /** The office's clock, so the page never trusts the device's. */
  serverNow: string;
  /** The office's wall clock in its own timezone, in the same shape stamps arrive in. */
  serverClock: string;
  timeZone: string;
  /** Changes when anything on the board changes. Cheap to ask for. */
  version: string;
  locked: boolean;
}

export interface Api {
  // -- board ---------------------------------------------------------------
  /** GET /api/board — replaces `getTripsPageData` / `getTripsByDate`. */
  getBoard(q: BoardQuery): Promise<Result<BoardResponse>>;

  /**
   * GET /api/board/version — replaces `getBoardVersion`.
   * The board asks every 3 seconds and the driver app every 4. It must stay a
   * cheap question: one number, no scan. Only fetch properly when it moves.
   */
  getBoardVersion(): Promise<Result<{ version: string; serverNow: string }>>;

  /** GET /api/server-time — replaces `getServerClock`. */
  getServerTime(): Promise<Result<{ now: string; clock: string; timeZone: string }>>;

  /** GET /api/trips/dates — which days actually hold a trip, for the calendar. */
  getTripDates(range: { from: DateKey; to: DateKey }): Promise<Result<{ dates: DateKey[]; locked: DateKey[] }>>;

  // -- trips ---------------------------------------------------------------
  /** GET /api/trips/:id */
  getTrip(id: string): Promise<Result<Trip>>;

  /**
   * POST /api/trips — replaces `addTripsFromSidebar`.
   * Creating a round trip creates TWO trips; the return carries
   * `returnOfTripId`. Creating a standing order creates the order and its days.
   */
  createTrips(input: {
    trips: NewTrip[];
    returnLeg?: NewTrip | null;
    standingOrder?: { days: StandingOrder['days']; endDate?: DateKey | null; title?: string } | null;
  }): Promise<Result<{ created: Trip[]; standingOrderId?: string; warnings: TripWarning[] }>>;

  /**
   * PATCH /api/trips/:id — replaces `updateTripFromSidebar`.
   * Send ONLY the fields that changed. The server merges field by field; a whole
   * record overwrite loses whatever the other dispatcher just typed.
   */
  updateTrip(id: string, patch: Partial<NewTrip> & IfUnchanged): Promise<Result<Trip>>;

  /** DELETE /api/trips/:id — replaces `deleteTripFromSidebar`. */
  deleteTrip(id: string, opts?: { alsoReturnLeg?: boolean }): Promise<Result<{ deleted: string[] }>>;

  /**
   * POST /api/trips/:id/dispatch-status — replaces `setTripQuickStatus`.
   * The office's column only. Never writes driver progress.
   */
  setDispatchStatus(id: string, value: DispatchStatus, opts?: { singleLegOnly?: boolean }): Promise<Result<Trip>>;

  /** POST /api/trips/validate — replaces `checkTripPlan` / blacklist and duplicate checks. */
  validateTrip(input: NewTrip): Promise<Result<{ warnings: TripWarning[] }>>;

  /** GET /api/trips/:id/activity — what happened to this trip, in order. The sheet never had this. */
  getTripActivity(id: string): Promise<Result<TripEvent[]>>;

  // -- the driver app ------------------------------------------------------
  /**
   * POST /api/driver/sign-in — replaces the emailed sign-in code.
   *
   * A driver names themselves however they can: the roster picker sends a
   * name, a driver who knows their own details can send either. The reply is
   * always the same `{ sent: true }`, for every caller — a different answer
   * for an unknown name turns this into a way to read the roster.
   */
  driverSignIn(input: { name?: string; email?: string; phone?: string }): Promise<Result<{ sent: true }>>;

  /**
   * POST /api/driver/verify.
   *
   * Takes an identifier as well as the code. This was once typed as the code
   * alone, which would put every driver signing in at that moment into one
   * six-digit space — the per-code attempt limit would protect an individual
   * code while doing nothing about the space as a whole. The live system asks
   * who you are too (`driverVerifyCode(name, code)`).
   */
  driverVerify(input: {
    code: string;
    name?: string;
    email?: string;
    phone?: string;
  }): Promise<Result<{ token: string; driver: Driver }>>;

  /**
   * GET /api/driver/day — replaces `getDriverTrips`. One driver, one day.
   *
   * `version` changes whenever anything on this driver's day changes, so the
   * phone can poll it cheaply and skip a redraw when nothing has moved.
   * `serverNow` and `serverClock` are what the phone corrects its own clock
   * against; `timeZone` says whose clock that is. `readOnly` marks a day the
   * driver may look at but not tap.
   */
  getDriverDay(q: { which: 'today' | 'tomorrow'; date?: DateKey }): Promise<Result<{
    driver: Driver; date: DateKey; trips: BoardTrip[];
    serverNow: string; serverClock: string; timeZone: string;
    readOnly: boolean; version: string;
  }>>;

  /**
   * POST /api/driver/trips/:id/progress — replaces `setDriverStatus`.
   *
   * `idempotencyKey` is the phone's nonce. A re-send from the offline queue
   * carries the same one: recognise it and answer success, never apply it
   * twice. The server also refuses any tap that would move the trip BACKWARDS.
   * The stamp written is the SERVER's clock, not the phone's.
   */
  setDriverProgress(id: string, input: {
    progress: DriverProgress;
    idempotencyKey: string;
    /** What the phone believed when the driver tapped, for the audit trail only. */
    tappedAt?: string;
  }): Promise<Result<{ trip: Trip; applied: boolean; alreadyApplied: boolean }>>;

  /** POST /api/driver/trips/:id/undo — must clear the stamp AND the progress. */
  undoDriverProgress(id: string, input: { idempotencyKey: string }): Promise<Result<Trip>>;

  /**
   * POST /api/driver/trips/:id/eta — a relative offset in minutes, never an
   * absolute time. The office's clock turns it into a time on the board, so a
   * phone with a wrong clock cannot write a wrong arrival into a note.
   * `alreadyFlagged` says the board already carried a warning for this trip.
   */
  reportEta(id: string, input: {
    minutesFromNow: number;
    reason?: string;
    note?: string;
  }): Promise<Result<{ noted: true; arriving: string; alreadyFlagged: boolean }>>;

  // -- pricing -------------------------------------------------------------
  /** POST /api/pricing/quote — replaces `getPrivatePayQuote`. Pure; the server owns the arithmetic. */
  getQuote(input: { trip: Partial<Trip>; options?: QuoteOptions }): Promise<Result<{ quote: Quote; options: string[] }>>;

  /** GET /api/pricing/settings — replaces `pricingConfig`. */
  getPricingSettings(): Promise<Result<PricingConfig>>;

  /** PUT /api/pricing/settings — replaces `savePricingSettings`. Refuses in words, not codes. */
  savePricingSettings(cfg: PricingConfig): Promise<Result<PricingConfig>>;

  // -- standing orders -----------------------------------------------------
  getStandingOrders(): Promise<Result<StandingOrder[]>>;
  /** GET /api/standing-orders/:id/trips — the order's other days, from a date on. */
  getStandingOrderTrips(id: string, from: DateKey): Promise<Result<{ trips: Trip[]; locked: DateKey[] }>>;
  /** PATCH /api/standing-orders/:id/trips — apply one day's edit to the days the office picked. */
  applyToStandingOrder(id: string, input: {
    tripIds: string[]; fields: Partial<NewTrip>;
  }): Promise<Result<{ updated: number; skipped: { id: string; reason: FailureReason }[] }>>;
  renameStandingOrder(id: string, title: string): Promise<Result<StandingOrder>>;
  deleteStandingOrderTrips(id: string, from: DateKey): Promise<Result<{ deleted: number }>>;

  // -- passengers, drivers, vehicles ---------------------------------------
  getPassengers(q?: { search?: string; cursor?: string }): Promise<Result<Paged<Passenger>>>;
  createPassenger(input: Omit<Passenger, 'id' | 'createdAt' | 'updatedAt'>): Promise<Result<Passenger>>;
  updatePassenger(id: string, patch: Partial<Passenger> & IfUnchanged): Promise<Result<Passenger>>;
  /** A blacklist needs a reason. Clearing one does not. */
  setBlacklist(id: string, input: { blacklisted: boolean; reason?: string }): Promise<Result<Passenger>>;
  /** Deleting a passenger takes their upcoming trips with them — say how many first. */
  deletePassenger(id: string, opts?: { confirmUpcoming?: number }): Promise<Result<{ deletedTrips: number }>>;
  getPassengerTrips(id: string, q?: { days?: number }): Promise<Result<{ past: Trip[]; upcoming: Trip[]; truncated: boolean }>>;

  getDrivers(): Promise<Result<Driver[]>>;
  saveDriver(input: Partial<Driver> & { id?: string }): Promise<Result<Driver>>;
  getVehicles(): Promise<Result<Vehicle[]>>;

  // -- the day -------------------------------------------------------------
  /** POST /api/days/:date/submit — closes the day. Nothing on it may change afterwards. */
  submitDay(date: DateKey): Promise<Result<{ date: DateKey; trips: number }>>;
  getSubmittedDays(range: { from: DateKey; to: DateKey }): Promise<Result<DateKey[]>>;

  // -- planning ------------------------------------------------------------
  /** POST /api/plan/drive — replaces `planDriveInfo_`. Cache it; Maps costs money. */
  getDriveInfo(input: { from: string; to: string }): Promise<Result<{ minutes: number; miles: number; cached: boolean }>>;
  /** POST /api/plan/reachability — can this driver physically make the next pickup? */
  checkReachability(input: { driverId: string; tripId: string }): Promise<Result<{
    ok: boolean; leaveBy: string | null; explanation: string;
  }>>;

  // -- notifications -------------------------------------------------------
  /** The outbox. Nothing sends inline; everything queues, dedupes and retries. */
  getOutbox(q?: { state?: Notification['state'] }): Promise<Result<Notification[]>>;
  retryNotification(id: string): Promise<Result<Notification>>;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What the trip form sends. Note what is NOT here: no driver progress, ever. */
export interface NewTrip {
  serviceDate: DateKey;
  scheduledTime: string | null;
  startTime: string | null;
  passengerId?: string | null;
  passengerName: string;
  phone?: string | null;
  medicaidNo?: string | null;
  invoiceNo?: string | null;
  transport?: string | null;
  pickup: string;
  dropoff?: string | null;
  pickupNotes?: string | null;
  dropoffNotes?: string | null;
  notes?: string | null;
  driverId?: string | null;
  driverName?: string | null;
  vehicleId?: string | null;
  /** The office's own status. The form's `#ep-status` control maps HERE. */
  dispatchStatus?: DispatchStatus;
  privatePay?: boolean;
  milesOverride?: number | null;
  deadheadMiles?: number | null;
}

/** Something the office should see before saving — never a silent refusal. */
export interface TripWarning {
  reason: 'blacklist' | 'duplicate' | 'near-duplicate' | 'passenger' | 'driver' | 'unreachable';
  message: string;
  tripId?: string;
  /** Can the dispatcher save anyway? A blacklist is a stop; a near-duplicate is a question. */
  blocking: boolean;
}
