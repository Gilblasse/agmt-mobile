# Independent reviews

## Phase 2, slice 1 — driver sign-in (security review)

Adversarial review against a running server. Two blockers and six major
findings, all reproduced live. Every fix below was re-verified by re-running
the reviewer's own attack, not by trusting the test suite.

| # | Finding | Disposition |
|---|---|---|
| B1 | `sign-in` was an enumeration oracle: a known driver got back a masked phone (`•••-•••-0001`), an unknown name got a different body, and a driver with no contact details got a 400. It also leaked the last four phone digits to any caller. | **Fixed** — all four paths return byte-identical `{sent:true}`; the unreachable case is logged for the office; the cooldown query runs either way so timing does not distinguish. Verified. |
| B2a | The attempt counter was a read-modify-write outside any transaction. 40 concurrent guesses cost 1–2 attempts, making the 5-attempt limit meaningless (~57 guesses/sec measured). | **Fixed** — one `UPDATE ... SET attempts = attempts + 1` that also burns at the limit. 40 concurrent guesses now land `attempts=5, burned=true`. |
| B2b | Burning a code set `consumed_at`, which the cooldown query required to be NULL — so running out of attempts cleared the cooldown and a fresh code issued instantly. | **Fixed** — cooldown measured from the most recent code of any kind. Verified: re-request straight after a burn queues nothing. |
| M3 | `throw new Error('code already consumed')` and `dedupe_key` collisions escaped as empty non-envelope 500s. | **Fixed** — `withResult()` wraps every handler; the losing racer gets a 401 envelope. 8 concurrent verifies: 1×200, 7×401, all JSON. |
| M4 | The 60s cooldown was check-then-act: 12 concurrent sign-ins sent 6 messages in one second. | **Fixed** — `SELECT ... FOR UPDATE` on the driver row plus a partial unique index (migration 0002). Now exactly 1. The index alone was insufficient; the lock is what serialises. |
| M5 | Verify read one arbitrary live code with no `ORDER BY`, so the driver's genuine code could be refused while a stale row was checked. | **Fixed** — at most one live code per driver is now a database rule, so there is exactly one candidate. |
| M6 | Knowing only a driver's name, a stranger could burn every code and lock them out indefinitely. | **Partly fixed, partly deferred.** B2a/B2b bound the rate, but per-caller limiting is what actually separates the driver from the attacker. Raised to the top of the backlog as a `[must]` before any real driver uses this. |
| M7 | Test SQL had no `WHERE` clauses — running the suite logged out an unrelated driver. | **Fixed** — every statement scoped to the fixtures. |
| M8 | All 17 tests passed against the broken implementation: the enumeration test compared only status and `ok`, the cooldown and attempt-limit tests fired sequentially, the device-cap test counted to 8 without checking *which* 8, and one assertion was a tautology. | **Fixed** — bodies compared whole, survivors checked by token, and 9 new cases covering concurrency and the email/phone identifier paths. 17 → 26. |

### Minor — fixed

`secretMatches` accepted a valid prefix of a malformed hash, because
`Buffer.from(…,'hex')` truncates silently (now validated with a regex);
`last_used_at` was written on every request (now throttled to 5 minutes and not
awaited); `/me` had no `Cache-Control: no-store` (added, with `Vary`);
`DATABASE_URL` was claimed to fail at startup but did not (now imported from
`instrumentation.ts`); `revokeSessionsBeyondLimit` had no tiebreaker (added
`id`); the citext patch could silently no-op (now asserts the expected column
count and exits non-zero); the CI readiness loop ended in `sleep` so it exited
0 after 60 failed probes (now explicit, and dumps the server log).

### Optional — actioned anyway

The reviewer showed the recorded argument for hashing codes with SHA-256 was
mathematically wrong: a ten-minute expiry is exactly what makes a slow KDF
worth it. Codes are now scrypt; tokens stay SHA-256. `decisions.md` records the
correction rather than quietly replacing it.

### Optional — recorded, not actioned

`or(...)` identifier resolution cannot mint another driver's session — the code
row is always looked up against the resolved driver — but supplying identifiers
belonging to different drivers resolves to one of them arbitrarily. A
deterministic `ORDER BY` was added; requiring all identifiers to agree is
still open. `authenticateDriver` answers *who*, not *what they may touch*: the
first trip endpoint must extend it with per-resource ownership, per docs/02
§1.7, which is where the old system let one driver complete another's trip.

## Phase 2, slice 2 — the tap flow and rate limiting (adversarial review)

Three blockers, eight major findings. **All 51 tests passed with every one of
them present**, which is the more important result: the suite was not testing
the failure modes that matter. Each fix below was re-verified by re-running the
reviewer's own attack.

| # | Finding | Disposition |
|---|---|---|
| B1 | Two taps racing on one trip: the guard was computed before the transaction and the nonce spent unconditionally, so the loser's update matched nothing, its nonce was burned, and it was answered **success**. The step was gone, its stamp never written, its re-send permanently refused. Lost in 3 of 6 rounds — by the ordinary offline-queue drain pattern. | **Fixed** — the trip row is locked inside the transaction and the guard recomputed there; the nonce is spent only once the tap is going to apply. Re-run: **0 of 6 rounds lost.** |
| B2 | The idempotency index was global, not per-trip, so one nonce reused across two trips silently ate the second tap. The guarantee rested on a phone never reusing a string. | **Fixed** — migration 0004 scopes the index to `(trip_id, idempotency_key)`. Both trips now apply. Tap and undo nonces are additionally namespaced, so one key used for both means two different things. |
| B3 | Undo wrote its event before knowing the update applied, so an undo that changed nothing still recorded that it had and answered success — with no `applied` flag for a client to notice. | **Fixed** — same lock; the event is written only when the undo will take effect. `undone` added to the response. |
| M4 | A trip crossing midnight became untappable: the drop-off was never stamped and the tap was discarded, because `validation` is not a reason a client retries. Overnight discharges and dialysis returns are routine. | **Fixed** — yesterday's unfinished trips stay tappable. Tomorrow answers `validation` ("not yet"), a closed day answers `day-locked` — both distinguishable, neither silent. |
| M5 | Undo was unbounded: six calls stripped a completed trip to nothing and blanked all four timestamps — the record payroll and invoices are read from — hours later. | **Fixed** — a 60-second server window (the app offers six). Re-run: six undos leave a completed trip at 4/4 stamps. |
| M6 | `officeTomorrow` added 86,400,000 ms, which skips a day across a 23-hour DST day — on the Saturday evening before the clocks change, Sunday's shift vanished. | **Fixed** — uses `addDays` from the rules package, which walks date keys and never touches UTC. |
| M7 | Rate limiting was bypassed entirely by one host rotating a made-up header: 60 requests, 0 refused. It trusted the **leftmost** `x-forwarded-for` entry, which is whatever the caller sent — and the common appending-proxy idiom leaves the attacker's value there. | **Fixed** — entries are validated as addresses and counted from the right, `TRUSTED_PROXY_HOPS` hops in; an unplaceable caller shares one bucket rather than getting a free pass. |
| M8 | Spoofing a victim's address locked *them* out for ten minutes — the control meant to protect a driver became the cheapest way to keep them out of a shift. Junk headers also inserted unbounded rows. | **Fixed** — closes with M7; a sweep now actually runs rather than being described in a comment. |
| M9 | `value in TO_DB` walked the prototype chain, so `constructor`, `toString` and `__proto__` were answered "already applied" — a corrupted queue item dropped instead of reported. | **Fixed** — uses `DRIVER_STEPS`, which existed for exactly this and was dead code. |
| M10 | The guard is monotonic but not sequential, so one tap could jump to COMPLETE leaving the intermediate stamps blank. | **Changed, deliberately not restricted.** The live system allows any forward move and the rules are parity-checked against it, so refusing a skip would be a behaviour change from the proven system. The gap is now recorded as a `note` event for the office instead. |
| M11 | The undo idempotency test never reached the nonce check — deleting the handling entirely left it passing. Concurrency, cross-trip nonces, DST, overnight trips and the office column were untested. | **Fixed** — rewritten to start two steps up and assert one recorded undo. 16 new cases; 51 → 69. |

### Minor — fixed

A non-UUID trip id returned 500 instead of "not on your schedule" (m12);
`progressToRules` returned `undefined` for an unmapped label, which walks
through `canAdvance` as rank 0 and disables the guard — now throws (m13); the
no-op path echoed a pre-lock snapshot instead of re-reading (m15); the body was
parsed before authenticating (OPTIONAL, taken).

### Minor — recorded, not actioned

Framework-level non-envelope responses: a `GET` on a POST-only route returns an
empty 405, and an unmatched path returns Next's HTML 404 (m16). `withResult`
cannot cover either; needs explicit method handlers and a catch-all.
`day/route.ts` omits `version` and the `BoardTrip` fields the contract names
(m17) — carried with the existing `driverVerify` contract drift. `retry-after`
reveals when the window opened (m18). No rate limit on the authenticated
endpoints, so a leaked token can scrape unthrottled. Trip payloads hand the
phone the full row including `medicaidNo` and an office email — contract-
sanctioned, but worth revisiting for a PHI system before the app ships.

### Clean, confirmed by the reviewer

`dispatch_status` vs `driver_progress` (non-negotiable #1) — five taps and an
undo left the office's three columns byte-identical. Ownership — another
driver's trip, an unassigned trip and a nonexistent id all answer identically,
with no timing oracle. Server-clock stamps. The rate-limit upsert is genuinely
atomic (45 concurrent requests, 45 hits). No SQL injection anywhere.

## Phase 2, slice 3 — the outbox and Running Late (adversarial review)

Four blockers, eight major findings. **96/96 green with all four blockers
live** — the third round in a row where a fully passing suite hid the defects,
and this time against the very improvements the previous retrospective had
named. Every fix re-verified by re-running the reviewer's own attack.

| # | Finding | Disposition |
|---|---|---|
| B1 | The claim lease was stamped once per **batch**, the batch sent serially, and `send()` had no timeout — so the last message of a batch had spent its lease before anything was sent to it, and a second worker re-sent it. Proven on a real clock: one message delivered **3 times**; with a 700ms provider, 4 of 6 sent twice. | **Fixed** — claiming is now a `sending` state with a worker id (migration 0005), every send is bounded by a timeout a quarter of the lease, sends run with bounded concurrency, and a sweeper returns genuinely stale claims. |
| B2 | `/eta` decided "already flagged?" from a read taken **outside** the transaction. Reproduced every run: concurrency N left N warnings on the dispatcher's note, and told N−1 callers it had not been flagged. | **Fixed** — decided under `FOR UPDATE` inside the transaction. Re-run: 8 simultaneous taps leave **1** warning. |
| B3 | Dedupe was a substring search of `trips.notes`, which the office also writes. An ordinary note reading "Call office if DRIVER RUNNING LATE" silently swallowed a genuine notice while telling the driver dispatch had been told. | **Fixed** — dedupe reads the event trail, not prose. Re-run with that exact office note: `alreadyFlagged: false`, notice reaches the board. |
| B4 | The writes recording an outcome were unguarded, so a failed bookkeeping write left a **delivered** message `pending` and aborted the rest of the batch. | **Fixed** — each message's resolution is guarded; an unrecordable outcome is counted as `unresolved` so it is visible rather than silently requeued. |
| M1 | `version` used `max(updated_at)`, and `now()` is the *transaction start*. A long office transaction committed a row stamped earlier than one already seen, so the token did not move for a committed edit — the phone skips the redraw and the driver keeps the old address. | **Fixed** — the version is a digest of the whole set (moves in either direction), and `touch_updated_at` uses `clock_timestamp()` (migration 0006). |
| M2 | `/eta` had no rate limit: 300 unbounded rows written in 1.1s. | **Fixed** — 6 per 10 minutes per driver (not per address: a phone changes networks). |
| M3 | The default sender logged the **sign-in code and the driver's phone number** in clear — and that is the sender production runs until a provider is wired. | **Fixed** — channel and a masked recipient only. Verified: 0 codes in the log. |
| M4 | `plainWords` was applied to the note and the event value and skipped for `payload.reason`, which `getTripActivity` serves to the office. | **Fixed** — sanitised everywhere it is stored. |
| M5 | No timeout plus serial sending meant one hanging provider stalled the queue and the scheduler's request. | **Fixed** with B1; a test now proves the message behind a hang still goes. |
| M6 | The outbox suite marked every other pending notification `'sent'` — recording a delivery that never happened, in the one table that must never claim that. | **Fixed** — rows are deleted, not falsely marked. |
| M7 | Nothing type-checked a route against `Api`; `getDriverDay` still declared `BoardTrip` while returning raw rows. | **Fixed** — the day payload is bound to the contract type, so drift is a compile error. It caught real drift immediately, and the fix also stopped the phone receiving the Medicaid number, invoice, price and an office email: 18 named fields now, not the whole row. |
| M8 | The two tests guarding the two blockers could not fail for them: the outbox concurrency test used a sender returning in microseconds, and the ETA dedupe test was sequential. | **Fixed** — a slow sender, a hanging sender, a stale-claim recovery case, and 8 simultaneous ETA taps. 96 → 103. |

### Minor — fixed

405 now carries `Allow` with an explicit `OPTIONS` (the exported verbs were
advertising every method on a POST-only endpoint), and answers `not-found`
rather than `validation`; the catch-all is optional so the bare `/api` no
longer returns HTML; `/eta` distinguishes `day-locked` from "not yet" as the
tap flow does; `plainWords` substitutes a space instead of deleting, so
"Route 9\nwill be late" no longer becomes "Route 9will be late"; `reason`
accepts 120 characters as the live system does; the ETA time carries a date
when it crosses midnight.

### Also found while fixing

`Trip` declares `vehicleLabel`; the `trips` table has only `vehicle_id`. The
contract no longer promises it. A flaky outbox ordering test — it asserted on
every message the sender saw, so another suite's leftover row broke it
intermittently; it now asserts on its own.

### Minor — recorded, not actioned

`CRON_SECRET` unset vs wrong is still distinguishable (500 vs 401) and the
length check is an oracle; the trip id is parsed from the URL string rather
than route params; a deduped second ETA does not move `version`; `plainWords`
is ASCII-only, which is a real limitation for non-English speakers.
