# What this system touches outside itself

Everything the old project reaches out to. Two of these nobody knew were there.

---

## 1. An undocumented Cloud Function — find out who reads it before touching it

`Calls_To_Lambdas.gs` POSTs the whole edited row, as JSON with its row number,
to a Google Cloud Function on **every edit to the DISPATCH sheet**:

```
https://us-central1-agmtlambdaapi.cloudfunctions.net/trips
```

Nothing in the 37 files reads anything back from it. It is pure outbound. The
project name (`agmtlambdaapi`) and a menu link elsewhere in `Code.gs` to

```
https://time-stamp-agmt.vercel.app/admin/dashboard
```

together suggest a separate, already-built web dashboard — probably
Firestore-backed, probably for driver time sheets — that has been quietly fed by
this system for some time.

**Before anything else in the rebuild: ask the owner what that dashboard is and
whether anyone still uses it.** If it is live, the new system has a second
consumer nobody has been counting, and trip changes have to keep reaching it —
which is what `outbound_events` in the schema is for. If it is dead, retire it
deliberately rather than by accident.

---

## 2. "Texting" drivers is email to a carrier gateway

`TextDrivers.gs` does not use an SMS service. It emails the driver's phone
number at their mobile carrier's gateway domain:

| Carrier | Gateway |
|---|---|
| Verizon | `@vtext.com` |
| AT&T | `@txt.att.net` |
| T-Mobile | `@tmomail.net` |
| Sprint | `@messaging.sprintpcs.com` |
| Boost | `@myboostmobile.com` |
| Cricket | `@sms.mycricket.com` |
| US Cellular | `@email.uscc.net` |
| Google Fi | `@msg.fi.google.com` |
| MetroPCS | `@mymetropcs.com` |

This is why every driver record carries a `carrier` field, and why the messages
use plain hyphens only — gateways mangle dashes.

It has three problems. There is **no delivery confirmation**, so nobody knows
whether a message arrived. Carriers are retiring and throttling these gateways,
so it can stop working for one carrier overnight and silently. And a note in the
old handoff records that messages to Verizon were **already being dropped**.

**Replace with a real SMS provider** (Twilio or similar). Keep `carrier` on the
driver record for the import, then stop using it. The `notifications` table in
the schema is the outbox: queued, deduped, retried, with the failure recorded —
which is the part that does not exist today.

There is also a **second, inconsistent path**: `Email_Employees.gs` sends to a
bare phone number as though it were an email address, with no gateway domain at
all. That one almost certainly never worked. Consolidate to one path.

---

## 3. Google Maps

`GoogleMaps.gs` uses the Apps Script Maps service for distance and duration
between two addresses. In the old code it has **no caching, no retry and no
graceful failure** — a failure throws and puts `#ERROR!` in a cell. The newer
`planDriveInfo_` in `TripManager.gs` does cache, for six hours, under its own
key, with a per-request budget.

Maps is charged per call and the answer between two fixed addresses does not
change. The `drive_cache` table exists for this. Cache it, budget it, and make
a failure a **quote that says it is incomplete** — never a silent zero-mile
fare.

---

## 4. Mail

`MailApp` / `GmailApp` for start-time notices to drivers, access-change notices,
and the SMS-gateway hack above. Any transactional email provider replaces this.
Everything goes through the same `notifications` outbox.

---

## 5. Five separate spreadsheets

The "database" is not one file. Hardcoded ids across the project:

| Workbook | Holds |
|---|---|
| Dispatcher `1oc_ac8X…` | DISPATCH, LOG, PASSENGERS, and a second sheet called `PAGE 2 of DISPATCH` |
| Drivers / Driver App `13rpPjV3…` | Per-driver tabs `1`–`9`, `Schedule Links`, `MASTER DRIVERS DATA LINKED` |
| Staff `1W9gT2Tk…` | `STAFF` — name, license, initials, phone, email, carrier |
| Vehicles `13ynJ0Q_…` | `Vehicles` |
| Archive `1nEAxrzY…` | Tab `Year2019` — **despite the name, this is where every day's closed-out trips are archived, right up to today** |

Two things to know. **`PAGE 2 of DISPATCH` is undocumented** and gets the same
address validation as the real board — ask the owner whether it holds real
trips. And the archive's name is a lie: do not carry "Year2019" forward, but do
export all of it, because it is the history.

The Apps Script project also has its own key-value store holding the pricing
configuration (`privatePay:pricing:v1`), the standing-order job queue, and
assorted counters. **A CSV export misses all of it.** See
`09-export-from-google.md`.

---

## 6. Live bugs in the old code — decide deliberately

Found while reading the 31 files nobody had opened. None is a reason to panic;
all are reasons not to "port the behaviour as designed" without asking.

1. **"SEND START TIMES" is broken.** `Email_Employees.gs` calls `conisole.log`
   — a typo — which throws before any message is sent, on every real match.
2. **"Enable Auto-Open Sidebar" is broken.** The menu points at
   `installAutoOpenSidebarTrigger`; the function is `installAutopenSidebarTrigger`.
   Clicking it throws.
3. **Every driver's carrier reads as the first driver's carrier.**
   `getDriverOptions()` in `CRUD.gs` uses `data[0][45]` where it means
   `data[i][45]`. The actual sending path reads it correctly, so the damage is
   limited to whatever else uses that dropdown.
4. **Marking a trip READY overwrites its scheduled time with the current time.**
   `TimeStamp.gs` writes `new Date()` into column C, which is where the
   *scheduled* time lives everywhere else. Either a deliberate repurposing or a
   long-standing bug — **ask the owner what "the trip's time" should mean after
   a trip is marked ready** before building it either way.
5. **Reassigning a driver silently wipes the pickup-in and arrived stamps**
   (`earseTime` in `Arrived-PU-DO.gs`). Decide on purpose whether the new
   system keeps that, and note that the audit trail makes it recoverable either
   way.
6. **A syntax bug in the shared trip-form loader** — `cont pickupList = …`
   instead of `const` in `SharedLoaders.html`. Check whether passenger
   auto-fill actually works today before porting it as working.
7. **`Web-Calendar_Request.gs` is one orphaned helper.** Evidence of an
   abandoned "request a trip from the web or a calendar" feature. Ask whether
   it is still wanted; do not assume from the filename that it exists.
8. **The standing-order 183-day cap is enforced only in the browser.** Nothing
   on the server re-checks it. Enforce it server-side.
