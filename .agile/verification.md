# Verification

Everything below was executed in this environment. Commands are reproducible
from a clean checkout after `bun install && bun run build:rules`.

## Shared rules — `bun run verify`

- Typecheck: clean.
- **34 of 34 rule suites pass** (`node --test`).
- **Parity against the live Apps Script: 1,778,112 quotes compared, identical;
  6,084 driver-name comparisons, identical.** ~36-40s.

## The apps build

| Check | Result |
|---|---|
| `@ag/web` typecheck | clean |
| `@ag/mobile` typecheck | clean |
| `@ag/web` production build | 4 routes, including `POST /api/pricing/quote` |
| `@ag/mobile` iOS export | 590 modules, 1.5MB Hermes bundle |
| `@ag/mobile` Android export | 588 modules |

No `metro.config.js` was needed: Expo SDK 57 resolves the package `exports` map
and the NodeNext `.js` specifiers unaided.

## Behaviour actually exercised

`POST /api/pricing/quote` against a running production server:

| Request | Response |
|---|---|
| Wheelchair, 12 miles | `total: 86`, `incomplete: false`; mileage line reads `12 miles, 5 included · 7 × $3.00`; 16 addable rules |
| Same trip, no mileage | `total: 65`, **`incomplete: true`**, `miles: null` — refuses to price zero miles as free |
| `{}` | HTTP 400, `{ ok: false, reason: "validation" }`, plain-language message |
| Malformed JSON | HTTP 400, same envelope |

The second row is non-negotiable #4 working: nil and zero are different facts.

`GET /` renders server-side from the same package: office-clock date, the
priced breakdown, and a total of $86.00.

## CI

Every step in `.github/workflows/ci.yml` was run locally with the same
`bun run --filter` invocations. All exited 0. **The workflow has not yet run on
GitHub Actions** — the remote repo does not exist yet.

## Not verified

- `expo-sqlite` cold-start behaviour with a corrupt row — no offline queue exists yet.
- Anything needing a device or simulator: no simulator in this environment. The
  bundles export; they have not been launched on a phone.
- `db/migrations/0001_init.sql` and `db/smoke.sql` were **not** run in this
  iteration — no PostgreSQL instance here. They passed in the original kit.
