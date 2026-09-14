# A plan that survives a live operation

There is no cutover weekend. Drivers are mid-route, patients have appointments,
and the office cannot stop. Everything below assumes the spreadsheet keeps
running until the day it doesn't.

---

## Phase 0 — Get everything out

`09-export-from-google.md`. All 37 script files, all five spreadsheets, the
script properties, the triggers, the deployment settings. Commit it.

**Done when:** you have a copy of the whole system that does not depend on
anyone's Google account being available.

> The 37 files are already in `legacy/apps-script/` in this package, as of the
> day it was made. Export again anyway — the live project moves.

## Phase 1 — Answer the four questions only the owner can answer

Do this before designing anything. Each one changes the data model.

1. **The Cloud Function.** Does anyone still use the dashboard that every
   DISPATCH edit feeds? (`06-external-services.md` §1)
2. **`PAGE 2 of DISPATCH`.** Does it hold real trips?
3. **READY and the trip's time.** Should marking a trip ready really overwrite
   its scheduled time? (§6.4)
4. **Reassigning and the arrival stamps.** Should reassigning a driver still
   wipe when the previous driver arrived? (§6.5)

**Done when:** you have four answers written down.

## Phase 2 — The rules, with no app around them

Already started: `src/rules/` and `test/` in this package. Keep going —
port the rest of the pure logic out of `legacy/`: the wait clock, the deadhead
calculation, the standing-order date maths, the conflict checks.

No database, no UI, no framework. Just the rules and their tests.

**Done when:** `npm test` passes and every assertion carries the comment saying
which real failure it came from.

**Why first:** these are the only part of the old system that cannot be
re-derived cheaply. Everything else is a matter of typing.

## Phase 3 — The importer

Read the exported CSVs, unpack the LOG's day-blobs, and write real rows. Build
the scratch database from `db/migrations/0001_init.sql` and run `db/smoke.sql`
after every schema change. Run the importer repeatedly until it is boring.

Things that will bite:

- Trips that exist in DISPATCH but not in LOG, and the reverse.
- Times in four different shapes, some of them 1899 date stamps.
- `23:58` meaning "blank" on two different fields.
- Passenger names that differ by punctuation between sheets.
- Driver names on trips that match no one on STAFF.
- Prices stored as a JSON snapshot that must become charge lines.
- Phantom driver timestamps inherited from a row's previous occupant.
- Standing orders whose anchor trip has been deleted.

**Done when:** the importer runs twice and produces the same result, and you can
explain every row it refused.

**Do not skip the reconciliation.** Count trips per day, total revenue per
month, trips per driver — old versus new. Differences are findings, not noise.

## Phase 4 — Read-only shadow

The new system reads the imported data and shows the board. Nobody uses it for
work yet. The importer runs nightly so the shadow stays roughly current.

**Done when:** a dispatcher can look at yesterday in the new system and say
"yes, that's what happened."

## Phase 5 — The driver app, in parallel

The natural first thing to move: drivers use one screen and it has the least
office habit attached to it.

Run it alongside — taps land in the new system **and** are written back to the
spreadsheet, so the office's board keeps working. One or two willing drivers
first, then the rest.

**Done when:** a week goes by with no tap lost and no dispatcher noticing a
difference.

**Do not ship without:** the offline queue, idempotent taps, the monotonic
guard, and the clock correction. A driver app that loses taps on bad signal is
worse than the one they have.

## Phase 6 — The board, in parallel

Dispatchers use the new board for one thing at a time — first viewing, then
assigning, then booking. The spreadsheet stays open beside it and stays
authoritative.

This is where the jobs the spreadsheet was doing have to actually exist:
correcting a trip, reassigning in bulk, looking at a past day, the blacklist,
the pricing settings. `07-feature-checklist.md` is the list. **Watch a morning
before building them.**

**Done when:** dispatchers stop opening the spreadsheet out of habit.

## Phase 7 — Flip the direction

Until now the spreadsheet has been the source of truth. Now the database is,
and the sheet becomes a read-only mirror — so the office keeps its familiar
view, its filters and its version history, while nothing writes back.

**Done when:** nothing writes to the sheet except the mirror.

## Phase 8 — Turn it off

Archive the script project. Keep the spreadsheets, read-only, forever — they are
the historical record and they cost nothing to keep.

---

## Sequencing rules

- **Never two sources of truth for the same field.** At every moment exactly one
  system owns a given piece of data. Where both must see it, one writes and the
  other mirrors.
- **One user group at a time.** Drivers, then dispatchers. Never both.
- **Reversible at every step.** Until Phase 7 you can stop using the new system
  and lose nothing.
- **The operator decides when each phase is done**, not the test suite.

---

## Where this usually goes wrong

**Building the database first and the habits last.** The schema is the easy
part. The office typing directly into cells is a real workflow with no
equivalent in the new system until someone builds one.

**Treating the old code as legacy to be discarded.** Most of it is scaffolding
and should go. A small part of it is years of correctness, and it is not
labelled — except where a comment explains a past failure. Those comments are
the map.

**Underestimating the driver app.** It looks like four buttons. It is four
buttons plus an offline queue, idempotency, a monotonic guard, clock
correction, undo that really undoes, and an authorisation rule with four
distinct tests.

**Skipping reconciliation.** If you cannot show the operator that last month's
revenue matches in both systems, they will not trust the new one, and they will
be right not to.

**Rebuilding the spreadsheet's machinery.** Locks, version counters, snapshot
routines, fingerprints, the background resync — all of that exists to make one
cell-per-day survive concurrent writes. With real rows, none of it is needed.
Do not port it out of respect.
