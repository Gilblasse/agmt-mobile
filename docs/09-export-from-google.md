# Getting everything out of Google

Do this first, before any design work. Two of these steps turn up things nobody
remembers building.

---

## 1. The whole script

The Apps Script project has **37 files**, about 230,000 characters. Six of them
are the dispatcher board, the driver app and the four server files behind them.
The other thirty-one hold address validation, trip-id generation, the passenger
sidebar, the sheet menus, sheet protection, the end-of-day close-out, and an
outbound call to a Cloud Function nobody documented.

```bash
npm install -g @google/clasp
clasp login
clasp clone 1DlTZn4A7T7wVnn_tDiI0HnCEubaj3ih9rULmxCDfc22GwMEo5C5Vf8xn
```

That gives you every file plus `appsscript.json`, which lists the OAuth scopes
the project uses — a useful summary of everything it touches outside itself.

> A copy as of the day this package was made is already in
> `legacy/apps-script/`. Export again anyway: the live project moves.

## 2. The data — five spreadsheets, not one

Export each sheet as CSV:

| Workbook | Sheets |
|---|---|
| Dispatcher `1oc_ac8X…` | DISPATCH, LOG, PASSENGERS, LOG_ARCHIVE, TRIP_INDEX, TRIP_TIMES, STOP_TIMES, PENDING_TRIPS, PASSENGER_CACHE, `PAGE 2 of DISPATCH` |
| Staff `1W9gT2Tk…` | STAFF |
| Vehicles `13ynJ0Q_…` | Vehicles |
| Drivers / Driver App `13rpPjV3…` | tabs `1`–`9`, Schedule Links, MASTER DRIVERS DATA LINKED |
| Archive `1nEAxrzY…` | `Year2019` — **the whole ongoing archive, not just 2019** |

Three warnings:

- **LOG will look wrong.** Each row is one day, with that whole day's trips
  packed into a single cell as JSON. A CSV export of it is one enormous field
  per row. That is expected; the importer has to unpack it.
- **Dates and times will lie to you.** Sheets exports them in whatever the
  display format happens to be. Pull the data through the Sheets API with
  `valueRenderOption=UNFORMATTED_VALUE` instead, which gives the underlying
  serial numbers, and convert those yourself.
- **Export old data too, not just recent.** Old trips are where the odd shapes
  live, and the importer needs to survive them.

## 3. The settings nobody thinks of as data

These live in Apps Script's key-value store, not in any sheet, and a CSV export
misses them entirely:

- **The pricing configuration** — every rate, every rule's on/off state, the
  after-hours window, the holiday list. Property key `privatePay:pricing:v1`.
- The standing-order job queue and its titles (`standingOrder:titles:v1`).
- Assorted counters, cache keys and last-run markers.

Get them with a one-off function in the script editor:

```js
function exportProperties() {
  const all = PropertiesService.getScriptProperties().getProperties();
  Logger.log(JSON.stringify(all, null, 2));
}
```

Run it, copy the log, save it as `legacy/script-properties.json`.

> `src/rules/pricing.ts` carries the pricing **defaults**, which is what a fresh
> install would start from. The real live amounts are in these properties. Do
> not assume they match.

## 4. The triggers

Seven. Six fire on a spreadsheet edit or on open — `addressValidation`,
`earseTime`, `passengerReady`, `TRIP_ID`, `onOpenShowTripsSidebar_` and
`onDispatchEditSyncTrips_`. The seventh, `backgroundDispatchSync`, is
time-based every ten minutes and installs itself from an ordinary board load.

There is also `autoSubmit`, a daily time-based trigger at about 10:15 PM
Eastern, which runs the whole end-of-day close-out: archive today's board,
sort, scrub, clear the driver tabs and clear completed rows.

List them from the Triggers panel and write down what each does.

## 5. The deployment settings

From Manage deployments: who it executes as, who has access, and the deployment
id. These encode the current access model, which is worth understanding before
you replace it.

---

## What you should have at the end

```
legacy/
  apps-script/            all 37 files + appsscript.json
  data/                   one CSV per sheet, from all five workbooks
  script-properties.json  pricing config, job queues and the rest
  triggers.md             what runs, when, and why
  deployment.md           execute-as, access, deployment id
```

Commit it. It is the last complete picture of the old system, and once the
rewrite starts, nobody will want to go back and get it again.
