# Backlog

Ordered. Priorities follow `docs/07-feature-checklist.md`, phases follow
`docs/08-migration-plan.md`.

## Done

- **Monorepo with shared rules** (Phase 1) — `packages/rules` shared by
  `apps/web` and `apps/mobile` via an exports map over compiled output; Bun
  workspaces; CI running the parity harness. Verified: see `verification.md`.

## Next

- **API skeleton** (Phase 2) — introspect `db/migrations/0001_init.sql` with
  `drizzle-kit pull` rather than rewriting it; implement `src/api/contract.ts`
  endpoint by endpoint behind the `Result<T>` envelope, with Zod at the
  boundary. Auth and `driver_sessions` first.
  *Acceptance:* every endpoint returns the contract's envelope; one integration
  test per `FailureReason`; `db/smoke.sql` still passes.

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
- `apps/web` has no linter yet. Add one when the first real endpoint lands, so
  the config is shaped by real code rather than guessed at.
