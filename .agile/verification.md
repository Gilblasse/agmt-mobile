# Verification

Everything below was executed in this environment. Reproducible from a clean
checkout with `bun install` (which builds the rules package via `prepare`).

## Shared rules — `bun run verify`

- Typecheck: clean.
- **34 of 34 rule suites pass** (`node --test`).
- **Parity against the live Apps Script: 1,778,112 quotes compared, identical;
  6,084 driver-name comparisons, identical.** ~37s.

## The apps build

| Check | Result |
|---|---|
| `@ag/rules` typecheck | clean |
| `@ag/web` typecheck | clean |
| `@ag/mobile` typecheck | clean |
| `@ag/web` production build | 4 routes, including `POST /api/pricing/quote` |
| `@ag/mobile` `export:all` | **one `dist/` holding both**: iOS 590 modules, Android 499; `metadata.json` lists `["android","ios"]` |

No `metro.config.js` was needed: Expo SDK 57 resolves the package `exports` map
and the NodeNext `.js` specifiers unaided.

A fresh clone works: with `dist/` deleted, `bun install` rebuilds it through the
`prepare` script and `bun run typecheck` then passes across all three packages.

`bun install --frozen-lockfile` — CI's install step — exits 0 against the
committed `bun.lock`.

## Behaviour actually exercised

`POST /api/pricing/quote` against a running production server:

| Request | Response |
|---|---|
| Wheelchair, 12 miles | `200` `total: 86`, `incomplete: false`; mileage line reads `12 miles, 5 included · 7 × $3.00` |
| `miles` as the string `"12"` | `200` `total: 86` — coerced, same answer |
| Same trip, no mileage | `200` `total: 65`, **`incomplete: true`**, `miles: null` |
| `miles: "twelve"` / `{}` / `-500` | `400` `validation` — refuses rather than pricing a trip with its distance silently missing |
| `options.manual` a string, `options.dropped` a number | `200`, coerced to empty; previously threw a 500 outside the envelope |
| `{"trip": []}` | `400` `validation` |
| `{}` | `400` `validation` |
| Malformed JSON | `400` `validation` |

The third and fourth rows are non-negotiable #4: a price that cannot be worked
out says so, and never quietly becomes a smaller number.

`GET /` renders server-side from the same package: office-clock date, the
priced breakdown, and a total of $86.00.

## Driver sign-in (this iteration)

17 integration tests against a real PostgreSQL and a running production
server — **17 pass, 0 fail**. Codes are read back out of the `notifications`
outbox, exactly as a delivery worker would; they never appear in a response.

Requesting a code: queued to the outbox and absent from the reply; stored only
as a SHA-256 digest; an unknown name gets the same answer as a known one; a
second request inside the 60s cooldown queues nothing; a request naming nobody
is refused.

Verifying: returns a token and the driver; the token is stored only as a
digest; a wrong code is refused without saying how many guesses remain; five
wrong attempts burn the code so the *correct* one stops working; a code is
single-use; one driver's code presented by another is refused; an expired code
is refused.

The roster gate: a signed-in driver passes; **marking a driver inactive cuts an
existing session off on the very next request, with no separate revoke step**;
missing, malformed and invented tokens are refused; revoked and expired
sessions are refused; a ninth sign-in revokes the oldest, holding at eight
trusted phones.

Demonstrated end to end by hand as well: request → outbox message → verify →
authorised `/api/driver/me` → driver marked inactive → same token refused with
"This account is no longer active."

## CI

Every `bun run` step in `.github/workflows/ci.yml` was run locally with the same
`--filter` invocations, and `bun install --frozen-lockfile` was checked
separately. All exited 0. **The workflow has not yet run on GitHub Actions.**

## The database

Run against a real PostgreSQL **16.13** instance (installed locally; Docker is
unavailable here).

`db/migrations/0001_init.sql` applies clean to an empty database and builds
exactly what `CLAUDE.md` claims: **17 tables, 1 view, 7 enums, 46 indexes,
12 foreign keys and 8 check constraints** — among them
`price_or_reason_never_both` and `blacklist_needs_a_reason`.

`db/smoke.sql` → `schema smoke test: all assertions passed`, and it leaves
nothing behind: every seeded table reads 0 rows afterwards.

Both root scripts work against `$PGDATABASE`. `bun run db:up` fails if re-run
against an already-migrated database (`type "office_role" already exists`) —
correct for a non-idempotent init migration under `ON_ERROR_STOP=1`, not a
defect.

## Not verified

- `expo-sqlite` cold-start with a corrupt row — no offline queue exists yet.
- Anything needing a device or simulator. The bundles export; they have not
  been launched on a phone.
