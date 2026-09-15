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

## A tap is decided under a lock on the trip row

Everything that decides a tap's outcome happens inside one transaction holding
`SELECT ... FOR UPDATE` on the trip. The first version read the current step
before the transaction and spent the nonce unconditionally, so two taps
arriving together left the loser's update matching nothing while its nonce was
burned and it was told it had succeeded. That is a lost tap, and it happened in
half of the attempts, from nothing more exotic than an offline queue draining
two taps back to back.

`packages/rules/src/rules/status.ts` already said the guard "belongs on the
SERVER, inside the same lock as the row read", and sign-in already used a row
lock for the same class of race. The tap was the one place it was not applied.

## A nonce is unique within a trip, and within an operation

Migration 0004. The scope was the whole table, so a phone numbering taps per
trip destroyed another trip's tap; and a key reused for a tap and its undo made
the undo look like a replay. Keys are now stored prefixed by operation and the
index covers `(trip_id, idempotency_key)`.

## A skipped step is recorded, not refused

The guard stays monotonic rather than strictly sequential: the live system
allows any forward move, and the rules are parity-checked against it, so
refusing a skip would be a behaviour change from the system still invoicing
real money. But a skip leaves the intermediate stamps blank, and a wait time is
billed from those — so the gap is written as a `note` event naming the steps
not tapped, rather than left for someone to notice.

## Undo is bounded to sixty seconds

The app offers six. Without a server-side window, undo was a ratchet in
reverse: six calls stripped a completed trip back to nothing and blanked all
four timestamps, hours later, for anyone holding the phone.

## Yesterday's unfinished trips stay tappable

A 23:45 pickup is still the trip the driver is inside at 00:10. Refusing it
stranded overnight runs with the drop-off never stamped, and `validation` is not
a reason a client retries, so the tap was discarded rather than queued. Today
and yesterday-while-unfinished are tappable; tomorrow answers "not yet" and an
older day answers `day-locked`.

## Rate limiting counts from the right of `x-forwarded-for`

The header arrives as the caller wrote it; a proxy appends what it saw. Trusting
the leftmost entry meant one host rotating a made-up value was never refused,
and that wearing someone else's address spent *their* budget. Entries are
validated as addresses and counted `TRUSTED_PROXY_HOPS` from the right, and a
caller who cannot be placed shares one bucket rather than getting a free pass.

## Delivery is an interface with a do-nothing default

Which SMS provider to use is a business decision with a bill attached, and the
worker should not wait on it. So the outbox, its lease, its back-off and its
giving-up are all built and tested, and the last inch is a `Sender` someone
plugs a provider into.

The default deliberately **fails** rather than pretending to succeed: a message
stays queued, and `describe()` reports "no delivery provider configured". A
development sender that quietly returned success would make the system look
like it works, which is the failure mode that matters here.

## Claiming a message leases it, rather than locking it

`FOR UPDATE SKIP LOCKED` protects a row only while the claiming transaction is
open. Incrementing `attempts` left the row `pending` and still due, so once the
first worker committed the next one sent it again — **ten messages went out
twenty-two times**. Claiming now pushes `send_after` forward by a lease, which
takes the row out of the due set and doubles as crash recovery: a worker that
dies mid-send does not strand its messages.

## Test files run one at a time

`node --test` runs files in parallel by default, and these suites share one
database and one server. In parallel the outbox drain — global by design —
claimed the sign-in codes another suite was waiting on. `--test-concurrency=1`.

`--test-force-exit` is also needed: a top-level `after` cannot close the
connection pool that is keeping the event loop alive, because it only runs when
the loop ends.

## Twilio for text messages, chosen by the owner

`docs/06` recommended it and the owner confirmed. No SDK: the Messages API is
one authenticated form POST, and calling it with `fetch` keeps the dependency
surface small and the transport injectable, so the whole path is exercised in
tests without an account or a bill.

**Only a message that can never be sent is permanent.** The outbox *abandons* a
message it is told is permanent, so a wrong verdict is a sign-in code a driver
never receives. Invalid number, replied STOP, landline, a body Twilio will not
take — those are permanent. A rotated token, a rate limit, an outage are not:
they are the office's to fix, and abandoning every queued code because a
credential changed would be the worse failure.

The first version of this list also held 21408 ("no permission to send to that
region") and 21612 ("this sender cannot reach that number"). Both read like the
recipient's fault and neither is: they are account settings, toggled in the
Twilio console. With them listed as permanent, one switch left off abandoned
every queued message on its first attempt — every driver's sign-in code thrown
away over something the office could fix in a minute. The test that now covers
this is named for the switch, not the code.

## Accepted and delivered are two different facts

Twilio answers `201` the moment it takes a message, and the body of that `201`
can already say `"status":"failed"`. Reading `response.ok` as success recorded
a message the carrier had refused as a clean delivery — which is precisely the
defect `docs/06-external-services.md` gives as the reason for abandoning the
carrier email gateways: *no delivery confirmation*. Rebuilding on a provider
and then keeping the same blindness would have been the rewrite's worst joke.

So `Sent` reports `accepted`, never `delivered`, and the queue has a state for
each: `accepted` means Twilio has it, `sent` means Twilio confirmed the handset
did. Confirmation arrives on a signed status callback
(`POST /api/notifications/twilio-status`), matched to the row by the provider's
own reference. Where no callback URL is configured a message stops at
`accepted` and the startup line says so in words — the honest answer, rather
than a state that claims more than is known.

## The queue asks the provider, rather than only waiting to be told

The status callback is the cheap way to learn what became of a message, and
it needs a public address. The first real message this system sent — from the
owner's Windows machine, with no address Twilio could reach — was refused by
the carrier five seconds after acceptance, and the row sat at `accepted`
while Twilio already knew. So the drain now asks: any message accepted more
than a minute ago with no report is looked up on Twilio directly, bounded to
twenty per drain, and settled through the *same* `settle()` the callback
uses, so the queue reads identically whichever way the news arrived. A row
with no provider reference can never be asked about; it stays `accepted` and
is counted, which is the honest answer for it.

## A phone number is parsed, not assembled from digits

The first version counted digits and glued a country code on: ten digits got
`+1`, eleven got `+` if they started with the code. It is wrong in three ways,
and all three were reproduced against live code. A London number written the
way Londoners write it — `2079460101` — became `+12079460101`, a real number in
Maine; a stranger received a driver's sign-in code and the outbox recorded a
clean success. `13800138000` became a real number in Ohio. And the eleven-digit
rule only worked at all for a one-character country code, so configuring `44`
applied it twice.

`libphonenumber-js` with a default **region** replaces it. A region (`US`,
`GB`) is the only thing that can settle what a local number means; a dialling
prefix cannot. The number must also be *valid* in that region, not merely the
right length, which is what rejects the Ohio case. Extensions are parsed and
dropped rather than dialled.

## The sender is resolved where it is used, not installed at boot

An earlier version called `configureSending()` from `instrumentation.ts`. The
startup log printed "Twilio" and the drain reported "no delivery provider
configured" and sent nothing — Next bundles instrumentation separately from
route handlers, so a value assigned to a module variable at startup is simply
not there when a route runs.

`instrumentation.ts` now only *reports* what the environment describes. The
sender itself is built on first use in whichever bundle needs it. Module-level
mutable state is not a way to pass configuration between the two.

## Email has no provider, and that is an unmet requirement

Twilio sends text messages. Email needs a separate service and separate
credentials, and it has neither yet.

**This entry previously justified that by citing `docs/07-feature-checklist.md`
line 183 — "two delivery channels, either one is enough" — which is a
`[should]`. That was the wrong line.** Line 182 is the governing one, and it is
a `[must]`: *"Sign-in code delivery — deliver the one-time sign-in code by text
and/or email, whichever channel(s) are actually available for that driver."*
For a driver on the roster with an email address and no phone number, email is
the channel that is actually available, and there is nothing to send it with.
So this is a gap in a `[must]`, tracked in the backlog, not a design decision.

What the code does in the meantime is at least honest: an email message reports
that no provider is configured rather than disappearing into a sender that
cannot carry it, and the failure does not count against the message's retry
budget. But the driver still cannot sign in, and sign-in deliberately tells
every caller the same thing, so the office has no signal either. Until an email
provider is wired, a driver with no phone number on file is locked out.
