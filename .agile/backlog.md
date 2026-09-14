# Backlog

Ordered. Priorities follow `docs/07-feature-checklist.md`, phases follow
`docs/08-migration-plan.md`.

## Done

- **Notification outbox worker** — claims due messages under a lease, retries
  with back-off, gives up after five attempts keeping the row and its last
  error, and drains behind a secret-gated job endpoint. Delivery itself is a
  `Sender` interface whose default sends nothing and says so.
  *Residual:* no provider is plugged in, so **no message is actually delivered
  yet**. That is the SMS decision in `docs/06`, and it is now the only thing
  between a driver and signing in.

- **Rate limiting on the unauthenticated endpoints** — fixed-window counters in
  the database (migration 0003), 30 per ten minutes per caller on each of
  `sign-in` and `verify`, answering `busy` with `Retry-After`. Verified: an
  attacker naming a driver gets 30 attempts then refusal for ten minutes, while
  the driver signs in normally from their own address.
  *Residual:* an attacker spread across many addresses is still only bounded by
  the per-driver cooldown. Recorded as an observation, not scheduled.

- **Monorepo with shared rules** (Phase 1) — `packages/rules` shared by
  `apps/web` and `apps/mobile` via an exports map over compiled output; Bun
  workspaces; CI running the parity harness. Verified: see `verification.md`.

- **Driver sign-in** (Phase 2, first slice) — schema introspected with
  `drizzle-kit pull`; `POST /api/driver/sign-in`, `POST /api/driver/verify`
  and `GET /api/driver/me` behind the `Result` envelope with Zod at the
  boundary; codes through the `notifications` outbox; the roster re-checked on
  every request. 17 integration tests against real PostgreSQL, in CI.

- **The driver's day and the tap flow** — `GET /api/driver/day`,
  `POST /api/driver/trips/:id/progress`, `POST .../undo`. Ownership gate,
  idempotent taps, monotonic guard, server-clock stamps, tomorrow read-only.
  20 integration tests.

## Next

- **The rest of the API** (Phase 2) — remaining `contract.ts` endpoints behind
  the same envelope. Next most useful: `getDriverDay`, then `setDriverProgress`
  with its idempotency key, since those unblock the driver app.
  *Acceptance:* every endpoint returns the contract's envelope; one integration
  test per `FailureReason` reachable on that endpoint; `db/smoke.sql` still passes.
  *Carry in:* update `contract.ts` so `driverVerify` matches what was built
  (see `decisions.md`).

- **Importer** (Phase 3) — *Acceptance:* runs twice with the same result, and
  every refused row is explainable. Watch the `23:58` sentinel and the Google
  1899 date stamps in `docs/04-data-model.md`.

- **Read-only shadow** (Phase 4) — *Acceptance:* a dispatcher looks at it and
  says "yes, that's what happened".

- **Driver app** (Phase 5) — build in this order, because the last three are the
  ship blockers: sign-in → day view → tap flow → **offline outbox** →
  **idempotent taps** → **clock correction**.
  *Acceptance:* a week in parallel with no tap lost and no dispatcher noticing.
  Do not ship without all four blockers. See the outbox design in
  `docs/mobile-tech-stack-recommendation.md`.

- **Dispatcher board** (Phase 6), then the office subset in the app.

## Observations (not scheduled work)

- Rate limiting is keyed on `x-forwarded-for`, which is caller-controlled
  unless a trusted proxy rewrites it. Whatever this deploys behind must be
  configured to overwrite that header, or the limit is advisory. Assess when
  hosting is chosen.
- Fixed windows allow up to 2× the limit across a window boundary. Accepted:
  these limits stop sustained abuse rather than meter precisely.

- Both app entry screens duplicate the same sample `quote(...)` call. Throwaway
  scaffolding; assess when the real screens replace them.
- `apps/web` now has real endpoints and still no linter. Worth adding on the
  next slice, when there is enough code for the config to be shaped by it.
- Sign-in and verify both resolve a driver from name/email/phone with nearly
  the same query. Observation: assess when the next endpoint needs the same
  lookup.
- The office cannot see the outbox: `getOutbox` and `retryNotification` from
  the contract need office authentication, which does not exist yet. Until
  then an abandoned message is visible only in the database.
