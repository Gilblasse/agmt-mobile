# Amazing Grace Mobile Transport — Data Model & Business Rules

Extracted by reading the live production source: `file_29.js` (main server logic —
`tripManager`, the pricing engine, standing orders, passengers), `file_18.js`
(row⇄object mappers, time helpers), `file_24.js` (DISPATCH↔LOG sync, snapshot
rebuild), `DriverApp.gs` (driver web app server code), `TripsPage.html`
(dispatcher board client), `DriverAppPage.html` (driver client). No file was
modified; this is a read-only extraction for a PostgreSQL rebuild.

## 0. A structural fact that shapes everything below

**The column-index constants (the `COLUMN` global: `COLUMN.DISPATCH.*` and
`COLUMN.LOG.*`) are not defined in any of the six files given.** Every file that
uses them (`file_18.js`, `file_24.js`, `file_29.js`, `DriverApp.gs`) says so
directly — `file_18.js` line 4: *"Column index constants are defined in
AmazingGraceTransport_constant.js"* — a server file that exists in the Apps
Script project but was not included in this handoff. This document reconstructs
the column layout from (a) inline comments next to `COLUMN.DISPATCH.X` reads,
(b) the actual `.getRange(row, COLUMN.DISPATCH.X + 1, ...)` write calls, whose
column arithmetic is code, not commentary, and (c) independent statements in
`RESUME.md`/`HANDOFF.md` written by a prior engineer who *did* have the constants
file open. Where these three sources agree, the letter is given with high
confidence. Where the only source is an inline comment and it **contradicts**
the code, that is flagged explicitly — some of these comments are stale
(written for an older column layout) and would mislead a rebuild if trusted at
face value. **Before building the Postgres schema, pull the real
`AmazingGraceTransport_constant.js` and diff it against §1.1 below.**

Two entirely different column layouts exist and must not be conflated:

- **DISPATCH sheet** — the physical spreadsheet the dispatcher board and driver
  app read/write live. `COLUMN.DISPATCH.*`.
- **LOG tripArray** — the fixed-position array shape used only for *legacy*
  rows inside the JSON blob stored in `LOG!B` (see §0.1). `COLUMN.LOG.*`, and
  independently confirmed in `TripsPage.html`'s client-side twin `EP_LOG_COL`.

### 0.1 How a trip is actually stored (JSON-in-a-cell, not one row per trip)

`LOG` has one row per **date** (column A = the date, column B = a JSON string).
Column B is `JSON.stringify(Array.from(map.entries()))` — an array of
`[tripKeyID, tripValue]` pairs (`serializeTripMap` / `deserializeTripMap`,
`file_18.js:41-87`). `tripValue` is one of two shapes:

- **Current format**: the full trip object, every property (including ones with
  no fixed column at all — `pricing`, `privatePay`, `milesOverride`,
  `deadheadMiles`, `pickupNotes`, `dropoffNotes`) serialized as-is.
- **Legacy format**: a fixed-length array (`Array.isArray(val)`), positioned per
  `COLUMN.LOG.*`, run through `convertRowToTrip` (`file_18.js:260-291`) to
  become a trip object. `convertRawData` (`file_18.js:232-240`) branches on
  `Array.isArray(val)` to read either shape transparently.

`DISPATCH` is a separate, physical sheet — one row per **trip**, only for
trips within the app's working window (`SIDEBAR_DISPATCH_MAX_ROW_`), and it
does **not** hold every field: `writeTripToDispatchRow_` (`file_29.js:1017-1053`)
never writes `transport`, `phone`, or `medicaid` to DISPATCH at all — only
LOG carries the complete record. DISPATCH is a working board, LOG is the
system of record. A Postgres rebuild should model **one `trips` table** (the
LOG record) and treat "DISPATCH" as either a materialized view/cache of
in-window trips or drop it entirely in favor of query filters.

---

## 1. The trip record — every field

> **Update — the column map is now confirmed.** This section was written from
> the six application files, where several column letters could only be
> inferred. The authoritative `COLUMN` map has since been recovered from
> `legacy/apps-script/AmazingGraceTransport_constant.gs`, and it settles every
> open question below:
>
> ```
> DATE 0 A · START_TIME 1 B · TIME 2 C · PASSENGER 3 D · TODAY 4 E
> TRANSPORT 5 F · PHONE 6 G · MEDICAID 7 H · INVOICE 8 I · PICKUP 9 J
> TRIP_KEY_ID 10 K · IN 11 L · DROPOFF 12 M · OUT 14 O · STATUS 16 Q
> VEHICLE 17 R · DRIVER 20 U · ID 23 X · NOTES 24 Y
> PICKUP_IN_AT 25 Z · ARRIVED_AT 26 AA · INTRANSIT_AT 27 AB · COMPLETED_AT 28 AC
> RETURN_OF 30 AE · RECURRING_ID 31 AF · STATUS_AT 32 AG
> ```
>
> So: **dropoff is M** (the note below marking it unknown is resolved), and
> transport, phone, medicaid and invoice are F, G, H and I — the same in LOG and
> DISPATCH. The stale comments in `Helpers.gs` remain wrong and should still be
> ignored.


Table below: property name on the trip object → DISPATCH column (best
reconstruction; see §0) → LOG tripArray legacy index/letter → type → allowed
values → blankable → written by → read by → sentinels.

| Property | DISPATCH col | LOG legacy col | Type | Values / format | Blank OK? | Written by | Read by | Sentinel |
|---|---|---|---|---|---|---|---|---|
| `tripKeyID` | K (confirmed: `file_18.js:190`, `HANDOFF.md:451`) | K (idx 10) | string | Salted SHA-256 hex, or (current UI) a `crypto.randomUUID()` v4 string (`epGenerateKey`, `TripsPage.html:10096`) | No (primary identity) | trip creation (`epSubmitNew`) | everything; the Map key in LOG!B, the TRIP_INDEX sheet, `recurringId` values | — |
| `id` | X — **computed/formula column**, never written by `writeTripToDispatchRow_` | X (idx 23) | string | Legacy composite key: `driver + '|' + date + '|' + time + '|' + passenger + '|' + pickup` | No | client on create (`epSubmitNew`, `TripsPage.html:10163`) | `isDuplicateTrip` (exact-match dedup), legacy row lookups | — |
| `date` | A (confirmed) | A (idx 0) | date | `yyyy-MM-dd` string, or a sheet Date serial (1899 epoch problem, §9) | No | trip create/edit | every date-keyed read (`getTripsByDate`) | `logDateKey_`/`dispatchDateKey_` fall back to `'9999-99-99'` for an unparsable date, so it sorts last but not lost |
| `startTime` | B (confirmed: `dispatchInheritedSpans_`, RESUME.md) | B (idx 1) | time-of-day | `"HH:mm"`, or ISO `"1899-12-30THH:MM:SSZ"`, or blank | **Yes — and often "blank"** | dispatcher form (`ep-start-time`) | hero card, trip details, DISPATCH col B | **`23:58` / `"11:58 PM"` — the historical stand-in for "no start time typed."** `isBlankStartTime_` (`file_18.js:93-110`) treats `23:58`, `T23:58`, and `"11:58 PM"` (case-insensitive) as blank on read; `startTimeCellValue_` never writes it going forward. `repairBlankStartTimes()` (`file_29.js:3241-3288`) is the one-time cleanup job for rows already poisoned with it. |
| `time` | C (derived: `writeTripToDispatchRow_` writes `[time, passenger, dispatchStatus]` as 3 contiguous cells starting at `COLUMN.DISPATCH.TIME+1`, and E is independently confirmed as the 3rd of those → TIME = E−2 = C) | C (idx 2) | time-of-day | `"HH:mm"` (scheduled pickup time) | Effectively no — client defaults to `'23:58'` if the box was left empty (`TripsPage.html:10154`) | dispatcher form (`ep-time`) | sort key for the board (`dispatchTimeValue_`), pricing engine's after-hours check | **`23:58` is ALSO the sentinel for "no time was typed" on this field** — but here it is the *actual stored value* for `time`, not a stand-in caught on read. The pricing engine explicitly special-cases it: `ppQuote_`'s `afterHours` rule returns `null` (no surcharge) when `o.timeHm === '23:58'` (`file_29.js:4972-4975`), because otherwise every untimed trip would get charged a false late-night fee. |
| `passenger` | D (derived, same 3-cell write) | D (idx 3) | string | Free text, normalized (`epNormalizePassengerName`), pipe chars stripped | **No — required** (`"Date and Passenger are required."`) | dispatcher form | passenger matching/blacklist/dedup, `passengerCacheKey_` | — |
| `dispatchStatus` | **E — confirmed repeatedly**: `writeTripToDispatchRow_` comment (`file_29.js:1034`), `RESUME.md`, client `EP_LOG_COL.TODAY` (`TripsPage.html:10105`, labeled `"E: the dispatcher's status"`) | E (idx 4, property name `TODAY` in `COLUMN.LOG`) | enum | `''`, `READY`, `NOT CONFIRMED`, `REASSIGN`, `UPDATE TIME`, `COMPLETE`, `CANCEL`, `NO SHOW` (`file_29.js:1536`) | Yes | **dispatcher only**, via the quick-status control (`applyQuickStatus`) and the edit-panel `#ep-status` select | board rendering, the "ended" classifier (`ttRowFor_`), pricing's `recurring`/discount eligibility is unaffected but reprice-on-save is | see §2 for the historic column-E/Q swap bug |
| `status` | **Q — confirmed repeatedly**: `dispatchInheritedSpans_`, "V102: driver app writes plain values into L, O and Q (IN, OUT and driver's status)" (`file_29.js:3507`) | Q (idx 16) | enum | `''`, `PICKUP LOCATION`, `INTRANSIT`, `DROPOFF LOCATION`, `COMPLETE`, `IN ROUTE` (`REPAIR_DRIVER_STATUSES_`, `file_29.js:3543`) | Yes | **driver app only** (`DriverApp.gs`), stamped in sequence as taps happen | "ended" classifier, wait-time engine (`ttRowFor_`), pricing (via `ppWaitMinutes_`) | — |
| `statusAt` | Q-adjacent, own column (`COLUMN.DISPATCH.STATUS_AT`, used as `stampCol` in `file_29.js:1601`) | (property `STATUS_AT`) | timestamp | Wall-clock ISO or sheet time | Yes | driver app, at the moment `dispatchStatus` is set to an ending value | `ttRowFor_`'s `endedAt` (used to compute a no-show/cancel's "wait" and the trip's finish time) | — |
| `vehicle` | derived (single-cell write after K) | R (idx 17) | string | Free text, datalist-suggested from `formOptions.vehicles[].label` — **not a strict enum/FK**, no dedicated Vehicles sheet found in the six files | Yes | dispatcher form (`ep-vehicle`) | board display, trip details | — |
| `driver` | derived (single-cell write) | U (idx 20) | string | Free text, datalist-suggested from `formOptions.drivers[].label`; matched fuzzily against STAFF (§3.3) — **also not a strict FK** | Yes ("Unassigned") | dispatcher form (`ep-driver`) | driver app's own trip list (`driverAppIdentify_` cross-reference), conflict checks | — |
| `transport` | **not written by `writeTripToDispatchRow_` at all** — LOG only | F (idx 5) | string, normalized to enum by pricing | Free text, datalist: `Taxi`, `Ambulatory`, `Wheelchair`, `Stretcher`; classified into `ambulatory\|wheelchair\|stretcher\|taxi\|other` by `ppTransportKey_` (regex match, `file_29.js:4841-4847`) | Yes (defaults to `other`/"Standard") | dispatcher form, or copied from the passenger profile's `type` | pricing base-fare lookup | — |
| `phone` | **not written by `writeTripToDispatchRow_`** — LOG only | G (idx 6) | string | Free text (formatted client-side as `(###) ###-####`, `epFormatPhone`) | Yes | dispatcher form | driver alerts (`driverCanBeTexted_`), passenger profile sync | — |
| `medicaid` | **not written by `writeTripToDispatchRow_`** — LOG only | H (idx 7) | string | Free text, max 40 chars in the Needs-Scheduling path (`pendingText_`) | Yes | dispatcher form | invoicing/reference only — not otherwise consumed in the read code paths inspected | — |
| `invoice` | derived (3-cell write `[invoice, pickup, tripKeyID]` ending at K, so INVOICE = K−2 = I) | I (idx 8) | string | Free text | Yes | dispatcher form | reference only | — |
| `pickup` | derived (I+1 = J) | J (idx 9) | string | Address text, pipe chars stripped | **No — implicitly required** for a real trip (used as a dedup key) | dispatcher form / Places autocomplete | Maps distance lookup (`planDriveInfo_`), dedup key, conflict detail | — |
| `dropoff` | single-cell write (letter not independently recoverable — old comment claims `L`, but `L` is code-verified as the driver's `IN` stamp, so that comment is **stale/wrong**; true letter unknown from the six files) | M (idx 12) | string | Address text, pipe chars stripped | Yes (but needed for mileage-based pricing) | dispatcher form | Maps distance lookup, board display | if blank, `ppQuote_` cannot get a distance and marks the quote `incomplete` |
| `in` (legacy alias) | **L — confirmed** (`dispatchInheritedSpans_`, "the sheet's L and O columns") | L (idx 11) | timestamp | Wall-clock ISO or sheet time | Yes | historically the driver's pickup-arrival stamp; superseded by `pickupArrival` but still read as a fallback (`row[COLUMN.LOG.PICKUP_IN_AT] \|\| row[COLUMN.LOG.IN]`) | `convertRowToTrip`, `ttRowFor_` | phantom-stamp risk — see §1.2 |
| `out` (legacy alias) | **O — confirmed** | O (idx 14) | timestamp | as above | Yes | historically the driver's completion stamp, superseded by `dropoffDeparture` | as above | phantom-stamp risk |
| `pickupArrival` | Z (`dispatchInheritedSpans_`: `[C.PICKUP_IN_AT + 1, 4]` spans Z:AC in the order pickupArrival, pickupDeparture, dropoffArrival, dropoffDeparture) | (extra, no fixed LOG index — part of the full object in current-format rows) | timestamp | as above | Yes | driver app, tap 1 ("arrived at pickup") | wait-time engine, pricing | — |
| `pickupDeparture` | AA | extra | timestamp | as above | Yes | driver app, tap 2 ("on board / left pickup") | as above | — |
| `dropoffArrival` | AB | extra | timestamp | as above | Yes | driver app, tap 3 ("arrived at drop-off") | as above | — |
| `dropoffDeparture` | AC | extra | timestamp | as above | Yes | driver app, tap 4 ("complete") | as above, and `status='COMPLETE'` classification | — |
| `notes` | single-cell write | Y (idx 24) | string | Free text, pipe-stripped, ≤1000 chars in the pending-trip path | Yes | dispatcher form | trip details panel | — |
| `pickupNotes` | not a DISPATCH column — extra field | not a fixed LOG index — extra field, `SO_EXTRA_FIELDS_` | string | Free text, pipe-stripped, ≤500 chars | Yes | dispatcher form (stop-note UI) | trip details, driver app (stop instructions) | — |
| `dropoffNotes` | extra | extra | string | as above | Yes | as above | as above | — |
| `returnOf` | derived (2-cell write `[returnOf, recurringId]`, so RETURN_OF = AE if the old comment is trusted) | AE (idx 30) | string | The outbound leg's `tripKeyID` | Yes (empty = not a return leg) | trip creation when "return trip" is checked | pricing (skips deadhead on a return leg, reuses outbound's `time` for pricing — `ppPriceTime_`), `SO_RETURN_LEG_SKIP_` field-swap logic | — |
| `recurringId` | derived (RETURN_OF+1 = AF) | AF (idx 31) | string | The **first date's `tripKeyID`** of the standing order (i.e. the parent/anchor trip's own key — `parentKey`, `TripsPage.html:10228-10243`) | Yes (empty = not part of a standing order) | trip creation when "standing order" is checked | `getStandingOrderMap()[recurringId]` for the pattern, `applyStandingOrderEdit`, pricing's `recurring` auto-discount detector | — |
| `privatePay` | extra | extra, `SO_EXTRA_FIELDS_` | boolean-ish | `true`/`false`, or the strings `"true"`/`"yes"`/`"1"` (`ppIsPrivate_`, `file_29.js:4832-4837`) — a genuinely loose boolean | Yes (falsy = not private-pay, no pricing engine involvement at all) | dispatcher form | gate for the entire pricing engine (`getPrivatePayQuote`, `repricePrivatePayTrips_`) | — |
| `milesOverride` | extra | extra | number-ish string | A dispatcher-typed mileage figure that overrides the Google Maps lookup | Yes | dispatcher form (typed field — "read end to end but nothing sets it" per `RESUME.md`'s Outstanding list, i.e. **no UI control currently writes it** even though the engine fully honors it when present) | `getPrivatePayQuote`, `repricePrivatePayTrips_` (keyed uniquely per override+route so two new trips on the same route don't share a cached override) | — |
| `deadheadMiles` | extra | extra | number-ish string | Dispatcher-typed empty-run mileage (never measured automatically) | Yes (0 = no deadhead charge) | dispatcher form | pricing engine, applied **after** the fare/percentage lines, never carried on a return leg | — |
| `price` | not a DISPATCH/LOG column — derived/cached | not fixed | number | The quote total, rounded to cents | Yes (empty when unpriceable) | `repricePrivatePayTrips_`, on every save of a private-pay trip | invoicing display | Cleared to `''` (not `0`) when a quote is `incomplete` and no prior agreed price exists — **`0` and `''` are NOT the same thing here**: `0` would mean "quoted at zero," `''` means "could not be priced." |
| `pricing` | extra (persisted JSON) | extra | object | See §5.6 for the full shape | Yes (`''` or absent = not private-pay / not yet priced) | `repricePrivatePayTrips_` | price breakdown UI | `pricing.incomplete`/`pricing.staleQuote`/`pricing.problem` sentinel fields mark a quote the engine could not (re)compute |
| `__changedFields` | not persisted | not persisted | array of field names | present only in-flight during a save, stripped before storage | n/a | client, to tell the merge which fields the dispatcher actually touched | `mergeTripFields_`, `writeTripToDispatchRow_`'s "only re-sort if date/time changed" optimization | — |

**Field count documented in §1: 30** persisted/logical trip properties
(`tripKeyID`, `id`, `date`, `startTime`, `time`, `passenger`, `dispatchStatus`,
`status`, `statusAt`, `vehicle`, `driver`, `transport`, `phone`, `medicaid`,
`invoice`, `pickup`, `dropoff`, `in`, `out`, `pickupArrival`,
`pickupDeparture`, `dropoffArrival`, `dropoffDeparture`, `notes`,
`pickupNotes`, `dropoffNotes`, `returnOf`, `recurringId`, `privatePay`,
`milesOverride`, `deadheadMiles`, `price`, `pricing`) — 33 if you count `in`/
`out` as distinct from their modern replacements and include `__changedFields`
as a documented-but-non-persisted transport field. Reported count below uses
33 to match exactly what is described above.

### 1.1 DISPATCH sheet column table (best reconstruction — see §0 caveat)

| Col | Field | Confidence |
|---|---|---|
| A | `date` | High (direct comment + universal usage) |
| B | `startTime` | High (code + RESUME.md agree) |
| C | `time` | High (derived from the 3-cell write ending at confirmed E) |
| D | `passenger` | High (same derivation) |
| E | `dispatchStatus` | **Highest — the one column this whole system's bug history hinges on** |
| F, G, H | Unknown identity, but **confirmed to hold sheet formulas/lookups**, not raw dispatcher input (`dispatchWritableRuns_` comment: *"F, G, H, L, O, Q, S, T, V, W and X hold lookups keyed off the row's own data"*) | High that they're computed; low on which field each is |
| I | `invoice` | Medium (derived from 3-cell write ending at confirmed K) |
| J | `pickup` | Medium (same derivation) |
| K | `tripKeyID` | High (three independent sources agree) |
| L | `in` (driver pickup-arrival legacy stamp) | High |
| M–N | Unknown | — |
| O | `out` (driver completion legacy stamp) | High |
| P | Unknown | — |
| Q | `status` (driver progress) | High |
| R–W | Unknown (S, T, V, W are formula/lookup columns per the same comment) | — |
| X | `id` — a **computed/formula column** (never written by the app; matches "unique trip ID" comment) | Medium |
| Y | `notes` | Low (single comment, unverified) |
| Z | `pickupArrival` | High |
| AA | `pickupDeparture` | High |
| AB | `dropoffArrival` | High |
| AC | `dropoffDeparture`/`completed` | High |
| AD | Unknown | — |
| AE | `returnOf` | Medium |
| AF | `recurringId` | Medium |
| AG | Sheet width ends here (`DISPATCH_SORT_COLS_ = 33` = columns A..AG) | — |

An **old, stale comment set** in `file_18.js`'s `dispatchRowToTripObject`
(lines 293-323) claims `C: Passenger`, `D: Phone`, `E: Transport`, `F:
Medicaid#`, `G: Invoice#`, `J: Pick Up`, `L: Drop Off`, `M: Vehicle`, `O:
Driver`. **Do not use these letters** — they directly contradict the
code-verified positions above (most importantly, they place `Transport` at E,
where `dispatchStatus` provably lives, and `Drop Off` at L, where the driver's
arrival stamp provably lives). They appear to describe an earlier version of
the sheet before columns were inserted/reordered, left behind when the code
changed. This contradiction is itself Data Trap #1 (see the final list).

### 1.2 Phantom driver-stamp trap

A DISPATCH row is a reused slot, not a permanent home for one trip. The app
only writes the columns it "owns"; when a new trip lands in a row a previous
occupant's driver stamps (columns Z, AA, AB, AC, plus L/O/Q) could survive
into the new trip's record, because those are exactly the columns the old
system also used for two now-repurposed legacy fields ("PU/DO" and "start
time"). The fix (`clearInheritedDispatchCells_`, `file_29.js:998-1015`) wipes
`dispatchInheritedSpans_()` — B, L, O, Q, Z:AC — the instant a row changes
hands, but only if the row is genuinely being reused for a *different* trip
(a row's own live progress is never touched). `tripStampsArePhantom_`
(`file_29.js:3228-3233`) is the diagnostic signature: a "departure" stamp
present while **both** "arrival" stamps are empty is impossible for a real
drive and marks an inherited (phantom) value.

---

## 2. The two status fields

| | `dispatchStatus` (DISPATCH col E, LOG prop `TODAY`) | `status` (DISPATCH col Q) |
|---|---|---|
| Who sets it | **Dispatcher only** — the board's quick-status buttons and the `#ep-status` select in the edit panel (despite that control's id containing "status" with no "dispatch" qualifier — a naming trap) | **Driver app only** — sequential taps as a trip is driven |
| Allowed values | `''`, `READY`, `NOT CONFIRMED`, `REASSIGN`, `UPDATE TIME`, `COMPLETE`, `CANCEL`, `NO SHOW` (`allowed` array, `file_29.js:1536`; same list surfaces client-side as `knownStatus`/`quickStatusOptions`, `TripsPage.html:5567`, `11189`, `11224`) | `''`, `PICKUP LOCATION`, `INTRANSIT`, `DROPOFF LOCATION`, `COMPLETE`, `IN ROUTE` (`REPAIR_DRIVER_STATUSES_`, `file_29.js:3543`) |
| What it means | The dispatcher's operational call on the trip — is it confirmed, ready to run, being reassigned, cancelled, a no-show | The driver's physical progress on the actual drive |
| Terminal values | `COMPLETE`, `CANCEL`, `NO SHOW`, `REASSIGN` are all end states dispatch can declare (`STAMPED = ['NO SHOW', 'CANCEL', 'REASSIGN']`, `file_29.js:1599`, get a `statusAt` stamp) | `COMPLETE` is the only true terminal driver state |
| Precedence when they disagree | **`dispatchStatus` wins.** `ttRowFor_` (`file_29.js:4051-4057`) checks `dispatchStatus` first — `NOSHOW`→`'no-show'`, `CANCEL`/`CANCELED`/`CANCELLED`→`'cancelled'`, `REASSIGN`→`'reassigned'` — and only falls through to `status === 'COMPLETE'` (or a `dropoffDeparture` timestamp existing) to call it `'completed'`. So a dispatcher-declared no-show or cancellation overrides whatever the driver's stamps say, even if the driver had already tapped through the whole trip. | — |

**The historical bug this distinction caused** (documented in `RESUME.md` and
throughout `file_29.js`'s V100–V102 comments): `writeTripToDispatchRow_` used
to put the driver's `status` value into column E on every dispatcher save,
because the function was written before the two concepts were cleanly
separated. Every time a dispatcher edited any field of a trip, that save
overwrote whatever `READY`/`NOT CONFIRMED`/etc. the dispatcher had previously
set, replacing it with the driver's progress word — and a background snapshot
rebuild moments later read that corrupted board value back into the permanent
LOG record, making the corruption durable. The fix explicitly writes
`trip.dispatchStatus` (never `trip.status`) into column E, with the comment
*"The driver's progress has its own column (Q) and is not written from here
at all."* (`file_29.js:1034-1039`). **A rebuild must keep these as two
separate columns/fields with two separate writers, never merge them.**

---

## 3. Passenger, driver/staff, and vehicle records

### 3.1 Passenger (PASSENGERS sheet)

Reconstructed row layout from `savePassengerFromDirectory`
(`file_29.js:3040-3120`), an 11-column row:

| Idx | Field | Type | Notes |
|---|---|---|---|
| 0 | `key` | string | `passengerCacheKey_(name)` — normalized lookup key |
| 1 | `displayName` | string | Required, whitespace-collapsed |
| 2 | `medicaid` | string | |
| 3 | `type` | string | Shares the transport vocabulary (Taxi/Ambulatory/Wheelchair/Stretcher datalist) |
| 4 | primary phone | string | First of the `phones` list |
| 5 | `phones` | string | Newline-joined list, de-duplicated by digits (`soDigits_`) |
| 6 | `addresses` | string | Newline-joined list, case-insensitive de-dup |
| 7 | `blacklisted` | boolean (stored as sheet TRUE/FALSE) | |
| 8 | `blacklistReason` | string | **Required, ≥3 characters, whenever `blacklisted` is true** — `"A reason is required to blacklist a passenger."` (both server: `file_29.js:3056`, and client: `TripsPage.html:6381`, `9847`) |
| 9 | `updatedAt` | Date | |
| 10 | `blacklistedBy` | string | Set to `currentDispatcherLabel_()` **only on the transition into** blacklisted (`!wasFlagged && outFlagged`); cleared to `''` when un-blacklisted |

A `PASSENGER_TRASH_HEADERS_` sheet exists for soft-deleted passengers:
`['Deleted at', 'Deleted by'].concat(PASSENGERS_HEADERS_)`.

Blacklist enforcement: `checkTripConflictsBatch` looks up the passenger by
normalized key and, if `blacklisted`, refuses the trip outright with
`{ ok:false, reason:'blacklist', passenger, note: blacklistReason }` — **this
can be overridden** by the caller passing `overrideBlacklist = true` (a
dispatcher "save anyway" path exists; it is not an absolute block).

Passenger profiles are also **auto-synced from trips**: every trip save calls
`syncPassengerFromTrip_`, which creates a new passenger record if the name is
unseen, or **adds** (never overwrites) a new phone/address to an existing
record, and fills in `medicaid`/`type` only if they were previously blank.

### 3.2 Passenger name matching / duplicate prevention

- `passengerCacheKey_` normalizes for lookup (exact mechanism defined outside
  the six files, but used consistently as the join key across blacklist,
  profile sync, and near-duplicate checks).
- **Exact conflict**: same passenger, same date, same normalized time
  (`hasPassengerConflict`, `file_29.js:660-676`) — blocks the save.
- **Near-duplicate**: same passenger, same date, pickup time within **20
  minutes** (`NEAR_DUPLICATE_WINDOW_MIN_ = 20`, `file_29.js:257`) of an
  existing trip — a soft warning (`overrideNearDuplicate` lets it through).
- **Exact-id duplicate**: `isDuplicateTrip` compares the legacy composite `id`
  string, or an "alt id" that drops the driver segment
  (`` `|${date}|${time}|${passenger}|${pickup}` ``) — catches the same trip
  re-submitted with a different/blank driver.

### 3.3 Driver / staff (STAFF sheet, in a **separate spreadsheet**, `DRIVER_STAFF_ID_`)

Columns actually read by the code (others may exist on the sheet but are
unused by any of the six files):

| Col idx | Letter | Field |
|---|---|---|
| 0 | A | `name` |
| 3 | D | `phone` |
| 4 | E | `email` (lower-cased on read; this is the sign-in identity — a Google account email matching this column walks straight into the driver app, `DriverApp.gs:1055-1059`) |
| 45 | AT | `carrier` (the cell-phone SMS gateway carrier, for text alerts) |

`RESUME.md`'s Outstanding list names five STAFF rows with no email in column
E: *(JP) Gerald DeFino JR, Jasmin DeFino, Mark Stephen, Jaslyn Blasse, Shatee
Damar* — without one they cannot receive a sign-in code.

**Driver name matching** (a trip's free-text `driver` string against the
STAFF roster) is genuinely fuzzy, built from three layered functions
(`DriverApp.gs:232-277`):

1. `driverNameParts_(s)` — Unicode-normalizes (NFD, strips diacritics: "José"
   == "Jose"), lower-cases, strips apostrophes ("O'Brien" == "OBrien"), splits
   on any non-alphanumeric run into word "parts."
2. `driverShortFormOf_(few, many)` — every part of the shorter name must be
   either an exact match to some part of the longer name, or a recognizable
   **prefix** (≥2 letters, "Chris" of "Christopher") or **suffix** (≥4
   letters — 3 is deliberately excluded because it over-matches: "Ana" would
   otherwise match "Dana", "Los" would match "Carlos") of some part of it.
3. `driverUniqueShortForm_(tripDriver, driverName)` — the short-form match is
   only trusted if it resolves to **exactly one** driver on the current
   roster; if the shortening is ambiguous between two or more staff, it is
   rejected (`hits > 1` → `false`).
4. `driverNorm_(s)` — a coarser normalize (lower-case, strip everything but
   `[a-z0-9]`) used for final identity comparison.

`driverCanBeTexted_(rec)` = has both a phone and a carrier.
`driverServerClock_()`/`getServerClock()` supply the office's own wall clock
(spreadsheet timezone) so a driver's phone with a wrong clock can be
corrected against it (see §9).

### 3.4 Vehicles

**No dedicated Vehicles table/sheet was found in any of the six files.** A
trip's `vehicle` field is free text with datalist autocomplete sourced from
`formOptions.vehicles[].label` (`TripsPage.html:4624`). The function that
builds `formOptions` (and therefore knows what a "vehicle" record actually
contains beyond a label) is not among the six files — it is almost certainly
alongside the missing `COLUMN` constants in `AmazingGraceTransport_constant.js`
or a further un-provided file. **This is a gap**: get that source before
modeling a `vehicles` table; as observed, only a `label` string is
structurally guaranteed to exist.

---

## 4. Standing orders / recurring trips

### 4.1 Identity and pattern shape

- **`recurringId`** = the `tripKeyID` of the very first generated date (the
  "parent"/anchor trip). Not a separate ID space — it is just another trip's
  key, reused as the join value (`TripsPage.html:10228-10243`).
- **Pattern string**: `"YYYY-MM-DD|YYYY-MM-DD|DAY,DAY,..."` — start date,
  end date, comma-separated day-of-week tokens from `SUN,MON,TUE,WED,THU,FRI,SAT`
  (`epEncodeDatePattern`/`epDecodeDatePattern`, `TripsPage.html:6230-6246`,
  `10148-10150`). Decoding walks every calendar day from start to end and
  keeps the ones whose `getDay()` is in the requested set.
- **Frequency shortcuts** offered in the UI collapse to that same day-list
  representation: `DAILY` → all 7 days, `WEEKDAYS` → Mon–Fri, `WEEKENDS` →
  Sat/Sun, custom → whatever checkboxes are ticked (defaulting to the start
  date's own weekday if none are checked).
- **`standingOrder` object** (the thing stored per `recurringId` in the
  standing-order map, keyed by `parentTripKeyID`, via
  `tripManager.updateStandingOrderMap`): `{ pattern, title, withReturnTrip,
  returnTime? }`.
- **Title**: stored **separately** from the pattern map, in its own Script
  Property (`SO_TITLES_PROPERTY_ = 'standingOrder:titles:v1'`), keyed by
  `recurringId`, max 60 chars (`SO_TITLE_MAX_`), max 300 titles total
  (`SO_TITLES_MAX_`) — kept apart specifically so "an order created before
  titles existed" never gets mistaken for carrying pattern data.
- **Span limit**: **183 days**, computed in fixed UTC day-blocks specifically
  to dodge DST arithmetic errors — `"a span crossing the autumn clock change
  gained an hour... a legal 183-day order was refused"` (`TripsPage.html:10216-10219`).

### 4.2 What can and cannot be mass-edited

`SO_MASS_EDIT_BLOCKED_ = ['date', 'tripKeyID', 'id', 'status', 'statusAt',
'returnOf', 'recurringId', 'price', 'pricing']` (`file_29.js:1835`) — a mass
edit across a standing order's days can touch anything **except** these
identity/derived fields. Price and pricing are blocked specifically because
they must be recomputed per-day (a Saturday's weekend surcharge must not
spread onto a Monday) — `applyStandingOrderEdit` reprices every touched trip
individually after the field merge, never copies a price verbatim.

`SO_RETURN_LEG_SKIP_ = ['pickup', 'dropoff', 'time', 'startTime',
'pickupNotes', 'dropoffNotes']` — additionally excluded when the specific
trip being mass-edited is a return leg, because these fields mean the
opposite thing on the way back (pushing the outbound's pickup address onto
the return leg would make it start where it should end).

`SO_EXTRA_FIELDS_ = ['privatePay', 'milesOverride', 'deadheadMiles',
'pickupNotes', 'dropoffNotes', 'startTime']` — the set of fields
`soApplyExtrasLocked_` will stamp across every day of a newly-created standing
order (from what was set on the template/parent trip).

A day already **submitted** (locked as history —
`isDateSubmitted_`/`filterUnsubmittedDates_`) is always excluded from mass
edits, deletes, and new creation — reported back as `locked` counts, never
silently skipped.

### 4.3 Background job queue

Standing orders longer than a couple of days are split: the **first date is
written synchronously** while the dispatcher waits (`soSplitDates_`, "near" =
`slice(0,1)` when ≥2 unique dates), and **every other date is queued** for a
background worker (`"later"`). Constants:

- `SO_JOB_HANDLER_ = 'processStandingOrderJobs_'`
- `SO_JOB_PREFIX_ = 'so-job:'` — jobs live as Script Properties under this prefix
- `SO_NEAR_DAYS_ = 7`, `SO_CHUNK_ = 8` (dates per chunk), `SO_TIME_BUDGET_MS_ = 240000` (4 min, safely under Apps Script's 6-minute execution ceiling)
- `SO_JOB_KEEP_MS_ = 24h`, `SO_FAILED_JOB_KEEP_MS_ = 30 days` ("a month to notice and retry")
- `SO_POLL_BATCH_ = 3` — dates written per progress-poll tick from the page

**Job shape** (`soEnqueueLocked_`, two kinds):

```
{ id, kind: 'create', parentTripKeyID, parentRow, recurringId, extras,
  dates, total, done, tries, createdAt, updatedAt, noTrigger? }

{ id, kind: 'delete', recurringId, dates, requested, total, done, tries,
  createdAt, updatedAt }
```

Creates are **idempotent per date** — a date that already holds a trip for
that `recurringId` is skipped on retry, so a re-run chunk can never duplicate
trips. The job is written to Script Properties **before** the trigger is
armed (`"write the job FIRST"` — `file_29.js:2579-2596`) specifically so that
if trigger creation itself fails, the job is not silently lost — the page's
own progress poll (`soRunChunk_`) can still work through it as long as the
dispatcher's tab stays open, and a `noTrigger` flag records the failure for
visibility. `soFinalizeStandingOrderDelete_` only removes the pattern from
the standing-order map once **every** date in the original request has been
processed (`requestedAll`), so a partial background delete can never orphan
a pattern that still has un-deleted trips.

---

## 5. Pricing (private-pay engine)

Entirely optional per trip — gated by `trip.privatePay` (`ppIsPrivate_`). A
trip with `privatePay` falsy never touches this engine at all.

### 5.1 Storage

- Script Property key: `PRICING_PROP_ = 'privatePay:pricing:v1'` (global
  operator-wide config, not per-trip).
- Sanity ceilings: `PRICING_MAX_PERCENT_ = 200`, `PRICING_MAX_AMOUNT_ = 100000`.
- `pricingConfig()` always returns a fully-populated config — it starts from
  `pricingDefaults_()` and merges in only the stored fields that validate,
  so a half-written or older-version config can never crash a quote.

### 5.2 The rule catalogue (`PRICING_RULES_`, `file_29.js:4482-4507`)

| Key | Group | Label | Auto-detectable? | Discount? |
|---|---|---|---|---|
| `afterHours` | Scheduling | After hours | Yes | |
| `weekend` | Scheduling | Weekend | Yes | |
| `holiday` | Scheduling | Holiday | Yes | |
| `sameDay` | Scheduling | Same-day request | Yes | |
| `shortNotice` | Scheduling | Short notice | No | |
| `doorToDoor` | Assistance | Door-to-door | No | |
| `doorThrough` | Assistance | Door-through-door | No | |
| `stairs` | Assistance | Stair assistance | No | |
| `attendant` | Assistance | Extra attendant | No | |
| `companion` | Assistance | Companion / escort | No | |
| `extraPax` | Assistance | Additional passenger | No | |
| `bariatric` | Equipment | Bariatric | No | |
| `oxygen` | Equipment | Oxygen | No | |
| `powerChair` | Equipment | Power / oversized chair | No | |
| `equipment` | Equipment | Special equipment | No | |
| `extraStop` | Trip | Additional stop | No | |
| `waitReturn` | Trip | Wait and return | No | |
| `tolls` | Pass-through | Tolls | No | |
| `parking` | Pass-through | Parking | No | |
| `cleaning` | Other | Cleaning / biohazard | No | |
| `custom` | Other | Additional service | No | |
| `recurring` | Discounts | Recurring trip | Yes | **Yes** |
| `facility` | Discounts | Facility / volume | No | **Yes** |
| `otherDisc` | Discounts | Other discount | No | **Yes** |

Each rule's live configuration is `{ mode, kind, amount }`:
- `mode` ∈ `PRICING_MODES_ = ['auto', 'optional', 'off']` — **a rule not
  flagged `auto: true` in the catalogue can never be stored as `'auto'`**,
  even if someone hand-edits the JSON property (`pricingConfig()` silently
  downgrades it to `'optional'`).
- `kind` ∈ `'fixed' | 'percent'`.
- `amount` — dollars (fixed) or a percentage number (percent), clamped to the
  two ceilings above.

### 5.3 Defaults (`pricingDefaults_`, `file_29.js:4516-4562`)

```
base fares:  ambulatory 45, wheelchair 65, stretcher 150, taxi 35, other 45
mileage:     mode auto, includedMiles 5, perMile 3, minimumFare 0
deadhead:    mode off, includedMiles 0, perMile 1.5   (dispatcher-typed miles only — nothing measures it)
wait:        mode off, graceMin 15, intervalMin 15, rate 10
afterHoursFrom: '19:00'   afterHoursTo: '06:00'   (wraps midnight)
holidays: []   (explicit yyyy-mm-dd list, operator-maintained)
rule seeds: afterHours $20 auto · weekend 15% auto · holiday $40 auto ·
  sameDay $25 optional · shortNotice $15 off · doorToDoor $0 off ·
  doorThrough $15 optional · stairs $25 optional · attendant $35 optional ·
  companion $10 optional · extraPax $10 optional · bariatric $75 optional ·
  oxygen $20 optional · powerChair $30 optional · equipment $25 optional ·
  extraStop $12 optional · waitReturn $40 optional · tolls $0 optional ·
  parking $0 optional · cleaning $100 optional · custom $0 optional ·
  recurring 10% off · facility 0% off · otherDisc $0 off
```

The `deadhead.mode` is effectively two-valued in practice, not three: nothing
is ever charged until the dispatcher types a mileage figure, so `'auto'` and
`'optional'` behave identically and `pricingConfig()` collapses any stored
`'auto'` to `'optional'` for this one field.

### 5.4 Engine order of operations (`ppQuote_`, `file_29.js:4898-5053`) — pure function, no sheet/clock reads

1. **Base fare** — looked up by `ppTransportKey_(trip.transport)` against
   `cfg.base`. A **zero base fare is legitimate** (mileage-only service, or a
   transport type this operator doesn't run) and only becomes a problem if
   nothing else fills the total (checked at the very end).
2. **Loaded mileage** (only if `cfg.mileage.mode === 'auto'` and a distance is
   known): `(miles − includedMiles) × perMile`, floored at 0 billable miles.
   If mileage is `auto` but no distance could be resolved, a `$0` mileage
   line is still added **and the whole quote is flagged `incompleteQuote`** —
   explicitly to avoid a $0 mileage line looking like a finished price.
3. **`fare`** = running sum of lines so far (base + mileage). **This is the
   base that every percentage-of-fare charge is computed against** —
   deliberately excluding anything added later, so a percentage rule can
   never compound on another percentage rule.
4. **Minimum-fare bump #1** — if `fare < cfg.mileage.minimumFare`, add a
   `minimum` line to bring it up, and raise `fare` to that floor for
   percentage purposes.
5. **Deadhead mileage** — added **after** the fare is settled, on purpose:
   it's a pass-through cost, not part of what the ride is worth, so a
   weekend surcharge is never taken on top of it and it can never itself
   satisfy a minimum fare. Never charged on a return leg.
6. **Waiting time** — `ppWaitMinutes_` sums the pickup-wait and drop-off-wait
   minutes computed from the driver's own stamps (via `ttRowFor_`); minutes
   beyond `graceMin`, rounded **up** to the next `intervalMin` block, times
   `rate`. Only ever computed from what actually happened — nothing is
   charged for waiting before the trip has been driven.
7. **Auto-detection functions** (`autoWhen`), evaluated against the
   **quoted** date/time, not "now":
   - `afterHours`: time falls in `[afterHoursFrom, afterHoursTo)` (wrapping
     midnight) — **except** when the time is exactly the `23:58` no-time
     sentinel, which is explicitly excluded so an untimed trip is never
     charged a false late-night fee.
   - `weekend`: `date`'s day-of-week is Saturday or Sunday.
   - `holiday`: `date` is in `cfg.holidays`.
   - `sameDay`: `date` equals "today" (passed in by the caller as `o.today`,
     not read from the system clock inside the pure engine).
   - `recurring`: `trip.recurringId` is non-empty.
   `shortNotice`, `doorToDoor`, `doorThrough`, `stairs`, `attendant`,
   `companion`, `extraPax`, `bariatric`, `oxygen`, `powerChair`, `equipment`,
   `extraStop`, `waitReturn`, `tolls`, `parking`, `cleaning`, `custom`,
   `facility`, `otherDisc` have **no** auto-detector and only ever apply
   when explicitly added by the dispatcher (`manual[key]`).
8. A rule only produces a line if: its `mode !== 'off'`, AND (it auto-fired
   and wasn't deliberately removed via `dropped[key]`, OR it was manually
   added via `manual[key]`), AND its configured `amount !== 0`.
9. **Charges** applied first: `percent` charges compute `fare × amount / 100`
   (against the `fare` frozen in step 3 — deadhead/wait/tolls/parking excluded
   even if they were added before this point in the line list, via the
   `PRICING_PASS_THROUGH_` exclusion set).
10. **Discounts** applied second, against `running` = sum of every
    **non-pass-through** line so far (base + mileage + minimum + charges —
    explicitly **not** including deadhead/wait/tolls/parking, so an operator
    is never handing back a percentage of their own pass-through costs).
    Discount amounts are always stored/added as negative (`-Math.abs(amount)`).
11. **Total** = sum of all lines, floored at 0.
12. **Minimum-fare bump #2** (`minimumFloor`) — re-checked **after**
    surcharges and discounts, because bump #1 happens before them and a
    discount could otherwise pull the total back under the stated minimum
    while an earlier line still claimed the minimum had been met.
13. Money rounding (`pricingMoney_`) rounds the **magnitude** half-up then
    restores sign, specifically to fix `Math.round(1.005*100) === 100` float
    error and to stop discounts/charges rounding in opposite directions.

### 5.5 Return-leg pricing rule

A return leg is priced using the **outbound leg's scheduled time**
(`ppPriceTime_`), not its own — because the hour a passenger happens to
return is a scheduling fact, not a pricing one; this keeps an after-hours
surcharge consistent between the two legs of one round trip regardless of
what time the return actually runs.

### 5.6 Stored quote/breakdown shape (`trip.pricing`)

```
{
  pickup, dropoff,             // the route this was priced against (route-change detection)
  total,                       // final rounded total
  lines: [ { key, label, detail, amount, source } ],   // source: 'auto' | 'manual'
  transport,                   // resolved pricing key (ambulatory/wheelchair/stretcher/taxi/other)
  miles,                       // resolved loaded mileage, or null
  manual: [ruleKey...],        // rules the dispatcher explicitly added
  dropped: [ruleKey...],       // auto-detected rules the dispatcher explicitly removed
  configVersion,                // pricing config version this quote was computed under
  quotedAt,                    // ISO timestamp
  deadheadMiles,
  pricedHere: true             // this trip's price came from a live compute, not a carried-over/incomplete one
}
```

When a quote cannot be completed (`incomplete`), two different outcomes are
possible, both without ever silently under-billing:
- If the route hasn't moved and a real agreed price already existed, the
  **previous price is kept**, with `pricing` merged in `{ incomplete: true,
  staleQuote: true, problem: "The distance could not be re-checked, so the
  previous price is still shown." }`.
- Otherwise `price` is cleared to `''` and `pricing` becomes `{ ...prior,
  incomplete: true, total: '', lines: [], problem: "This trip could not be
  priced - check the addresses and the base fare, then save again." }`.

---

## 6. Every enumeration

- **`dispatchStatus`**: `''`, `READY`, `NOT CONFIRMED`, `REASSIGN`, `UPDATE TIME`, `COMPLETE`, `CANCEL`, `NO SHOW`
- **`status`** (driver progress): `''`, `PICKUP LOCATION`, `INTRANSIT`, `DROPOFF LOCATION`, `COMPLETE`, `IN ROUTE`
- **Terminal/"stamped" dispatch statuses**: `NO SHOW`, `CANCEL`, `REASSIGN`
- **`ended` classification** (derived, `ttRowFor_`): `'in progress'`, `'no-show'`, `'cancelled'`, `'reassigned'`, `'completed'`
- **Pricing `mode`**: `auto`, `optional`, `off`
- **Pricing `kind`**: `fixed`, `percent`
- **Pricing transport keys**: `ambulatory`, `wheelchair`, `stretcher`, `taxi`, `other`
- **Transport free-text datalist / passenger `type` datalist**: `Taxi`, `Ambulatory`, `Wheelchair`, `Stretcher`
- **Pricing rule keys** (24 total): see §5.2 table
- **Pricing rule groups**: `Scheduling`, `Assistance`, `Equipment`, `Trip`, `Pass-through`, `Other`, `Discounts`
- **Standing-order frequency (UI shortcut)**: `DAILY`, `WEEKDAYS`, `WEEKENDS`, custom day-set
- **Pattern day tokens**: `SUN`, `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`
- **Standing-order job `kind`**: `create`, `delete`
- **Standing-order mass-edit endedLabels map** (`TripsPage.html:9429`): `NO SHOW` → "No Show", `CANCEL` → "Cancelled", `REASSIGN` → "Reassigned"
- **Trip conflict `reason`**: `blacklist`, `duplicate`, `passenger`, `driver`, `near-duplicate`
- **Pricing pass-through keys** (excluded from percentage bases): `deadhead`, `wait`, `tolls`, `parking`

---

## 7. Every validation rule found

Server-side (`file_29.js`, thrown as `Error`, propagates to the client as a failure):
- `"Those days have been submitted and are locked as history."` — editing/deleting a submitted (locked) date.
- `"Missing trip."` / `"No pending trip given."` / `"A tripKeyID is required to delete a sidebar trip."` / `"A tripKeyID is required to update a sidebar trip."` — missing identity on an operation that needs one.
- `"The passenger list is busy right now. Please try again."` — passenger-sheet lock contention (`PASSENGERS_LOCK_MS_` timeout).
- `"Passenger name is required."` (directory editor) / `"A passenger name is required."` (pending trip) / `"No passenger was named."` / `"No passenger was selected."`
- `"<name> already exists on the passenger list."` — rename collision in the passenger directory.
- `"A reason is required to blacklist a passenger."` — blacklist flag set with a reason under 3 characters.
- `"DISPATCH sheet is missing."` / `"DISPATCH sheet not found."` / `"TRIP_INDEX sheet is missing."` — structural sheet-integrity checks.
- `"Unsupported status: <value>"` — a `dispatchStatus` write outside the allowed list.
- `"No trips on the DISPATCH board."` — operating on an empty board.
- `"The Needs Scheduling list is full (500). Schedule or remove some first."` — `PENDING_TRIPS_MAX_` cap.
- `"This day has been submitted and is locked as history."` — duplicate-worded lock check in a second code path.

Client-side (`TripsPage.html`, `showToast(..., 'error')`, blocks the save before it reaches the server):
- `"Date and Passenger are required."` — both fields mandatory on new-trip submit.
- `"Cannot add a trip in the past."` — `date < localDateKey()`.
- `"That day was already submitted — it is locked as history."` (repeated at several call sites — new trip, standing order, pending-trip promotion).
- `"Please enter a return trip time."` — return-trip checkbox on with no time.
- `"Return time must be later than the trip time."` — same-day ordering check on the two legs.
- `"Give this standing order a title so it is easy to find."` — title required for any new standing order.
- `"Standing order needs start and end dates."`
- `"End date cannot be before start date."`
- `"Standing order cannot exceed 183 days."` — computed in fixed UTC-day blocks to avoid DST miscounts.
- `"No dates match that standing order."` — pattern decodes to zero dates.
- `"First and last name are required."` / `"Last name is required."` — new-passenger forms (two separate forms, slightly different requirement).
- `"A reason is required to blacklist."` — client-side mirror of the server rule.
- `"<name> already exists."` — client-side duplicate-passenger check.
- `"A passenger is required."` — pending/Needs-Scheduling entry.
- `"That day has already passed — leave it blank if it is not known."` — Needs-Scheduling target date.
- `"Please type a name for this standing order."` — the rename/title dialog.
- Trip conflict rejections surfaced from `checkTripConflictsBatch`: blacklist block, exact-id duplicate, same-passenger-same-time conflict, same-driver-same-time conflict, near-duplicate (same passenger within 20 minutes — overridable), and a non-blocking **driver-feasibility warning** (`checkTripPlan`) when two of a driver's trips are geographically too close in time to physically make (< `PLAN_TIGHT_MINUTES_ = 15` minutes of slack) — this one **never blocks a save**, it only warns, "because they know things the sheet does not."

---

## 8. Every derived/computed value

- **`ended`** classification (`ttRowFor_`) — see §2 precedence rule.
- **`pickupWaitMin`** — minutes between `pickupArrival` and `pickupDeparture`; if the trip ended in a no-show/cancellation before departure, minutes between `pickupArrival` and the dispatch `statusAt` stamp instead.
- **`dropoffWaitMin`** — minutes between `dropoffArrival` and `dropoffDeparture`/`completed`.
- **`onRoadMin`** — minutes between `pickupDeparture` and `dropoffArrival`.
- **`totalMin`** — minutes between `pickupArrival` and the trip's finish instant (completion time, or the dispatch end-stamp for a non-completed ending).
- **`lateByMin`** — minutes between the scheduled pickup instant (`ttScheduled_`, date + `time`) and the actual `pickupArrival`; discarded (`''`) if the gap exceeds `TRIP_TIMES_MAX_GAP_MIN_` (12 hours) — treated as a bad/impossible stamp rather than a real 12-hour lateness.
- **Any of the four wait/road/total gaps** — discarded (`''`) if negative or longer than `TRIP_TIMES_MAX_GAP_MIN_`: "a gap longer than this is a forgotten tap, not a wait."
- **`ppWaitMinutes_`** (billable waiting, for pricing) = `pickupWaitMin + dropoffWaitMin` from the above, defaulting to 0 on any failure.
- **Board sort order** — DISPATCH rows are kept sorted by (date, time-of-day-in-minutes, original position as tiebreaker), empty rows always last; **only re-computed when a save touched `date` or `time`** (an optimization, not a correctness relaxation, since nothing else affects sort key).
- **`dispatchStatusFromStamps_`** — a repair-only derivation that rebuilds what column E/Q *should* say purely from the four driver timestamps: `COMPLETE` if `dropoffDeparture` present, else `DROPOFF LOCATION` if `dropoffArrival` present, else `INTRANSIT` if `pickupDeparture` present, else `PICKUP LOCATION` if `pickupArrival` present, else blank.
- **Pricing `fare`, `running`, `total`** — see §5.4, all derived, never independently stored except in the final `pricing` snapshot.
- **`zeroBase_`/`incomplete`** pricing flags — derived booleans that gate whether a $0 total is "valid" or "broken."
- **STOP_TIMES medians** (`ST_*` constants) — a background job learns the median pickup/drop-off dwell time per driver/location from history (120-day window, discards outlier waits over 45 minutes, needs ≥5 samples for a per-context median or ≥10 for the company-wide fallback) and uses it, instead of the fixed 5-minute/3-minute allowance, to judge whether a driver can plausibly make their next trip.
- **`driverUniqueShortForm_`** — not stored, computed live on every board render/driver match to resolve a typed short name.
- **Board version** (`BOARD_VERSION_KEY_`) — a cache-only "has anything changed" counter bumped on every write, polled cheaply by both apps to avoid re-fetching the whole board every few seconds.

---

## 9. Time and date handling

### 9.1 Formats accepted on input

- `"HH:mm"` (24-hour, e.g. `"14:30"`).
- ISO instant with the Google Sheets 1899 anchor: `"1899-12-30THH:MM:SSZ"` — this
  is how a **time-of-day-only** cell round-trips through JSON. The date part
  is meaningless (always Dec 30, 1899); only the `T`-hours/minutes are the
  real wall-clock value.
- `"11:58 PM"` — legacy 12-hour display string, recognized only as the blank-time sentinel (see §9.3).
- A native `Date` object (from `getValues()` reads) or anything else `new Date(val)` can parse.
- Full `"yyyy-MM-dd"` for date-only fields.

### 9.2 The 1899 date-stamp problem

Google Sheets stores a "time only" cell internally as a date-time whose date
portion defaults to **December 30, 1899** (Sheets' day-zero minus one, for
historical Lotus 1-2-3 compatibility reasons outside this codebase, but
consistently exploited by it). Every time-parsing helper in this system
(`toTimeOnlySmart`, `toWallClockTimeIso_`, `fromTimeOnly`, the LOG row
builders) deliberately **constructs** `new Date(1899, 11, 30, h, m)` when
writing a time-only value, and strips/ignores the date part when reading one
back — so a time survives round-tripping through a `Date` object without
picking up a spurious real date. `DriverApp.gs:322` notes a real production
incident: *"happened to store the time - a negative 1899 epoch for one trip,
a positive 2026 [epoch] for another"* — i.e., not every time cell was
written consistently through these helpers, so a rebuild must tolerate mixed
representations in historical data (some 1899-anchored, some genuinely dated).

### 9.3 Sentinel values — the full list found

1. **`23:58` / `"11:58 PM"` / `"T23:58"` for a blank `startTime`.** The
   single most consequential trap in this system. `toTimeOnlySmart` (the
   general "make me a time" helper) returns `new Date(1899,11,30,23,58)` as
   its universal "nothing" fallback for **any** unparsable/blank input — and
   for years, that fallback value was written straight into the
   `startTime` column, so every trip with no start time typed displayed as
   "leaves at 11:58 PM." `isBlankStartTime_` now recognizes and blanks all
   three textual shapes it can arrive in; `repairBlankStartTimes()`
   (`file_29.js:3241-3288`) is the batch-fix job for rows already poisoned
   with it, in both LOG's JSON blobs and DISPATCH column B.
2. **`23:58` for a blank `time`** (the *scheduled pickup time*, a different
   field from `startTime`) — the client defaults an empty time box to
   `'23:58'` on submit (`TripsPage.html:10154`) rather than leaving it truly
   empty, and the **pricing engine explicitly detects and excuses this exact
   value** so an untimed trip is never charged a false after-hours surcharge
   (`file_29.js:4972-4975`). Unlike `startTime`, there is no cleanup job for
   this one — it's treated as an intentional, permanent sentinel rather than
   a bug to repair.
3. **`24*60+1` minutes-of-day** — `dispatchTimeValue_`'s fallback when a
   dispatch row's time can't be parsed at all, deliberately placed after
   every real time-of-day so an untimed row sorts last within its date.
4. **`'9999-99-99'`** — `dispatchDateKey_`'s fallback for an unparsable date,
   sorting after every real date but ahead of the empty-row bucket.
5. **`price = ''`** (empty string) vs **`price = 0`** — deliberately distinct:
   `''` means "could not be priced," `0` would mean "priced at zero dollars."
   `getPrivatePayQuote`/`repricePrivatePayTrips_` are careful never to
   collapse these.
6. **`pricing.incomplete` / `pricing.staleQuote`** flags — sentinel markers
   *inside* the stored pricing object (not a bare sheet value) meaning "this
   total cannot be trusted as freshly computed," carried so the UI can warn
   rather than present a broken price as final.

### 9.4 Timezone handling

There is **no user-facing timezone selector** — everything is anchored to the
**bound spreadsheet's own timezone** (`activeSpreadsheet_().getSpreadsheetTimeZone()`
/ `Session.getScriptTimeZone()`), read fresh on every relevant call rather than
cached, specifically because (per `RESUME.md`) *"clocks are not to be
trusted... anything comparing times uses the office's clock carried down with
the data, never the machine's own."* The client mirrors this: `wtSkew`/`wtZone`
(`TripsPage.html:7521-7531`) measure, on load, how far the **browser's own
clock** is from the server's reported clock (`getServerClock()`, which returns
both a raw `now` epoch and a `clock` string formatted in the spreadsheet's
timezone) and how far the **browser's timezone** is from the spreadsheet's —
then every subsequent "how long has this been waiting" calculation in the UI
is corrected by both offsets. `RESUME.md` independently notes a real device
whose clock ran an hour behind Eastern, which the apps now compensate for but
which "still displays the wrong time elsewhere" (a known, accepted residual
gap).

### 9.5 Day-key format

Every date-keyed lookup — `getTripsByDate`, `logDateKey_`, `dispatchDateKey_`,
`localDateKey`, the TRIP_INDEX sheet, submitted-dates lock map — uses the plain
**`"yyyy-MM-dd"`** string as its canonical key, independent of any Date
object's own timezone. This is why so much code calls `Utils.formatDateString(...)`
immediately upon receiving anything date-shaped, before using it as a lookup
key — comparing raw `Date` objects (or their serialized forms) directly would
reintroduce exactly the timezone/1899 ambiguities this format sidesteps.

---

## 10. Proposed PostgreSQL schema

Given the DISPATCH/LOG duality (§0.1), the schema below treats **LOG as the
system of record** and does not attempt to reproduce DISPATCH as a persisted
table — model it (if a live "board" cache is still wanted) as a materialized
view or an application-layer cache keyed off `trips.date` and a rolling
window, not as separate ground truth. `SIDEBAR_DISPATCH_MAX_ROW_`-style row
recycling and the phantom-stamp problem (§1.2) are entirely artifacts of
DISPATCH being a fixed-size, reused-row physical sheet — a real database with
row-per-trip and no fixed capacity eliminates that whole bug class, so this is
one clean simplification a rebuild gets for free.

```sql
-- ── trips ──────────────────────────────────────────────────────────────────
CREATE TYPE dispatch_status AS ENUM
  ('READY','NOT CONFIRMED','REASSIGN','UPDATE TIME','COMPLETE','CANCEL','NO SHOW');
CREATE TYPE driver_status AS ENUM
  ('PICKUP LOCATION','INTRANSIT','DROPOFF LOCATION','COMPLETE','IN ROUTE');

CREATE TABLE trips (
  trip_key_id       uuid PRIMARY KEY,                 -- was tripKeyID (SHA-256 hex historically, UUID going forward — normalize both to uuid or keep as text if legacy hex hashes must be preserved verbatim)
  legacy_id         text,                             -- old composite "driver|date|time|passenger|pickup" string, kept only for historical dedup/audit, NOT a real key
  trip_date         date NOT NULL,
  start_time        time,                             -- NULL = genuinely blank; NEVER store the 23:58 sentinel
  scheduled_time    time,                             -- the "time" field; consider a boolean has_scheduled_time instead of overloading NULL vs 23:58
  passenger_id      bigint NOT NULL REFERENCES passengers(id),
  passenger_name_raw text NOT NULL,                   -- free text as typed, for audit even after a passenger record is edited/merged
  transport         text,                             -- free text; keep a separate transport_key derived column/enum for pricing (ambulatory/wheelchair/stretcher/taxi/other)
  phone             text,
  medicaid_number   text,
  invoice_number    text,
  pickup_address    text,
  dropoff_address   text,
  vehicle_label     text,                             -- free text; no vehicles table existed in the source (see §3.4 gap)
  driver_name_raw   text,                             -- free text; resolve to driver_id via the fuzzy-matcher at write time, keep raw for audit
  driver_id         bigint REFERENCES drivers(id),
  dispatch_status   dispatch_status NOT NULL DEFAULT '',   -- Postgres enums can't have '', use a nullable enum instead: dispatch_status driver_status NULL
  status            driver_status,                    -- NULL = driver hasn't started
  status_at         timestamptz,
  pickup_arrival_at    timestamptz,
  pickup_departure_at  timestamptz,
  dropoff_arrival_at   timestamptz,
  dropoff_departure_at timestamptz,
  notes             text,
  pickup_notes      text,
  dropoff_notes     text,
  return_of         uuid REFERENCES trips(trip_key_id),   -- self-FK, nullable
  recurring_id      uuid REFERENCES standing_orders(id),  -- see below: recurring_id in the source is a *trip* key; here it should point at the standing_orders row instead
  private_pay       boolean NOT NULL DEFAULT false,
  miles_override    numeric(6,1),
  deadhead_miles     numeric(6,1),
  price             numeric(10,2),                    -- NULL = unpriced/incomplete, distinct from 0.00 = priced at zero
  pricing_snapshot  jsonb,                             -- the {pickup,dropoff,total,lines,...} object, §5.6, verbatim
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON trips (trip_date, scheduled_time);
CREATE INDEX ON trips (passenger_id, trip_date);
CREATE INDEX ON trips (driver_id, trip_date);
CREATE INDEX ON trips (recurring_id);

-- ── passengers ─────────────────────────────────────────────────────────────
CREATE TABLE passengers (
  id                bigserial PRIMARY KEY,
  lookup_key        text NOT NULL UNIQUE,             -- passengerCacheKey_ normalization
  display_name      text NOT NULL,
  medicaid_number   text,
  transport_type    text,                             -- Taxi/Ambulatory/Wheelchair/Stretcher free text
  phones            text[] NOT NULL DEFAULT '{}',
  addresses         text[] NOT NULL DEFAULT '{}',
  blacklisted       boolean NOT NULL DEFAULT false,
  blacklist_reason  text CHECK (NOT blacklisted OR length(blacklist_reason) >= 3),
  blacklisted_by    text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,                      -- soft-delete, replaces the separate trash sheet
  deleted_by        text
);

-- ── drivers (from STAFF) ───────────────────────────────────────────────────
CREATE TABLE drivers (
  id      bigserial PRIMARY KEY,
  name    text NOT NULL,
  phone   text,
  email   citext UNIQUE,                              -- sign-in identity; nullable, but a driver with no email can't be sent a sign-in code — flag this at the app layer
  carrier text                                         -- SMS gateway carrier
);
-- Fuzzy short-name matching (driverShortFormOf_/driverUniqueShortForm_) does not
-- map to a SQL constraint — keep it as an application-layer resolver that writes
-- driver_id once resolved, never as a foreign key lookup done by name at query time.

-- ── vehicles — GAP, no source data model found (§3.4) ─────────────────────
CREATE TABLE vehicles (
  id    bigserial PRIMARY KEY,
  label text NOT NULL UNIQUE
);
-- Confirm against the real formOptions-building source before adding more
-- columns; nothing in the six files proves vehicles carry more than a label.

-- ── standing_orders ────────────────────────────────────────────────────────
CREATE TABLE standing_orders (
  id                 uuid PRIMARY KEY,                -- was recurringId == the anchor trip's own tripKeyID; consider decoupling to a real surrogate key
  title              text NOT NULL CHECK (length(title) <= 60),
  pattern_start      date NOT NULL,
  pattern_end        date NOT NULL CHECK (pattern_end >= pattern_start
                        AND pattern_end - pattern_start <= 183),
  pattern_days       int[] NOT NULL,                  -- 0=Sunday .. 6=Saturday, replaces the "SUN,MON,..." string
  with_return_trip   boolean NOT NULL DEFAULT false,
  return_time        time,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ── standing_order_jobs (background generation/deletion queue) ────────────
CREATE TABLE standing_order_jobs (
  id                 uuid PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN ('create','delete')),
  standing_order_id  uuid REFERENCES standing_orders(id),
  parent_trip_key_id uuid,
  dates              date[] NOT NULL,
  requested_dates    date[],                          -- 'delete' jobs only: the full original request, to know when it's safe to drop the pattern
  total              int NOT NULL,
  done               int NOT NULL DEFAULT 0,
  tries              int NOT NULL DEFAULT 0,
  extras             jsonb,                            -- SO_EXTRA_FIELDS_ payload
  no_trigger_error   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Trivially replaced by a real job/queue table + a proper worker (e.g. a
-- Postgres-backed queue or an external one) — the whole "trigger might fail to
-- register, poll from the page as a fallback" design exists only because Apps
-- Script triggers are unreliable; a real backend does not need that fallback.

-- ── pending_trips ("Needs Scheduling") ─────────────────────────────────────
CREATE TABLE pending_trips (
  id              uuid PRIMARY KEY,
  passenger       text NOT NULL,
  phone           text,
  medicaid_number text,
  invoice_number  text,
  transport       text,
  pickup_address  text,
  dropoff_address text,
  vehicle_label   text,
  notes           text,
  pickup_notes    text,
  dropoff_notes   text,
  target_date     date,
  target_time     time,
  needed_by       date,
  return_wanted   boolean NOT NULL DEFAULT false,
  last_chased_at  timestamptz,
  last_chased_by  text,
  created_at      timestamptz NOT NULL,
  created_by      text,
  updated_at      timestamptz NOT NULL
);
-- Enforce the 500-row cap (PENDING_TRIPS_MAX_) at the application layer, or a
-- trigger — it was a spreadsheet-row-count limit, not a meaningful business rule.

-- ── pricing_config (single row / operator-wide) ────────────────────────────
CREATE TABLE pricing_config (
  version           int PRIMARY KEY,
  base_fares        jsonb NOT NULL,       -- {ambulatory, wheelchair, stretcher, taxi, other}
  mileage           jsonb NOT NULL,       -- {mode, includedMiles, perMile, minimumFare}
  deadhead          jsonb NOT NULL,       -- {mode, includedMiles, perMile}
  wait              jsonb NOT NULL,       -- {mode, graceMin, intervalMin, rate}
  after_hours_from  time NOT NULL,
  after_hours_to    time NOT NULL,
  holidays          date[] NOT NULL DEFAULT '{}',
  rules             jsonb NOT NULL,       -- { ruleKey: {mode, kind, amount}, ... } for all 24 keys
  updated_at        timestamptz,
  updated_by        text
);
-- The 24 rule keys/labels/groups/auto-flags themselves (PRICING_RULES_) are
-- effectively static application metadata, not data — a lookup table is
-- reasonable, but they are not something an operator adds to; keep them as a
-- versioned seed/migration, not a freely-editable table, unless "add a custom
-- pricing rule" becomes an actual product requirement.

-- ── trip_times / stop_times (analytics rollups) ────────────────────────────
-- TRIP_TIMES_HEADERS_ and STOP_TIMES_HEADERS_ are both derived/cache tables in
-- the source (rebuildable from trips at any time). Model them as materialized
-- views over `trips`, not as independently-writable tables:
--   trip_times  ~= SELECT ... arrival/departure gaps ... FROM trips
--   stop_times  ~= median dwell time per (scope, which, key) over a rolling
--                  120-day window, min 5 samples (10 for the all-drivers case)
```

### Things that do **not** map cleanly

1. **`COLUMN.*` itself is missing.** The single biggest open item before
   writing real migration scripts: get `AmazingGraceTransport_constant.js`
   and confirm every DISPATCH letter in §1.1, especially F/G/H/S/T/V/W/X
   (confirmed to be *some kind* of computed lookup, identity unknown) and the
   stale-comment contradictions (§1.1's final paragraph).
2. **DISPATCH vs LOG duality** (§0.1) has no natural single-table Postgres
   analogue — a real database doesn't need two competing physical
   representations of the same trip, so this is a simplification, not a
   mapping problem, but it does mean **there is no source "DISPATCH schema"
   to faithfully preserve** — only LOG's fuller shape is worth preserving.
3. **Driver/vehicle as free text, not foreign keys.** The source system never
   enforces referential integrity on `driver`/`vehicle` — they're
   autocomplete-suggested strings, reconciled to a real staff member only by
   the fuzzy `driverShortFormOf_` matcher at read time, and only for
   texting/email purposes, not for data integrity. A rebuild has to decide
   whether to (a) keep this looseness (nullable `driver_name_raw` +
   best-effort `driver_id`) for compatibility with messy historical data, or
   (b) make the FK mandatory going forward and treat unmatched names as a
   data-quality queue — recommend (a) for import, (b) for new writes.
4. **`recurringId` is a trip key, not an order key.** In the source, a
   standing order has no independent identity — it's identified by "whichever
   trip happened to be generated first." A rebuild should mint a real
   `standing_orders.id` and treat the source `recurringId` purely as an
   import-time join key, never as the ongoing identity.
5. **`pricing` snapshot is a point-in-time cache of a pure function's output**,
   not authoritative data — it can be fully recomputed from `trips` +
   `pricing_config` (as of the `configVersion` it recorded) at any time.
   Store it (for audit/history and the `staleQuote` fallback behavior) but
   never treat it as something a migration needs to get "right" independent
   of the trip row it came from.
6. **Vehicles table has no confirmed field list** beyond a label (§3.4) — a
   real gap in the provided source, not a translation difficulty.
7. **The 1899 date-stamp convention and the `23:58` sentinels** (§9.2, §9.3)
   should **not** be reproduced in Postgres at all — they're artifacts of
   Google Sheets' cell-typing model. Use real nullable `date`/`time` columns
   and a boolean or NULL to mean "not set"; the ETL from the legacy sheets is
   exactly where `isBlankStartTime_`'s three-pattern detection needs to be
   run once, on import, so the sentinel never has to be re-implemented in the
   new system.
8. **STAFF sheet columns B, C, F..AS** (everything except name/phone/email/
   carrier) are unread by any of the six files — they may hold real driver
   data (license number, hire date, etc.) that this extraction cannot see or
   document. Inspect the actual STAFF sheet before finalizing a `drivers`
   table.
