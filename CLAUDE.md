# Amazing Grace Mobile Transport — rebuild kit

Read this first. It is written for whoever — or whatever — picks this up.

## What this is

Amazing Grace Mobile Transport runs non-emergency medical transport: wheelchair,
stretcher, ambulatory and taxi trips, booked by an office and driven by drivers
with phones. It runs today on a Google Sheet with an Apps Script project bolted
to it — 37 files, 28,779 lines, in daily production use. All 37 are in
`legacy/apps-script/`.

This package is everything needed to rebuild it as a normal application: the
business rules ported and tested, a database schema that runs, an API contract,
and a specification of both apps written from the live code.

**The old system still runs.** Nothing here has replaced anything. There is no
cutover weekend: drivers are mid-route, patients have appointments, and the
office cannot stop.

## The order to work in

1. `docs/00-system-overview.md` — what the thing actually is. Ten minutes.
2. `npm run verify` — type-check, 34 rule suites, and a parity run that
   compares the port against the live code shipped in `legacy/`.
3. `docs/07-feature-checklist.md` — everything that has to exist.
4. `docs/08-migration-plan.md` — the phases, and where this usually goes wrong.

Do not start by designing screens. Start by reading `docs/04-data-model.md`
and running the test suite, because that is the part of the old system that
cannot be re-derived cheaply. Everything else is a matter of typing.

## The non-negotiables

These are not preferences. Each one is a production failure that has already
happened, usually more than once. A rebuild that breaks one of them is worse
than the spreadsheet.

1. **The office's status and the driver's progress are two different fields.**
   `dispatch_status` is the office's call on the trip; `driver_progress` is
   where the driver physically is. They look like the same thing. Merging them
   silently erased dispatcher statuses for years.

2. **A driver's tap is never lost and never applied twice.** The phone keeps an
   offline queue and re-sends. Every tap carries a nonce; a re-send is
   recognised, not re-applied; and a tap can never move a trip backwards. Time
   spent with no signal does not count against the retry budget.

3. **The office's clock decides what time it is.** Never the phone's, never the
   browser's, never the server's own timezone. A test phone an hour behind
   froze every timer in the system at `00:00` — silently.

4. **A price is a breakdown, never one number.** Every line carries its own
   explanation. A price that could not be worked out says so in words; it never
   quietly becomes zero. Nil and zero are different facts.

5. **An overdue trip nobody dealt with stays in front of the dispatcher.** It
   looks like a bug. It is not — the operator was asked and chose it, so a
   missed pickup cannot quietly disappear.

6. **Cancelling is visible whatever the driver is doing.** A called-off trip
   reads as called off even if the driver is mid-route.

7. **A blank is a blank.** The old system wrote `23:58` to mean "nobody typed a
   time" and then charged a late-night surcharge on it. Import those as NULL and
   never invent a sentinel again.

## The target

Unless told otherwise: **TypeScript, Next.js, Node, PostgreSQL.** That is the
owner's own stack.

`db/migrations/0001_init.sql` builds 17 tables, 1 view, 7 enums, 46 indexes,
12 foreign keys and 8 check constraints on PostgreSQL 16, and `db/smoke.sql`
proves it still honours every non-negotiable above:

```bash
createdb agnext
psql -d agnext -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
psql -d agnext -v ON_ERROR_STOP=1 -f db/smoke.sql
```

The smoke test rolls back and leaves nothing behind. **If you change the
schema, keep it passing.** No real data has been imported through it yet, so
expect to change it — but do not expect to discard it.

## What is already done, and what is not

**Done and running:**
- `src/rules/` — money, clocks, status, driver identity, the whole pricing
  engine, recurrence. Ported from the live code, covered by `test/`, and checked
  against the live code itself by `npm run parity` — 1.78 million quotes and
  6,084 name comparisons, with no differences. **Run it after any change to
  `pricing.ts` or `drivers.ts`.**
- `src/types/` — every entity, every enum, every field.
- `src/api/contract.ts` — every call the two apps make, typed. Not implemented.
- `db/` — schema and smoke test, both runnable.
- `docs/` — the two apps, the server API, the data model, and the 31 script
  files nobody had read.

**Not done:** any screen, any endpoint body, any importer, any auth. Those are
the rebuild.

## Working here

- **Plain language in anything the operator reads.** No jargon. The owner has
  asked for this explicitly and it applies to error messages and UI copy too.
- Assume a parallel run. The new system and the spreadsheet will both be live
  for weeks. Design for it.
- When you find a rule in the old code with a comment explaining a past
  failure, that comment is the most valuable thing in the file. Carry it across.
- `legacy/apps-script/` holds all 37 live files. When something here seems
  arbitrary, the answer is in there.
