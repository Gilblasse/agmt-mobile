# Backlog

Ordered. Priorities follow `docs/07-feature-checklist.md`, phases follow
`docs/08-migration-plan.md`.

## Done

- **Twilio for text messages** — adapter, failure classification, phone
  numbers parsed against a configured region, delivery confirmation through a
  signed status callback, and boot-time reporting of which provider is live.
  Proven end to end against a stand-in endpoint: request → queued → drained →
  API call → marked accepted → driver signs in with the texted code.
  *Not verified:* any real delivery. No message has left this system, and the
  four Twilio console settings that decide whether one could (A2P 10DLC
  registration, trial restrictions, number capability, geographic permissions)
  cannot be checked from here.

- **Running Late notice** [must] — `POST /api/driver/trips/:id/eta`. The phone
  sends minutes; the office's clock turns it into a time on the board. Reason
  stripped to plain words, warning deduped on the trip, every report kept in
  the trail.
- **Contract drift closed** — `contract.ts` matches what was built
  (`driverVerify` identifiers, `driverSignIn` name, `getDriverDay` timeZone /
  readOnly / version, `reportEta` reason and note). Parity re-run: unaffected.
- **Every answer is the envelope** — an unknown `/api` path and a wrong method
  both returned non-JSON, which crashes a client that always parses JSON.

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

- **Send a real message through the real Twilio** [must, before any driver] —
  the adapter is built and proven against a stand-in endpoint, but **no message
  has ever left this system**. Needs a Twilio account, a number, and the three
  environment variables. Watch for: a trial account can only text verified
  numbers; the roster's numbers must be textable (a landline abandons with
  21614); and check the sending number's region.
  *Acceptance:* a driver receives a code on a real phone and signs in with it.

- **Email delivery** [should] — Twilio carries text only, so a driver with no
  phone number on file cannot receive a code and the office is not told. Needs
  a transactional email provider behind the same `Sender` interface.

- **Schedule the drain** — the worker exists and the endpoint is gated, but
  nothing calls it on a timer yet. A platform cron hitting
  `POST /api/jobs/drain-outbox` every minute with `CRON_SECRET`.

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

## Next — raised by the Twilio review

- **An email provider** [must] — `docs/07-feature-checklist.md:182` makes
  sign-in code delivery a `[must]` by "whichever channel(s) are actually
  available for that driver". A driver on the roster with an email address and
  no phone number cannot be sent a code today: there is nothing to send it
  with, and sign-in deliberately tells every caller the same thing, so the
  office gets no signal either. This is an unmet requirement, not a decision —
  `decisions.md` previously cited the wrong line to justify it.

- **Schedule the drain** — nothing calls `POST /api/jobs/drain-outbox` yet, so
  in a real deployment a queued sign-in code would sit there. One cron entry.

- **Send one real message** — needs the owner's Twilio account. Everything up
  to the network is proven; nothing past it is. Blocked on an account, which
  is a business decision with a bill attached and is not mine to make.

- **A driver's own sign-in codes are not the only thing in the queue.** Trip
  alerts (`docs/07:178-182`) are all `[must]` and none are queued yet — the
  outbox exists and nothing but sign-in writes to it.

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
