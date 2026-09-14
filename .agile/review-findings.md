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
