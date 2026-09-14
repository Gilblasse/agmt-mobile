# The old system, as it runs today

All 37 files of the live Apps Script project, copied on 12 September 2026, plus
the test suites written against them.

Nothing in here should be ported as-is. It is here so that when something in the
new design looks arbitrary, you can find out why it is that way.

## The six that matter

| File | Lines | What it is |
|---|---|---|
| `TripsPage.html` | 11,909 | The dispatcher board. The whole office app, in one file. |
| `TripManager.gs` | 5,499 | The service layer: trips, standing orders, passengers, pricing. |
| `DriverAppPage.html` | 1,956 | The driver's phone app. |
| `DriverApp.gs` | 1,299 | The server behind it. |
| `Helpers.gs` | 1,198 | Row↔trip mappers and the time helpers. |
| `SideBarSnapShots.gs` | 795 | Board↔record sync, fingerprints, the background sync. |

That is 22,656 lines. `docs/01`–`docs/04` describe them in full.

## The other thirty-one

Menus, triggers, sheet protection, address validation, the end-of-day close-out,
the passenger cache, an outbound Cloud Function call, and several abandoned or
broken features. `docs/05-rest-of-project.md` goes through every one and says
whether it is live, dead, or a test, and whether a rebuild needs it.

## The tests

`tests/` holds the suites written against the live code during recent releases:
pricing, the client, the driver app, statuses, the wait clock, the refresh path,
and deadhead mileage. They run on plain Node with no framework.

They are kept because each assertion documents a real failure. The ported
versions of these rules — and their tests — live in `src/rules/` and `test/`.
