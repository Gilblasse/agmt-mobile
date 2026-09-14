# Amazing Grace Mobile Transport — Server API Specification

Reverse-engineered from the live Google Apps Script backend, for a rebuild as a
normal web API. Read-only analysis; no source file was modified.

**Sources analyzed (100% read, sequentially):**

| File | Editor name | Lines | Role |
|---|---|---|---|
| `/home/claude/work/file_29.js` | `TripManager.gs` | 5,499 | Main service layer: trips, board, standing orders, passengers, pricing, planning, repairs |
| `/home/claude/work/file_18.js` | (row/trip mappers) | 1,198 | Row↔trip object mappers, time-string helpers, TRIP_INDEX maintenance, sheet-formatting menu functions |
| `/home/claude/work/file_24.js` | (board sync) | 795 | DISPATCH↔LOG snapshot/restore, fingerprinting, background sync triggers, onEdit trigger |

**External dependencies referenced constantly but defined in files *not* provided
to this analysis** (do not invent behavior for these — flag them for the actual
source when rebuilding):

- `COLUMN` — the column-index map for `LOG`, `DISPATCH`, etc. (e.g. `COLUMN.DISPATCH.TRIP_KEY_ID`, `COLUMN.LOG.RECURRING_ID`).
- `Utils.formatDateString(value)` — canonical `yyyy-MM-dd` normalizer used on every date touchpoint.
- `spreadsheetService` / `logManager` (`logManager.jsonToTrips(json)`) — sheet-access and JSON-decoding service objects `tripManager` is constructed from.
- `passengerCacheKey_`, `getPassengerCacheLookup_`, `ensurePassengersHeaders_`, `PASSENGERS_HEADERS_`, `splitLines_`, `invalidateFormOptionsCache_`, `rebuildPassengerCache` — the passenger-cache module.
- `driverAssignmentAlert_`, `driverCancelAlert_` — driver push/SMS notification module, called after trip create/update/cancel.
- `captureDriverStatusTransitions_`, `driverDriveMinutes_` — driver-app polling/telemetry module.
- `currentDispatcherLabel_` — resolves the acting user's display name for audit stamps.
- `decodeDatePattern` / `encodeDatePattern` — standing-order recurrence pattern codec.
- `rowAddressValidation`, `dispatchSheetFormulas`, `driversDataLinkedRangeHeight` — DISPATCH sheet formula/validation setup (spreadsheet artefacts, see §8).

---

## 1. Data shapes

### 1.1 The Trip object (the canonical unit of the whole system)

A trip is a plain JS object, never a class instance, produced by
`convertRowToTrip` (from a `LOG` row) or `dispatchRowToTripObject` (from a
`DISPATCH` row), and merged/patched throughout `TripManager.gs`. Full field
list (union of every field ever read or written):

| Field | Type | Meaning |
|---|---|---|
| `tripKeyID` | string (UUID) | The stable, permanent identity of the trip. Generated once (`Utilities.getUuid()`), never changes, is the Map key inside the LOG JSON blob and the `TRIP_INDEX` lookup key. **Protected** — cannot be overwritten by a client save except through the server's own forced-override list. |
| `id` | string | A legacy/secondary id (`salted SHA-256 hash of date, time, passenger, phone, pickup, dropoff` per an old comment in `file_18.js`). Used to link a return leg to its outbound leg via `returnOf`. Preserved across DISPATCH↔LOG resync. |
| `date` | string `yyyy-MM-dd` | Trip service date. Normalized by `Utils.formatDateString` everywhere. |
| `startTime` | string (ISO time anchored `1899-12-30`) or `''` | Optional "leaves at" time distinct from pickup `time`. `''` when blank — see the V100 repair below for why this matters. |
| `time` | string (ISO anchored `1899-12-30THH:mm:ssZ`) | Scheduled pickup time. `23:58` is the sentinel meaning "no time typed" (see `toTimeOnlySmart`). |
| `passenger` | string | Passenger display name. Presence of a non-blank passenger is what makes a LOG row entry "real" (see `getTripsByDate` filter). |
| `transport` | string | Free-text transport type; parsed by `ppTransportKey_` into `ambulatory\|wheelchair\|stretcher\|taxi\|other` for pricing/board icons. |
| `phone` | string | Passenger phone. |
| `medicaid` | string | Medicaid #/type. |
| `invoice` | string | Invoice #. |
| `pickup` / `dropoff` | string | Addresses. |
| `pickupNotes` / `dropoffNotes` | string | Stop-specific notes. No DISPATCH column — LOG-only field, must be carried over on every board↔record resync (V74 fix). |
| `notes` | string | General trip notes. |
| `vehicle` | string | Assigned vehicle. |
| `driver` | string | Assigned driver name. |
| `status` | string | Driver-set status (legacy/record-side status). |
| `dispatchStatus` | string | Dispatcher-set status shown in DISPATCH column E: `''`, `READY`, `NOT CONFIRMED`, `REASSIGN`, `UPDATE TIME`, `COMPLETE`, `CANCEL`, `NO SHOW`. |
| `statusAt` | string (ISO) | Timestamp of the last dispatcher status stamp (only for `NO SHOW`, `CANCEL`, `REASSIGN`). |
| `in` / `out` | string (ISO) | Legacy door/finish stamps (older records only). |
| `pickupArrival`, `pickupDeparture`, `dropoffArrival`, `dropoffDeparture` | string (ISO, wall-clock) | Driver-app tap stamps, in required order: arrival at pickup → departure from pickup ("in transit") → arrival at drop-off → departure/complete. |
| `returnOf` | string | The `id` (or `tripKeyID`) of the outbound trip this is the return leg of. Empty for outbound/one-way trips. |
| `recurringId` | string | Ties a trip to a standing order pattern. |
| `privatePay` | boolean/string | Whether this trip is billed directly to the passenger (drives the whole Pricing engine, §6.6). |
| `price` | number/string | The billed total, in dollars, or `''` if unpriceable. |
| `pricing` | object or `''` | The full pricing snapshot — see §6.6 `ppQuote_` return shape. |
| `milesOverride` | number/string | Dispatcher-typed distance override (used when Maps can't route the address). |
| `deadheadMiles` | number/string | Dispatcher-typed empty-run mileage. |
| `__changedFields` | string[] (non-enumerable, never persisted) | Attached in-memory by `SidebarTripService.update` so `writeTripToDispatchRow_` can skip an unnecessary board re-sort. |

### 1.2 LOG sheet storage format

`LOG!A:B`, one row **per calendar date** (not per trip):
- Column A: the date (`Date` or string), read via `logDateKey_`/`Utils.formatDateString`.
- Column B: `serializeTripMap()` output — `JSON.stringify(Array.from(map.entries()))`, i.e. an array of `[tripKeyID, tripObject]` pairs, **sorted by time** at serialization. `deserializeTripMap()` accepts this shape, a legacy plain-object shape, and legacy raw row-arrays (via `convertRowToTrip`), and always strips a stray `standingOrder` field.
- `LOG!A1` is repurposed: it holds `getStandingOrderMap()/updateStandingOrderMap()` — a JSON object of `{ recurringId: { pattern, title? } }` standing-order definitions. **This is why the LOG data rows start at row 2 and why row/column 1 must never be touched by a naive "read the whole sheet" import.**
- A date can appear on **more than one row** (duplicates from old bugs/migrations); every reader in the codebase takes the **last** (highest row number) as authoritative (`logDateKey_` + last-wins reduction, repeated verbatim in ~6 different functions).

### 1.3 DISPATCH sheet (the working board)

- Fixed layout, columns A..AG (`COLUMN.DISPATCH.*`, up to `SIDEBAR_DISPATCH_MAX_ROW_ = 100` rows, i.e. **hard cap of 99 visible trips at once**).
- Only carries `DISPATCH_WINDOW_DAYS_ = 1` days ahead of today — i.e. **today and tomorrow only** (`dispatchWindowKeys_()`). A trip for a later date is fully saved to LOG but does not get a DISPATCH row until its date rolls into the window.
- Several columns are **spreadsheet formulas** the app must never overwrite (VLOOKUPs into `PASSENGERS`, `drivers data linked`, `vehicles`): F, G, H, L, O, Q, S, T, V, W, X per `fixDispatch()`. The board-sort and repair code (`sortDispatchSheet_`, `dispatchWritableRuns_`) detects these at runtime by checking every cell in a column for a formula, and only rewrites non-formula ("writable") column runs.
- Row reuse: a blank row (no passenger, no trip key) is up for grabs by the next trip (`findOpenDispatchRow_`). Because of this, several columns "inherit" the previous occupant's leftover values unless explicitly cleared — the entire "phantom stamps" repair family (§7) exists because of this reuse design.

### 1.4 Standing order object

```
{ pattern: <encoded recurrence pattern, decoded by decodeDatePattern()>, title?: string }
```
Stored per `recurringId` inside `LOG!A1`'s JSON map. Titles (added later, V88) live
in a **separate** script property (`standingOrder:titles:v1`) specifically so
adding a title never risks corrupting the repeat/delete logic that already
existed around the pattern map.

### 1.5 Pricing config object

See §6.6 for the full shape (`pricingDefaults_()` / `pricingConfig()`); stored
as one JSON blob under script property `privatePay:pricing:v1`.

---

## 2. Concurrency and locking (read this before anything else)

### 2.1 The one real lock: `withTripsDocumentLock_`

```js
function withTripsDocumentLock_(callback) { ... }
```
*File: `file_29.js` line 350.*

This is **the** lock. Every write to LOG, DISPATCH, or the standing-order map
goes through it (directly, or by calling a function that does).

- Backed by `LockService.getDocumentLock()` — one lock per **spreadsheet document**, shared by every concurrent execution (every dispatcher tab, every driver-app poll, every trigger).
- **Re-entrant by hand-rolled depth counter** (`tripsLockDepth_`), *not* by GAS itself (`LockService` locks are not natively reentrant). Only the outermost call actually calls `lock.waitLock(15000)` / `lock.releaseLock()`; nested calls just increment/decrement the counter and run the callback directly. The comment on this fix (V120) is explicit about the historical bug:
  > "V120: repair functions call snapshotDispatchToLog while already holding this lock. The old code took a fresh lock each time and released it on the INNER return, so the outer frame carried on writing with the board unlocked. Only the outermost frame now takes and releases the lock."
- **Wait timeout: 15,000 ms** (`lock.waitLock(15000)`). No explicit catch around the wait — if it times out, `waitLock` itself throws, and the exception propagates to the caller (e.g. `updateTripFromSidebar` throwing to the client).
- On the **outermost** unlock (depth returns to 0): if `dispatchNeedsSort_` was set during the critical section, it runs `sortDispatchSheet_()` (swallowing any error — "A board that cannot be tidied is not a reason to fail the save") and then calls `boardBump_()` to advance the board version counter. Only then is the real lock released.
- A **try-lock variant**, `withTripsDocumentTryLock_(waitMs, callback)`, is used only by `getStandingOrderJobStatus` (a page polling a background job wants a quick "do a little work if free" without blocking the poll for 15s) — it does *not* call `boardBump_()` on release, and does not do the version bump; it defers to whatever eventually calls the real lock.

### 2.2 Sequencing rule inside the lock — write destination before source

Any move-between-days write (changing a trip's `date`, or a standing-order
delete/spread) **writes the new location first, flushes, then deletes from the
old location**. Documented explicitly in `updateTripInLog`:
> "V120: write the destination FIRST. If anything throws in between, the worst case is the trip briefly existing on both days (which the next save or snapshot resolves) rather than on neither, which was unrecoverable."

### 2.3 Other locks

| Lock | Backing | Timeout | Guards | Notes |
|---|---|---|---|---|
| Passengers lock (`withPassengersLock_`) | `LockService.getScriptLock()` | `tryLock(10000)`, throws `'The passenger list is busy right now. Please try again.'` on failure | All writes to `PASSENGERS` sheet (create/update/delete/restore/sort) | Deliberately a **different** lock than the trips lock — a long passenger clean-up must not block a dispatcher's trip save, and vice versa. `deletePassengersFromDirectory` explicitly releases the passengers lock *before* calling `paxRemoveFutureTrips_` (which takes the trips lock) for exactly this reason. |
| Pending-trips lock (`withPendingLock_`) | `LockService.getScriptLock()` | `waitLock(10000)` | `PENDING_TRIPS` sheet reads/writes | Separate again — "Needs Scheduling" list must not block or be blocked by trip saves. |
| Trip-times lock (inline in `tripTimesRecord_`) | `LockService.getScriptLock()` | `tryLock(5000)`, returns `{ok:false, reason:'busy'}` (never throws) | `TRIP_TIMES` sheet append/update | Deliberately **never blocks a driver's tap** — a failure here is swallowed. |
| Stop-time stats rebuild lock (inline in `stRebuildIfStale_`) | `LockService.getScriptLock()` | `tryLock(1000)` | `STOP_TIMES` sheet rebuild | Best-effort; skipped entirely if busy. |
| Background-sync install lock (inline in `ensureBackgroundSyncTrigger_`) | `LockService.getScriptLock()` | `tryLock(0)` (non-blocking) | Trigger creation | Prevents two simultaneous board loads from both installing the timer. |

### 2.4 Version / fingerprint counters (the "has anything changed" fast path)

Two independent mechanisms answer "did the board/day change since I last
asked", each progressively cheaper than a full re-read — added over several
versions specifically to kill full-sheet reads on every poll:

1. **Board version** (`board:version:v1`, `getScriptCache()`, TTL **21,600s / 6h**): a millisecond timestamp string, bumped by `boardBump_()` on every write-lock release. `getBoardVersion()` is the cheap poll; `syncDispatchIfChanged_` compares it to a cached `dispatchVer:v1` before doing anything more expensive.
2. **Dispatch fingerprint** (`dispatchFp:v1`, script cache, TTL **21,600s**): `dispatchFingerprint_()` reads and hashes (`tripsHash_`, a DJB2-style hash) the **entire 32-column DISPATCH display-value grid**. Only computed when the version check says something *might* have changed, or a hard 60s ceiling (`DISPATCH_FULL_CHECK_MS_`) has elapsed with no other signal (`dispatchFullAt:v1`) — "the safety net for a change that announced itself in neither way."
3. **Per-day trips hash** (`tripCacheKey_(date)+':h'`, document cache, TTL 300s): written alongside the trips-cache payload so `getTripsPageDelta` can tell a polling client "unchanged" from one cache read, without re-hashing a whole day's JSON on every 3-second poll (V120 SPEED note explicitly calls out the old O(day-size) hash-per-poll cost this replaced).
4. **`dfpBusy`** (script cache, TTL 30s) — a mutex flag (not a `LockService` lock) so two simultaneous `syncDispatchIfChanged_` calls don't both run a full `snapshotDispatchToLog`; the loser sleeps 1.2s and re-checks rather than duplicating the write.

### 2.5 The full sequence of a normal dispatcher trip save

`updateTripFromSidebar(trip, changedFields)` (client-facing) →
1. `assertDateNotSubmitted_(trip.date)` — throws if the day is locked as history.
2. Read the **currently stored** trip for this `tripKeyID` (searching today/tomorrow's dispatch window if the save also changes the date) — this is `prevTrip`, needed so pricing and the "did the route move" check compare against truth, not against what the possibly-stale client just sent.
3. `repricePrivatePayTrips_([trip], {tripKeyID: prevTrip})` — re-quote the trip from its own date/time (outside any lock; pure computation + a possibly-cached Maps lookup).
4. **Enter `withTripsDocumentLock_`**:
   a. `sidebarTripService.update(trip, changedFields)` →
      - `tripManager.updateTripInLog(trip, changedFields)`: locate the trip's current LOG row (via `TRIP_INDEX` sheet or a linear scan), `mergeTripFields_` the incoming changed fields onto the **currently stored** record (never a raw overwrite), write destination row first if the date changed, flush, delete from the old row, `invalidateTripsCache_([old, new])`.
      - Find/allocate the DISPATCH row for this `tripKeyID`; `writeTripToDispatchRow_` (writes only the columns this app owns; marks the board dirty for re-sort only if date/time changed).
   b. On unlock: conditional `sortDispatchSheet_()`, then `boardBump_()`.
5. Outside the lock: `syncPassengersFromTrips_([trip])` (merge phone/address into `PASSENGERS`, its own lock), `driverAssignmentAlert_(...)` (notify the driver if the assignment or time changed) — both wrapped in `try/catch` so a notification failure never fails the save.

### 2.6 Locking anti-patterns fixed historically (informs what to avoid in a rebuild)

- Repair functions used to hold the document lock for their **entire multi-minute run**, which would have timed out every concurrent dispatcher save and driver tap — `repairPhantomProgressStampsLocked_` now takes/releases the lock **per 200-row block**, with an explicit six-minute execution budget check (`budgetUntil`) so a long LOG doesn't die mid-run with no record of where it stopped (`out.timedOut` / `out.resumeFromRow`).
- `setTripQuickStatus` used to write DISPATCH status cells with **no lock at all** ("a status could land in the middle of another dispatcher's save or a board re-sort"); it also used to read the key→row map **outside** the lock that then wrote to it, so a re-sort finishing in between could move rows and misdirect the write — both are now inside one lock, read-then-write.

---

## 3. Caching — every key and TTL

All caches are Apps Script `CacheService` (`getDocumentCache()` unless noted `Script`) — process-wide, shared across every user session against this spreadsheet, but capped at 100KB **per value in bytes** (a hard-won lesson, see §7).

| Key pattern | Cache | TTL | Written by | Read by | Value |
|---|---|---|---|---|---|
| `passenger-trips:v4:<date\|'undated'>` | Document | 300s (`TRIP_CACHE_TTL_SECONDS`) | `writeTripsCache_` | `readTripsCache_`, `getTripsByDate` | JSON array of trips for that date, or gzip-prefixed (`GZ:` + base64) if the JSON exceeds ~90,000 bytes |
| `passenger-trips:v4:<date>:h` | Document | 300s | `writeTripsCache_` | `readTripsHashCached_`, `getTripsPageDelta` | `tripsHash_()` of the (pre-gzip) payload — lets a poll answer "unchanged?" with one read |
| `board:version:v1` | Script | 21,600s (6h) | `boardBump_()` | `getBoardVersion()`, `syncDispatchIfChanged_` | `Date.now()` as string |
| `dispatchVer:v1` | Document | 21,600s | `syncDispatchIfChanged_` | same | last-seen board version, to skip the full fingerprint read |
| `dispatchFullAt:v1` | Document | 21,600s | `syncDispatchIfChanged_` | same | timestamp of last full DISPATCH read (enforces the 60s safety-net ceiling `DISPATCH_FULL_CHECK_MS_`) |
| `dispatchFp:v1` | Document | 21,600s | `syncDispatchIfChanged_` | same | `tripsHash_()` of the full 32-col DISPATCH grid |
| `dfpBusy` | Document | 30s | `syncDispatchIfChanged_` | same | mutex flag, not a real lock |
| `submitted-dates:v1` | Document | 60s | `isDateSubmittedCached_` | same | JSON map of submitted dates, mirrors the script property so every poll doesn't hit PropertiesService |
| `passenger-trips:dates:v2` | Document | 120s | `getTripDatesInfo` | same | `{dates: [...], firstDate}` — which days have a real (non-empty) trip, for the date picker's dots |
| `plan:drive:<md5(from\|to)>` | Script | 21,600s success / 300s (`PLAN_DRIVE_FAIL_CACHE_SECONDS_`) failure | `planDriveMinutes_` | conflict/reachability checker | drive minutes only, or `'x'` sentinel for "no route" |
| `plan:drive2:<md5(from\|to)>` | Script | same 21,600 / 300 split | `planDriveInfo_` | pricing mileage lookup | `"minutes\|miles"` pair — deliberately a **different key namespace** than `plan:drive:` so an old bare-number cache entry is never misread as a distance |
| `bgSyncChecked:v1` | Script | 3,600s (or 300s on failure) | `ensureBackgroundSyncTrigger_` | same | guards re-checking trigger existence to at most once/hour per instance |

**In-memory-only (single execution, never cross-request):**
- `SO_TRIPS_MEMO_` — per-execution memo of a day's trips JSON, cleared by `invalidateTripsCache_`.
- `SUBMITTED_MEMO_` — per-execution memo of the submitted-dates map.
- `ST_MAP_` — per-execution memo of the learned stop-time medians (`stMap_`).
- `DISPATCH_WINDOW_MEMO_` — per-execution memo of today/tomorrow's date-key window.
- `_dispatchSheetMemo` / `_logSheetMemo` — per-instance sheet handle memoization on `SidebarTripService`/`TripManager` (avoids repeated `getSheetByName` lookups within one save, called out as a hot path in several "V120 SPEED" comments).

**Explicit historical cache bug** (V120), worth preserving as a rebuild
warning: *"the cache limit is 100KB in BYTES, and this was counting
characters. One em-dash in a pricing note is three bytes, so a day could sail
past the check and then be rejected outright – losing both the day and its
hash."* Fixed by measuring `Utilities.newBlob(payload).getBytes().length`
before the 90,000-byte gzip threshold decision.

---

## 4. Script properties — every persistent key

All via `PropertiesService.getScriptProperties()` (global to the Apps Script project, not per-user).

| Key | Shape | Purpose |
|---|---|---|
| `passengerTrips:dateRows:v1:<sheetId>` | `{ "yyyy-MM-dd": rowNumber }` | Cache of which LOG row currently holds a given date, so a lookup is O(1) instead of a linear scan (`readTripDateRowIndex_`/`rebuildTripDateRowIndex_`). Rebuilt lazily whenever a lookup misses or is stale. |
| `passengerTrips:metrics:v1` | `{ [operation]: { count, totalMs, maxMs, lastMs, lastAt, lastDetails } }` | Server-side timing telemetry, sampled (every call ≥1000ms, else 5% random) via `recordTripMetric_`. Read by `getTripPerformanceMetrics()`, cleared by `resetTripPerformanceMetrics()`. |
| `passengerTrips:submittedDates:v1` | `{ "yyyy-MM-dd": isoTimestamp }` | Which service days have been "submitted" (billing-locked) — see `markDateSubmitted_`/`assertDateNotSubmitted_`. Once a day is here, essentially every mutating trip/standing-order function refuses to touch it. |
| `so-job:<uuid>` | `{ id, kind: 'create'\|'delete'\|'paxdel', dates: [...], done, total, tries, error?, unpriced?, noTrigger?, createdAt, updatedAt, ...kind-specific fields }` | One key **per background job** for standing-order create/delete or passenger-delete trip cleanup that spans more than a few days. Consumed in chunks by `soRunChunk_`/`soWorkJob_`. |
| `standingOrder:titles:v1` | `{ [recurringId]: title }` (max 300 entries, each ≤60 chars, kept in a separate property specifically so titles can never corrupt the pattern map) | Human-readable standing-order names. |
| `privatePay:pricing:v1` | Full pricing config object (§6.6) | The single source of truth for every dollar figure the pricing engine uses. |
| `stopTimes:builtAt:v1` | ISO timestamp string | When `STOP_TIMES` medians were last rebuilt; drives the 12-hour staleness check (`ST_REBUILD_HOURS_`). |
| `lastSnapshotTs` | epoch ms string | Debounce for `snapshotDispatchToLog` — a non-forced, non-alert call is a no-op inside 5 minutes of the last one. |
| `mapItCount` | *(referenced, dead code)* | `countMe()` is a no-op stub; the property read/write is commented out. Listed for completeness only — not actually persisted by current code. |
| `fixDispatchCount` | integer string | Incremented every time the `fixDispatch()` spreadsheet-formatting menu action runs. Pure UI/ops artefact. |

---

## 5. API reference

Every endpoint below is a `function` callable via `google.script.run` from a
client HTML page today. Grouped per the requested taxonomy. Each entry gives
name/file/line, purpose, arguments, return shape, side effects (in write
order), locking, caching, and failure modes, followed by the HTTP endpoint a
rebuild should expose instead.

### 5.1 Trips — read

---
**`getTripsByDate(dateStr)`** — `file_29.js:1374` (thin wrapper over `TripManager.getTripsByDate`, body at line ~1096)
- **Purpose:** Fetch every trip scheduled on one calendar day.
- **Args:** `dateStr` (string, any shape `Utils.formatDateString` accepts, e.g. `"2026-09-12"`) — required.
- **Returns:** `Trip[]` (see §1.1). Only entries with a non-blank `passenger` are included.
- **Side effects:** None on the data; **writes** the per-day cache entry if it was cold (`writeTripsCache_`).
- **Locking:** None (read-only; safe under concurrent writers because it always re-reads on a cache miss).
- **Caching:** Per-execution memo `SO_TRIPS_MEMO_[date]` → document cache `passenger-trips:v4:<date>` (300s) → falls through to a LOG row read via the date→row index.
- **Failure modes:** Never throws; a bad date normalizes to `''` and returns `[]`. Corrupt JSON in a LOG cell is caught and logged, contributing `[]` for that date.
- **HTTP equivalent:** `GET /api/trips?date=2026-09-12`

---
**`getAllTrips()`** — `file_29.js:1376`
- **Purpose:** Every trip in the entire LOG history, across all dates. Used sparingly (full-history operations).
- **Args:** none.
- **Returns:** `Trip[]`, unsorted, one date's worth at a time concatenated (last-row-wins per date).
- **Side effects:** none.
- **Locking:** none.
- **Caching:** none — always a full sheet read (2 columns × every row).
- **Failure modes:** A single corrupt date's JSON is caught, logged, and skipped; the rest of the result is still returned.
- **HTTP equivalent:** `GET /api/trips` (should almost certainly be paginated/date-ranged in a rebuild — this is an expensive full-table scan today).

---
**`getTripById(encodedId, date)`** — `file_29.js:1375`
- **Purpose:** Look up one trip by its (legacy) `id` on a known date, for pages that only carry `id` rather than `tripKeyID`.
- **Args:** `encodedId` (string, URI-encoded), `date` (string).
- **Returns:** the matching `Trip`, or `{}` if not found.
- **Side effects/locking/caching:** identical to `getTripsByDate` (calls it internally).
- **HTTP equivalent:** `GET /api/trips/by-id/:id?date=...`

---
**`getTripActivity(tripKeyID)`** — `file_29.js:1373`, body in `SidebarTripService.getActivity` (~line 1146)
- **Purpose:** A cheap, DISPATCH-only read of one trip's live progress (for a polling detail panel) — scheduled time, dispatcher status, and the four driver-tap timestamps.
- **Args:** `tripKeyID` (string).
- **Returns:** `{ found: boolean, tripKeyID, scheduledTime, driverStatus, pickupArrival, pickupDeparture, dropoffArrival, dropoffDeparture }` — `found:false` shape has all string fields `''`.
- **Side effects:** none.
- **Locking:** none — direct read via `TextFinder` over the DISPATCH trip-key column, capped at `SIDEBAR_DISPATCH_MAX_ROW_ = 100`.
- **Caching:** none (comment: "PRODUCTION_CACHED_ACTIVITY_FALLBACK_V13: keep this endpoint consistent with the polling cache" — i.e. it deliberately reads live rather than a cache, to stay consistent with what `getTripsPageDelta` shows).
- **Failure modes:** returns the `found:false` shape rather than throwing if the trip isn't on the board (e.g. it's beyond the dispatch window).
- **HTTP equivalent:** `GET /api/trips/:tripKeyID/activity`

---
**`getTripDatesInfo()`** — `file_29.js:1406`
- **Purpose:** Which dates should show a dot on the dispatcher's date-picker calendar.
- **Args:** none.
- **Returns:** `{ dates: string[] (sorted yyyy-MM-dd), firstDate: string }`.
- **Side effects:** writes the `passenger-trips:dates:v2` cache.
- **Locking:** none.
- **Caching:** document cache, 120s.
- **Failure modes:** none observed; degrades to scanning if cache is cold.
- **Note (historical bug fixed):** *"This used to list every date that had a ROW in the LOG, which is not the same thing as a date that has trips: a day whose trips were all deleted keeps its row, and so kept its dot, and tapping it showed 'No trips found for this date'. Now a day has to actually contain a trip."* — enforced via the regex prefilter `TRIP_DATES_HAS_TRIP_RE_ = /"passenger"\s*:\s*"\s*[^"\s]/` scanned in 200-row chunks (`TRIP_DATES_CHUNK_ROWS_`) before paying to fully parse JSON.
- **HTTP equivalent:** `GET /api/trips/dates` → `{dates:[...], firstDate}`

---
**`checkDuplicateTrip(trip)`**, **`checkDriverConflict(trip)`**, **`checkPassengerConflict(trip)`** — `file_29.js:1390-1392`
- **Purpose:** Individual pre-save sanity checks (exact-duplicate id match; same driver same time; same passenger same time), superseded in practice by the combined `checkTripConflictsBatch` but still individually callable.
- **Args:** `trip` (Trip-shaped object).
- **Returns:** boolean.
- **HTTP equivalent:** folded into `POST /api/trips/validate` in a rebuild (see `checkTripConflictsBatch` below) rather than three separate endpoints.

---
**`checkTripConflictsBatch(trips, overrideBlacklist, overrideNearDuplicate, excludeTripKeyID)`** — `file_29.js:1715`
- **Purpose:** The single pre-save gate the client actually calls: blacklist check → exact duplicate → passenger-double-booked → driver-double-booked → near-duplicate (same passenger within 20 minutes) → driver-reachability plan warnings. Returns on the **first hard failure**; soft findings (plan warnings) are always computed last and returned alongside a success.
- **Args:** `trips` (Trip or Trip[] — a batch, e.g. an outbound+return pair), `overrideBlacklist` (bool, dispatcher explicitly proceeding past a blacklist warning), `overrideNearDuplicate` (bool), `excludeTripKeyID` (string, so editing a trip doesn't conflict with itself).
- **Returns:** on failure: `{ ok:false, reason: 'blacklist'|'duplicate'|'passenger'|'driver'|'near-duplicate', passenger?, note?, detail? }`. On success: `{ ok:true, warnings: PlanFinding[], checkedDays, ofDays }` (see `checkTripPlan` for `PlanFinding` shape).
- **Side effects:** none (read-only), but pre-warms the per-date trips cache for every date in the batch (`soPrewarmTripsCache_`) when `trips.length > 1`.
- **Locking:** none.
- **HTTP equivalent:** `POST /api/trips/validate` with body `{trips, overrideBlacklist, overrideNearDuplicate, excludeTripKeyID}`.

---
**`checkTripPlan(trips, excludeTripKeyID)`** — `file_29.js:5483`
- **Purpose:** "Can the driver actually get there?" — physically-reachable-in-time check between a trip and its immediate neighbours on the same driver's day, using real drive-time lookups (not just a same-time-slot clash). Only examines the **first** trip of a batch (a standing order's later days would repeat the identical finding and cost a Maps lookup each — not worth 40 lookups on one save).
- **Args:** `trips` (Trip[]), `excludeTripKeyID` (string).
- **Returns:** `{ warnings: PlanFinding[], checkedDays, ofDays }` where `PlanFinding = { kind: 'impossible'|'tight', driver, from: {passenger,time,pickup,dropoff}, to: {...}, ride: minutes|null, transfer: minutes, spare: minutes (negative if impossible), readyAt: "h:mm AM/PM", stops: {pickup,dropoff,pickupWhy,dropoffWhy,pickupLearned,dropoffLearned,pickupTrips,dropoffTrips}, text: plain-English sentence }`.
- **Side effects:** none on data; Google Maps Directions API calls (budgeted, see below), cached.
- **Locking:** none.
- **Caching:** `plan:drive:<md5>` (script cache) — 21,600s on a real answer, 300s on a route failure (V120: *"a failure must not be remembered as long as an answer. Holding 'no distance' for six hours meant one bad moment left every trip on that route unpriceable for the rest of the day."*).
- **Failure modes:** never throws to the client; a Maps failure just drops that particular finding (no route ⇒ "nothing honest to say").
- **Budget:** `PLAN_MAX_LOOKUPS_ = 8` Maps calls max per check call.
- **Stop-time allowance:** uses the **learned** median (§6.7 `planStopInfo_`) when ≥5 (passenger/address) or ≥10 (fleet-wide) completed-trip samples exist in the last 120 days, else the fixed fallback `PLAN_STOP_PICKUP_MIN_=5` / `PLAN_STOP_DROPOFF_MIN_=3`.
- **HTTP equivalent:** folded into the same `POST /api/trips/validate` response (its `warnings` are the plan warnings), or `POST /api/trips/reachability` if kept separate.

### 5.2 Trips — write

---
**`addTripsFromSidebar(trips)`** — `file_29.js:1289`
- **Purpose:** Create one or more new trips (a lone one-way trip, or an outbound+return pair) from the dispatcher's trip form.
- **Args:** `trips` (Trip or Trip[]). Each must have `date`; `tripKeyID` is generated server-side if absent.
- **Returns:** `{ created: number, dispatchRows: number[], dispatchSkipped: number, dispatchDeferred: number, unpriced?: number, passengers?: SyncResult[] }`.
- **Side effects, in order:**
  1. `assertDateNotSubmitted_` per trip (throws before anything else happens if any date is locked).
  2. `repricePrivatePayTrips_` (pure compute + cached Maps call, **outside** the lock).
  3. **Lock** → `sidebarTripService.create`: `tripManager.addTripToLog` (append/merge into the day's LOG JSON, write per-date cache, update `TRIP_INDEX` if maintained) → allocate/claim DISPATCH rows for any trip inside the dispatch window, `clearInheritedDispatchCells_` for fresh rows, write the owned columns.
  4. Outside lock: `syncPassengersFromTrips_` (passengers lock), `driverAssignmentAlert_` per trip (best-effort, swallows errors).
- **Locking:** trips document lock around step 3 only.
- **Failure modes:** throws `Error('This day has been submitted and is locked as history.')` if any trip's date is submitted. `result.unpriced` is set (not thrown) if private-pay pricing couldn't complete — the trip is still saved, with `price:''`.
- **HTTP equivalent:** `POST /api/trips` — body: `Trip | Trip[]`.

---
**`updateTripFromSidebar(trip, changedFields)`** — `file_29.js:1305`
- **Purpose:** Save an edit to an existing trip. **This is the central "field-level merge" endpoint** — see the full sequence walkthrough in §2.5.
- **Args:** `trip` (Trip, must include `tripKeyID`), `changedFields` (string[] — the field *names* the dispatcher actually touched in the UI; omitting it falls back to whole-record overwrite for backward compatibility with an older client).
- **Returns:** `{ updated:true, dispatchRow, dispatchSkipped?, dispatchDeferred?, trip: Trip, unpriced?, passengers? }`.
- **Side effects order:** read stored trip → reprice → lock → merge-and-write LOG → find/allocate/clear/write DISPATCH row (or clear it if the trip moved outside the dispatch window) → unlock (conditional sort + version bump) → sync passengers → driver alert.
- **Locking:** trips document lock.
- **Failure modes:** throws if date submitted; throws `'A tripKeyID is required to update a sidebar trip.'` if missing.
- **Concurrency guarantee (`mergeTripFields_`):** only the named `changedFields` are taken from the incoming payload — everything else is read from **whatever the record currently holds**, so two dispatchers editing different fields of the same trip within the same window never clobber each other. `tripKeyID`, `id`, `status`, `statusAt`, `returnOf`, `recurringId` are hard-PROTECTED and can only be forced through by the server's own internal `overrides` mechanism (used by `setTripQuickStatus` to push `dispatchStatus`/`statusAt`/`status`).
- **HTTP equivalent:** `PATCH /api/trips/:tripKeyID` — body: `{trip, changedFields}`.

---
**`updateTripInLog(trip, changedFields, overrides)`** — `file_29.js:1377`
- **Purpose:** Lower-level than `updateTripFromSidebar` — writes the LOG record only (no DISPATCH board write). Called directly by the DISPATCH `onEdit` sync (`onDispatchEditSyncTrips_`) and by `setTripQuickStatus`.
- **Args:** `trip`, `changedFields` (string[]), `overrides` (object of forced field values — only `status`, `statusAt`, `dispatchStatus` may pass the PROTECTED guard, per `FORCEABLE_`).
- **Returns:** the merged `Trip`.
- **Locking:** trips document lock.
- **Historical bug called out in the comment:** *"the field list used to be dropped here, so onDispatchEditSyncTrips_ fell into mergeTripFields_'s whole-record path and erased every field that lives only in the LOG (price, pricing, stop notes, milesOverride)."*
- **HTTP equivalent:** internal-only in a rebuild — not a public endpoint; folded into the DISPATCH-edit webhook handler and the quick-status endpoint.

---
**`deleteTripFromSidebar(tripKeyID, date)`** — `file_29.js:1343`
- **Purpose:** Delete one trip (from both LOG and DISPATCH), and — if it was the last trip carrying its `recurringId` — retire the standing-order pattern.
- **Args:** `tripKeyID` (string), `date` (string).
- **Returns:** `{ deleted:true, dispatchRow, patternRemoved: boolean }`.
- **Side effects order (inside lock via `sidebarTripService.delete`):** find the DISPATCH row → capture the trip's `recurringId` before deleting → `deleteTripFromLog` (also deletes any return leg whose `returnOf` points at this trip's `id`) → clear the DISPATCH row (formulas preserved) → `soFinalizeStandingOrderDelete_`.
- **Failure modes:** throws if date submitted; throws if no `tripKeyID`.
- **HTTP equivalent:** `DELETE /api/trips/:tripKeyID?date=...`

---
**`deleteTripFromLog(id, date)`** — `file_29.js:1383`
- **Purpose:** LOG-only delete (no DISPATCH interaction) — internal building block.
- **HTTP equivalent:** internal only.

---
**`setTripQuickStatus(tripKeyID, value, singleLegOnly, dateKey)`** — `file_29.js:1534` (240+ lines — the single most complex write path in the codebase)
- **Purpose:** The one-tap status buttons on the board/driver app: `READY`, `NOT CONFIRMED`, `REASSIGN`, `UPDATE TIME`, `COMPLETE`, `CANCEL`, `NO SHOW`, or clear (`''`).
- **Args:** `tripKeyID`, `value` (must be one of the allowed set, case/whitespace-normalized, else throws `'Unsupported status: ...'`), `singleLegOnly` (bool — true for a driver's own phone, so cancelling never takes an unrelated driver's linked return leg with it), `dateKey` (string — **required for correctness**; a page that sends nothing defaults to today, which used to silently misfile a status set while viewing any other day, fixed in V121).
- **Returns (several distinct shapes):**
  - Not on board and not in today's records: `{ ok:false, reason:'notfound', status, boardWritten:false, message }`.
  - Board written but LOG record write failed: `{ ok:false, reason:'record', message, status, boardWritten:true }`.
  - Success: `{ ok:true, status, linkedCount: number }`.
- **Side effects, in exact order:**
  1. Validate + resolve `dayKey`, `assertDateNotSubmitted_`.
  2. Determine `targetKeys` — for `CANCEL`/`REASSIGN`/`NOT CONFIRMED` on a non-single-leg call, walks the day's trips to find the linked return/outbound leg via `id`/`returnOf` matching (`PRODUCTION_LINKED_TERMINAL_STATUS_V14`).
  3. Determine `restoreKeys` — if the *primary* leg is being set back to an active state (`''`, `READY`, `UPDATE TIME`, `COMPLETE`), any return leg that was auto-cancelled/auto-not-confirmed has that state cleared (`AUTO_RESTORE_RETURN_V15`).
  4. **Lock**: read `tripKeyID → row` map fresh (must be inside the lock — see §2.6), write column `TODAY` (dispatcher status) + `STATUS_AT` stamp for every target row, clear for restore rows, and if setting `READY` while on-board, stamp the `TIME` cell with `new Date()` (a UI affordance — "picked up now"). `SpreadsheetApp.flush()`.
  5. If on-board: `snapshotDispatchToLog(false, true)` (forced) so the LOG mirrors the just-written board immediately.
  6. **Lock again**: for every target/restore key, `tripManager.updateTripInLog(..., ['dispatchStatus','statusAt'] or [...,'status'], overrides)`, and build `ttToRecord` entries.
  7. Outside lock: `tripTimesRecord_(t)` for each `ttToRecord` entry (own 5s try-lock, never throws).
  8. If `CANCEL`/`REASSIGN`: another lock pass to push `status`/`dispatchStatus` onto any linked leg that has **no** DISPATCH row (LOG-only, because the 100-row board is full) — "A linked return may live only in the LOG when the 100-row Dispatch limit is full."
  9. `driverCancelAlert_` per affected trip (best-effort).
- **Locking:** trips document lock, taken **three separate times** in sequence (board write, record write, linked-leg record write) rather than once — each is short and the intermediate `snapshotDispatchToLog` needs to run between the first two.
- **Failure semantics (explicitly designed, not accidental):** the function distinguishes "board updated, record failed" from total failure and **reports it rather than either silently succeeding or throwing** — quoted directly: *"Throwing here would be just as wrong in the other direction – the board HAS been written by this point – and a throw on this path also reaches the driver app, where it jams that phone's queue. Report exactly what happened and let the caller decide."*
- **HTTP equivalent:** `POST /api/trips/:tripKeyID/status` — body `{value, singleLegOnly, date}`. A rebuild should preserve the tri-state response (`ok:true` / `ok:false,reason:'notfound'` / `ok:false,reason:'record'`) rather than collapsing to a single success/failure boolean — that distinction is load-bearing for the UI's error messaging.

---
**`addTripToLog(trip)`** — `file_29.js:1277`
- **Purpose:** Raw LOG-only append/merge, no DISPATCH interaction, no reprice, no conflict check. Internal building block, exposed at top level mainly for legacy/console use.
- **HTTP equivalent:** internal only.

### 5.3 The board (DISPATCH sheet ↔ trip records)

---
**`getTripsPageData(dateStr, refreshToday)`** — `file_24.js:420`
- **Purpose:** The main polling read for the dispatcher's Passenger-Trips page: today's data optionally forced through a fresh DISPATCH→LOG snapshot first.
- **Args:** `dateStr`, `refreshToday` (bool — only meaningful when `dateStr` is today; forces `maybeSnapshotDispatchToLog()` before answering).
- **Returns:** `Trip[]`.
- **Side effects:** may run `snapshotDispatchToLog(false)` (rate-limited to once per 5 min unless forced elsewhere).
- **HTTP equivalent:** superseded by `getTripsPageDelta` in newer client code (below); a rebuild only needs the delta version.

---
**`getTripsPageDelta(dateStr, clientHash, refreshToday, force)`** — `file_24.js:510`
- **Purpose:** **The actual polling endpoint** the board/passenger-trips page calls every few seconds. Answers "has today's data hash changed since you last saw `clientHash`" as cheaply as possible, and lazily installs the background-sync trigger on the side.
- **Args:** `dateStr`, `clientHash` (string, the hash the client last received), `refreshToday` (bool), `force` (bool — dispatcher pressed "Refresh"; also bypasses the client-hash short-circuit).
- **Returns:** either `{ unchanged:true, hash, submitted:boolean }` or `{ unchanged:false, hash, trips: Trip[], submitted:boolean }`.
- **Side effects:** `ensureBackgroundSyncTrigger_()` (idempotent, cheap after first call); if `refreshToday && dateKey===today`, calls `syncDispatchIfChanged_(force)` which may run a full `snapshotDispatchToLog`.
- **Caching:** reads `readTripsHashCached_` first (cheapest path); falls back to the raw payload cache; falls back to a full `getTripsByDate`.
- **HTTP equivalent:** `GET /api/trips/delta?date=...&hash=...&force=false` — in a rebuild this maps naturally onto a WebSocket/SSE push or an ETag/If-None-Match HTTP caching pattern instead of polling, but the **semantics** (server-computed content hash, cheap unchanged check, optional forced bypass) should be preserved.

---
**`sortDispatchBoard()`** — `file_29.js:5271`
- **Purpose:** Manually force a board tidy (date-then-time order) without saving anything.
- **Args:** none. **Returns:** `true`.
- **Side effects:** sets the deferred-sort flag; the actual sort (`sortDispatchSheet_`) runs on lock release.
- **HTTP equivalent:** `POST /api/board/sort` — **spreadsheet-shaped concept**: in a rebuild with a real database, "sort order" is a query-time `ORDER BY date, time`, not a stored physical row order. This entire function and the whole `sortDispatchSheet_`/`dispatchWritableRuns_`/`dispatchNeedsSort_` machinery is a **spreadsheet artefact** that should not be rebuilt as-is (see §8) — it exists only because DISPATCH is a fixed 100-row grid with formula columns that must "travel with" their row.

---
**`getBoardVersion()`** / **`getServerClock()`** — `file_29.js:324` / `315`
- **Purpose:** `getBoardVersion` — cheap polling primitive (§2.4). `getServerClock` — gives the client both the server's `now` (epoch ms) and `clock` (wall-clock string in the spreadsheet's timezone) so a phone can correct **both** its clock skew and its timezone against driver-progress stamps, which the comment says is necessary because progress stamps arrive as bare local-looking strings with no zone info: *"the office's clock, for a board that cannot trust the machine it is running on."*
- **Returns:** `getServerClock` → `{ now: number, clock: "yyyy-MM-ddTHH:mm:ss" }`.
- **HTTP equivalent:** `GET /api/board/version`, `GET /api/server-time`.

---
**`snapshotDispatchToLog(isAlert, force)`** — `file_24.js:66`
- **Purpose:** **The reconciliation engine.** Reads the entire DISPATCH grid and merges it into the LOG record for each date represented, one date at a time — this is what makes a raw edit typed directly into the spreadsheet (or a driver-app tap that only touches DISPATCH) show up in the trip record.
- **Args:** `isAlert` (bool — show a UI toast on completion; also bypasses the 5-minute debounce), `force` (bool — bypass the debounce without a toast).
- **Returns:** `boolean` (`true` if it actually ran and wrote something).
- **Side effects, in order (inside the trips lock):**
  1. Read `DISPATCH!A2:AG<lastRow>` in one call.
  2. For each row with a non-blank passenger and a date ≥ today: generate a fresh `tripKeyID` if missing/duplicated within this pass (writes back into the in-memory grid, batched to column K at the end); default a blank `TIME` cell to the `23:58` sentinel.
  3. Group by date; for each date, read the current LOG JSON, and **for every trip on the board, look up the existing LOG record by `tripKeyID`, falling back to a match by legacy `id`** if the key lookup misses (covers the case where a formula-column-driven key got regenerated) — then carry over every field that has **no DISPATCH column**: `id`, `returnOf`, `recurringId`, `pickupNotes`, `dropoffNotes`, `privatePay`, `price`, `pricing`, `milesOverride`, `deadheadMiles`.
  4. Write the merged LOG JSON back only if it actually changed; refresh `TRIP_INDEX` for that date; refresh the per-date trips cache.
  5. `props.setProperty('lastSnapshotTs', ...)`.
- **Locking:** trips document lock (checks the debounce **again** inside the lock, in case two callers raced to the outer check).
- **Debounce:** 5 minutes (`5 * 60 * 1000` ms) unless `isAlert` or `force`.
- **Global side channel:** stashes its result in module-level `passengerTripsSnapshotResult_` so the immediately-following `getTripsPageData` call in the same request can reuse the just-computed trips for `today` without a second read.
- **Historical bug fixed here (quoted verbatim):** *"PRODUCTION_PRESERVE_LINK_IDENTITY_V14: Dispatch formulas must not replace the stable ID used by returnOf"* and *"a board row with a blank or duplicated key gets a fresh UUID a few lines above, which used to make this lookup miss – so the trip was re-added with no price and the priced original was left orphaned in the record. Fall back to the trip's own stable id."*
- **HTTP equivalent:** `POST /api/board/reconcile` (internal/cron-triggered in a rebuild, not user-facing) — but see §8: in a proper database-backed system, DISPATCH and LOG would simply be **the same row**, and this entire reconciliation would not need to exist at all. It is the single largest "spreadsheet tax" function in the codebase.

---
**`dispatchFingerprint_()`** *(private but load-bearing — full spec)* — `file_24.js:446`
- **Purpose:** Cheap-as-possible "did the physical board change" detector.
- **Returns:** `tripsHash_(JSON.stringify(displayValuesGrid))` — a hash of the **display values** (not underlying values) of `DISPATCH!A2:AF<lastRow>`.
- **HTTP equivalent:** internal-only; folded into the polling/webhook design.

---
**`syncDispatchIfChanged_(force)`** *(private but load-bearing)* — `file_24.js:460`
- **Purpose:** Orchestrates the version→fingerprint→snapshot cascade described in §2.4, and calls `captureDriverStatusTransitions_()` (external module) first, on every invocation, to capture first-seen driver-status transitions before anything else touches the row.
- **HTTP equivalent:** internal-only; this is the cron/webhook body in a rebuild.

---
**`onDispatchEditSyncTrips_(e)`** — `file_24.js:625` — **Apps Script `onEdit` simple/installable trigger, not client-callable.**
- **Purpose:** Instant sync when a human hand-edits a cell directly in the DISPATCH sheet (bypassing the app entirely) or the driver's own polling write touches a cell.
- **Args:** the Apps Script edit event `e` (`e.range`, `e.range.getSheet()`).
- **Behavior:** ignores edits outside DISPATCH or past column 33 (V120 fixed a bug where column 33, "Status At", was invisible to this trigger because the check stopped at 32); ignores > 20 rows at once by falling back to a full `snapshotDispatchToLog(false, true)` instead of processing row-by-row; otherwise, for each edited row with a passenger and a trip key, converts the row to a trip object, fixes timezone-naive driver-stamp strings to true wall-clock ISO (**V120**: *"Left alone, correcting a phone number in another column shifted every progress time on that trip by the timezone offset"*), and calls `updateTripInLog` with `changedFields` limited to exactly `DISPATCH_OWNED_FIELDS_` (plus `status`/`statusAt` **only** if those specific columns were the ones edited) — this field-scoping is what stops a random cell edit from wiping LOG-only fields (price, pricing, stop notes, mileage override).
- **Locking:** wraps the **entire batch of edited rows** in one `withTripsDocumentLock_` call — historical bug: *"Each [call to updateTripInLog] waited up to fifteen seconds and threw on timeout, so a paste across several rows on a busy morning could stall for minutes and then abort halfway, syncing some rows and silently not others. The lock is re-entrant, so taking it once around the whole batch makes the inner calls free and the whole edit all-or-nothing."*
- **HTTP equivalent:** in a rebuild with no spreadsheet, this trigger simply **does not exist** — its entire purpose (reconciling a spreadsheet UI edit into the "real" record) collapses into "the write already went to the one real table." Pure spreadsheet artefact (§8), but its **field-ownership list** (`DISPATCH_OWNED_FIELDS_`) is a useful reference for which fields a "board view" vs. "full trip record" API should expose as writable vs. read-only.

---
**`restoreDispatchFromLog(date)`**, **`promptRestoreSnapshotByDate()`**, **`deleteTodaysLogsThenUpdateSnapshotDispatchToLog()`**, **`applyCleanupNow()`**, **`maybeSnapshotDispatchToLog()`** — `file_24.js` various
- **Purpose:** Ops/admin tools: rebuild the DISPATCH board from a LOG day's snapshot (disaster recovery after board corruption), interactively (via `SpreadsheetApp.getUi().prompt`), force-clear-then-resnapshot today, or trigger a snapshot without the 5-minute debounce.
- **UI coupling:** `restoreDispatchFromLog` and `promptRestoreSnapshotByDate` call `SpreadsheetApp.getUi().alert/prompt` directly — **these are spreadsheet-menu functions, not callable from a client web page** at all (they'd throw `no UI` in a web-app context). Listed here for completeness since they are part of the board's operational surface, but flagged for §8.
- **HTTP equivalent:** `restoreDispatchFromLog(date)`'s *logic* (rebuild today's/any day's live board state from the historical record for that date) maps to `POST /api/board/restore {date}` in an admin tool, with the UI confirmation moved to the client.

---
**`archiveAndCompactTripLog()`**, **`analyzeTripLogCompaction()`**, **`installWeeklyLogCompactionTrigger()`** — `file_24.js:333/307/777`
- **Purpose:** Because LOG accumulates duplicate/superseded rows per date over time (old writes never delete a row, only add a newer one and let "last wins" logic paper over it), this periodically **archives every superseded/blank row to a hidden `LOG_ARCHIVE` sheet and rewrites LOG as one canonical row per date**, then rebuilds the date-row index and the `TRIP_INDEX` sheet from scratch. Installed as a **weekly trigger, Sundays ~3 AM** (`installWeeklyLogCompactionTrigger`).
- **Returns (`archiveAndCompactTripLog`):** `{ sourceRows, canonicalRows, archivedRows, indexedTrips }`.
- **Locking:** full trips document lock for the entire operation (acceptable at 3 AM).
- **HTTP equivalent:** a scheduled maintenance job in a rebuild (`cron: compactTripLog`) — but note: this entire category of function exists **only** because of the "append new row per date, never update in place" LOG storage design. A real database with an upsert-by-date-and-tripKeyID model needs no compaction step at all. **Spreadsheet artefact category**, see §8.

### 5.4 Standing orders

---
**`getStandingOrderMap()`** / **`updateStandingOrderMap(map)`** — `file_29.js:1386-1389`
- **Purpose:** Raw read/write of the entire `{recurringId: {pattern, title?}}` map stored in `LOG!A1`.
- **Locking:** `updateStandingOrderMap` takes the trips lock (it's a LOG-sheet write).
- **HTTP equivalent:** `GET /api/standing-orders`, and folded into the create/delete endpoints below rather than exposed as a raw map write in a rebuild.

---
**`createStandingOrderFromSidebar(parentTripKeyID, standingOrder, parentRow, dates, extras)`** — `file_29.js:2490`
- **Purpose:** Create a new recurring pattern from a trip the dispatcher just built, expanding it across `dates`.
- **Args:** `parentTripKeyID`, `standingOrder` (`{pattern, title}` or falsy for a one-off multi-date save that isn't really "standing"), `parentRow` (legacy row-array shape, used as the template), `dates` (string[]), `extras` (`{privatePay, milesOverride, deadheadMiles, pickupNotes, dropoffNotes, startTime}` — only these fields, see `SO_EXTRA_FIELDS_`, are propagated across every day; **price/pricing are deliberately excluded and recomputed per day** — quoted: *"A Saturday carries a weekend surcharge a Monday does not, so copying the first day's figure across the series would under-bill every one of them."*).
- **Returns:** `{ created, immediate, queued, jobId, dispatchSkipped, dispatchDeferred, unpriced }`.
- **Side effects order:** sync the parent passenger → **lock** → store the pattern in the standing-order map (+title) → write the **first date only** immediately (`sidebarTripService.createRecurring`) → apply `extras` + reprice that first date → **enqueue every remaining date as a background job** (`soEnqueueLocked_`) if there's more than one date, or if it's a true recurring pattern (`isStanding`).
- **Split rule (`soSplitDates_`):** a **real recurring pattern** always writes only the first (earliest) date synchronously and queues the rest; a plain multi-date one-off (no pattern) writes **all** dates synchronously. This is `allNow` in `soSplitDates_`.
- **HTTP equivalent:** `POST /api/standing-orders` — body `{parentTrip, pattern, title, dates, extras}` → `{created, immediate, queued, jobId}`; client then polls the job endpoint below.

---
**`getStandingOrderJobStatus(jobId)`** — `file_29.js:2898`
- **Purpose:** Poll a background create/delete job's progress, **and opportunistically do a small chunk of work itself** so progress moves even before the timer trigger wakes up (which can take 30–90s).
- **Args:** `jobId`.
- **Returns:** `{ found, done, total, completed, remaining, error, kind }`.
- **Locking:** `withTripsDocumentTryLock_(3000, ...)` — a **short try-lock**, not the normal 15s wait, "because the page asks about once a second while a standing order runs" and must never itself become the thing a save is blocked behind.
- **Side effects:** may do up to `SO_POLL_BATCH_ = 3` dates of work per poll; calls `boardBump_()` once at the end if it did any work (not per date).
- **HTTP equivalent:** `GET /api/jobs/:jobId` (poll) — in a rebuild this becomes a real job queue (or the whole multi-day expansion becomes a single fast bulk-insert, removing the need for background chunking entirely, since a real DB doesn't have Apps Script's ~6-minute execution ceiling).

---
**`retryStandingOrderJob(jobId)`** — `file_29.js:2849`
- **Purpose:** Clear a job's error/try-count so it resumes (jobs auto-fail after 3 tries: `soWorkJob_`'s catch block).
- **HTTP equivalent:** `POST /api/jobs/:jobId/retry`

---
**`listFailedStandingOrderJobs()`** — `file_29.js:2863`
- **Purpose:** Every job stuck with an error, an unpriced date, or a lost trigger (`noTrigger`), for an ops dashboard.
- **Returns:** `{id, kind, remaining, total, done, error, unpriced, updatedAt}[]`.
- **HTTP equivalent:** `GET /api/jobs?status=failed`

---
**`sweepOrphanStandingOrders()`** — `file_29.js:2751`
- **Purpose:** Callable clean-up for standing-order patterns with **zero trips left anywhere** (leftovers from deletes that finished before the auto-retire logic existed). Capped at `SO_SWEEP_MAX_PATTERNS_ = 40` patterns per call (skips entirely, returning nothing removed, if there are more than 40 — a safety valve against an expensive scan).
- **HTTP equivalent:** `POST /api/standing-orders/sweep-orphans`

---
**`getStandingOrderTripsFrom(recurringId, fromDateKey, excludeTripKeyID)`** — `file_29.js:1772`
- **Purpose:** "Apply to all future days of this order" support — list every trip on or after `fromDateKey` that carries this `recurringId`, so the dispatcher can pick which days to bulk-edit.
- **Returns:** array of light trip summaries with a `locked` flag per submitted date. Bounded to `SO_SPREAD_HORIZON_DAYS_ = 180` days ahead **only when the order has no decodable pattern** (legacy orders); a pattern-backed order looks only at its own pattern dates, which is far cheaper.
- **HTTP equivalent:** `GET /api/standing-orders/:recurringId/trips?from=...`

---
**`applyStandingOrderEdit(recurringId, items, fields)`** — `file_29.js:1839`
- **Purpose:** Bulk-apply a set of field changes across many days of one standing order in one call (batched sheet I/O — "trip by trip cost about fifteen seconds each").
- **Args:** `recurringId`, `items` (`{tripKeyID, date}[]` — which specific trip instances to touch), `fields` (object of field→value; `SO_MASS_EDIT_BLOCKED_` = `date, tripKeyID, id, status, statusAt, returnOf, recurringId, price, pricing` can never be mass-applied).
- **Returns:** `{ updated, skipped, locked, dispatchSkipped, fields, unpriced? }`.
- **Side effects order (one lock, one pass):** group requested items by date → for each date, read LOG row once, for each trip apply `mergeTripFields_` (skipping return-leg-inappropriate fields like `pickup`/`dropoff`/`time` via `SO_RETURN_LEG_SKIP_` when the trip is a return leg) → if `pickup`/`dropoff` changed, **drop the stale cached mileage** before repricing → `repricePrivatePayTrips_` for the whole day's touched trips → write the day → after all dates: one batched read+write pass over DISPATCH for any trips currently on the board.
- **HTTP equivalent:** `PATCH /api/standing-orders/:recurringId/trips` — body `{items, fields}`.

---
**`renameStandingOrder(recurringId, title)`** — `file_29.js:3170`
- **HTTP equivalent:** `PATCH /api/standing-orders/:recurringId {title}`

---
**`createRecurringTripsFromSidebar(parentTrip, dates)`** / **`deleteRecurringTripsFromSidebar(recurringId, dates)`** — `file_29.js:1300`, `1347`
- **Purpose:** Lower-level create/delete across explicit dates (used by `createStandingOrderFromSidebar` internally, but also independently callable — e.g. delete deals with the same near/later job split via `soSplitDates_`).
- **`deleteRecurringTripsFromSidebar` returns:** `{ deleted, immediate, queued, jobId, result, tripsRemoved, patternRemoved, repeatStillActive, orphansCleared }` — also runs `soSweepOrphanPatterns_()` as a side effect on every call.
- **Failure modes:** both throw `'Those days have been submitted and are locked as history.'` if every requested date is submitted (`filterUnsubmittedDates_` strips submitted ones first, but throws only if *none* remain).
- **HTTP equivalent:** folded into `POST /api/standing-orders/:recurringId/trips` (create) and `DELETE /api/standing-orders/:recurringId/trips` (delete) with a `dates` body.

### 5.5 Passengers

---
**`getPassengerDirectory()`** — `file_29.js:3022`
- **Returns:** `{name, medicaid, type, phones[], addresses[], blacklisted, blacklistReason, blacklistedBy}[]`, sorted case-insensitively by name.
- **HTTP equivalent:** `GET /api/passengers`

---
**`savePassengerFromDirectory(originalName, profile, changedFields)`** — `file_29.js:3046`
- **Purpose:** Create-or-update-or-rename one passenger from the directory editor, with the same field-level merge discipline as trips.
- **Args:** `originalName` (string — the name the row had when opened, so a rename can still find the row), `profile` (`{displayName, medicaid, type, phones[], addresses[], blacklisted, blacklistReason}`), `changedFields` (string[]).
- **Returns:** the saved profile plus `renamedFrom` if the name changed.
- **Side effects:** if flagging as blacklisted for the first time, stamps `blacklistedBy = currentDispatcherLabel_()`; re-sorts the sheet on rename or new insert; invalidates the form-options cache.
- **Locking:** passengers lock.
- **Failure modes:** throws if `displayName` blank; throws if flagging blacklisted with a reason under 3 characters; throws `'<name> already exists on the passenger list.'` on a rename collision.
- **HTTP equivalent:** `PUT /api/passengers/:originalName` — body `{profile, changedFields}`.

---
**`deletePassengersFromDirectory(names)`** — `file_29.js:2315`
- **Purpose:** Soft-delete (moves the row to a hidden `PASSENGER_TRASH` sheet for `PASSENGER_TRASH_DAYS_ = 3` days) plus best-effort removal of that passenger's **future** trips.
- **Returns:** `{ deleted[], missing[], trashed, pruned, tripDates?, tripDatesLocked?, tripsDeleted?, jobId?, queued?, immediate?, tripError? }`.
- **Side effects order:** passengers lock → write to `PASSENGER_TRASH` **before** deleting from `PASSENGERS` (*"a failure half way through can only ever leave an extra copy, never lose one"*) → delete rows → invalidate form-options cache → prune trash rows older than 3 days → **release the passengers lock**, then separately clear that passenger's future trips (`paxRemoveFutureTrips_`) — first `PAX_TRIP_FIRST_BATCH_ = 2` days synchronously, remainder via the same background-job mechanism as standing orders (`kind:'paxdel'`).
- **Note:** trips **before today**, and any **submitted** day, are never touched — "the record the invoices and payroll are read from."
- **HTTP equivalent:** `DELETE /api/passengers` — body `{names}`.

---
**`restorePassengersFromTrash(names)`** — `file_29.js:2374`
- **Purpose:** Undo a delete within the 3-day trash window. Not wired to any button in the current UI — "here so a mistake within the three days can be undone without retyping anything" — but fully functional and callable.
- **HTTP equivalent:** `POST /api/passengers/restore` — body `{names}`.

---
**`getPassengerTrips(passengerName, days)`** — `file_29.js:1959`
- **Purpose:** One passenger's trips within a rolling window (default `PASSENGER_TRIPS_DEFAULT_DAYS_ = 90` days back through the future) — the Passengers page's default view.
- **Returns:** `{ name, trips[], from, days, truncated, earliestOnRecord }`. `truncated:true` means real history exists further back than the requested window.
- **HTTP equivalent:** `GET /api/passengers/:name/trips?days=90`

---
**`getPassengerTripHistory(passengerName)`** — `file_29.js:2060`
- **Purpose:** **Every** trip a passenger has ever had, full stop — needed for the calendar heat-map and search. Optimized to avoid parsing the whole LOG: pre-filters on the longest word in the name (usually the surname) as a plain substring test on the raw JSON text before paying to `JSON.parse` + decode each candidate day (`ptHistoryNeedle_`, `PT_HISTORY_CHUNK_ROWS_ = 200`).
- **Returns:** `{ name, trips[] (each with pickup/dropoff/vehicle/driver/notes/status/timestamps/isReturn/past/locked), orders: {recurringId: title}, full:true, scannedRows, readRows, ms }`.
- **HTTP equivalent:** `GET /api/passengers/:name/history` — in a rebuild with an indexed `passenger` column this becomes a trivial query; the needle-prefilter trick here is purely a workaround for "the datastore is a spreadsheet cell full of JSON text" (§8 candidate).

---
**`getPassengerUpcomingCounts(names)`** — `file_29.js:2171`
- **Purpose:** How many trips (today or later) each of a list of passengers still has — used before a bulk delete to warn the dispatcher.
- **HTTP equivalent:** `POST /api/passengers/upcoming-counts` — body `{names}`.

### 5.6 "Needs Scheduling" (pending trips)

A trip the dispatcher knows about but cannot yet place on a real day/time —
deliberately **not** stored as a real trip (a guessed day would either fall
off the 2-day DISPATCH window or, if faked, risk locking as history; a
guessed time would hit the same `23:58` blank-time bug documented in §7).
Stored on its own hidden `PENDING_TRIPS` sheet, all columns as `@`
(text)-formatted so Sheets never coerces a partial date/time into a serial number.

---
**`listPendingTrips()`** — `file_29.js:3819` → `{items: PendingItem[], today}`
**`savePendingTrip(input)`** — `file_29.js:3850` → create-or-update by `id`; throws if passenger blank; throws if the list is at `PENDING_TRIPS_MAX_ = 500`; preserves `createdAt`/`createdBy`/chase history across an update.
**`touchPendingTrip(id)`** — `file_29.js:3901` → stamps `lastChasedAt`/`lastChasedBy` ("somebody followed up today"); throws if the row is gone.
**`deletePendingTrip(id)`** — `file_29.js:3918` → idempotent delete; `{ok:true, deleted:0}` if already gone rather than an error.

- **PendingItem shape:** `{id, createdAt, createdBy, passenger, phone, medicaid, invoice, transport, pickup, dropoff, vehicle, notes, pickupNotes, dropoffNotes, targetDate, targetTime, neededBy, returnWanted, lastChasedAt, lastChasedBy, updatedAt}`.
- **Locking:** `withPendingLock_` — its own script lock, 10s wait, independent of trips/passengers locks.
- **HTTP equivalent:** `GET /api/pending-trips`, `POST /api/pending-trips`, `POST /api/pending-trips/:id/chase`, `DELETE /api/pending-trips/:id`.

### 5.7 Pricing (private-pay quoting engine)

The whole engine is **pure** given `(trip, config, options)` — no sheet reads,
no clock inside `ppQuote_` itself — which is exactly what makes
`repricePrivatePayTrips_` safe to call from every write path without fear of
side effects. Only applies when `trip.privatePay` is truthy; every other
billing type (insurance, Medicaid, broker, facility) never touches this code.

---
**`getPricingSettings()`** — `file_29.js:4649` → `{config, rules: PRICING_RULES_, transports: PRICING_TRANSPORTS_}` — everything the settings screen needs to render.
**`pricingConfig()`** — `file_29.js:4598` → the resolved config alone (defaults filled in against `pricingDefaults_()` so a half-written or old-shape stored config can never crash a quote).
- **Config shape:**
```
{
  version: number, updatedAt: iso, updatedBy: string,
  base: { ambulatory, wheelchair, stretcher, taxi, other },   // dollars
  mileage: { mode: 'auto'|'off', includedMiles, perMile, minimumFare },
  deadhead: { mode: 'off'|'optional', includedMiles, perMile },     // dispatcher-typed miles only, never measured
  wait: { mode: 'auto'|'optional'|'off', graceMin, intervalMin, rate },
  afterHoursFrom: "HH:mm", afterHoursTo: "HH:mm",   // wraps midnight
  holidays: ["yyyy-MM-dd", ...],   // max 60
  rules: { <ruleKey>: { mode: 'auto'|'optional'|'off', kind: 'fixed'|'percent', amount } }
}
```
- **Rule catalogue (`PRICING_RULES_`, 23 fixed keys):** grouped `Scheduling` (afterHours*, weekend*, holiday*, sameDay, shortNotice), `Assistance` (doorToDoor, doorThrough, stairs, attendant, companion, extraPax), `Equipment` (bariatric, oxygen, powerChair, equipment), `Trip` (extraStop, waitReturn), `Pass-through` (tolls, parking), `Other` (cleaning, custom), `Discounts` (recurring*, facility, otherDisc) — `*` = system-detectable (`auto:true`); everything else can only be `optional` or `off`, enforced server-side even if a client tries to set `mode:'auto'` on a non-auto rule (`pricingConfig`/`savePricingSettings` both silently downgrade it to `'optional'`).

---
**`savePricingSettings(input)`** — `file_29.js:4712`
- **Purpose:** Validate and persist a new config. **Refuses to save invalid input outright** with plain-English problem strings (`pricingProblems_`), rather than silently coercing bad values — this function is dense with historical near-miss bugs, quoted directly because they're exactly the class of bug a rebuild must re-guard against:
  - *"Number('') is 0 and isFinite(0) is true, so a blank box used to read as a real zero and the fallback never fired. A cleared base-fare box then quoted every trip at nothing."* → `pricingNum_` now special-cases blank/`-`/`.` strings.
  - *"a time typed as '7pm' or '19.00' was silently thrown away and the old window kept, so a dispatcher believed a change had taken effect when it had not."* → after-hours times are now validated with `/^([01]\d|2[0-3]):[0-5]\d$/` and **rejected outright** if malformed or blank, rather than falling back silently.
  - *"0.15 typed for a 15% rule charged fifteen hundredths of one percent."* → any percent rule with `0 < amount < 1` is now flagged as a probable decimal/percent confusion.
  - *"this used to start from the factory defaults, so any field an older or half-loaded page did not send was silently reset to the shipped number rather than keeping the operator's own."* → `next` is now deep-cloned from the **current stored config**, not `pricingDefaults_()`.
- **Args:** `input` — a partial or full config object (only present top-level keys are applied; `base` fields are validated individually and any blank one blocks the entire save with a specific message rather than silently keeping the old value).
- **Returns:** `{ok:true, config}` or `{ok:false, problems: string[], config?}` (the invalid save never touches the stored property).
- **Side effects on success:** `version` incremented, `updatedAt`/`updatedBy` stamped, written to `privatePay:pricing:v1`.
- **HTTP equivalent:** `GET /api/pricing/settings`, `PUT /api/pricing/settings` (returning `422` with the `problems` array on validation failure).

---
**`getPrivatePayQuote(trip, manual, dropped)`** — `file_29.js:5076`
- **Purpose:** The one call the pricing sheet UI makes live as a dispatcher edits a trip — full quote breakdown plus which optional rules are still available to add.
- **Args:** `trip` (Trip-shaped, must have `privatePay` truthy to get a real quote), `manual` (string[] of rule keys the dispatcher has explicitly added), `dropped` (string[] of rule keys the dispatcher has explicitly removed even though they'd auto-apply).
- **Returns:** `{privatePay:false}` if not a private-pay trip, else `{ privatePay:true, quote: Quote, options: Option[], configVersion }`.
- **`Quote` shape:** `{ total, incomplete: boolean, lines: [{key,label,detail,amount,source:'auto'|'manual'}], transport, miles, deadheadMiles, configVersion, manual[], dropped[], quotedAt }`.
- **`Option` shape (what "Add to this trip" offers):** every rule that's `mode!=='off'`, not already applied, with `amount!==0`, excluding rules already used — `{key,label,group,kind,amount,discount,preview}`.
- **Mileage resolution order:** `milesOverride` (dispatcher-typed) → cached/looked-up Google Maps distance (`planDriveInfo_`, cache `plan:drive2:*`) → `null` (renders as "No distance yet").
- **Quote-engine rules worth preserving exactly (`ppQuote_`):**
  - Base fare first, keyed off a fuzzy regex read of the free-text `transport` field (`ppTransportKey_`).
  - Mileage billed only past `includedMiles`, at `perMile`; a mileage-mode-auto trip with no resolvable distance is marked `incomplete:true` rather than silently priced at $0 for that line — *"mileage is usually most of the fare. Quoting $0 for it looked like a finished price and under-billed by the whole distance."*
  - Minimum fare bump applied **twice** if needed: once mid-calculation (before surcharges/discounts) and again at the very end, because *"the earlier bump is taken before surcharges and discounts, so a discount could pull the total back below the stated minimum while a line in the breakdown still claimed the minimum had been met."*
  - Deadhead and waiting-time are **pass-through costs**, added **after** the fare is settled specifically so a weekend/after-hours percentage surcharge is never taken on top of them, and so they can't be used to satisfy the minimum-fare floor.
  - Percentage **discounts** are computed against a running total that **excludes** the same pass-through lines (`PRICING_PASS_THROUGH_ = {deadhead,wait,tolls,parking}`) — historical bug: *"Discounts were using the full running total instead, so the operator was handing back a slice of their own costs."*
  - `23:58` (the blank-time sentinel) is explicitly excluded from ever triggering the after-hours surcharge.
  - Waiting time is computed from **actual driver-tap stamps** (via `ttRowFor_`), never estimated — "nothing is charged before the trip has happened."
  - Money is always rounded via `pricingMoney_`, which fixes a half-cent/negative-rounding bug: *"Math.round(1.005 \* 100) is 100.4999..., so a half cent used to be lost, and negatives rounded the other way – discounts drifted one way and charges the other."*
- **HTTP equivalent:** `POST /api/pricing/quote` — body `{trip, manual, dropped}`.

---
**`repricePrivatePayTrips_(trips, stored)`** *(private but essential — full spec, called on every trip create/update/standing-order-spread)* — `file_29.js:5127`
- **Purpose:** Write the **authoritative** `price`/`pricing` fields onto every private-pay trip in a batch just before it's persisted, from **each trip's own date/time/route** — never inherited from a sibling in the same batch.
- **Args:** `trips` (Trip[]), `stored` (map of `tripKeyID → the record's current stored trip`, used as ground truth for "did the route actually move" — **critically, not** the incoming payload, because *"the incoming trip and its pricing snapshot both come from the same page, so comparing them against each other always says 'unchanged'."*).
- **Key behaviors:**
  - A **route lookup budget** scoped to the batch size (`Math.max(2, privatePayCount + 2)` Maps calls), keyed by normalized pickup~dropoff pair so two trips on the same road share one lookup (`ppRouteKey_`).
  - A **return leg is priced on its outbound's scheduled time**, never its own — *"The hour a passenger happens to come back at is a scheduling fact, not a pricing one, so the leg is quoted on its outbound's clock and the two legs always match."*
  - A **moved address** invalidates any carried-over cached mileage; an **unmoved** address reuses the last known mileage rather than re-querying Maps.
  - A **typed mileage override always wins**, even over a Google lookup, keyed separately so two brand-new same-route trips with different overrides don't collide.
  - On an **incomplete quote** (distance lookup failed): if the trip already had an agreed price **and the route hasn't moved**, the old price is **kept**, flagged `staleQuote:true`, rather than blanked — *"a lookup that failed this minute is not a reason to un-bill a trip – and clearing it would be worse than leaving it, because a blank price is easy to miss on an invoice."* Otherwise (no prior price, or the route moved), the price is cleared to `''` with `problem` text set for the UI.
  - Never throws — a pricing failure on one trip in a batch is logged and that trip is left as it arrived; the rest of the batch still saves.
- **HTTP equivalent:** internal-only (invoked automatically server-side before any private-pay trip write in a rebuild) — not a public endpoint, but its exact precedence rules (override > cached-if-unmoved > fresh lookup; keep-old-price-if-agreed-and-unmoved on failure) must be preserved by whatever replaces it.

### 5.8 Planning & drive times (stop-time learning)

---
**`rebuildStopTimeStats()`** — `file_29.js:4354`
- **Purpose:** Recompute learned per-stop dwell-time medians from completed-trip history (`TRIP_TIMES`), at four levels of specificity: `passenger+address`, `passenger`, `address`, `all` (fleet-wide) — written to the `STOP_TIMES` sheet.
- **Sampling rules (exact, load-bearing for a rebuild):**
  - Only trips whose `ended === 'completed'` count (no-shows, cancellations, in-progress excluded).
  - Only the last `ST_WINDOW_DAYS_ = 120` days count.
  - A driver arriving **early** is not charged wait time before the scheduled slot — effective pickup wait = `max(0, pickupWaitMin - earlyMinutes)`.
  - A wait over `ST_MAX_SAMPLE_MIN_ = 45` minutes is treated as a forgotten tap, not a real wait, and dropped from the sample.
  - A bucket needs `ST_MIN_SAMPLES_ = 5` trips (or `ST_MIN_SAMPLES_ALL_ = 10` for the fleet-wide bucket) before it's trusted at all.
  - The stored median is clamped to `[ST_FLOOR_MIN_=1, ST_CEIL_MIN_=30]` minutes regardless of what the raw data says — "so one bad row cannot make the checker talk nonsense."
- **Returns:** `{ok, entries, tripsScanned, tripsUsed, builtAt}`.
- **Freshness:** auto-triggered (`stRebuildIfStale_`) after any driver tap write, if the last build is >`ST_REBUILD_HOURS_ = 12` hours old — but **never** while a driver's own tap is mid-flight (`DRIVER_TAP_IN_PROGRESS_` flag) and never blocking (1s try-lock, best-effort).
- **HTTP equivalent:** `POST /api/stop-times/rebuild` (cron-triggered in a rebuild, e.g. nightly) rather than piggybacking on driver taps — a real backend has no execution-time pressure forcing this opportunistic design.

---
**`stopTimeStatsReport()`** — `file_29.js:4447`
- **Purpose:** Diagnostic dump of the current learned map for a human to eyeball. `HTTP equivalent:` `GET /api/stop-times/report`.

### 5.9 Times / telemetry

---
**`tripTimesRecord_(trip)`** *(private, called after every driver-tap-affecting write)* — `file_29.js:4114`
- **Purpose:** Derive and persist one row of `TRIP_TIMES` analytics per trip: `pickupWaitMin`, `dropoffWaitMin`, `onRoadMin`, `totalMin`, `lateByMin`, and `ended` (`'in progress'|'completed'|'no-show'|'cancelled'|'reassigned'`). Never writes a `0` for a tap that never happened — leaves the cell blank so it can't drag down an average.
- **Locking:** own 5s try-lock; **never throws**, returns `{ok:false, reason:'busy'|message}` instead.
- **HTTP equivalent:** internal-only — a rebuild would compute these as derived/materialized columns off the trip's own tap timestamps rather than a separate written table, but the exact wait-time math (late-arrival offset, no-show wait measured to the dispatcher's end-stamp, `TRIP_TIMES_MAX_GAP_MIN_ = 720` sanity ceiling on any gap) should be kept.

---
**`backfillTripTimes(apply)`** / **`backfillTripTimesApply()`** — `file_29.js:4144`/`4207`
- **Purpose:** One-time (or re-runnable) backfill of `TRIP_TIMES` from LOG history, from `TRIP_TIMES_BACKFILL_FROM_ = '2026-08-31'` (the week real driver taps began) onward. Dry-run by default; records with out-of-order stamps (the "phantom" pattern, see §7) are counted and skipped, never written.
- **HTTP equivalent:** one-off migration script in a rebuild, not a standing endpoint.

---
**`getTripPerformanceMetrics()`** / **`resetTripPerformanceMetrics()`** — `file_29.js:210`/`220`
- **Purpose:** Ops dashboard for server-side timing (`recordTripMetric_` samples: always if ≥1000ms, else 5% random sample, to keep the properties payload small).
- **HTTP equivalent:** `GET /api/ops/metrics`, `POST /api/ops/metrics/reset` (or replace entirely with real APM in a rebuild).

### 5.10 Repair / maintenance functions

See §7 for the *why* of each of these — they are grouped here only for the calling convention. **Every one of them follows a strict dry-run/apply pattern**: `fn(false)` (or no `apply` arg) computes and returns what it *would* change with zero writes; `fn(true)` performs the writes; a same-named `fnApply()` wrapper exists for each because the Apps Script script-editor function picker cannot pass arguments.

| Function | File:line | Dry-run wrapper | Apply wrapper |
|---|---|---|---|
| `repairBlankStartTimes(apply)` | `file_29.js:3241` | `repairBlankStartTimes(false)` | `repairBlankStartTimesApply()` |
| `repairPhantomProgressStamps(apply)` | `file_29.js:3290` | `findPhantomProgressStamps()` | `repairPhantomProgressStamps(true)` |
| `repairMisplacedDriverStatus(apply)` | `file_29.js:3560` | `repairMisplacedDriverStatus(false)` | `repairMisplacedDriverStatusApply()` |
| `repairSkippedStepStamps(apply)` | `file_29.js:3636` | `repairSkippedStepStamps(false)` | `repairSkippedStepStampsApply()` |
| `removeTestTrips(dateKey, apply)` | `file_29.js:3695` | `findTestTripsOnSep5()` | `removeTestTripsOnSep5()` |
| `sweepOrphanStandingOrders()` | `file_29.js:2751` | n/a (always safe) | same call |
| `archiveAndCompactTripLog()` | `file_24.js:333` | `analyzeTripLogCompaction()` | same call (no dry-run flag; always applies) |
| `validateTripIndexAgainstLog()` | `file_24.js:1` | n/a (read-only report) | n/a |
| `backSyncLegacyTripIds()` | `file_24.js:545` | n/a (idempotent repair, always applies) | n/a |

- **HTTP equivalent:** an admin-only `/api/admin/repairs/:name?apply=false` family of endpoints in a rebuild, or (better) a proper migration-runner — but the **dry-run-first, explicit-apply-second** convention, and the JSON diagnostic report shape (`{apply, ...counts, samples/changes}`) each one returns, is worth preserving verbatim since it's clearly saved this operation multiple times in production.

### 5.11 Misc

- **`auditWorkbookCells()`** — `file_29.js:1497` — reports every sheet's `maxRows × maxCols` cell footprint (Google Sheets has a whole-workbook cell limit); ops-only, `TEMP_audit()` is a throw-to-see-in-logs wrapper around it.
- **`sortDispatchBoard()`**, `getTripPerformanceMetrics()`, etc. — covered above.

---

## 6. Repair functions — a map of everything that has gone wrong

This is, in the codebase's own words, a history of production incidents. Each
one below is a *diagnosis* — the failure mode a rebuild must not reintroduce
— not merely a fix. Version tags (`V74`..`V123`) are the codebase's own
sequential markers, inferred from inline comments.

1. **V74 — concurrent-edit clobbering.** Before field-level merge existed, any save wrote the *entire* trip object, so a save started minutes ago (stale page) could silently revert a colleague's more recent edit, or a driver's live progress. Fixed by `mergeTripFields_` + the `changedFields` convention threaded through nearly every write path. **Rebuild implication:** any PATCH-style endpoint needs an explicit changed-field list (or a real optimistic-concurrency/CRDT model), not last-write-wins on the whole record.

2. **V75 — same class of bug, formalized as "Concurrent-edit safety."** `PROTECTED` fields (`tripKeyID, id, status, statusAt, returnOf, recurringId`) can never be overwritten by a normal client save, only by the server's own internal forced-override list — because a stale page's save could otherwise silently reassign a trip's identity or relink it to a different journey.

3. **V78 — standing-order deletion had a stale "must supply every date" rule** that has since been unified into one shared finalize path (`soFinalizeStandingOrderDelete_`) — every delete path (single-day, multi-day, passenger-delete cascade) now agrees on one rule: a pattern is retired the moment no trip anywhere still carries its `recurringId`.

4. **V88 — standing-order titles stored separately from the pattern map** specifically so a purely cosmetic feature (naming an order) could never risk corrupting the delete/sweep logic that predates it. **Rebuild implication:** keep "derived/display" metadata in a separate table/column from "structural" state, even when it would be more normalized to merge them, if the structural logic is fragile.

5. **V89/V90 — "Phantom driver stamps."** The root cause, stated verbatim: *"A DISPATCH row is a slot that gets reused by whatever trip lands in it next, and this app only writes the columns it owns."* The driver app's progress columns (Z, AA, AB, AC) and two overloaded legacy columns (B "start time", the IN/OUT mirrors L/O) were **not** cleared when a row changed hands, so a new trip inherited a stranger's stale timestamps — symptom: *"trips showing 'Intransit 10:32 AM, Completed 11:16 AM' with no driver assigned — the very same pair on three different passengers across three dates, because they all sat in the same row."* Fixed two ways: (a) going forward, `clearInheritedDispatchCells_` wipes the inherited spans (`dispatchInheritedSpans_`) the instant a row is claimed by a new trip; (b) retroactively, `repairPhantomProgressStamps`/`repairMisplacedDriverStatus`/`repairSkippedStepStamps` detect and clear rows already corrupted, using the signature "a later-stage stamp present with an earlier-stage stamp missing — real driver taps can only ever arrive in order." **Rebuild implication:** if the rebuild ever reuses a row/slot concept (it shouldn't — see §8), every column not explicitly owned by the new occupant must be wiped atomically with the claim, not left to a later "someone will overwrite it" assumption.

6. **V95/V102/V102b — board sort losing computed/live-value columns.** The very first board-sort implementation moved only the columns that weren't spreadsheet formulas, on the theory that formula columns "recompute themselves in place" — but the **driver app writes plain values directly into three of those "formula" columns** (L=IN, O=OUT, Q=STATUS), overwriting the formula. Leaving those three columns physically in place while the rest of a trip's row moved during a sort put one trip's live driver status on a completely different trip's row. Fixed in V102 by tracking, per cell, whether it currently holds a formula or a driver-written value, and moving *that* — formula cells keep their formula (R1C1-relative), value cells travel with their row. V102b (`repairSkippedStepStamps`) then found and cleared rows where the *pre-V102* sort had already left a stamp orphaned this way, using "a later stamp present without its earlier stamps" as the same telltale signature as the phantom-stamp bug.

7. **V96/V106/V108 — reachability checking evolved from "same time slot" → "same time, different address" → "learned per-stop dwell time."** V96 added real drive-time lookups between neighbouring trips on a driver's day (`checkDriverReachability_`), because two trips 40 minutes apart that both start at 5:30 PM are impossible even though neither one "conflicts on the clock" against the naive same-time check. V106 added a *fixed* dwell allowance at each stop (5 min pickup / 3 min drop-off) because a driver isn't instantly free the moment the clock hits the trip's scheduled time. V108 replaced the fixed guess with a learned median per passenger/address/fleet, specifically because "a wheelchair passenger at a nursing home is not a walk-out at a house," with three safeguards baked in (early arrivals aren't charged wait time; no-shows/cancellations are excluded; anything over 45 minutes is a forgotten tap, not a real wait).

8. **V100 — the `23:58` blank-time sentinel leaking as real data.** `toTimeOnlySmart` returns `11:58 PM` (`1899-12-30T23:58:00`) as a stand-in for "no time was typed." This sentinel silently leaked into displayed start times ("leaves at 11:58 PM" on every trip without one) and — much worse — into the **pricing engine**, where an untimed trip was being charged the after-hours surcharge because `23:58` looks like a legitimate late-night pickup. Fixed by `isBlankStartTime_`/`startTimeCellValue_` (treat it as blank on write) and an explicit sentinel check inside `ppQuote_`'s `afterHours` rule. `repairBlankStartTimes` retroactively blanks every stored `23:58` start time in LOG and DISPATCH. **Rebuild implication: never encode "no value" as a specific, plausible-looking value of the same type — use null/undefined, full stop.**

9. **V105 — trips created for testing production, with no safe path to clean them up once their date passed.** Both client pages refuse to touch a "past" day, so test trips became permanent. `removeTestTrips(dateKey, apply)` matches only on an explicit `/\btests?\b/i` word in the notes field (never on passenger name) and deletes through the app's normal delete path (so all its side effects — return-leg cleanup, standing-order retirement — still run correctly), always dry-run first. `findTestTripsOnSep5`/`removeTestTripsOnSep5` are literally named for one specific incident date (`2026-09-05`).

10. **V105 — "Needs Scheduling."** A trip the dispatcher knows is coming but can't yet place used to be either (a) not entered at all and tracked on paper/memory, or (b) entered with a *guessed* date/time — which for a guessed date risks falling outside the 2-day DISPATCH window or, worse, being created on a day that later gets marked "submitted" and permanently locked; for a guessed time it walks straight into the V100 `23:58` sentinel bug. Solved by giving it an entirely separate, date-optional, sheet-formatted-as-text storage (`PENDING_TRIPS`) that only becomes a real trip once every detail is confirmed and it goes through the ordinary `addTripsFromSidebar` path (with all its conflict/blacklist/duplicate checks).

11. **V106 — "Trip times."** Driver taps were already stamped on the trip record but buried inside LOG's per-day JSON blob, unusable for sorting/filtering/charting. `TRIP_TIMES` mirrors them as a flat, one-row-per-trip sheet with derived numeric wait/road/late columns, explicitly **never written to LOG or DISPATCH** (a pure read-side projection) so it can never itself become a source of corruption.

12. **V110/V114/V116/V118/V120 — the pricing engine's long tail of near-misses**, each independently quoted in §6.6/§5.7 above: blank-box-reads-as-zero, silently-discarded malformed time input, 0.15%-vs-15% confusion, config-save resetting untouched fields to factory defaults, batch-save pricing a trip off a sibling's date instead of its own (**V114**, the reason `repricePrivatePayTrips_` re-quotes every trip individually right before write), return-leg priced at its own (wrong) time instead of its outbound's (**V116**), deadhead mileage having no allowance/rate of its own so it was either unbillable or wrongly taxed by percentage surcharges (**V118**), half-cent rounding drift, discount base including pass-through costs, minimum-fare floor bypassable by a late discount, and finally the general principle stated as its own comment: *"the stored snapshot carries the distance of the route the trip used to take. Leaving it in place meant the re-price after an address change quietly used the old mileage."*

13. **V120 — the cache-byte-vs-character-count bug** (§3): a payload measured in JS string length (UTF-16 code units) rather than actual bytes could sail past a byte-based size cap in one direction and then be flatly rejected by `CacheService`'s real 100KB-in-bytes limit, silently losing both the day's cache entry and its paired hash.

14. **V120 — the two duplicate `sortPassengersSheet_` implementations.** Apps Script silently uses "whichever file happens to be evaluated last" when two files define the same global function name; the shadowed copy in `file_18.js`'s menu-tools file sorted only 10 of the 11 passenger columns, so the "Flagged By" column stayed physically in place while every other column moved underneath it during a sort — silently attaching a blacklist reason to the *wrong passenger*. Fixed by deleting the duplicate and routing both menu entries (`sortPassengers`, `sortPassengers2`) through the one correct, lock-guarded implementation in `TripManager.gs`. **Rebuild implication: this exact class of bug (silent last-definition-wins shadowing across files) cannot happen in a real module system — but it's a reminder to grep for duplicate exported names when porting.**

15. **V120 — `backSyncLegacyTripIds` used to run every trip through the DISPATCH-row serializer** (`tripObjectToRowArray`, which only has slots for the ~26 mapped columns) as part of a key-repair pass — permanently destroying every LOG-only field (price, pricing, private-pay flag, stop notes, deadhead, mileage override) across the *entire* trip history in one run. Fixed to only ever touch the `tripKeyID` field and leave the rest of each entry's shape untouched. **This is the single most severe historical incident documented in the code** — a full-history, irreversible-in-place data-destroying bug in a "repair" script.

16. **V121 — `setTripQuickStatus` defaulted to "today" with no way to target another date**, so tapping a status control while viewing any other day silently wrote nothing and *still reported success* to the dispatcher. Fixed by requiring/threading an explicit `dateKey` through the whole call.

17. **V123 — background sync vs. standing-order jobs contention.** Both hold the same document lock and share the same rough execution-time budget; `backgroundDispatchSync` now checks `soAnyJobOpen_()` (itself guarded by a 15-minute "still actually moving" cutoff, so a job orphaned by a lost trigger doesn't permanently disable background sync) and stands aside rather than competing.

---

## 7. Spreadsheet-only artefacts — do not rebuild these as-is

These exist **only** because the datastore is a Google Sheet edited directly
by humans and formulas, side-by-side with the app's own writes. A rebuild
onto a real database/API eliminates the entire *reason* for each of these to
exist — they should not be ported, only their *business logic* (if any is
tangled inside them) should be extracted.

- **`sortDispatchSheet_` / `sortDispatchBoard` / `dispatchNeedsSort_` / `dispatchWritableRuns_` / `dispatchMarkForSort_`** (`file_29.js`) — physical row reordering to fake date/time order in a fixed grid, with elaborate cell-by-cell logic to avoid clobbering spreadsheet formula columns while still moving driver-written values that happen to live in formula-labeled columns. A real API returns rows in query order (`ORDER BY date, time`); "board order" is never a stored, mutated physical property.
- **`clearInheritedDispatchCells_` / `dispatchInheritedSpans_` / the entire "phantom stamp" repair family** (§7 items 5–6) — exists only because DISPATCH rows are a scarce, reused 100-row pool. A real trips table has one row per trip, forever; there is no "row hand-me-down" concept to guard against.
- **`findOpenDispatchRow_` / `buildDispatchRowMaps_` / `writeTripsToDispatchRows_` / `SIDEBAR_DISPATCH_MAX_ROW_ = 100` cap** — the entire "does a free board slot exist" allocation logic, and the **hard 100-trip live-board ceiling**, is a spreadsheet artefact. A rebuild has no such ceiling.
- **`snapshotDispatchToLog` / `restoreDispatchFromLog` / `dispatchFingerprint_` / `syncDispatchIfChanged_` / `onDispatchEditSyncTrips_` / the whole DISPATCH↔LOG reconciliation layer** (`file_24.js`) — exists because DISPATCH (today/tomorrow's working view, partly formula-driven, hand-editable) and LOG (the full historical JSON-blob record) are **two physically different sheets holding overlapping data that must be kept in sync**. In a rebuild, "the board" is just a filtered view/query (`WHERE date IN (today, tomorrow)`) over the **one** trips table — there is nothing to reconcile because there is nothing to duplicate.
- **`archiveAndCompactTripLog` / `analyzeTripLogCompaction` / `LOG_ARCHIVE` sheet / the "one row per date, last-wins" LOG storage model** — a consequence of storing an entire day's trips as one JSON blob in one cell, appended rather than updated. A real per-trip row with an upsert-by-`(date, tripKeyID)` write needs no compaction pass, no archive sheet, and no "which row is the live one for this date" resolution logic (`getIndexedLogRowForDate_`, `logDateKey_`, the whole `passengerTrips:dateRows:v1:*` index) at all.
- **`TRIP_INDEX` sheet + `ensureTripIndexHeaders_`/`upsertTripIndex_`/`findTripIndexCell_`/`refreshTripIndexForDate_`/`rebuildTripIndexFromLog_`/`validateTripIndexAgainstLog`** — a hand-rolled secondary index (`tripKeyID → row number`) to avoid an O(n) `TextFinder` scan of the LOG sheet. A real database's primary key / index on `tripKeyID` replaces this entirely.
- **`fixDispatch`, `fixDrivers`, `fixAddress`, `fixPassengerDropDown[11]`, `fixIt`, `eStatusCol`, `styleHeaderRow`, `applyHeader`, `applyFormulas`, `applyValidation`, `applyAlternateRowColors`, `applyProtections`, `applyVisibilitySettings`, `applyConditionalFormatting`, `applyFormattingAndBorders`, `conditionalFormatting`, `countMe`** (all `file_18.js`) — spreadsheet *cosmetic and structural* setup: cell formulas, data-validation dropdowns, conditional formatting rules, column hide/show, protected ranges, per-sheet formatting for a whole separate "drivers" workbook (`fixDrivers`, hardcoded spreadsheet ID `13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA`). None of this has any equivalent in a web API — it's UI/theming for a spreadsheet-as-UI, driven by `SpreadsheetApp.getUi()` dialogs (which don't even function outside the Sheets editor).
- **`addNewAddress`, `addNewPassenger`, `copyPassenger`, `copyNewPassenger`, `clearNewAddress`, `clearNewPassenger`, `legacyPassengerFormNotice_`** — stub/no-op shims left behind after an old in-sheet mini-form UI was replaced by the `PASSENGERS` tab + trip-sidebar auto-sync; each just shows an `alert()` pointing the user elsewhere. Dead weight, safe to drop entirely.
- **`useSpreadSheet`, `dataFromSheet`, `rowFromSheet`, `formatData`, `applyFormulas` and the small functional-utility library (`zip`, `omit`, `keep`, `isEmpty`, `uniqBy`, …)** (`file_18.js`) — generic spreadsheet-range-to-object helpers built around A1-notation ranges and hardcoded `ssIds`; superseded in practice by the `COLUMN`-constant + row-array approach used everywhere else in the codebase. No use outside a Sheets backend.
- **`auditWorkbookCells` / `TEMP_audit`** — reports Google Sheets' own per-workbook cell-count ceiling. Meaningless once there is no spreadsheet.
- **`promptRestoreSnapshotByDate`** — literally calls `SpreadsheetApp.getUi().prompt(...)`; cannot run outside the Sheets editor UI at all.
- **`backupLogJson_` / `LOG_ARCHIVE` sheet** — an ad hoc "undo log" implemented as spreadsheet rows; a rebuild gets this for free from normal database transaction/audit-log tooling.
- **`installBackgroundSyncTrigger` / `installDispatchSyncTrigger` / `installWeeklyLogCompactionTrigger` / their `uninstall*` counterparts / `ensureBackgroundSyncTrigger_`** — Apps Script's own time-based/installable-trigger bookkeeping. The *behaviors* they schedule (periodic reconciliation, weekly compaction) may still be needed in a rebuild as ordinary cron jobs, but the trigger-installation code itself is 100% platform-specific.

**Not spreadsheet-only, but worth flagging as "spreadsheet-shaped" logic that
should be simplified, not ported verbatim, in a rebuild:** the entire
version/fingerprint/hash cascade in §2.4 and §3 exists to make "did anything
change" answerable without a full table scan **on a platform with no
database indexes and a per-call execution budget**. A real backend with a
proper trips table, an `updated_at` column, and either push (WebSocket/SSE)
or simple `If-Modified-Since`/ETag semantics gets the same guarantee for far
less code — the *goal* (cheap polling, instant propagation of a change) should
be kept; the specific multi-layer cache-key mechanism should not.
