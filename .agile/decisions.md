# Decisions

Recorded so they are not re-argued. Each names what was chosen and why.

## `driverVerify` takes an identifier as well as the code

`src/api/contract.ts` types it as `driverVerify({ code })` — the code alone.
Implemented literally, every code in flight would share one six-digit space:
someone guessing `000000` is guessing against *every* driver signing in at
that moment, and the five-attempt limit protects an individual code while
doing nothing about the space as a whole.

The implementation takes `{ name | email | phone, code }`. That is also what
the live system does (`driverVerifyCode(name, code)`, docs/02 §1.3), proven in
production. The contract is an unimplemented sketch and `CLAUDE.md` says to
expect it to change.

**Follow-up:** update `contract.ts` to match, so the type and the endpoint
agree. Not done in this slice to keep the parity-covered package untouched.

## Sign-in codes go to the `notifications` outbox, never to the caller

No SMS provider is wired yet. Rather than stub a sender, sign-in codes are
queued to the `notifications` table — the path docs/06 says everything the
office sends must take. The code is never in an API response. Tests read it
back out of the outbox exactly as a delivery worker would.

## scrypt for sign-in codes, SHA-256 for session tokens

**Revised after review — the first version of this decision was wrong.**

It originally used SHA-256 for both, arguing that a six-digit code "would not
be saved by a slow hash either: a million candidates is trivial to sweep at any
cost per guess." That inverts the maths. The code expires in ten minutes, so
any per-guess cost above roughly a millisecond puts a full sweep of 10⁶ beyond
the code's life, where SHA-256 finishes in seconds. Low entropy *plus a hard
deadline* is the regime where a slow KDF helps most, not least.

Codes are now scrypt (N=2¹⁴, ~50ms a guess), which runs once per verification
attempt. Session tokens stay SHA-256: 160 bits of randomness has nothing to
guess, and they are checked on every request where a slow hash would be real
latency for no gain.

The original decision also rested on three named controls — "dies after ten
minutes, after five wrong attempts, or on first use." Single use held. The
attempt limit and the resend cooldown did **not**: the attempts counter was a
lost update under concurrency, and burning a code cleared the cooldown. Both
are fixed (see below). A decision that depends on controls should not be
recorded until those controls are tested under the conditions they are supposed
to survive.

## One live sign-in code per driver, enforced by the database

`db/migrations/0002_one_live_code_per_driver.sql` adds a partial unique index
on `driver_sign_in_codes (driver_id) WHERE consumed_at IS NULL`, and sign-in
runs under `SELECT ... FOR UPDATE` on the driver row.

Checking for a recent code and then inserting one is a check-then-act race that
application code cannot close. Twelve requests arriving together all read "no
recent code" and all inserted: six codes and six text messages inside one
second. That is a way to run up a driver's phone bill, and it multiplied the
number of codes an attacker could guess against at once. It also made
verification ambiguous — with several codes alive, verify read one arbitrary
row, so the code the driver actually received could be refused.

The index alone was not enough, because each request consumed the others' rows
before inserting its own; the row lock is what serialises them.

## The attempt count is the database's, not the application's

Verify increments with a single `UPDATE ... SET attempts = attempts + 1`
statement that also burns the code at the limit. The previous read-modify-write
lost updates: forty simultaneous wrong guesses cost one or two attempts, which
left the five-attempt limit meaningless and made the code brute-forceable at
roughly 57 guesses a second.

The resend cooldown is measured from the most recent code of any kind, not the
most recent *live* one. Keying it on live codes meant the fifth wrong attempt —
which consumes the code — also cleared the cooldown, so an attacker could burn
a code and immediately pull a fresh one, indefinitely.

## Sign-in returns `{ sent: true }` and nothing else, on every path

**Revised after review.** The first version claimed the reply was identical for
an unknown caller and was not: a known driver got back a masked contact
(`•••-•••-0001`), which both confirmed the driver exists and handed out the
last four digits of their phone number to anyone who asked. A driver with no
contact details on file got a 400, which was a second oracle.

All four paths — known, unknown, inactive, and on-the-roster-but-unreachable —
now return byte-identical `{ ok: true, data: { sent: true } }`. The unreachable
case is logged for the office instead of answered to the caller. The cooldown
query runs whether or not a driver matched, so the response time does not
distinguish them either.

The cost is that a driver who mistypes their name is told a code was sent when
none was. That is the right trade for an endpoint needing no authentication:
the roster is a list of real people, and an anonymous caller should not be able
to test names against it.

## `citext` is applied to the generated schema after each pull

`drizzle-kit pull` cannot parse `citext` and emits `unknown(...)`. The
case-insensitivity is load-bearing — a driver typing their name in any casing
must match the roster, and `drivers.name` is UNIQUE, so under plain `text` the
same person could be added twice in different casing. `bun run db:pull` runs
the pull and then `lib/db/apply-citext.mjs`.

## Drizzle introspects the schema; it never generates it

`db/migrations/*.sql` is the source of truth and `db/smoke.sql` proves it still
honours the non-negotiables. `drizzle.config.ts` exists to pull types *out* of
the database. The duplicate migration `drizzle-kit pull` emits alongside the
schema is deleted, so there is only ever one definition of the schema.
