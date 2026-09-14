# Amazing Grace Mobile Transport — Rest-of-Project Reference

Covers the 31 previously-undocumented files in `legacy-31/`. The six main
application files (`TripsPage.html`, `TripManager.gs`, `Helpers.gs`,
`SideBarSnapShots.gs`, `DriverApp.gs`, `DriverAppPage.html`) are documented
elsewhere and are **not** re-described here, but many functions below call
into them (e.g. `tripManager`, `dataFromSheet`, `fixDispatch`,
`activeSpreadsheet_`) — those symbols are undefined in this folder and are
assumed to live in the main files.

Legend used throughout:
- **LIVE** — something in this corpus (menu, trigger, HTML `google.script.run`, another function) calls it.
- **DEAD** — no caller found anywhere in this corpus or the main-file symbol list implied by naming; also used for callers only found for a broken/mistyped name.
- **TEST** — a `TEST_*`/assertion helper, only run manually or via a test suite runner.
- **PORT** — real business logic a rebuild must reimplement.
- **REPLACE** — a real feature that must exist in the new system but needs a new implementation (not a Sheets-specific mechanism).
- **DROP** — spreadsheet/Google-Workspace housekeeping with no equivalent in a rebuilt system (protections, sheet formulas, column hide/show, etc).

---

## 1. AmazingGraceTransport_constant.gs (124 lines)

**Purpose:** Central constants file — spreadsheet IDs, the production API URL, and the authoritative `COLUMN` index map used by every other file to read/write DISPATCH and LOG rows.

### Top-level constants

| Name | Value | Notes |
|---|---|---|
| `driversSheetID` | `13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA` | The "Drivers App" spreadsheet (separate file from the dispatcher spreadsheet this script is bound to). Referenced throughout as the driver-facing workbook. |
| `dispatchSheetID` | `1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME` | The dispatcher spreadsheet itself (containing DISPATCH/LOG/PASSENGERS tabs). |
| `prodUrl` | `https://us-central1-agmtlambdaapi.cloudfunctions.net/trips` | External Google Cloud Function endpoint — see §Calls_To_Lambdas below. |
| `driversDataLinkedRangeHeight` | `230` | Row height used inside the DISPATCH lookup formulas that reference `'drivers data linked'!...`. |

### `COLUMN.LOG` (complete, columns are 0-indexed, A=0)

```
DATE:          0   // A
START_TIME:    1   // B
TIME:          2   // C
PASSENGER:     3   // D
TODAY:         4   // E  (status keyword / override column)
TRANSPORT:     5   // F
PHONE:         6   // G
MEDICAID:      7   // H
INVOICE:       8   // I
PICKUP:        9   // J
TRIP_KEY_ID:  10   // K
IN:           11   // L
DROPOFF:      12   // M
(13 unused)
OUT:          14   // O
(15 unused)
STATUS:       16   // Q
VEHICLE:      17   // R
(18, 19 unused)
DRIVER:       20   // U
(21, 22 unused)
ID:           23   // X
NOTES:        24   // Y
PICKUP_IN_AT: 25   // Z
ARRIVED_AT:   26   // AA
INTRANSIT_AT: 27   // AB
COMPLETED_AT: 28   // AC
(29 unused)
RETURN_OF:    30   // AE
RECURRING_ID: 31   // AF (no letter comment in source)
STATUS_AT:    32   // AG
```

### `COLUMN.DISPATCH` — byte-for-byte identical map to `COLUMN.LOG`

```
DATE: 0, START_TIME: 1, TIME: 2, PASSENGER: 3, TODAY: 4, TRANSPORT: 5,
PHONE: 6, MEDICAID: 7, INVOICE: 8, PICKUP: 9, TRIP_KEY_ID: 10, IN: 11,
DROPOFF: 12, OUT: 14, PICKUP_IN_AT: 25, ARRIVED_AT: 26, INTRANSIT_AT: 27,
COMPLETED_AT: 28, STATUS: 16, VEHICLE: 17, DRIVER: 20, ID: 23, NOTES: 24,
RETURN_OF: 30, RECURRING_ID: 31, STATUS_AT: 32
```
(Since LOG and DISPATCH share exactly the same column layout, LOG rows are effectively "the same row shape as DISPATCH," which is what lets `serializeTripMap`/`dispatchRowToTripObject`-style code reuse one column map for both sheets. A rebuild's DB row/record shape should use this same field list.)

### `dispatchSheetFormulas` / `dispatchSheetFormulasB`

Two near-identical maps of A1-range → formula string, used to (re)install the DISPATCH sheet's live lookup formulas. **Not referenced anywhere in this 31-file corpus** — almost certainly consumed by `fixDispatch()`/`fixDrivers()` in the main `Helpers.gs` (menu items "Fix Dispatch / Drivers App" and "Fix Drivers App" call those names, which aren't defined here). They encode:
- `L2:L100`, `O2:O100`: driver clock-in/out lookup against a `'drivers data linked'` sheet (`INDEX/MATCH` keyed on column X, the composite legacy ID).
  - **Difference between the A and B versions:** version A's `L2:L100` formula matches header `$L$1` (i.e. looks up the "L" column's own header value), while version B's `L2:L100` formula matches header `$O$1` instead — i.e. version B makes L and O resolve the *same* looked-up value. This looks like a bug-fix variant (B) kept alongside the original (A); it's unclear from this corpus which one is actually installed, so this is a real ambiguity for the rebuild to resolve with the sheet owner.
- `F2:F100`, `G2:G100`, `H2:H100`: `VLOOKUP` against `PASSENGERS!$B$2:$E` for passenger type/phone/medicaid (matches `CRUD.gs`'s `PASSENGERS` sheet layout: B=name, C=medicaid, D=type, E=phone).
- `Q2:Q100`: derives the live STATUS column — if `TODAY` (E) is `REASSIGN`/`COMPLETE`/`CANCEL` use that literal, else pull the driver's current status from `'drivers data linked'`.
- `S2:S100`, `T2:T100`: `VLOOKUP` against a `vehicles` sheet.
- `V2:V100`, `W2:W100`: `VLOOKUP` against a `drivers` sheet.
- `X2:X100`: builds the composite legacy trip key `DRIVER|DATE|TIME|PASSENGER|PICKUP` (pipe-joined) — this is the same shape `id` field the HTML forms build client-side (see AddTripPage.html).

**PORT** (as documented reference data — a rebuild replaces the spreadsheet formulas with real joins/queries, but must reproduce the same derivation rules): passenger type/phone/medicaid from a passenger record, vehicle plate/type from a vehicle record, driver info from a driver record, and the composite legacy ID format.

### `ssIds`, `dataSheetDefault`, `fullPgProps`

- `ssIds = { Dispatcher: dispatchSheetID, Driver: driversSheetID }` — used as the default id map for `AmazingGraceTransportSpreadsheetService`.
- `dataSheetDefault` — a default-options object (`cellRange:'A1:Y100'`, etc.) for an unseen `dataFromSheet()` helper (defined in the main files); not otherwise used in this corpus except via `fullPgProps`.
- `fullPgProps.dispatch` — `{cellRange:'A1:Y100', sheetName:"DISPATCH"}`, used once by `getVehicalDriversData()` in `Calls_To_Lambdas.gs`.

**PORT**: sheet/spreadsheet IDs need to become config values (env vars / DB refs) in the rebuild, not hardcoded Sheet IDs.

---

## 2. Calls_To_Lambdas.gs (47 lines) — external HTTP dependency

**Purpose:** The one place in this corpus that calls an outside HTTP service — a Google Cloud Function endpoint — with dispatch row data.

### Functions

- **`getVehicalDriversData()`** — Debug/dead. Calls `dataFromSheet(fullPgProps.dispatch)` (function from the main files) and `console.log`s the result. Has commented-out driver/vehicle loading and an unused `uniqueBy` idea. **DEAD** (no caller in this corpus; looks like a REPL scratch function left in the project).
- **`getPassengersData()`** — Debug/**broken**. Calls `dataFromSheet({cellRange:'E1:E6000', sheetName:"ADD PASSENGERS", list:['rowNum'], isFormatted:false})` and then does `console.log({uniqAddresses})` — but `uniqAddresses` is only declared in a **commented-out** line above it (`// const uniqAddresses = uniqBy(addresses, 'Address')`). Calling this function throws `ReferenceError: uniqAddresses is not defined`. It also targets the sheet `"ADD PASSENGERS"`, which `CRUD.gs`'s migration functions (`migrateToPassengersSheet`/`repairPassengersFromBackup`) delete once the passenger cache has been migrated to the new `PASSENGERS` sheet — so this function is doubly stale. **DEAD/BROKEN.**
- **`async function updateTripsFirestoreDb(e)`** — The real integration. Shaped like an `onEdit(e)` handler: reads `e.range.rowStart` and `e.source.getActiveSheet().getName()`. If the edited sheet is `"DISPATCH"`, it re-reads that single row (`A{row}:Y{row}`) via `rowFromSheet(...)` (main-file helper, not defined here) with an explicit field list `['Tomorrow','Phone','SIG','id','Chat','LICENSE PLATE','Vehicle Type','DRIVER LICENSE']`, then does:
  ```js
  UrlFetchApp.fetch(prodUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({...trips[0], rowStart})
  })
  ```
  i.e. **POSTs the full dispatch row (as an object) plus its row number to `https://us-central1-agmtlambdaapi.cloudfunctions.net/trips`** every time a DISPATCH row is edited. The name of the endpoint (`agmtlambdaapi`) and the field list (mixing DISPATCH columns with what look like driver-app-only fields — Tomorrow/SIG/Chat/LICENSE PLATE/DRIVER LICENSE) suggest this feeds a separate backend (Firestore, per the function name) that something else (maybe a mobile app or the "Time Sheet" web dashboard linked from the menu, `https://time-stamp-agmt.vercel.app`) reads from.
  - **No caller of `updateTripsFirestoreDb` is visible in this corpus** (only its own definition) — it is written in the shape of an onEdit trigger handler but nothing here wires it up. It is either (a) invoked from the main-file onEdit dispatcher (likely, given the pattern used by `TRIP_ID(e)`, `passengerReady(e)`, `checkDispatchForUpdates(e)`, `addressValidation(e)` — see below), or (b) genuinely dead code left mid-integration. **Flag as LIVE-probable / verify.**

**REPLACE**: this is the single clearest "outside dependency nobody else documented" — a live Cloud Function at `us-central1-agmtlambdaapi.cloudfunctions.net/trips` that receives a POST of the edited dispatch row shape on every edit. A rebuild needs to either keep pushing to this endpoint (if something downstream still depends on it) or formally retire it after confirming nothing consumes it anymore.

---

## 3. GoogleMaps.gs (96 lines) — distance/duration lookups

**Purpose:** Distance/time calculations using the legacy Google Apps Script **Maps Service** (`Maps.newDirectionFinder()` — an Advanced Google Service backed by the (deprecated for new projects) Google Maps Directions API bundled into Apps Script), plus a bulk "fill in the mileage column" batch job.

### Functions

- **`GOOGLEMAPS(start_address, end_address, return_type)`** — a **custom spreadsheet function** (`@customfunction` — usable as `=GOOGLEMAPS(...)` directly in a cell). Builds a `Maps.newDirectionFinder()` route between two address strings and returns:
  - `"miles"` → meters × 0.000621371
  - `"minutes"` → duration(seconds) / 60
  - `"hours"` → duration(seconds) / 3600
  - `"kilometers"` → meters / 1000
  - `"time"` → formats duration as `HH:MM:SS` string
  - anything else → the literal string `"Error: Wrong Unit Type"`
  - No caching, no error handling around `getDirections()` — if the Maps service can't resolve an address (typo, service quota, transient failure) the function throws and the cell shows `#ERROR!`. This is also used by `Email_Employees.gs`'s `addBeginTime()` (see below) to estimate drive time from a fixed base address.
- **`mapIt()`** — Loop over DISPATCH rows 2–100. For each row: reads pickup (`P` column offset −6 → this is actually column **J**, i.e. `PICKUP`), dropoff (offset −3 → column **M**, `DROPOFF`), and status (offset +1 → column **Q**, `STATUS`). If the mileage cell (`P`) is blank and pickup/dropoff are present and status isn't `CANCEL` and the row's date matches today, it writes a **formula** into the cell: `=GOOGLEMAPS("<pickup>","<dropoff>","miles")` formatted to one decimal. If status is `CANCEL`, it just writes `"0.0"` as a literal. Also bumps a `mapItCount` script property that is **written but never read anywhere** (dead telemetry).
  - Wired to the **Assistance → "map it"** menu item in `Code.gs`. **LIVE.**
  - Column P itself is not in the documented `COLUMN.DISPATCH` map (the map jumps from `OUT:14` to `STATUS:16`, so columns 15 (O, unused by name) and this "P" mileage column at index 15 aren't named constants) — this mileage/"miles driven" column is a real, currently-used field with no symbolic name anywhere in the constant map.

**PORT**: the actual distance/duration business rule (skip CANCELed trips, only fill same-day rows, compute miles from pickup/dropoff addresses) — a rebuild should replace the Maps Advanced Service with a real Google Maps Distance Matrix/Directions API call (with actual error handling and caching, which this code has none of) but preserve the same decision logic. **DROP** the literal "write a spreadsheet formula into a cell" mechanic — that's Sheets-specific; a rebuild computes and stores a numeric value directly.

---

## 4. TextDrivers.gs (150 lines) — the SMS path

**Purpose:** Sends "text messages" to drivers by emailing their phone's SMS-to-email gateway address, triggered by specific edits to the DISPATCH sheet.

### Functions

- **`sendSmsToStaff(driverName, {passenger, tripTime, notes, dispatchStatus})`** — Opens a **separate spreadsheet** (`1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE`, the "Staff" workbook — same one used for driver/vehicle option lists) and its `"STAFF"` tab. Scans rows for a name match in column A, reads phone from column **D** (index 3) and cell-carrier from column **AT** (index 45). Builds the SMS gateway address via `getSmsEmail`, and if found, calls `SpreadsheetApp.getActiveSpreadsheet().toast(...)` (a UI toast — only visible if a human has the dispatcher sheet open) and then:
  ```js
  MailApp.sendEmail({ to: smsEmail, subject: "", body: message });
  ```
  The message body sent as a "text":
  ```
  AMAZING GRACE ALERT !!! 
  PLEASE Check DRIVERS APP:

  Time: <tripTime>
  Name: <passenger>
  Status: <dispatchStatus> 
  Notes: <notes>
  ```
  Errors per-row are caught and logged, not surfaced.
- **`getSmsEmail(phone, carrier)`** — Strips phone to digits (rejects if <10 digits) and looks up a **carrier-name → SMS gateway domain** table (the classic "email-to-SMS" trick):
  ```
  verizon      → vtext.com
  att          → txt.att.net
  t-mobile     → tmomail.net
  tmobile      → tmomail.net
  optimum      → tmomail.net      (note: routed through T-Mobile's gateway)
  sprint       → messaging.sprintpcs.com
  boost        → myboostmobile.com
  cricket      → sms.mycricket.com
  uscellular   → email.uscc.net
  googlefi     → msg.fi.google.com
  metropcs     → mymetropcs.com
  ```
  Returns `null` (no send) if the carrier isn't in this list or the phone is too short. **This whole mechanism is fragile by nature**: it depends on (a) the STAFF sheet's carrier column being kept accurate per driver, (b) the gateway domains staying valid (carriers frequently retire/throttle these), and (c) `MailApp`/`GmailApp` not being rate-limited or spam-filtered by the carrier. There is no delivery confirmation.
- **`checkDispatchForUpdates(e)`** — The trigger-shaped entry point (`e.range`, presumably an installable `onEdit`). Guards: only sheet `"DISPATCH"`, only rows 2–100, only columns **E (5)** or **Y (25)**. Reads the edited row's A:Y values. Requires date, driver name, and time to be present, and requires the row's date to equal *today*. Then computes the driver's active time window across the whole DISPATCH sheet (`getDriverTimeRange`) and requires "now" to fall inside it. Then:
  - **Column E edit** (the `TODAY`/status-keyword column): if the new value (uppercased) is `CANCEL`, `UPDATE TIME`, or `READY`, sends the SMS.
  - **Column Y edit** (`NOTES`): compares against a script-property-cached previous value (keyed `dispatch_row<row>_colY`) and, if changed, sends the SMS and updates the cached value. (This is how "any note change" gets texted to the driver, regardless of content.)
- **`getDriverTimeRange(driverName, data)`** — Given the DISPATCH `C2:U100` block, filters to rows where column U (index 18, `DRIVER`) matches and takes column C (index 0 of the slice, `TIME`) as each trip's time-of-day. Returns a window from **2 hours before the driver's earliest trip** to **30 minutes after the driver's latest trip** — SMS's only fire inside that window (this is presumably to avoid texting a driver about a schedule change once their shift has clearly ended).
- **`parseTimeToDateObj(timeInput)`** — normalizes any time-like value onto *today's* date (keeps hours/minutes, zeroes seconds), so time-of-day comparisons in `getDriverTimeRange` are apples-to-apples regardless of the underlying cell's stored date.

**LIVE**: `checkDispatchForUpdates` is written exactly like `TRIP_ID`, `passengerReady`, `addressValidation` — an onEdit-triggered handler — and is almost certainly invoked from a central `onEdit(e)` dispatcher in the (undocumented-here) main files, alongside those others. No caller is visible in this 31-file corpus, but the shape strongly implies it's wired.

**REPLACE**: the SMS-via-email-gateway hack must become a real SMS provider (Twilio, etc.) in a rebuild — carrier-gateway addresses are unreliable and getting more so as carriers block them. **PORT** exactly: which edits trigger a text (E→CANCEL/UPDATE TIME/READY, any Y/notes change), the "today + inside active shift window" guard, and the message content/fields.

---

## 5. Email_Employees.gs (398 lines) — "Send Start Times" feature

**Purpose:** Dispatcher-facing tool to email or text each driver their next start time, assigned vehicle, and first trip of the day, plus a picker UI to do it in bulk for one date.

### Functions

- **`findEmail(selectedDriver, selectedDate)`** — Looks up the driver's row in the `"drivers"` sheet (on the *active* — dispatcher — spreadsheet, not the Staff workbook) across `A1:F40`, matching column A (name) and reading column F (index 5) as the "email" value. Returns an error object `{error:"Please Choose A Date. Then Select Driver"}` if either selector is still on its placeholder value. Determines `isEmail` from whether the stored contact value's first 9 characters are non-numeric (`isNaN(email.slice(0,9))`) — i.e. **if it parses as a phone number it's treated as SMS, else as email**; this is the same "contact field doubles as phone-or-email" pattern used elsewhere in the project. Delegates to `driversData(...)`.
- **`driversData(name, email, selectedDate, isEmail)`** — Reads DISPATCH `A2:AC96` (`getRange(2,1,95,29)`). Also opens the **Drivers workbook** (`13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA`) and reads a `"Schedule Links"` sheet, `G2:H10` (7 rows × 2 cols) mapping driver name → a personal schedule link URL. For the first (`instance===0`) non-cancelled row matching the driver on the selected date, it builds a trip-detail object: `{name, day, start, car, trip, email, link}` where:
  - `car` = DISPATCH column **R** (index 17, `VEHICLE`)
  - `trip` = `"1) From: <pickup> || To: <dropoff>"` (columns J/M)
  - `start` = **DISPATCH column AC** sliced `[16:21]` — i.e. it reads the **`COMPLETED_AT`** timestamp column (index 28) as the "start time" string?! This looks like a leftover/likely bug: `COMPLETED_AT` should hold a completion timestamp, not a scheduled start time, yet this is what's emailed to drivers as "you're scheduled to work at ___". (There's also an unused local `colStartTime` computed from column B/`START_TIME` that is calculated but never actually used in the output — the real "start" field comes from column AC instead.) **This is a real, currently-shipping bug worth flagging to the business owner before porting.**
  - Then calls **`conisole.log({...})`** — a **typo for `console.log`**. Since `conisole` is not defined anywhere, **this throws `ReferenceError: conisole is not defined` every single time a matching trip is found**, aborting the function before it reaches `tripDetails.push(...)` and `sendEmail(...)`. In other words: **the "Send Start Times" feature is currently broken for any driver/date combination where a trip actually matches** (it only "succeeds" silently when nothing matches, in which case `tripDetails` stays empty and the subsequent `tripDetails[0].start` access throws a *different* error, "Cannot read properties of undefined"). Either way, this feature does not currently work end-to-end. **Flag as a live, reproducible bug.**
- **`sendEmail(email, obj, isEmail)`** — If `isEmail`, sends a styled HTML email via `GmailApp.sendEmail` titled `"Amazing Grace Mobile Transport: [Your New Start Time]"` with the driver's name/day/start time/vehicle/first-trip details and a link to their full schedule. If not `isEmail` (phone number), sends a plain-text version via `MailApp.sendEmail` (note: **straight to the phone number as an email address**, not through the carrier-gateway trick used in `TextDrivers.gs` — this looks like a second, inconsistent SMS mechanism, and would fail silently/bounce since a bare phone number is not a valid email address unless the "drivers" sheet's contact field is actually already a full gateway address).
- **`selectedEmployee()`** — Sorts DISPATCH (`sortDispatchTabA_Z()`), then shows `myHtml.html` as a modal dialog (450×250, iframe-sandboxed) titled "Email/SMS Start Times". Wired to menu item **"SEND START TIMES."** **LIVE.**
- **`chosenDate(selectedDate)`** — Given a date, scans DISPATCH `A2:U100`, collects unique driver names with a trip on that date, returns them (used by `myHtml.html`'s `dateList()` handler to populate the driver dropdown once a date is chosen).
- **`selectDate()`** — Sorts DISPATCH, then shows `CreateStartTime.html` modal (450×250) titled "Create Start Times". Wired to menu item **"START TIMES."** **LIVE.**
- **`addBeginTime(dateSelectedByUser)`** — For every non-cancelled/non-reassigned trip on the given date, computes each driver's **first** trip and works backward: `mintues = GOOGLEMAPS(baseLocation, pickupLocation, "minutes")` from a hardcoded base address `"216 Church St Poughkeepise NY 12601"` (note the misspelling of "Poughkeepsie" baked into a literal used for every drive-time calculation), subtracts that many minutes from the trip's scheduled time, and writes the result into DISPATCH column **B** (`START_TIME`) for that driver's row, formatted `h:mm AM/PM`. Returns the array of `{name, row, date}` per unique driver — this return value is what `CreateStartTime.html`'s `addBeginTimeObjReturned()` then loops over to call `findEmail`/send messages. **This is the actual "how do drivers get told when to leave the garage" business rule**: dispatch time = trip time − drive time from the shop to first pickup. **PORT** exactly, including the "first non-cancelled trip per driver, per date" selection and the drive-time-from-base-location subtraction.
- **`getUni()`** — Debug-only variant of the "unique drivers on DISPATCH" idea; only logs, doesn't return usably. **DEAD** (no caller).
- **`findWithAttr(array, attr, value)`** — Generic linear-search-by-property helper (returns index or −1). Used by `addBeginTime`'s de-duplication.
- **`addZero(i)`**, **`convertTime(time)`** — Zero-pad and format a `Date` as `HH:MM:SS`. Used by `addBeginTime`.
- **`subtractTime(time, mintues)`** — Computes `h:m:s` by subtracting a **Date's minute-of-hour** (not actual elapsed minutes!) from `time`'s minutes, using `Math.abs`. This function is **not called anywhere in this corpus** — **DEAD**, and also almost certainly broken (subtracting `new Date(mintues).getMinutes()` — the minute component of a raw minutes-count reinterpreted as a timestamp — is not equivalent to subtracting a duration).
- **`retrieveMonth(month)`** — 0-indexed month number → 3-letter English abbreviation. Only used inside other **commented-out** code in this same file — **DEAD**.

**PORT**: the whole "compute each driver's leave-time by subtracting drive-time-from-base from their first trip's time, then email/text them their day" workflow, and the "contact value doubles as phone-or-email, decided by whether the first 9 chars parse as a number" convention — but fix the `conisole.log` bug and re-derive "start time" from the correct scheduled-time column instead of `COMPLETED_AT` before porting the business rule forward.

---

## 6. CRUD.gs (483 lines) — passenger cache + reference data

**Purpose:** The "PASSENGERS" sheet is the canonical passenger address book (superseding an older `"ADD PASSENGERS"` tab); this file is its full CRUD layer plus the vehicle/driver option lookups used to populate dropdowns, plus a request-scoped cache of that whole bundle.

### Passenger sheet shape

`PASSENGERS_SHEET_NAME_ = 'PASSENGERS'`, header row (`PASSENGERS_HEADERS_`, 11 columns):
```
key, Passenger Name, Medicaid #, Type, Primary Phone, All Phones, Addresses,
Blacklisted, Blacklist Reason, Updated, Flagged By
```
- `key` (col A, hidden) = normalized lowercase/trimmed/whitespace-collapsed passenger name — the join key used everywhere (`passengerCacheKey_`).
- `All Phones` / `Addresses` are **newline-separated lists in a single cell** (`splitLines_`/`.join('\n')`) — i.e. one passenger can have multiple phones/addresses, and the *first* line is treated as "primary."
- `Blacklisted` is a real checkbox (data-validated) column; `Blacklist Reason`/`Updated`/`Flagged By` audit who blacklisted them and why.

### Functions

- **`passengersSheet_()`** — Gets the `PASSENGERS` sheet or throws (with a hint to run `migrateToPassengersSheet()`). **`passengerCacheSheet_()`** and **`ensurePassengerCache_()`** are trivial legacy aliases kept only for backward compatibility with old call sites.
- **`passengerCacheKey_(value)`** (and duplicate `normalizePassengerCacheKey_` in `Data_Validation_Filter.gs`) — `String(value||'').trim().replace(/\s+/g,' ').toLowerCase()`. **This exact normalization rule is the passenger-matching business rule** and must be reproduced exactly in a rebuild (case/whitespace-insensitive name matching).
- **`parsePassengerList_`**, **`splitLines_`** — small parsing helpers (JSON-array-or-empty; newline-split-trim-filter).
- **`markPassengerCacheDirty_()`** → calls `invalidateFormOptionsCache_()`. Called whenever the `PASSENGERS` sheet's profile columns (≤ column I) are edited (from `addressValidation(e)` in `Data_Validation_Filter.gs`).
- **`getPassengerCacheLookup_()`** — Reads the whole `PASSENGERS` sheet (as **display values**, i.e. exactly what's shown in the cell) into a `Map<normalizedKey, record>` where `record = {displayName, medicaid, type, primaryPhone, phones[], addresses[], blacklisted, blacklistReason, blacklistedBy}`. This is the single source of truth every other lookup builds on. **No caching at this layer** — every call re-reads the whole sheet (the caching happens one level up, in `getFormOptionsBundle`).
- **`getPassengerAddressesFromCache_(name)`** — Convenience wrapper returning just `.addresses` for a name; used by `Data_Validation_Filter.gs` to populate DISPATCH pickup/dropoff dropdown validation.
- **`getPassengerBlacklistInfo_(name)`** — Returns `{blacklisted, reason, displayName}` for a name, defaulting to not-blacklisted/blank if unknown.
- **`updatePassengerProfile(key, profile)` / `updatePassengerProfileUnlocked_`** — Upserts a passenger row: finds an existing row by exact-match on the normalized key (`createTextFinder(...).matchEntireCell(true)`), or appends a new one. Merges incoming `profile.phones`/`profile.addresses` (deduped via `Set`) with whatever's already there if not provided. Always stamps `Updated` with `new Date()`. Runs inside `withPassengersLock_` (a locking helper not defined in this corpus — presumably `LockService`-based, in the main files) to avoid concurrent-edit races, then calls `sortPassengersSheet_()` (also not defined here) to keep the sheet sorted. Invalidates the form-options cache. **No caller in this corpus** — presumably invoked via `google.script.run` from a passenger-management UI in the main `TripsPage.html`. **PORT** as the canonical "upsert passenger" API for a rebuild.
- **`ensurePassengersHeaders_()`** — Idempotently makes sure the sheet has the 11-column header row (widens the sheet if needed, rewrites the header row only if it's out of date).
- **`currentDispatcherLabel_()`** — `"<email> on <M/d/yyyy h:mm a>"` — tries `Session.getActiveUser()` then `Session.getEffectiveUser()`, falling back to the literal string `"unknown"`. Used to audit *who* flagged a passenger.
- **`setPassengerBlacklist(displayName, flagged, reason)` / `setPassengerBlacklistUnlocked_`** — The blacklist workflow: **requires a non-empty reason when flagging on** (`if (on && !note) throw`), errors if the passenger isn't found on the sheet, and writes columns H–K (`Blacklisted, Blacklist Reason, Updated, Flagged By`) in one call. Clearing the flag (`flagged=false`) blanks the reason/who but still stamps `Updated`. **PORT this exact rule**: a reason is mandatory to blacklist, not to un-blacklist.
- **`getPassengerNames()`** — All display names, sorted. **`getPassengerProfiles()`** — the full profile bundle keyed by display name (phones fall back to `[primaryPhone]` if the multi-phone list is empty), used to seed the Add/Edit Trip forms' passenger autocomplete + auto-fill.
- **`getFormOptionsBundle()` / `FORM_OPTIONS_CACHE_KEY_ = 'trip-form:options:v2'`** — The perf-critical function: builds `{profiles, vehicles, drivers}` from the three functions above, caches it in `CacheService.getDocumentCache()` for **600 seconds**, and if the JSON payload exceeds 90,000 characters, **gzips and base64-encodes it** (`'GZ:' + base64(gzip(json))`) before caching (`CacheService` entries are size-limited, hence the compression fallback). **LIVE** — this is what `SharedLoaders.html`'s `loadTripFormData()` calls when there's no server-side preload, and what `TripRouter.gs` preloads server-side into the Add/Edit Trip sidebar templates.
- **`invalidateFormOptionsCache_()`** — clears that cache key; called on any passenger profile change.
- **`repairPassengersFromBackup()`** — **One-off recovery tool**: re-derives the `PASSENGERS` sheet from a specific hardcoded backup spreadsheet (`1V8CU4KK_ekP7ePS-A5JZkbE5Zrr1HBsOzNDcEhgC-Bg`, tab `"ADD PASSENGERS"`), used presumably after a data-loss incident. Applies the same "must have length ≥3 and contain a comma" filter as the main migration to reject junk rows, re-applies the checkbox validation, column widths, and DISPATCH lookup formulas, and re-points the DISPATCH `D2:D100` passenger-name data validation at the new sheet. **DEAD in normal operation** — manual/administrative, run once, no caller found. **DROP** from a rebuild except as a one-time data-migration script.
- **`migrateToPassengersSheet()`** — The actual **from-scratch migration**: reads the legacy `"ADD PASSENGERS"` tab starting at **row 10** (rows 1–9 were presumably a header/instructions block), aggregates by normalized name (same ≥3-chars-and-contains-a-comma filter — i.e. names are expected in `"Last, First"` form), **backs the old tab up into a brand-new standalone spreadsheet** (`SpreadsheetApp.create(...)`) before deleting anything, deletes the old `"ADD PASSENGERS"` tab and a `"PASSENGER_CACHE"` tab if present, builds the new `PASSENGERS` sheet, and re-points DISPATCH's lookup formulas/data validation. Idempotent-ish: if `"ADD PASSENGERS"` is already gone and `PASSENGERS` exists, it's a no-op success message. **DROP** from a rebuild (its job — one-time data migration — is done); but the **shape it produces** (dedupe-by-normalized-name, first-non-empty-wins for medicaid/type, union of phones/addresses) is exactly `getPassengerCacheLookup_`'s data model and should be preserved as the target schema.
- **`rebuildPassengerCache()`** — Legacy-named alias that now just clears the cache and returns the current lookup size; kept so any old call sites (menu items, other scripts) referencing the old cache-rebuild name still work.

### Vehicles / Drivers reference data

- **`getVehicleOptions()`** — Opens the **Vehicles workbook** (`13ynJ0Q_pn-Ao4fcJTmpSswbAk8MRy-RMpCF3YnIm-Ug`), sheet `"Vehicles"`, reads `B2:K` (columns 2–11). Destructures `[name, nickname, make, plate, type, vin, , , , , vehicleType]` — i.e. it explicitly skips columns 8–11 (relative) and pulls `vehicleType` from the **11th** field in that slice. Builds `{label: "name (nickname)" or "name", value: name, vehicleType, meta:{plate, make, type, vin}}`. Rows without a `name` are skipped.
- **`getDriverOptions()`** — Opens the **Staff workbook** (`1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE`), sheet `"STAFF"`, reads `A2:AT`. Builds `{label, value: name, license, initials, phone, email, carrier}`.
  - **Bug**: `carrier: String(data[0][45] || "").trim()` — this indexes **row 0 of the read block** (the *first* driver row) for every single driver in the loop, instead of `data[i][45]` (that driver's own row). **Every driver option returned by this function reports the same carrier — the first driver's carrier** — regardless of whose record it actually is. `TextDrivers.gs`'s `sendSmsToStaff`, by contrast, correctly reads `data[i][45]` per-row from the same STAFF sheet — so the SMS-sending code path is correct, but this dropdown-data path (whatever in the main UI consumes `.carrier` from `getDriverOptions()`, if anything does) is wrong. **Flag as a real, reproducible bug to fix during the port**, not to carry forward.

**PORT**: the vehicle/driver reference-data shape (label/value/meta) and, for drivers, per-row carrier once the bug above is fixed. **DROP** the "read directly from a linked external Google Sheet by hardcoded ID" mechanism — a rebuild should have real Vehicle/Driver/Passenger tables in its own database instead of live-querying three separate spreadsheets.

---

## 7. Data_Validation_Filter.gs (199 lines) — validation rules and sheet sort/protect helpers

**Purpose:** Keeps DISPATCH's pickup/dropoff dropdowns validated against each passenger's known addresses, audits stale validation setups, and holds the "sort the DISPATCH tab" utilities used everywhere else in the project.

### Every validation rule, exactly as coded

1. **Address-in-list rule** (`buildAddressValidationRule_`): given an address list, dedupe (`Set`) + trim, and if any remain, build `SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build()`. **`setAllowInvalid(true)`** means this is a *suggestion* dropdown, not an enforced constraint — a dispatcher can still type any free-text address; only known addresses show as autocomplete options. If the address list is empty, **no rule is applied at all** (pickup/dropoff become plain free-text cells for that passenger).
2. **Which sheets get this treatment**: `ADDRESS_VALIDATION_SHEETS_ = ['DISPATCH', 'PAGE 2 of DISPATCH']` — note a **second DISPATCH-like tab** (`'PAGE 2 of DISPATCH'`) exists and receives the same treatment; it is not otherwise mentioned or handled anywhere else in this corpus. Its existence/purpose (overflow past row 100? an archive view?) is undocumented and worth asking the business owner about before the rebuild drops it.
3. **`addressValidation(e)`** — the onEdit-shaped handler:
   - If called with **no event** (`e.range` missing — i.e. called manually/programmatically), runs a **migration mode**: calls `rowAddressValidation()` (rebuild every row's validation from scratch) then `auditLegacyListsValidationRefs()` (find rows still pointing at the old `'lists'` sheet) and returns a summary.
   - If the edited sheet is **`PASSENGERS`** and the edit intersects columns 1–9 (the profile columns) and touches row ≥2, calls `markPassengerCacheDirty_()` (invalidates the form-options cache) and returns `false` (no validation work to do on that sheet).
   - If the edited sheet isn't one of `ADDRESS_VALIDATION_SHEETS_`, no-op.
   - Otherwise, if the edit **touches column D (passenger name, col 4)**: for every affected row, **clears** the pickup (col J/10) and dropoff (col M/13) cell's content *and* its data validation, looks up that row's passenger's known addresses via `getPassengerAddressesFromCache_`, and — if any exist — re-applies a fresh `requireValueInList` rule to both cells. **Net effect: changing who the passenger is on a DISPATCH row wipes whatever pickup/dropoff was previously entered and swaps in that new passenger's own address list as suggestions.** This is a real,易-to-miss UX rule to preserve: **PORT.**
4. **`rowAddressValidation()`** — Full rebuild of every row's pickup/dropoff validation rules for both DISPATCH-like sheets, from the current passenger cache, in one batched `setDataValidations` call per column per sheet (fast path for the "no event" migration mode above). Also records a `addressValdCount` script property = `Date.now()` (write-only, never read — dead telemetry, same pattern as `mapItCount`/`toggleCount`) and logs a summary line `ADDRESS_VALIDATION_MIGRATION {...}`.
5. **`auditLegacyListsValidationRefs()`** — Scans every pickup/dropoff-area validation rule (columns J–M) on both sheets; for any rule whose criteria is `VALUE_IN_RANGE` (the *old* range-based validation mechanism, as opposed to the newer `VALUE_IN_LIST`) pointing at a sheet literally named `'lists'`, records its A1 address as an "issue." Logs `LEGACY_LISTS_VALIDATION_REFS {...}` with count + first 20 examples. This is a **cleanup/audit tool for a specific past migration** (moving off a `lists` reference-sheet approach to the cache-driven approach above) — **DROP** from a rebuild (it's about detecting stale Sheets metadata), but its *existence* signals the sheet has been migrated more than once, which the rebuild's data model should account for by not assuming addresses live in any particular "lists" sheet.
6. **`toggleProtection(sheet, range, callback)`** — Generic helper: finds an existing range-protection matching `range`'s A1 notation, remembers its editors/domain-edit setting, **removes** the protection, runs an arbitrary `callback()` (meant for actions, like a sort, that Sheets otherwise blocks on a protected range), then **re-applies** protection to the same range (description `"Auto-reprotected after protected action"`), restoring the remembered editors. **Currently unused** — the only call site (`sortDispatchTabA_Z`) has it commented out. **DEAD** (present but disabled) — **DROP**, this is a Sheets-protection-specific workaround with no equivalent need outside Sheets.
7. **`sortDispatchTabA_Z()`** — Opens the DISPATCH spreadsheet by its hardcoded ID (not "active spreadsheet" — this is a defensive/explicit reference), sorts `A2:AA100` by column 1 (Date) then column 3 (Time), both ascending. **Heavily used** across the project: `Code.gs`'s `clearRows`/`autoClearRows`, `Email_Employees.gs`'s `selectedEmployee`/`selectDate`. **LIVE**, core "keep the board in date/time order" behavior. **PORT** as "sort trips by date then time" — trivial in a real DB (an `ORDER BY`), but the *when it's invoked* (after every clear/bulk operation, before opening the start-times pickers) is the business rule to preserve.
8. **`sortDispatchTabDriver()`** — Same idea sorting `A2:AA` (unbounded) by Date then column 21 (Driver, 1-indexed → col U). **No caller found in this corpus** — **DEAD** here (maybe called from the main files). Represents an alternate "group by driver" view/ordering that a rebuild's UI should offer as a sort option regardless.
9. A large commented-out block (`depDrop_`/an old `onEdit`) for dependent-dropdown data validation — inert, historical, **DROP**.

**REPLACE**: address-suggestion-from-passenger-history should become a real autocomplete against the passenger's stored addresses in the new DB (already effectively true in the AddTripPage/EditTripPage HTML, which do this client-side from `getPassengerProfiles()` — this server-side Sheets validation is the *old*, sheet-native parallel mechanism for people editing DISPATCH directly instead of through the sidebar forms). **PORT** the "changing the passenger clears pickup/dropoff and reloads that passenger's known addresses" rule regardless of which UI enforces it.

---

## 8. RecurringTrips.gs (213 lines) — standing-order engine

**Purpose:** The performance-optimized batch engine for creating/deleting many recurring ("standing order") trip instances at once across the LOG sheet.

### `class StandingOrderManager`

- **constructor(service)** — defaults to the shared `spreadsheetService`.
- **`get logSheet`** — `this.service.getSheet('Dispatcher', 'LOG')`.
- **`createAcrossDatesFast(parentTrip, datesToCreate)`** — Given a `[tripId, fieldsArray]` pair (the "template" trip row, using the `COLUMN.LOG` layout) and an array of target date strings:
  1. Looks up the **standing order definition** for this trip's `RECURRING_ID` from `tripManager.getStandingOrderMap()` (map keyed by recurring-id → `{pattern, withReturnTrip, returnTime}`, itself stored/loaded via `tripManager` in the main files — not defined here).
  2. Reads **only column A** of LOG (dates) once, to build a `date → row index` map — this is the key perf trick: LOG stores **one row per date**, with column B holding a JSON blob of *all* that date's trips (`Map<tripKeyID, tripObject>`, via `serializeTripMap`/`deserializeTripMap`, defined in the main files). So "add a trip to March 5th" means "load March 5th's JSON blob, add an entry, re-save the blob" — not literally appending spreadsheet rows.
  3. For each target date: if that date already has a LOG row, lazily loads (and memoizes) its existing trip map; if not, reserves a **new row at the end of the sheet** for it (tracked in `newRows`).
  4. For each date, generates a **brand-new trip** (fresh `Utilities.getUuid()` for both `id` and `tripKeyID`, template fields copied from the parent, `RECURRING_ID` preserved) via `convertRowToTrip` (main files) and inserts it into that date's in-memory map.
  5. **If the standing order has `withReturnTrip` and a `returnTime`**, also generates a **paired return trip** for the same date: swaps pickup↔dropoff, sets `TIME` to the standing order's `returnTime`, appends `" [RETURN TRIP]"` to notes, and sets `RETURN_OF` to the outbound trip's `id`.
  6. Grows the sheet (`insertRowsAfter`) only as much as needed for genuinely new date-rows.
  7. Writes all touched rows back in **contiguous runs** (batches adjacent row indices into single `setValues` calls) — an explicit perf optimization to minimize the number of Sheets API calls when many new dates land at the bottom of the sheet consecutively.
  8. Calls `invalidateTripsCache_(...)` (main files) for every touched date, so cached reads reflect the new trips immediately.
  9. Updates a **date → row-index index** (`readTripDateRowIndex_`/`writeTripDateRowIndex_`, main files) for the newly-created rows only (existing rows' index entries are untouched, since only brand-new dates change the index).
  10. If a `TRIP_INDEX` sheet is being maintained (`shouldMaintainTripIndexForLog_`), **appends** one row per created trip (`tripKeyID, dateKey, rowIndex, returnOf, id`) to it in one batch call — this is a secondary, denormalized lookup index (trip-key → its row) separate from the date-index, presumably to make single-trip lookups (edit/delete by tripKeyID) fast without scanning every date's JSON blob.
  11. Persists the (possibly newly-created) standing-order-map entry back via `tripManager.updateStandingOrderMap(soMap)`.
  12. Returns the flat array of created trip objects.
  - **Business rules to PORT exactly**: one row per calendar date in the log, trip blobs keyed by `tripKeyID`, optional paired same-day return trip with swapped pickup/dropoff and a `" [RETURN TRIP]"` notes suffix and `returnOf` back-reference, and a secondary trip-key index for fast lookup.
- **`deleteFromDates(recurringId, datesToDelete)`** — For each date, loads its LOG row and JSON blob, removes every trip entry whose `recurringId` matches, and re-saves the blob (only if something actually changed). Invalidates the trips cache for the touched dates. **Note**: unlike `createAcrossDatesFast`, this does **not** update the `TRIP_INDEX` sheet to remove the deleted trip-key rows — a rebuild should decide whether that's an intentional gap (index rows for deleted trips become stale/orphaned and must be tolerated by index-consumers, or cleaned up by a separate compaction job like `archiveAndCompactTripLog` in the main files) or a bug to fix.

### Module-level wrappers
`const standingOrderManager = new StandingOrderManager();` plus two free functions `createRecurringTripAcrossDatesFast` / `deleteRecurringTripFromDates` that just delegate — these are the actual `google.script.run`-callable entry points (`AddTripPage.html` calls `createRecurringTripsFromSidebar`, which is presumably a thin main-file wrapper around `createRecurringTripAcrossDatesFast`; `EditTripPage.html` calls `deleteRecurringTripsFromSidebar`, likewise around `deleteRecurringTripFromDates`).

### The recurrence pattern shape (defined in `Utils.gs`, consumed here and in the HTML)
`encodeDatePattern(startDate, endDate, daysOfWeek)` → a single string `"<startISO>|<endISO>|<DAY,DAY,...>"` (e.g. `"2024-06-01|2024-06-02|SAT,SUN"`). `decodeDatePattern(patternStr)` expands that back into every matching ISO date in range (inclusive) by iterating day-by-day and checking weekday membership. **Limits enforced client-side only** (in `AddTripPage.html`, not here): end date can't precede start date, and the span can't exceed **183 days**. There is **no server-side re-validation of the 183-day limit** in this corpus — a determined caller (or a bug in the client) could ask the server to expand/create an arbitrarily long date range. **Flag as a gap to close in the rebuild**: enforce the date-range cap server-side, not just in the browser.

**PORT**: the whole standing-order data model — `pattern` string (start/end/weekday-set), `withReturnTrip`/`returnTime`, "one trip row per (date, recurringId, isReturn)" instance generation, the 183-day client cap (move server-side), and the trip-key index/date-index optimization strategy (though a real database would use actual indexes instead of hand-rolled sheet columns).

---

## 9. The small "class layer": Utils.gs, LogManager.gs, TripRouter.gs, AmazingGraceTransport_SpreadsheetService.gs

### Utils.gs (120 lines)

- **`class Utils`**
  - `static formatDateString(date)` — if given an already-`yyyy-MM-dd` string, parses it as a **local** date (avoids UTC-shift bugs from `new Date("yyyy-MM-dd")`) and reformats via `Utilities.formatDate` in the script's timezone; otherwise tries `new Date(date)` and formats if valid, else returns the original string (or `''`). **PORT** exactly — this local-date-safe parsing is a recurring correctness concern (`TripsTest.gs` explicitly asserts `Utils.formatDateString(row[...]) === updatedDate`).
  - `static generateTripId({date, time, passenger, phone, pickup, dropoff})` — **deterministic** trip ID: SHA-256 of `salt + date|time|passenger|phone|pickup|dropoff` (salt = literal string `'AGMT_TRIP_SALT'`), hex-encoded. **Not used anywhere in this corpus** (the actual live ID scheme, seen in `AddTripPage.html` and the `X2:X100` DISPATCH formula, is the simpler pipe-joined `driver|date|time|passenger|pickup` composite string, and `tripKeyID`s are random UUIDs) — this hashed-ID generator looks like an **abandoned alternate design**, kept but unused. **DEAD.**
- **`function TRIP_ID(e)`** — onEdit-shaped handler, guarded to sheet `DISPATCH`, rows 2–100. If the edited column is **D (4, passenger name)** and a name was entered but that row's **K (11, `TRIP_KEY_ID`)** cell is still empty, fills it with a fresh `Utilities.getUuid()`. Then unconditionally calls `SpreadsheetApp.flush()` and `tripManager.onDispatchSheetEdit(e)` (main files) inside a try/catch that just logs failures. **This is very likely the master per-edit hook** — every other "shaped like onEdit" handler in this corpus (`passengerReady`, `checkDispatchForUpdates`, `addressValidation`, `earseTime`) is probably called from the same installable `onEdit` trigger this function is registered under (or from within `tripManager.onDispatchSheetEdit` itself). **LIVE — core.**
- **`generateTripIDs_K2toK100()`** — One-shot batch version of the same "fill missing trip keys" idea across the whole sheet at once; **manual/administrative, no caller found — DEAD** in normal operation (a repair tool).
- **`encodeDatePattern` / `decodeDatePattern`** — see §8 above; duplicated verbatim in `SharedLoaders.html` for client-side use (same logic, two copies — a rebuild should have exactly one implementation, shared).

### LogManager.gs (15 lines)
- **`class LogManager`** — a thin adapter with three one-line methods: `tripToRow(trip)` → `tripObjectToRowArray(trip)`, `jsonToTrips(json)` → `convertRawData(json)`, `rowToTrip(row)` → `convertRowToTrip(row)`. All three delegate to functions defined in the main files (not here). `const logManager = new LogManager()` is passed into every `TripManager`/`SidebarTripService` constructor seen in `TripsTest.gs`. **PORT the pattern** (an injectable serialization boundary between "trip object" and "row/JSON on disk") even though the concrete conversion logic lives elsewhere.

### TripRouter.gs (93 lines)
- **`class TripRouter`** — Every entry point that renders a sidebar or serves the web app:
  - `openPassengerTripList(date, flash)` — renders `TripsPage` as a **400px sidebar**, preloading `initialDate`, `initialTrips` (via `tripManager.getTripsByDate`), `tripDatesInfo` (via `getTripDatesInfo()`), and `initialSubmitted` (via `isDateSubmitted_(date)`) — each preload wrapped in its own try/catch so a single failing preload doesn't block the sidebar from opening (it just logs and falls back to an empty/false default). `flash` is a one-off toast message shown after navigation (e.g. `"✅ Trip added"`).
  - `showAddTripSidebar(date)` — renders `AddTripPage` as a 400px sidebar, preloading `formOptions` via `getFormOptionsBundle()`.
  - `openEditTripSidebar()` — renders `EditTripPage` with **no preload at all** (no `tripId`/`tripDate` template vars set) — this looks like a **secondary/legacy entry point** distinct from `showEditTripSidebar(id, date)` below; it's exposed as a free function (`function openEditTripSidebar(id)` — note the **parameter `id` is accepted but never forwarded** to `tripRouter.openEditTripSidebar()`, which takes no arguments) — calling this free function with an id silently drops it. Called from `TripsTest.gs`'s `TripsTest.openEditTripSidebar(id)` test wrapper, but not obviously from the live HTML (which uses `showEditTripSidebar(id, date)` instead, based on menu/route naming conventions). **Likely dead/vestigial** relative to `showEditTripSidebar`.
  - `showEditTripSidebar(id, date)` — the real one: preloads `initialTrip` via `getTripById(encodeURIComponent(id), date)` and `formOptions`, each independently try/caught.
  - `showRestoreDatePicker()` — modal dialog (300×180) showing `DatePicker.html`. Wired to a **menu item that is currently commented out** in `Code.gs` (`// .addItem('Restore Snapshot by Date', 'showRestoreDatePicker')`) — so right now this is reachable only by calling the function directly (Apps Script editor) or via `TEST_showRestoreDatePicker()`. **Present in code, not currently exposed to dispatchers via the menu.**
- Free-function wrappers (`openPassengerTripList`, `showAddTripSidebar`, `openEditTripSidebar`, `showEditTripSidebar`, `showRestoreDatePicker`) exist so these are directly `google.script.run`-callable and directly usable as Apps Script menu item handler names (Apps Script menu items must reference top-level functions, not class methods).
- **`function doGet(e)`** — the **web app entry point** (this project is also deployed as a standalone web app, not just a Sheets sidebar). If `e.parameter.page === 'driver'`, delegates to `serveDriverApp_(e)` (main files — the Driver App's own web entry point). Otherwise serves `TripsPage` as a full page (not a sidebar) with the same `initialDate`/`initialTrips`/`tripDatesInfo`/`initialSubmitted` preload pattern as `openPassengerTripList`, plus a mobile viewport meta tag. **This confirms Passenger Trips is a real mobile/standalone web app**, not merely a Sheets sidebar — an important fact for a rebuild (there are at least two "clients" of this same trip data: the Sheets sidebar and a public/standalone web page, both served by the very same `TripsPage` template).

### AmazingGraceTransport_SpreadsheetService.gs (18 lines)
- **`class AmazingGraceTransportSpreadsheetService`** — `constructor(ids = ssIds)`; `openSpreadsheet(name)` maps a friendly name (`"Dispatcher"`/`"Driver"`) to a hardcoded ID via `this.ids`, or falls back to `SpreadsheetApp.getActiveSpreadsheet()` if the name isn't recognized; `getSheet(ssName, sheetName)` opens the spreadsheet then gets a tab by name. `const spreadsheetService = new AmazingGraceTransportSpreadsheetService()` is the shared singleton used by `StandingOrderManager` (and, per `TripsTest.gs`, `TripManager`/`SidebarTripService` in the main files accept an injected service of this same shape, allowing tests to substitute an in-memory or scratch-spreadsheet fake). **PORT the pattern**: one indirection point between "logical spreadsheet name" and "physical location," which in a rebuild becomes "logical table name → physical DB/table."

---

## 10. Trigger handlers and sheet automation

### TimeStamp.gs (50 lines)
- **`passengerReady(e)`** — onEdit-shaped, DISPATCH only, single-cell edits only (`getNumRows()===1 && getNumColumns()===1`), only row ≥2 and **column 5 (E, `TODAY`)**. If the new value (uppercased/trimmed, read from `e.value` if present else re-read from the cell) is exactly `"READY"`, **writes `new Date()` into column 3 (C, `TIME`) of the same row** and returns `true`; otherwise returns `false`/does nothing.
  - **Semantic concern for the rebuild**: column C is documented (`COLUMN.DISPATCH.TIME`) as the trip's **scheduled** time everywhere else in the project (formulas, the trip-form mapping, `dispatchRowToTripObject`'s test in `TripsTest.gs`). This function overwrites that same cell with **the current real-world timestamp** the moment a dispatcher marks a row `READY`. That means marking a trip "ready" **destroys its originally-scheduled time**, replacing it with "whenever it was marked ready." This needs to be confirmed with the business owner: either (a) it's a known/accepted behavior (column C is being reused as "the moment dispatch marked it ready," and the *displayed schedule* lives elsewhere), or (b) it's a long-standing bug that silently corrupts scheduled times whenever "READY" is used. **Flag prominently — do not silently port this exact overwrite behavior without confirming intent.**
  - **LIVE** (onEdit-shaped, same wiring inference as `TRIP_ID`/`checkDispatchForUpdates`/`addressValidation`).
- **`TEST_passengerReadyUsesEventRange()`** — a self-contained **TEST** with hand-built mock sheet/range objects (no real spreadsheet needed) asserting: missing event → `false`; a `READY` event → `true` and exactly one write, to row 12 / column 3, with a `Date` value. Confirms the intended contract precisely (row/col target, single write).

### Arrived-PU-DO.gs (108 lines)
- **`captureDriverStatusTransitions_()`** (internal name references "PRODUCTION_STATUS_TRANSITION_TIMES_V13" in a comment — i.e. this replaced at least 12 earlier iterations of the same idea) — Scans DISPATCH rows 2–100 (or fewer if the sheet is shorter) with any `PASSENGER` value, and for each, ensures four "first observed" activity timestamps (`PICKUP_IN_AT`/Z, `ARRIVED_AT`/AA, `INTRANSIT_AT`/AB, `COMPLETED_AT`/AC) are populated **once and never overwritten**:
  - If `stamps[0]` (pickup-in) is empty but the row's `IN` column (L) already has a value, **backfill** `stamps[0]` from it.
  - If `stamps[3]` (completed) is empty but `OUT` (column O) has a value, backfill from it.
  - If `STATUS` (Q) uppercases/strips-non-letters to `PICKUPLOCATION` and there's no pickup-in stamp yet, stamp it `now`.
  - If status is `INTRANSIT` and no in-transit stamp yet, stamp it `now`.
  - If status is `DROPOFFLOCATION` and no arrived stamp yet, stamp it `now`. (Note: "arrived" is stamped from the `DROPOFFLOCATION` status, and "in-transit" from `INTRANSIT` — the four columns don't map 1:1 in an obviously-ordered way to the four status keywords; this asymmetric mapping should be preserved exactly, not "cleaned up," since it reflects how dispatchers actually use the status keywords.)
  - If status is `COMPLETE` and no completed stamp yet, stamp it `now`.
  - Writes all four columns back in one batched range write, formatted `h:mm AM/PM`, only if anything actually changed. Returns `{updated: <count>}`.
- **`arrivedPuDo()`** — trivial public wrapper around the above. **No caller found in this corpus** — given the "first-observed, never-overwritten" design (idempotent, safe to re-run), this is almost certainly invoked either from a **time-driven trigger** (a periodic sweep) or from the DISPATCH onEdit chain in the main files, to progressively backfill activity timestamps as a trip's status changes throughout the day. **PORT this exact "first write wins" semantics and the specific status-keyword → timestamp-column mapping** — this is real operational/audit data (when did the driver actually arrive/go in transit/complete) that a rebuild's trip-status history must capture.
- **`earseTime(e)`** *(sic — "erase," misspelled in the source)* — onEdit-shaped (`e.range`), opens the DISPATCH spreadsheet **by hardcoded ID** (not "active," notable since this file otherwise doesn't specify — meaning this handler works even if triggered from a bound script context where "active" might resolve differently). If the edited column is **21 (U, `DRIVER`)**, clears the cell six and five columns to the right (offsets `+6`→col AA/27 and `+5`→col Z/26, i.e. **`ARRIVED_AT`(26,1-idx) and `PICKUP_IN_AT`(25,1-idx)`** using 1-based column math — matches `COLUMN.DISPATCH.PICKUP_IN_AT`(0-idx 25) and `ARRIVED_AT`(0-idx 26) once you convert 0-index to `offset()`'s "how many columns right of U" delta). **Business rule: reassigning a trip's driver wipes that trip's pickup-in/arrived timestamps** (presumably because those timestamps belong to the *old* driver's visit and are meaningless once a new driver is assigned). **PORT this rule exactly.**
- **`showCol()` / `hideCol()` / `toggleCol()`** — Show/hide DISPATCH columns 26–27 (Z/AA, i.e. `PICKUP_IN_AT`/`ARRIVED_AT`) as a pair, and a toggle wrapper that flips a script-property boolean (`'hidden'`) each call (tracked with yet another write-only counter, `toggleCount`). **DROP** — purely a Sheets UI convenience (hide/show columns); a rebuild's UI decides its own field visibility instead.

### Auto_Submit.gs (38 lines) — the daily auto-submit timer
- **`createAuto()`** — Installs a **time-based trigger**: `ScriptApp.newTrigger("autoSubmit").timeBased().atHour(22).nearMinute(15).everyDays(1).inTimezone("America/New_York").create()` — i.e. **fires once a day, around 10:15 PM Eastern**. (Function name says "noon" in its comment — `// Schedule the trigger to execute at noon` — but the actual hour configured is **22 (10 PM)**, not noon; the comment is stale/wrong.)
- **`autoSubmit()`** — The trigger's handler: logs the current time, then runs the same "close out the day" sequence as the manual Submit button minus the confirmation dialog and minus `fixDispatch()`:
  ```
  transfer();          // archive today's DISPATCH rows to the Year2019 log workbook
  sortClients();        // sort that archive
  DeleteNewEntries();    // scrub still-in-progress rows from the last 50 archived rows
  clearDrivers();        // clear completed/cancelled driver-app entries across all driver sheets
  autoClearRows();       // clear completed/cancelled DISPATCH rows for today + re-sort + clear driver status
  ```
  **This is a real nightly batch job** with no confirmation, no undo, and (per `DeleteNewEntries`'s logic in `Code.gs`) it inspects the archive's *status* column but its "is this row from today" check compares `tempDate` (today's date, freshly computed) against `currentDate` (also today's date) — **these are always equal**, so in practice `DeleteNewEntries` clears any archived row in the scanned window whose status is still in-progress (`IN TRANSIT`/blank/`IN ROUTE`/`PICK UP LOCATION`/`DROP OFF LOCATION`/`WAITING`), regardless of the row's actual date — likely a stale/broken date comparison inherited from an earlier version, worth flagging. **PORT the intent** ("nightly, archive+scrub the day, don't let a stuck/incomplete trip's row linger"), but fix the always-true date check when reimplementing.
- **`deleteTrigger()`** — Utility to find-and-delete any installed trigger whose handler function is literally `"autoSubmit"` (loops all project triggers, string-compares). Used for re-installing/cleaning up the nightly trigger; no caller found (manual/admin use). **DROP** (Apps Script trigger management has no equivalent concept — a rebuild's nightly job is just a cron/scheduled task).

**Trigger summary for this file**: one clock trigger, `autoSubmit`, ~10:15 PM America/New_York, daily.

### BackSyncLogObjects.gs (56 lines)
- **`backSyncLogObjects()`** — A **manual data-repair tool**, not a trigger. Scans every row of the LOG sheet's column B (the trip-map JSON blobs), and for each: deserializes it (`deserializeTripMap`, main files), and for every entry, if the stored value is a **raw array of row values** (the *old*, pre-object storage format) rather than a trip object, converts it via `convertRowToTrip` (main files). Then ensures the map's **key** matches the trip's own `tripKeyID` field (re-keying if they've drifted apart — e.g. from an earlier bug or manual edit). Rewrites the row's JSON only if something actually changed. Explicitly documented (in the file's own header comment) as: *"Run manually if historical LOG data needs normalization."* **DEAD** in normal operation (no automatic caller) — **DROP** as a rebuild concern except as a one-time migration script when importing historical LOG data into the new system; the underlying invariant it enforces ("every trip map entry is keyed by that trip's own `tripKeyID`, and entries are always objects, never raw arrays") **should be true by construction** in a rebuilt data layer, making this whole repair tool unnecessary going forward.

### Web-Calendar_Request.gs (13 lines) — an unfinished feature stub
- **`findEmptyRowInDispatcher()`** — Scans DISPATCH `A2:A100` for the first blank Date cell and returns that row number (as a string) — nothing more. **No caller anywhere in this corpus.** The filename ("Web-Calendar Request") strongly implies an intended feature — likely a public-facing web form or Calendar-integration flow for *requesting* a trip, which would need to find the next free DISPATCH row to insert into — that was **never built beyond this one helper function**. **DEAD.** Flag under "Features found here the main docs would miss": this is evidence of an **abandoned/never-shipped "request a trip via the web or a calendar" feature**, not an implemented one — worth asking the business owner whether it's still wanted, since the filename alone could otherwise mislead a rebuild into thinking such a feature already exists.

---

## 11. ADD_EDITOR.gs (119 lines) — sheet-protection housekeeping (DROP)

Standalone administrative utilities for managing Google Sheets **range protections** (the "only certain emails can edit this range" feature) on the Drivers spreadsheet and the active spreadsheet. None are wired to any menu or trigger found in this corpus — all are meant to be run manually from the Apps Script editor by the developer.

- **`multiSheetProtection()`** — On the Drivers spreadsheet, for every sheet literally named `'1'` through `'9'`, applies five named range-protections (`C6:I18`, `K6:L18`, `N6:O18`, `Q6:AG18`, `C1:S5`) and strips every editor **except** the hardcoded allow-list `["nethelbert.blasse@gmail.com"]` — i.e. this locks those tabs down to just the developer's personal email.
- **`removeDriversProtectedRanges()`** — Removes every range protection the current user can edit, across sheets `'1'`–`'9'` on the Drivers spreadsheet.
- **`protectMultiple()`** — Same idea but on whatever spreadsheet is "active," three different ranges (`A1:D4`, `F1:F4`, `L1:O4`), allow-listing two business emails (`amazinggracemobiletransport@gmail.com`, `amazinggracetransport@gmail.com`) instead of the developer's.
- **`removeEditors()`** — Removes every editable range protection on the active spreadsheet (logs each one's index).
- **`addEditor()`** *(misleading name — it doesn't add anyone)* — Just logs the current editors of every editable protected range on the active spreadsheet, indexed.

**DEAD** (no live caller) and **DROP** entirely from a rebuild — Google Sheets range-level ACLs have no equivalent concept in a real application; access control in a rebuild is handled by the application's own auth/roles layer. Worth noting only because the hardcoded personal email (`nethelbert.blasse@gmail.com`) and the two business Gmail addresses are the closest thing in this corpus to a list of "who is allowed to administer this system."

---

## 12. The HTML files — which are live, which are superseded

| File | Status | Notes |
|---|---|---|
| **AddTripPage.html** | **LIVE** | Rendered by `TripRouter.showAddTripSidebar`. See full field/flow breakdown below. |
| **EditTripPage.html** | **LIVE** | Rendered by `TripRouter.showEditTripSidebar`. See below. |
| **TripFormFields.html** | **LIVE** (partial, `include()`d) | Shared `<div class="scroll-container">` form markup + a few small scripts, included by both Add and Edit pages. |
| **SharedLoaders.html** | **LIVE** (partial, `include()`d) | Shared dropdown-loading/autocomplete/date-pattern JS, included by both Add and Edit pages. **Contains a live bug** — see below. |
| **TripStyles.html** | **LIVE** (partial, `include()`d) | Shared CSS for the trip-form sidebars (Add/Edit), plus the shared modal styling reused from `TripsPage.html`. |
| **loading.html** | **LIVE** (partial, `include()`d) | The loading-spinner overlay + toast notification widget shared by Add/Edit Trip pages (and, per its comment, `TripFormTemplate.html`). |
| **DatePicker.html** | **Present, not currently menu-exposed** | Rendered only by `TripRouter.showRestoreDatePicker()`, whose menu item is commented out in `Code.gs`. Still reachable by direct function call (Apps Script editor / `TEST_showRestoreDatePicker`). |
| **CreateStartTime.html** | **LIVE** | Rendered by `Email_Employees.selectDate()`, wired to the **"START TIMES"** menu item. |
| **myHtml.html** | **LIVE** | Rendered by `Email_Employees.selectedEmployee()`, wired to the **"SEND START TIMES"** menu item. (Note: this workflow is currently broken end-to-end per the `conisole.log` bug in `driversData()` — see §5.) |
| **EmailAccessSidebar.html** | **LIVE** | Rendered by `Code.showAccessSidebar()`, wired to the **"Grant Access to Drivers App"** menu item. |
| **TripFormTemplate.html** | **DEAD / superseded** | No `include()`/`createTemplateFromFile('TripFormTemplate')`/`createHtmlOutputFromFile('TripFormTemplate')` reference found anywhere in this corpus. Its CSS is a near-byte-for-byte subset of `TripStyles.html` (missing the disabled-button, autocomplete, and modal styles `TripStyles.html` has added since). This is an **earlier, abandoned version** of the shared trip-form styling, left in the project after `TripStyles.html` replaced it. **DROP.** |

### AddTripPage.html — fields and flow (already the live version; see §"TripFormFields.html" for the shared field list)

Fields (via included `TripFormFields.html`): Date* (required, defaults to `initialDate`/today), Time, Passenger* (required, autocomplete against `getPassengerProfiles()`), Phone (datalist, auto-filled from the passenger profile), Medicaid #, Invoice #, Transport (datalist: Taxi/Ambulatory/Wheelchair/Stretcher), Pick Up / Drop Off (datalists auto-filled from the passenger's known addresses, plus a generated "Open directions in Google Maps" link once both are filled), a **"Also create return trip"** checkbox (reveals a Return Trip Time input, defaulting to +4 hours from the main trip time), a **"Standing order"** checkbox (reveals Frequency/custom-days/Start-End date controls; checking it also auto-checks "return trip" if not already checked, and defaults Start Date to the trip's date), Vehicle (datalist), Driver (datalist), Status (datalist: READY/CANCEL/COMPLETE/REASSIGN/NO SHOW/UPDATE TIME/NOT CONFIRMED/IN TRANSIT/IN ROUTE/WAITING/PICK UP LOCATION/DROP OFF LOCATION), Notes.

Submit flow (`submitNewTrip()`): validates Date/Passenger present, blocks past-dated trips (`date < today`), strips `|` characters from passenger/pickup/dropoff (since `|` is the composite-ID field separator), builds the trip object, and — if a standing order — client-side validates end-date ≥ start-date and span ≤ **183 days**, expands the pattern into concrete dates, and for each date builds a primary trip (+ a return-trip twin if requested) each with a fresh client-generated UUID `tripKeyID` (via `crypto.randomUUID()` or a manual fallback) and a shared `recurringId` = the very first generated `tripKeyID`. Before saving, runs **three rounds of server-side conflict checks in parallel per trip** (`checkDuplicateTrip`, `checkPassengerConflict`, `checkDriverConflict` — all defined in the main files, not here) and aborts with an alert if any fail. Only then saves: `createRecurringTripsFromSidebar(parent, expandedDates)` for standing orders (after first fetching/mutating/re-saving the standing-order map itself via `getStandingOrderMap`/`updateStandingOrderMap`), or `addTripsFromSidebar(tripsToSave)` for ordinary adds. On success, navigates back to `openPassengerTripList(date, "✅ Trip added")`.

### EditTripPage.html — fields and flow

Same shared field list, but return-trip/standing-order controls are hidden entirely (edit is single-trip-instance only). Loads the trip either from a **server-preloaded** `initialTrip` (fast path) or via `getTripById(safeId, safeDate)` if not preloaded. `toggleSaveButtonVisibility` **hides the Save and Delete controls entirely for trips whose date is in the past** — past trips are view-only. Delete flow: for a non-recurring trip, a plain confirm + `deleteTripFromSidebar(tripKeyID, date)`; for a **recurring** trip, opens a modal listing every date in that standing order (via `expandStandingOrder` against the live `getStandingOrderMap()`), letting the dispatcher check which specific occurrences to delete, then calls `deleteRecurringTripsFromSidebar(recurringId, selectedDates)`. Save flow (`submitTrip()`) always preserves the trip's original `tripKeyID`, `returnOf`, and `recurringId` from `currentTrip`, and calls `updateTripFromSidebar(trip)`.

### TripFormFields.html specifics
Also renders the Google-Maps-directions link (`http://maps.google.com/maps/dir/<pickup>/<dropoff>`, plain `http://`, shown only once both fields are non-empty) and, for the standing-order block, clamps the End Date input's `min`/`max` to `[startDate, startDate+183 days]` live as the Start Date changes (client-side only, same 183-day rule as the submit-time check).

### SharedLoaders.html — **live bug**
```js
// Addresses
cont pickupList = document.getElementById("pickup-options");
```
**`cont` is a typo for `const`.** This is a **JavaScript syntax error** — it will fail to parse, which (depending on how/where this `<script>` block is inlined relative to the rest of the page's script) can break `syncPassengerProfile()` entirely (and potentially the whole inline script block containing it, since a `SyntaxError` at parse time prevents *any* of that block's functions from being defined). Given `syncPassengerProfile` is called on passenger selection in both Add and Edit Trip pages to auto-fill phone/medicaid/pickup/dropoff, **this needs to be verified as a live-breaking bug** (or already silently patched at deploy time / non-fatal due to how Apps Script concatenates included files) before porting the auto-fill behavior forward. At minimum, fix the typo when reimplementing this logic.

### myHtml.html / CreateStartTime.html specifics
Both are **scriptlet-templated** (`<? ... ?>`/`<?= ... ?>`) HTML, evaluated server-side via `HtmlService.createTemplateFromFile(...).evaluate()` (not `createHtmlOutputFromFile`) — meaning they run **live Apps Script code inline in the markup** at render time: both read `DISPATCH!A2:A100`, collect unique non-blank date strings (as `MM/dd/yyyy`-ish sliced text, not a real date compare), and populate a `<select>` of dates.
- `myHtml.html` additionally has a **driver** `<select>`, populated *after* a date is chosen (`dateList()` → `google.script.run.chosenDate(selectedDate)` → repopulates driver options with that date's unique drivers), then "Submit Start Time" calls `findEmail(selectedDriver, selectedDate)` and renders either a green success message (email/day/start time) or a red error message from the returned object.
- `CreateStartTime.html` has two buttons: **"Create Times and Send"** (`createAndSend()` → `addBeginTime(selectedDate)` → for every affected driver, `findEmail(...)` → `sendToDrivers(...)`, appending a green/red status line per driver) and **"Create Times"** (`createBtn()` → `addBeginTime(selectedDate)` only, no emailing, then closes the dialog).

### EmailAccessSidebar.html specifics
Loads the current Staff-sheet email list (`getEmailList()`) as checkboxes, lets the dispatcher pick Edit/View access, requires an explicit **"Confirm changes"** checkbox before either button is enabled/does anything, and before actually granting/revoking, re-fetches the Drivers spreadsheet's current editor+viewer list (`getCurrentEditorsAndViewers()`) to warn about no-op duplicates (already has access / doesn't have access) before proceeding. On success, calls `grantAccessToEmails`/`revokeAccessFromEmails` (in `Code.gs`), which **directly modify the Drivers spreadsheet's sharing permissions** (`targetSS.addEditor`/`addViewer`/`removeEditor`) and email each affected person a notice via `GmailApp.sendEmail`. **REPLACE**: this "grant/revoke Sheets sharing access" flow must become real user/role management in a rebuild (invite/remove a user from the app, not from a spreadsheet's sharing settings) — but **PORT** the UX rules: explicit confirm-checkbox gate, pre-flight duplicate-check against current access, and an email notification on both grant and revoke.

---

## External dependencies

| Dependency | Used by | What for | Rebuild replacement |
|---|---|---|---|
| **Cloud Function** `https://us-central1-agmtlambdaapi.cloudfunctions.net/trips` | `Calls_To_Lambdas.gs` → `updateTripsFirestoreDb(e)` | POSTs the edited DISPATCH row (as JSON, plus its row number) on every DISPATCH edit — likely feeding a Firestore-backed system (name: "agmtlambdaapi") consumed by something outside this corpus (maybe the "Time Sheet" dashboard). **Undocumented anywhere else — verify who/what still reads from it before retiring or re-pointing it.** | Either keep pushing trip-change events to whatever consumes this today, or formally retire after confirming no consumer remains. |
| **Google Maps Advanced Service** (`Maps.newDirectionFinder()`) | `GoogleMaps.gs` (`GOOGLEMAPS` custom function, `mapIt()`), `Email_Employees.gs` (`addBeginTime()`) | Distance (miles/km) and duration (minutes/hours) between two addresses; no caching, no retry, no graceful failure (throws → `#ERROR!` in-sheet). | Google Maps Distance Matrix or Directions API called directly, with real caching and error handling. |
| **Carrier SMS-to-email gateways** (vtext.com, txt.att.net, tmomail.net, messaging.sprintpcs.com, myboostmobile.com, sms.mycricket.com, email.uscc.net, msg.fi.google.com, mymetropcs.com) via `MailApp.sendEmail` | `TextDrivers.gs` (`sendSmsToStaff`/`getSmsEmail`) | "Texting" drivers by emailing their phone's carrier gateway address. No delivery confirmation; fragile as carriers retire/throttle these gateways. | A real SMS API (Twilio, etc.). |
| **Gmail / MailApp** (`GmailApp.sendEmail`, `MailApp.sendEmail`) | `Email_Employees.gs` (start-time notices), `Code.gs` (`grantAccessToEmails`/`revokeAccessFromEmails` access notices), `TextDrivers.gs` (the SMS-via-email hack above) | Transactional email to drivers/staff. | Any transactional email provider. |
| **Google Sheets as a database** — at least 5 separate spreadsheets referenced by hardcoded ID: the **Dispatcher** sheet (`1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME`, containing DISPATCH/LOG/PASSENGERS/"PAGE 2 of DISPATCH"), the **Drivers/Driver App** sheet (`13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA`, containing per-driver tabs `1`–`9`, `Schedule Links`, `MASTER DRIVERS DATA LINKED`, `HOME`, `DATA`), the **Staff** sheet (`1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE`, `STAFF` tab — name/license/initials/phone/email/carrier), the **Vehicles** sheet (`13ynJ0Q_pn-Ao4fcJTmpSswbAk8MRy-RMpCF3YnIm-Ug`, `Vehicles` tab), and the **archive/"Year2019" log** sheet (`1nEAxrzYy4cRMw7NLEupYUEe0eB0wP11LyzDVA_kDm8Y`, `Year2019` tab — despite the year in its name, this is where **every day's** closed-out trips get archived, per `transfer()`/`sortClients()`/`DeleteNewEntries()` in `Code.gs`). Also a one-off **backup spreadsheet** (`1V8CU4KK_ekP7ePS-A5JZkbE5Zrr1HBsOzNDcEhgC-Bg`) used by `repairPassengersFromBackup()`. | Everywhere | The entire system's real database, split across 5+ live spreadsheets cross-referenced by hardcoded Sheet IDs, plus ad-hoc backup/migration spreadsheets created on the fly. | A real relational/document database with proper tables for Trips, Passengers, Drivers, Vehicles, and an Archive/History table — collapsing all five spreadsheets into one system of record. |
| **External web dashboard** `https://time-stamp-agmt.vercel.app/admin/dashboard` | `Code.gs` (`linkToTimeSheet` menu link) | A separate, already-built web app (hosted on Vercel) for driver time-sheet administration — **not part of this Apps Script project at all**, just linked from the menu. Its existence (and the fact it's named "time-stamp-agmt") is a strong hint it's the actual consumer of the Firestore data `updateTripsFirestoreDb` pushes. | Out of scope for this rebuild unless the two systems are meant to merge; at minimum, confirm the relationship before touching `updateTripsFirestoreDb`. |
| **Google Drive** (`DriveApp.getFileById(...).setTrashed(true)`) | `TripsTest.gs` (test cleanup) | Trashes scratch spreadsheets created during tests. | N/A (test-only). |

---

## Trigger inventory

| Handler | Fired by | What it does |
|---|---|---|
| **`autoSubmit`** | **Time-based trigger**, installed by `createAuto()`: daily, ~10:15 PM America/New_York (`atHour(22).nearMinute(15).everyDays(1)`) | Runs the full end-of-day close-out: `transfer()` (archive today's DISPATCH to the Year2019 log workbook) → `sortClients()` → `DeleteNewEntries()` (scrub still-in-progress rows from the archive's last 50 rows — date check is effectively always-true, see §Auto_Submit.gs) → `clearDrivers()` (clear completed/cancelled entries across the Drivers workbook's tabs) → `autoClearRows()` (clear completed/cancelled DISPATCH rows for today, re-sort, clear driver status). No confirmation dialog (unlike the manual Submit button). |
| **`onOpen`** | **Simple trigger**, fires automatically whenever the bound spreadsheet is opened | Builds the full custom menu (`AMAZING GRACE MOBILE TRANSPORT` + `Assistance`/`Links` submenus) and best-effort tries to auto-open the Passenger Trips sidebar (silently no-ops in simple-trigger mode, since simple triggers can't show sidebars — see next row). |
| **`onOpenShowTripsSidebar_`** | **Installable `onOpen` trigger**, installed by `installAutopenSidebarTrigger()` (menu item **"Enable Auto-Open Sidebar"** — but note the menu item string is `'installAutoOpenSidebarTrigger'`, which **does not match** the actual function name `installAutopenSidebarTrigger` — **clicking that menu item throws "script function not found," so this menu item is currently broken and the auto-open-sidebar feature cannot be enabled through the UI**) | Once actually installed (e.g. by calling the correctly-spelled function directly), opens the Passenger Trips sidebar automatically on every spreadsheet open, with full permissions (unlike the simple `onOpen` trigger). |
| **An implied master `onEdit(e)` handler** (not present in this corpus — must live in the main `Helpers.gs`/`TripManager.gs`) | Every edit to the bound spreadsheet | Almost certainly fans out to, at minimum: `TRIP_ID(e)` (assigns a trip key when a passenger name is entered on DISPATCH; also calls `tripManager.onDispatchSheetEdit(e)`), `passengerReady(e)` (stamps column C when `TODAY`/status is set to `READY`), `checkDispatchForUpdates(e)` (fires driver SMS on `CANCEL`/`UPDATE TIME`/`READY` in the status column, or any change to Notes), `addressValidation(e)` (rebuilds pickup/dropoff dropdown validation when the passenger name changes; invalidates the passenger-form cache when the `PASSENGERS` sheet itself is edited), `earseTime(e)` (clears pickup-in/arrived timestamps when the Driver column is edited), and possibly `updateTripsFirestoreDb(e)` (posts the row to the external Cloud Function). **None of these is directly wired to an `onEdit` in this corpus** — this is inferred entirely from every one of them sharing the exact `function name(e) { const range = e.range; ...guard on sheet name/column/row... }` shape. **A rebuild replaces this whole fan-out with explicit application-layer event handlers** (e.g. "on trip status change" → notify driver; "on passenger change" → refresh addresses) rather than one giant spreadsheet onEdit dispatcher. |
| **A weekly LOG-compaction trigger** (name implied: `installWeeklyLogCompactionTrigger`, menu item **"Schedule Weekly LOG Cleanup"**; handler implied: `archiveAndCompactTripLog`, menu item **"Run LOG Cleanup Now"**) | Both referenced only in `Code.gs`'s menu wiring — **neither function is defined anywhere in this 31-file corpus**, so both live in the main files. | Presumably compacts/archives the LOG sheet's per-date JSON-blob rows over time (the LOG-as-database design in §8/RecurringTrips means this sheet only grows). Flagged here because the menu names make its existence and cadence ("weekly") clear even though its implementation isn't in scope for this document. |

---

## Features found here that the main-app documentation would miss

1. **A live, undocumented external Cloud Function dependency.** Every DISPATCH edit is meant to POST the full row to `https://us-central1-agmtlambdaapi.cloudfunctions.net/trips` (`Calls_To_Lambdas.gs`). Nothing else in this corpus reads from or explains this endpoint — it is pure outbound integration, presumably feeding a separate Firestore-backed system (possibly the linked `time-stamp-agmt.vercel.app` dashboard). A rebuild must track down what (if anything) still consumes this before deciding to keep or drop it.
2. **The SMS "texting" feature is actually email-to-carrier-gateway forwarding**, not a real SMS API (`TextDrivers.gs`). This is invisible unless you read this file — from the driver's phone, it just looks like a text, but it's one dropped carrier-gateway domain away from silently stopping working for that carrier.
3. **The "Send Start Times" feature (menu → "SEND START TIMES") is currently broken** for any real match, due to a `conisole.log` typo in `Email_Employees.gs`'s `driversData()` that throws before the email/SMS is ever sent. This is a live production bug the main-app docs (which describe intended behavior, not bugs like this) would not surface.
4. **The "Enable Auto-Open Sidebar" menu item is broken** — it references a misspelled function name (`installAutoOpenSidebarTrigger` vs. the real `installAutopenSidebarTrigger`) and throws immediately when clicked.
5. **`getDriverOptions()` reports every driver's SMS carrier as the *first* driver's carrier** (`data[0][45]` instead of `data[i][45]`), a copy-paste indexing bug in `CRUD.gs` that silently corrupts whatever in the main UI relies on the driver dropdown's `.carrier` field (the actual SMS-sending code path in `TextDrivers.gs` reads the carrier correctly, per-row, so this bug is scoped to whatever else consumes `getDriverOptions()`'s output).
6. **Marking a trip "READY" overwrites its scheduled time with the current real-world time** (`TimeStamp.gs`'s `passengerReady`, writing `new Date()` into the same column (`TIME`, C) that holds the trip's originally-scheduled time everywhere else in the system). This is either an intentional repurposing of that column or a long-standing correctness bug — either way, it's not something you'd guess from the main trip-form docs, and must be resolved with the business owner before the rebuild decides what "the trip's time" even means once a trip has been marked ready.
7. **Reassigning a trip's driver silently wipes its pickup-in/arrived timestamps** (`Arrived-PU-DO.gs`'s `earseTime`). A rebuild's audit trail for "when did the driver actually get there" needs to intentionally replicate (or intentionally decide not to replicate) this behavior.
8. **A second, undocumented "DISPATCH-like" sheet, `'PAGE 2 of DISPATCH'`**, exists and receives the exact same address-validation treatment as the real DISPATCH sheet (`Data_Validation_Filter.gs`). Nothing else in this corpus explains its purpose (overflow past row 100? an archival/secondary view?) — worth asking the business owner directly, since a rebuild's data model needs to know whether this represents real, separate trip data or is a stale/legacy artifact.
9. **An abandoned "Web/Calendar trip request" feature.** `Web-Calendar_Request.gs` contains exactly one helper (`findEmptyRowInDispatcher`) and nothing else — strong evidence of an intended (never finished) public-facing or Calendar-integrated trip-request flow. A rebuild should ask whether this is still wanted rather than assuming (from the filename alone) that it already exists.
10. **The daily archive workbook is misleadingly named "Year2019"** (`1nEAxrzYy4cRMw7NLEupYUEe0eB0wP11LyzDVA_kDm8Y`, tab `Year2019`) but is where **every day's** closed-out trips get archived indefinitely, not just 2019's — a rebuild's "trip history/archive" table is this sheet's true successor, and its misleading name should not be carried forward.
11. **Standing orders have a 183-day span cap enforced only in the browser** (`AddTripPage.html`), with no server-side re-check in `RecurringTrips.gs`. A rebuild must enforce this limit (or whatever the business actually wants it to be) server-side.
12. **Passenger identity is matched by a whitespace-collapsed, lowercased name string** (`passengerCacheKey_`/`normalizePassengerCacheKey_`, duplicated verbatim in two files) — there is no numeric passenger ID anywhere in this corpus. A rebuild introducing real passenger IDs must decide how to reconcile/migrate historical trips that only ever recorded a name string, and must preserve this exact normalization rule wherever historical name-matching still matters.
13. **A live JavaScript syntax bug in the shared trip-form loader** (`cont pickupList = ...` in `SharedLoaders.html`) that should be verified as fixed/non-fatal or genuinely broken before its passenger auto-fill behavior is ported forward as "working as designed."
14. **Two independent SMS/notification mechanisms with different reliability characteristics for the same real-world action** ("tell a driver something"): `TextDrivers.gs`'s carrier-gateway trick (fired automatically on specific DISPATCH edits) versus `Email_Employees.gs`'s `sendEmail`, which for phone numbers just emails the bare phone number as if it were an address (no gateway-domain lookup at all, and thus likely non-functional) — a rebuild should consolidate to one real notification path rather than preserving two inconsistent, partially-broken ones.
