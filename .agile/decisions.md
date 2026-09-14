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

## SHA-256 for both codes and tokens, not a slow KDF

A session token is 160 bits of randomness — there is nothing to guess, and it
is checked on every request where a slow hash would cost real latency. A
six-digit code would not be saved by a slow hash either: a million candidates
is trivial to sweep at any cost per guess. What protects the code is that it
dies after ten minutes, five wrong attempts, or first use. Reasoning is in
`lib/auth/tokens.ts` and stops holding if codes ever become long-lived.

## Sign-in answers the same way for an unknown name

Telling an unknown caller "no such driver" turns the endpoint into a way to
read the roster, and the roster is a list of real people. The one exception is
a driver who is on the roster with no phone and no email: they are told, since
"sent" would leave them waiting for a message that cannot arrive.

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
