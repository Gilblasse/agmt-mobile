# What this system is

Ten minutes. Read it before anything else.

---

## The business

Amazing Grace Mobile Transport moves people who cannot easily move themselves:
dialysis three mornings a week, a hospital discharge, an appointment across the
county. Four kinds of trip — **ambulatory, wheelchair, stretcher, taxi** — and
two kinds of payer: Medicaid-style billing, and **private pay**, where the
office quotes a price.

A trip is one passenger, one pickup, one drop-off, on one day, at one time,
with one driver and one vehicle. Most trips come in pairs: out in the morning,
back in the afternoon. Many repeat — the same trip every Monday, Wednesday and
Friday for three months.

Two groups of people use the system:

- **The office.** One or two dispatchers, on a laptop or a phone. They book
  trips, assign drivers, watch the day, fix things, and close the day out.
- **The drivers.** On phones, on cell signal, in moving vehicles, often in
  hospital basements with no bars at all. They see their own day and tap four
  buttons per trip.

---

## How it works today

One Google Sheet plus an Apps Script project of 37 files and 28,779 lines — of which the two apps and the four server files behind them are 22,656. The sheet is doing
**four jobs at once**, and this is what makes a rewrite harder than it looks:

1. **The database.** All trip data lives in it.
2. **The admin interface.** The office types directly into cells. Not as a
   workaround — as normal daily practice.
3. **The backup and the audit trail.** Version history is the undo.
4. **The thing everyone already knows how to use.** Years of habit.

A rewrite has to replace all four. If the new system is a good database with no
answer for "but I just type it into the sheet", it will not be adopted.

### The sheets

| Sheet | What it holds |
|---|---|
| **DISPATCH** | The working board — today and tomorrow only, about 99 rows. What the office watches and what the drivers write to. |
| **LOG** | The trip records. **One row per day**, holding that whole day's trips as a single block of data in one cell. This is the real memory. |
| **STAFF** | Drivers: name, phone, email, mobile carrier. In a *separate* spreadsheet. |
| **PASSENGERS** | The passenger list, with a blacklist flag, a reason, and who set it. |
| **TRIP_INDEX** | A lookup from trip key to the row it lives on. |
| **LOG_ARCHIVE** | Older days moved out of LOG so it stays a workable size. |
| **TRIP_TIMES**, **STOP_TIMES** | Derived timing data: what actually took how long. |
| **PENDING_TRIPS** | Trips the office knows about but has not scheduled. |
| **PASSENGER_CACHE**, **Vehicles** | Derived data and the vehicle list. |

> The LOG's shape is the single biggest thing to change. A whole day of trips in
> one cell is why the old system needs locks, caches, version counters and a
> nightly snapshot routine. All of that disappears with real rows.

### The column map

DISPATCH and LOG share one column layout. Two columns matter more than all the
others put together:

```
A  DATE            K  TRIP_KEY_ID     Z   PICKUP_IN_AT
B  START_TIME      L  IN              AA  ARRIVED_AT
C  TIME            M  DROPOFF         AB  INTRANSIT_AT
D  PASSENGER       O  OUT             AC  COMPLETED_AT
E  TODAY  ◀        Q  STATUS  ◀       AE  RETURN_OF
F  TRANSPORT       R  VEHICLE         AF  RECURRING_ID
G  PHONE           U  DRIVER          AG  STATUS_AT
H  MEDICAID        X  ID
I  INVOICE         Y  NOTES
J  PICKUP
```

This is copied from `COLUMN` in `legacy/apps-script/AmazingGraceTransport_constant.gs`,
which is the authoritative map. **Ignore the column letters in the comments in
`Helpers.gs`** — they describe a layout from before columns were inserted, and
they contradict the real one (most dangerously, they put Transport at E, where
the dispatcher's status provably lives).

**E is the dispatcher's status. Q is the driver's progress.** They are read back
as `dispatchStatus` and `status`, and only the driver app writes Q. For years
the board writer put the driver's progress into E on every save, which silently
erased dispatcher statuses. If you take one thing from this document, take this.

---

## The two apps

### The dispatcher board (`TripsPage.html`, 11,909 lines)

A single-page app the office keeps open all day. It shows the day's trips
grouped by driver, split into **Current & upcoming** and **Past trips**. From
it the office books, edits, duplicates and deletes trips; assigns drivers;
sets a status; prices a private-pay trip; manages passengers and the blacklist;
creates standing orders and pushes one day's edit across the rest of them;
looks back at past days; and submits a day to close it.

Full detail: `01-dispatcher-app.md`.

### The driver app (`DriverAppPage.html` + `DriverApp.gs`, 3,255 lines)

One screen per driver: today's trips, the current one enlarged, and four taps
per trip — **arrived at pickup, on board, arrived at drop-off, complete**. Plus
undo, an ETA report, and a call-dispatch button.

It looks like four buttons. It is four buttons plus an **offline queue**,
**idempotent taps**, **clock correction**, **undo that really undoes**, and an
**authorisation rule with four distinct tests**. This is the part where a naive
rewrite loses real trips.

Full detail: `02-driver-app.md`.

---

## How the two stay in step

Every write bumps a single counter. The board asks for that counter every three
seconds and the driver app every four — a cheap question — and only fetches
properly when it has moved. That is why a driver's tap reaches the office in
about three seconds without either app reading the whole sheet.

A second job runs **every ten minutes with nobody watching**, so the board is
already current when the first dispatcher arrives. Keep that idea: it is the
difference between opening the app and waiting for it.

In a rebuild this becomes a websocket, server-sent events, or the same polling
against a database. The polling works fine; it is not the part that needs
rescuing.

---

## Pricing, in one paragraph

Only trips ticked **Private Pay** are priced. The engine is a pure function:
base fare by transport type, then loaded mileage, then a minimum-fare top-up,
then deadhead (the empty run out to the passenger), then waiting time from the
driver's own stamps, then surcharges, then discounts, then a second
minimum-fare check. Twenty-four rules, of which only five can be detected
automatically — after hours, weekend, holiday, same-day, recurring. Everything
else is offered to the dispatcher or does not exist at all. A percentage is
always taken on the fare, never on another percentage, and never on money being
passed on. See `04-data-model.md` §5, and `src/rules/pricing.ts`, which is the
whole engine ported.

---

## What the office does that has no screen yet

Done today by typing into the spreadsheet. Each needs a real screen, or the
office will keep the sheet open beside the new system:

- Correcting a trip in place — a time, an address, a vehicle.
- Reassigning a driver across several trips at once.
- Looking back over a past day.
- Anything to do with a passenger's blacklist flag.
- Adjusting the pricing rules and amounts.

Watch a normal morning before designing these. The habits matter more than the
feature list.

---

## Where the bodies are buried

A short list; the detail is in `04-data-model.md`.

- **`23:58` means "nobody typed a time"** — on two different fields, handled
  two different ways. Import it as NULL.
- **Google's 1899 date stamps** ride along with every time-only value, and some
  old rows carry a real date instead.
- **A DISPATCH row is a reused slot**, so a new trip could inherit the previous
  occupant's driver timestamps. There is a whole repair function for this.
- **`recurringId` is not an order id** — it is the trip key of whichever day
  happened to be created first, so deleting that day orphans the order.
- **`driver` and `vehicle` are free text** with no key behind them; matching a
  trip to a driver is fuzzy name matching.
- **Some column comments in the old code are stale and wrong.** They describe a
  sheet layout from before columns were inserted. Trust the code, not them.
