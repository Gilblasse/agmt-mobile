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

26 integration tests against a real PostgreSQL and a running production
server — **26 pass, 0 fail**. An independent security review found two
blockers and six major issues in the first version; all are fixed, and the
attacks the reviewer used were re-run against the fix rather than trusted to
the tests. Dispositions in `review-findings.md`. Codes are read back out of the `notifications`
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

Under concurrency — the cases the first suite missed entirely, because every
check fired sequentially and the defects only appear when requests arrive
together:

- 40 simultaneous wrong guesses land `attempts=5, burned=true`, and the real
  code is then refused. Previously they cost one or two attempts.
- 12 simultaneous sign-ins queue exactly **1** message. Previously 6.
- 8 simultaneous verifies of the correct code yield exactly one 200 and seven
  `401 application/json` envelopes. Previously 7 empty non-envelope 500s.
- Burning a code does not clear the resend cooldown.
- After racing sign-ins, the code the driver actually received still verifies.

Enumeration: known, unknown, inactive, and on-the-roster-but-unreachable all
return byte-identical `{"ok":true,"data":{"sent":true}}`.

Demonstrated end to end by hand as well: request → outbox message → verify →
authorised `/api/driver/me` → driver marked inactive → same token refused with
"This account is no longer active."

## Rate limiting

7 tests, all passing, plus the sign-in suite re-run as a regression.

Covered: a caller flooding `sign-in` or `verify` is refused with `busy` and a
`Retry-After`; limits are per caller, so one attacker does not lock out anyone
else; the two endpoints have separate budgets, so exhausting sign-in still
lets a driver use a code they already hold; and 45 simultaneous requests are
all counted — a read-modify-write counter would lose hits under exactly the
concurrency the limit exists to stop.

Demonstrated by hand: an attacker naming a driver gets 30 attempts, then 15
straight refusals with `retry-after: 599`, while the real driver on a
different address requests a code and signs in normally.

**Found while doing this:** the first limits (10 per ten minutes) broke 18 of
the 26 sign-in tests, because they all shared one caller bucket. That is not
only a test artefact — a depot of drivers on one WiFi shares a public IP too.
Limits were raised to 30 and the reasoning written where they are set.

**Found by review:** the limit was bypassed completely by one host rotating a
made-up header (60 requests, 0 refused), and spoofing a victim's address locked
*them* out — the control meant to protect a driver was the cheapest way to keep
them out of a shift. Both are covered by tests now.

## The driver's day and the tap flow

36 tests, all passing, and the 33 earlier tests re-run as regression — **69 in
total** against a real PostgreSQL and a real server. An independent adversarial
review found three blockers and eight major issues in the first version; all
are fixed and re-verified by re-running the reviewer's attacks, not by trusting
the suite. Dispositions in `review-findings.md`.

**The day:** only this driver's trips, for the office's date — another
driver's and an unassigned trip are both absent. Every payload carries
`serverNow`, `serverClock` and the timezone so the phone can correct its own
clock. A trip with no time sorts last, not at midnight. Tomorrow is readable
and marked `readOnly`.

**The tap**, which is what docs/08 says not to ship without:

- Five steps walk in order, each writing its own timestamp.
- The same nonce re-sent four times applies once: one `trip_events` row.
- Eight simultaneous re-sends of one nonce apply once, and the seven losers
  answer success — the driver did tap — rather than an error.
- A stale tap arriving after the trip completed is ignored and reports what is
  actually true; it never drags the trip backwards.
- What the phone believed is recorded in the event payload; the stamp written
  is the server's. A device clock set to 2020 changes nothing.

**Whose trip it is** — the gate the old system got wrong, where a name match
let one driver complete another's:

- Another driver's trip is refused, and is left untouched.
- An unassigned trip is refused: it belongs to the office, not whoever asks.
- A trip that does not exist and a trip that is not yours answer identically,
  so ids cannot be probed.
- Marking a driver inactive stops them mid-trip, on the next tap.
- Tomorrow's trips refuse taps, so read-only is enforced by the server rather
  than trusted to the app.

**Undo** steps back exactly one place and clears the stamp as well as the
step — leaving the stamp behind let the step re-assert itself on the next
read. A re-sent undo changes nothing further.

**The failure modes the first suite could not see**, each re-run against the fix:

- Two taps arriving together on one trip: **0 of 6 rounds lose a tap** (3 of 6
  before). Both steps land and both stamps are written.
- One nonce reused across two trips: both apply (the second was swallowed).
- A nonce shared between a tap and its undo: the undo is not mistaken for a
  replay.
- Six undos on a completed trip after the window: refused with `conflict`, and
  the trip keeps **4/4 stamps** (all four were being erased).
- A trip that began at 23:45 yesterday and is still running: still tappable,
  drop-off stamped. A finished old day answers `day-locked`; tomorrow answers
  `validation` — distinguishable, neither discarded silently.
- `''`, `constructor`, `toString`, `__proto__`, `valueOf`, `hasOwnProperty` as
  a step: all `400 validation` (all six were answered "already applied").
- A mangled trip id: `404`, not a 500.
- A skipped step records a `note` event naming the steps not tapped.
- `dispatch_status`, `dispatch_status_at` and `dispatch_status_by` are
  byte-identical after a tap and an undo.

Demonstrated by hand end to end: sign in, open the day, tap all five steps,
re-send an already-delivered tap five times (5 events recorded, not 10), then
drain a stale tap which is ignored with the trip left at COMPLETE.

## The notification outbox

9 tests. A queued message is sent once and marked sent; with no provider it
stays `pending` with the reason recorded, rather than looking delivered; a
failure backs off and is not picked up again until it is due; five attempts
abandons it while keeping the row and its last error; a permanent failure
abandons at once; a message not yet due is left alone; one bad message does
not stop the others; oldest goes first.

**The concurrency test earned its place immediately.** Four overlapping drains
against ten messages sent **22** of them before claiming became a lease —
exactly the "driver told twice" failure the outbox exists to prevent. Now ten
messages, ten sends, no duplicates.

Demonstrated by hand: a driver requests a code, it queues, the drain claims it
and reports `no delivery provider configured`, the message stays `pending`, and
the code still works. The job endpoint returns 401 without the secret and with
a wrong one.

## Running Late

6 tests. The phone's "minutes away" becomes a time on the office clock; an
office note already on the trip survives the append; two taps leave **one**
warning on the board but **two** entries in the trail; a reason containing
markup is stripped to words; a nonsense offset is refused; another driver's
trip is refused.

## Every answer is the envelope

An unknown `/api` path returns `404 application/json` with `reason:
not-found`, and a wrong method returns `405 application/json` — both returned
non-JSON before, which crashes a client that always parses the body.

## The day version

Stable across two identical reads, and changes on a tap and on a new trip.

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

## The Twilio repair round

All seven migrations apply clean to an empty database
(`0001`–`0007`), and `db/smoke.sql` still passes afterwards.

`bun run typecheck` clean. **156 tests, 0 failures, 0 cancelled**, against
PostgreSQL 16 and a running Next server on the same database.

Three fixes were verified the way the round-3 retrospective requires — the test
was run against the *unfixed* code and watched to fail:

| Fix | Reverted to | The test that then failed |
|---|---|---|
| Phone numbers parsed against a region | the digit-counting `toE164` | `takes a region, not a dialling prefix`, `refuses digits that are not a number in that region`, `does not dial the extension` |
| Accepted ≠ delivered | `if (response.ok) return { accepted: true }` | `reports only that Twilio has the message`, `does not call a 201 a success when the body says it failed`, `classifies a failure reported inside a 201` |
| Per-message claim re-stamp | `stillOurs` guard removed | `does not send a message the sweeper handed to somebody else` — the last message of a batch went twice |

The delivery-report endpoint is tested against signatures computed
independently of the code that checks them: a valid one is accepted, and an
absent, wrong-token, tampered, short and non-base64 signature are each refused
403 with the row untouched. Out-of-order and replayed reports cannot move a
settled message.

The whole path was then run live against a stand-in that answers like Twilio
*and reports back like Twilio*, signing its callback with the account token:

```
request  → {"ok":true,"data":{"sent":true}}
queued   → state=pending, attempts=0, expires_at set
drain    → claimed 2, accepted 2
stand-in → To=+18455557788 From=+15550001111
           Body=431906 is your Amazing Grace sign-in code. It expires in 10 minutes.
           StatusCallback=http://localhost:3000/api/notifications/twilio-status
callback → 204, state=sent, provider_ref=SM_standin_1, delivered_at set
verify   → the driver signs in with the texted code
```

Two more behaviours confirmed on the same run: asking for a second code
abandoned the text still queued for the first (`A newer sign-in code was sent
before this went out.`), and a message past its expiry was given up on without
being sent — the drain reported `expired: 1` and the stand-in saw nothing.

**Still not verified: any real delivery.** No message has left this system.
Everything up to the network is proven against a stand-in; nothing past it is.
The four Twilio console settings that decide whether a message could arrive —
A2P 10DLC registration, trial restrictions, `TWILIO_FROM` capability,
geographic permissions — cannot be checked from here at all, which is why the
README now says what the startup line can and cannot tell you.

## The second Twilio repair round

All eight migrations apply clean to an empty database and `db/smoke.sql` still
passes. `bun run typecheck` clean. **174 tests, 0 failures**, against
PostgreSQL 16 and a running Next server on the same database.

Every blocker fix has a test that was run against the *unfixed* code and
watched to fail:

| Fix | Reverted to | The test that then failed |
|---|---|---|
| A provider problem backs off on a count of its own | a flat 60-second retry | `does not let unsendable messages starve everything behind them` — the sign-in code expired unsent; and `backs a stuck provider off instead of retrying it every minute` |
| An ambiguous timeout is reconciled, not retried | — | the four cases under `when Twilio does not answer`, which did not exist against a path that had only one outcome |
| An outcome counts only if its `UPDATE` matched | — | `does not record a message as accepted when the claim moved under it` |

The first version of the starvation test **passed** against the broken
back-off, because the `ELSE` arm still eventually backed the row off. That is
recorded in `improvements.md`: it is precisely what the round-4 rule exists to
catch, and without running it against the revert a test asserting nothing
would have gone in as evidence.

Re-run live against the stand-in after the repairs:

```
sign-in  → drain: claimed 1, accepted 1, unresolved 0, unconfirmed 0
stand-in → To=+18455557799 Body=380452 is your Amazing Grace sign-in code…
callback → 204, state=sent, provider_ref=SM_standin_3, delivered_at set
email-only driver → channel=email state=abandoned
           "No provider is configured for email."
```

That last line is the B1 fix: the same row used to sit `pending` for ever at
the head of the queue.

`OUTBOX_LEASE_SECONDS` validation confirmed directly: `"2m"` is refused at
startup with a message naming the setting, rather than becoming `NaN` and
defeating the assertion that a send cannot outlast a claim.

## Not verified

- `expo-sqlite` cold-start with a corrupt row — no offline queue exists yet.
- Anything needing a device or simulator. The bundles export; they have not
  been launched on a phone.
- A real Twilio account: a real send, a real status callback arriving over the
  network, and Twilio's own signature (the scheme is implemented from its
  specification and tested against an independent implementation of it here,
  which is not the same as having accepted a genuine request).
- Email delivery of a sign-in code. There is no provider, which is an unmet
  `[must]` (`docs/07-feature-checklist.md:182`), not a gap in testing.
