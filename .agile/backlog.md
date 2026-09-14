# Backlog

Ordered. Priorities follow `docs/07-feature-checklist.md`, phases follow
`docs/08-migration-plan.md`.

## Done

- **Monorepo with shared rules** (Phase 1) — `packages/rules` shared by
  `apps/web` and `apps/mobile` via an exports map over compiled output; Bun
  workspaces; CI running the parity harness. Verified: see `verification.md`.

- **Driver sign-in** (Phase 2, first slice) — schema introspected with
  `drizzle-kit pull`; `POST /api/driver/sign-in`, `POST /api/driver/verify`
  and `GET /api/driver/me` behind the `Result` envelope with Zod at the
  boundary; codes through the `notifications` outbox; the roster re-checked on
  every request. 17 integration tests against real PostgreSQL, in CI.

## Next

- **Rate limiting on the unauthenticated endpoints** [must, before any real
  driver uses this] — `sign-in` and `verify` need a per-caller limit, not just
  the per-driver cooldown and per-code attempt cap that exist now. Knowing only
  a driver's name (or phone, in any punctuation), a stranger can burn each code
  as it is issued and keep that driver locked out; the per-driver controls
  bound the rate but cannot tell the driver and the attacker apart.
  *Acceptance:* a caller exceeding the limit gets `busy`; a test proves a third
  party cannot indefinitely deny sign-in to a driver they can name.

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

- Both app entry screens duplicate the same sample `quote(...)` call. Throwaway
  scaffolding; assess when the real screens replace them.
- `apps/web` now has real endpoints and still no linter. Worth adding on the
  next slice, when there is enough code for the config to be shaped by it.
- Sign-in and verify both resolve a driver from name/email/phone with nearly
  the same query. Observation: assess when the next endpoint needs the same
  lookup.
- Nothing drains the `notifications` outbox yet, so a queued sign-in code is
  never actually delivered. That worker is what makes sign-in usable by a real
  driver, and it needs the SMS provider decision from `docs/06`.
