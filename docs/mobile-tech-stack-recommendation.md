# Mobile tech stack for the Amazing Grace rebuild

## Context

Amazing Grace Mobile Transport runs non-emergency medical transport (wheelchair,
stretcher, ambulatory, taxi). It runs **today, in production**, on one Google Sheet plus
an Apps Script project of 37 files / 28,779 lines. Two groups use it:

- **The office** — one or two dispatchers, on a laptop or a phone.
- **The drivers** — on phones, on cell signal, in moving vehicles, and the docs are
  explicit: *"often in hospital basements with no bars at all."*

The uploaded kit is **not a greenfield brief**. It already contains decisions and working
code that constrain the stack:

| Asset | What it is | Why it matters here |
|---|---|---|
| `src/rules/` | ~1,150 lines of **pure, zero-dependency, strict TypeScript** — the 24-rule pricing engine, time/clock, status transitions, driver identity matching, money rounding, recurrence | `tsconfig.json` targets ES2022 / NodeNext with `lib: ["ES2022"]` — **no DOM lib**. This is deliberately portable logic. |
| `tools/parity.mjs` | Differential harness running the **live Apps Script code** in a Node `vm` against the TS port | **1.78M quote comparisons + 6,084 name comparisons, zero drift.** This is the single most valuable thing in the repo. |
| `src/api/contract.ts` | Every call both apps make, typed, over plain REST | `Result<T>` discriminated union, `idempotencyKey` on driver writes, `ifUpdatedAt` optimistic concurrency |
| `db/migrations/0001_init.sql` | PostgreSQL 16 — 17 tables, 1 view, 7 enums, 46 indexes | Already models `driver_sessions`, `driver_sign_in_codes`, a `notifications` outbox with channel `('sms','email','push')`, and a **partial unique index on `trip_events.idempotency_key` that *is* the idempotency guarantee** |
| `CLAUDE.md:68-71` | *"Unless told otherwise: **TypeScript, Next.js, Node, PostgreSQL.** That is the owner's own stack."* | The server half is already chosen |

**Nothing about the mobile client has been decided.** The kit describes the current driver
app as a *"mobile web page"* and never names React Native, Flutter, Swift, Kotlin or
Capacitor. That is the open question this plan answers.

### Decisions taken this session

1. **One app, both roles** — a single mobile app that shows driver or dispatcher screens
   depending on who signs in. Dispatchers additionally keep **full web** access.
   **Drivers get the app only** — no web fallback.
2. **Private / internal distribution** — not a public App Store listing.
3. **Rebuild the driver UI properly**, treating the legacy 1,956-line HTML page as a UX
   specification rather than code to port.

### The requirement that actually decides the stack

`CLAUDE.md:44-47`, non-negotiable #2:

> **A driver's tap is never lost and never applied twice.** The phone keeps an offline
> queue and re-sends. Every tap carries a nonce; a re-send is recognised, not re-applied;
> and a tap can never move a trip backwards. Time spent with no signal does not count
> against the retry budget.

`docs/07-feature-checklist.md:160` — a `[must]`: a tap made with no connection is saved
**on the phone itself** and retried until confirmed, **surviving the app being closed or
the phone restarting**. And `docs/08-migration-plan.md:91-93` makes it a ship blocker:
*"A driver app that loses taps on bad signal is worse than the one they have."*

Worth stating plainly, because it cuts against the usual argument: the driver checklist
requires **no camera, no photo, no signature capture, no barcode, no Bluetooth, no
biometrics, no offline maps, and no background location**. Location sharing is `[should]`
and **foreground-only** (`docs/02-driver-app.md:535` — one-shot lat/lng every 120s while a
hero trip exists). This is **not** a "we need native for the sensors" decision. It is a
durable-storage, distribution, and delivery decision.

---

## Recommendation

**Expo (React Native) + TypeScript for the app. Next.js for the web app and the API. One
Bun-workspace monorepo. PostgreSQL 16. `src/rules` promoted to a shared package consumed
unchanged by both.**

### The stack

**Mobile app — `apps/mobile`**

| Concern | Choice | Why |
|---|---|---|
| Framework | **Expo SDK (React Native)**, TypeScript strict | One codebase → iOS + Android; keeps 100% of the TS rules and the parity harness |
| Routing | **expo-router** | File-based, near-identical mental model to the Next.js App Router already in use |
| Styling | **NativeWind v4** | Tailwind syntax on React Native; the legacy UI already uses shadcn design tokens, which port to CSS variables cleanly |
| Server state | **TanStack Query** | Gives the polling cadence (`refetchInterval`), cache invalidation and optimistic updates the spec needs, for free |
| **Offline outbox** | **expo-sqlite** | **The load-bearing choice — see below** |
| Session token | **expo-secure-store** | Keychain / Keystore instead of `localStorage["ag-token"]` |
| Location | **expo-location**, foreground only | Matches the spec exactly, and avoids the background-location review gauntlet |
| Navigate / call | `Linking.openURL` | `tel:` and a maps deep link — same as today |
| Push | **expo-notifications** → APNs/FCM | Optional but cheap; see "Push vs SMS" |
| OTA updates | **expo-updates** | Ship JS fixes to drivers **without a store round-trip** — enormous during a parallel run |
| Builds | **EAS Build** (or local/CI builds) | iOS builds without owning a Mac |

**Web + API — `apps/web`**

Next.js 16 App Router route handlers on the Node runtime (exactly the pattern already
used in the take-home repo), PostgreSQL 16, **Drizzle introspected from the existing SQL**
via `drizzle-kit pull` — do *not* rewrite `0001_init.sql` as a Drizzle schema; keep the
raw SQL migrations as the source of truth and `db/smoke.sql` as the guard. **Zod** at every
request boundary (the one real gap in the current toolkit). Custom auth on the
`office_users` / `driver_sessions` tables that already exist — no NextAuth, the schema
already models the exact scheme.

**Shared — `packages/`**

```
packages/
  rules/        ← the existing src/rules + src/types, unchanged, plus test/ and tools/parity.mjs
  api-client/   ← a typed fetch client implementing the Api interface from src/api/contract.ts
apps/
  web/          ← Next.js: dispatcher web UI + ALL /api routes (the server)
  mobile/       ← Expo: driver screens + dispatcher-mobile screens
```

Both apps import `@ag/rules` and get the same pricing engine, the same `officeDateKey()`,
the same monotonic `canAdvance()` guard. The parity harness keeps running in CI against the
still-live Apps Script, so the phone and the office can never drift from production.

---

## Why this, and not the alternatives

**Flutter** — the strongest competitor on pure app quality, and the wrong answer here. It
means porting ~1,150 lines of parity-tested pricing/time/status logic to Dart and
**abandoning `tools/parity.mjs`** — the 1.78M-comparison harness that is the only thing
proving the rewrite prices trips identically to the system currently invoicing real money.
Rebuilding that in Dart is weeks of work to get back to zero. It also splits the codebase
in two languages for a team that is one developer on a TypeScript/Next.js stack.

**Capacitor wrapping a React web app** — a genuinely fair option, and the runner-up. It
would give one codebase for web + mobile, store binaries, native SQLite, and real push,
while letting the legacy CSS port almost directly. It loses on two counts: the user has
asked for the UI to be rebuilt properly rather than reused, which removes Capacitor's main
advantage; and the driver app is a thumb-driven, in-motion, gesture-heavy surface where
webview scrolling and sheet gestures are noticeably worse. Reconsider Capacitor only if the
RN learning curve proves to be the schedule risk.

**PWA only** — ruled out by the user's own decisions, not by capability. Two hard blocks:
a PWA cannot be distributed privately through Apple Business Manager or managed Google Play
(there is no binary), and drivers have **no web fallback**, so install reliability is not
optional. On the technical merits the PWA case is more defensible than usually claimed —
IndexedDB does survive app close and restart, and the current production system already
does this with `localStorage`. But Safari's ITP evicts script-writable storage after 7 days
without interaction (home-screen-installed apps are largely exempt, which is a fragile
thing to depend on), and **Background Sync is not implemented in Safari at all**, so a
queued tap can only ever drain when the driver next opens the app.

**Bare React Native (no Expo)** — no reason to. Expo's managed workflow, EAS Build, and
expo-updates are exactly the ergonomics a solo developer with no RN experience needs, and
there is no native module here that Expo doesn't already wrap.

---

## The offline outbox — the part that must not be got wrong

This is where the native choice actually pays, so it is worth being precise about what it
does and does not buy.

**Design (`apps/mobile/src/outbox/`):**

```sql
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- FIFO order
  idempotency_key TEXT NOT NULL UNIQUE,               -- the phone's nonce
  endpoint        TEXT NOT NULL,
  payload         TEXT NOT NULL,                      -- JSON
  tapped_at       TEXT NOT NULL,                      -- device clock, corrected; server still stamps the truth
  first_sent_at   TEXT,
  tries           INTEGER NOT NULL DEFAULT 0,
  trip_id         TEXT NOT NULL,                       -- FIFO is per trip, not global
  state           TEXT NOT NULL DEFAULT 'pending'      -- pending | sent | stuck | parked
);
```

- **SQLite over AsyncStorage/localStorage.** `docs/02-driver-app.md:301-303` records a real
  total outage: one malformed `localStorage` value bricked the entire app, because a throw
  mid-`<script>` aborts every function definition after it. SQLite gives atomic
  transactions and per-row failure. Every read is still wrapped defensively, and a row that
  fails to parse is **quarantined, not thrown** — the `[must]` in
  `docs/07-feature-checklist.md:161` is that a corrupt queue can never stop a driver
  signing in and seeing their day.
- **The nonce flows straight to the database.** `idempotency_key` goes in the request body
  and lands on the partial unique index on `trip_events.idempotency_key`. A re-send is
  rejected by Postgres, not by application logic, and the endpoint returns
  `{ applied: false, alreadyApplied: true }` per `src/api/contract.ts`.
- **Driver progress writes never send `ifUpdatedAt`.** The contract carries both
  `idempotencyKey` and `ifUpdatedAt`, and this is a trap. A tap queued in a basement and
  drained an hour later would fail optimistic concurrency against a trip the dispatcher has
  since edited — and a rejected tap is a **lost** tap, which breaks non-negotiable #2.
  `setDriverProgress` / `undoDriverProgress` are protected by the idempotency key plus the
  server-side monotonic `canAdvance()` guard, and **nothing else**. `ifUpdatedAt` is for
  office edits, where two dispatchers overwriting each other is the real risk.
- **Retry budget and its terminal state.** 6 tries, 20s timeout, 10s drain interval — but
  when `NetInfo.isConnected === false`, clear `first_sent_at` and requeue **for free**, per
  non-negotiable #2. A tap that exhausts the budget moves to `state = 'stuck'`: it **stays
  in SQLite**, it surfaces in the UI as a plain "couldn't send this yet — tell dispatch"
  marker on that trip, and it is retried again on the next foreground. Nothing is ever
  deleted for failing to send.
- **Draining is FIFO per trip, not globally serial.** A tap the server permanently refuses
  (a backwards move, a trip reassigned away) is marked `parked` and must not block the taps
  queued behind it. Order matters within one trip's sequence; across trips it does not.
- **Drain triggers:** on app foreground, on a NetInfo connectivity regain, on a 10s timer
  while foregrounded, and — Android only, reliably — a WorkManager job via
  `expo-background-task`.

**Be honest about iOS background execution.** Native does **not** give you guaranteed
background draining on iOS. `BGAppRefreshTask` is opportunistic — the OS decides when or
whether to run it, with a floor around 15 minutes — and silent pushes are rate-limited and
**will not launch an app the driver has force-quit**. So the iOS guarantee to state to the
office, without softening it, is: **a tap is durably stored and sends the moment the app is
next opened.** Android can additionally drain in the background via WorkManager. The native
win over a web app is **durability plus store distribution**, not background execution.
Anyone who tells you otherwise is selling something.

---

## "One app, both roles" — how to scope it

The user's choice, with one recommendation attached. The dispatcher surface is large: 28
board items in the checklist alone, plus booking/editing, standing orders, the passenger
directory, and the pricing settings screen — from an 11,909-line source page.

**Recommended split:**

- **`app/(driver)`** — the complete driver experience. Nothing omitted; this is the whole
  reason the app exists.
- **`app/(office)`** — a deliberate **on-the-go subset**: the live board, quick status
  changes, trip details, add/edit a trip, Needs Scheduling, and driver "running late"
  notes. This is what a dispatcher needs away from the desk.
- **Web only** — the heavy admin: pricing settings, passenger directory and blacklist,
  standing-order spread modals, and Submit Day. These are dense, consequential,
  keyboard-shaped screens. Building them twice is real cost for no gain, and
  `docs/07-feature-checklist.md` flags Submit as a one-way action that *"can't be undone."*

Two sign-in paths land in the same app: office users by email, drivers by name + 6-digit
code. Routing is a convenience; **the real gate is server-side authorization** — the
four-test rule in `docs/02-driver-app.md:76-91`, re-checked against the roster on every
single call, because `docs/07-feature-checklist.md:115` requires removing a driver to cut
access within minutes.

---

## Private distribution — start the paperwork first

This has the longest lead time of anything in the plan and nothing else depends on code.

**Recommended path:**

- **Pilot (migration Phase 5, "one or two willing drivers first"):** **TestFlight** (iOS) +
  **Play internal testing** (Android). Zero setup friction, available immediately.
- **Production, iOS:** **Apple Business Manager Custom App** — distributed privately to
  named organizations, and not subject to the "must be useful to a broad public audience"
  rejection under guideline 4.2 that sinks company-internal apps submitted as normal
  listings.
- **Production, Android:** a **permanent Play closed-testing track** is the right default
  — no 90-day expiry, no Android Enterprise or Google Workspace enrollment, testers added
  by email address, and updates ship in hours. Only move to a managed Google Play private
  app if the company is already on Google Workspace and wants devices centrally managed.
- **Fallback if ABM enrollment stalls:** stay on TestFlight for iOS indefinitely.
  TestFlight builds expire after 90 days — automate a rebuild-and-upload on a scheduled
  GitHub Action so the expiry is a cron job, not a chore. Android needs no fallback; the
  closed-testing track is already the long-term answer.

**Do not plan around the Apple Developer Enterprise Program** ($299/yr, in-house
distribution, no review). Apple grants it restrictively and a small transport company is
unlikely to qualify.

**Prerequisites to start now:** a D-U-N-S number for the business, Apple Developer Program
enrollment **as an organization** ($99/yr — an individual account cannot do Custom Apps),
Apple Business Manager enrollment, and a Google Play Console account ($25 one-time).
Allow weeks, not days.

**Running costs at this scale:** Twilio ~$0.008/SMS plus ~$1.15/mo per number (negligible
for ~9 drivers); Google Maps Distance Matrix ~$5 per 1,000 elements — **must** be cached in
the `drive_cache` table that already exists, per `docs/06-external-services.md:80-83`
(*"Maps is charged per call… Cache it, budget it"*); managed Postgres and Vercel in the
$0–45/mo range. EAS Build has a free tier; builds can also run in GitHub Actions to avoid
the paid plan.

---

## Push vs SMS

SMS is a `[must]` — `docs/07-feature-checklist.md:186` mandates replacing the dying
carrier-email gateways with a real provider (Twilio). Push is in the DB enum
(`notification_channel`) but is **not** a stated requirement.

Add push anyway, as a second channel behind the same `notifications` outbox. It costs
little once expo-notifications is wired, it is free per message where SMS is not, and it can
carry a deep link straight to the trip — which SMS deliberately cannot, since
`docs/07-feature-checklist.md` requires *"plain punctuation with no web links"* because
carrier gateways treat links as spam and can start blocking the sender.

**Do not treat push as an outbox-draining mechanism.** A visible push prompts the *driver*
to open the app, which drains the queue — that is a behavioural nudge, not a technical
guarantee. Keep SMS as the guaranteed channel; the outbox already supports *"attempt both,
delivered if either succeeds."*

---

## Build order

Mapped onto the nine phases in `docs/08-migration-plan.md`. The kit is at the end of
Phase 2.

1. **Monorepo + shared rules.** **Bun workspaces throughout** — Bun is already the package
   manager and runner in the existing repo and in CI, so every command in this plan is
   `bun run`, including inside `packages/rules` (whose scripts came from the kit as `npm`).
   Move `src/` → `packages/rules` unchanged. Keep `bun run verify` (tsc + `node --test` +
   parity) green and wire it into CI on day one. **Consume the compiled `dist/` output** —
   the package already has `"build": "tsc"` and `declaration: true` — and point
   `exports`/`types` at it, rather than feeding raw `.ts` with `.js` specifiers to Metro.
   **This spike has now been run — see "Spike results" below. It passes, and needs no
   custom Metro configuration.**
2. **API skeleton.** `drizzle-kit pull` against `0001_init.sql`. Implement
   `src/api/contract.ts` endpoint by endpoint, `Result<T>` envelope, Zod at the boundary,
   Jest integration tests against real Postgres. Auth + `driver_sessions` first.
3. **Importer** (Phase 3) and **read-only shadow** (Phase 4) — out of scope for the mobile
   decision but they gate everything after.
4. **The driver app** (Phase 5). Build in this order, because the last three are the ship
   blockers and finding out they are hard *after* the UI is built is the classic failure:
   sign-in → day view → tap flow → **outbox** → **idempotency** → **clock correction**.
5. **Dispatcher web** (Phase 6), then the office subset in the app.
6. Phases 7–8 per the migration doc.

---

## Spike results (verified, not predicted)

The plan's one day-1 technical unknown was whether Metro could consume a NodeNext-built
TypeScript package whose internal imports carry `.js` extensions. **It can.** Everything
below was executed, not reasoned about.

**Baseline — the kit is green as shipped.** `tsc` builds clean, emitting both `.js` and
`.d.ts`. All **34 rule suites pass**. The parity harness reports
**1,778,112 quotes compared, identical** and **6,084 name comparisons, identical**, in
**36 seconds** — fast enough to run on every CI push, not just nightly.

**The shared package bundles through the real Expo pipeline.** A `create-expo-app`
project on **Expo SDK 57 / React Native 0.86 / React 19.2**, with `@ag/rules` declared as
a `file:` dependency and an `exports` map pointing at `dist/`, produced a production
export: **590 modules, a 1.5 MB Hermes bytecode bundle, exit 0.** The rule strings
`23:58`, `Wheelchair`, `Deadhead` and `Minimum fare` are all present in the compiled
`.hbc`, so the engine is genuinely in the app binary.

**Correction to the plan as written:** `unstable_enablePackageExports` is **not** needed.
Expo SDK 57's default Metro config resolves the `exports` map and the NodeNext `.js`
specifiers with **no `metro.config.js` at all**. The original plan called for that flag;
that was wrong, and carrying it would have added config nobody needs.

**The rules compute correctly off the built package:**

| Check | Result | What it proves |
|---|---|---|
| `officeDateKey(2026-09-13T02:30Z, America/New_York)` | `"2026-09-12"` | Non-negotiable #3 — the office's clock decides the day, not UTC and not the device |
| `money(1.005)` | `1.01` | The documented half-up rounding survives the port |
| `canAdvance('', 'IN ROUTE')` | `true` | Monotonic guard lets progress move forward |
| `canAdvance('COMPLETE', 'IN ROUTE')` | `false` | …and never backward — non-negotiable #2 |
| `quote(...).incomplete` | `true` | Non-negotiable #4 — an unpriceable trip says so; it never silently becomes zero |

**One practical trap found.** Hand-creating the workspace symlink and *then* running
`npm install` leaves an empty `node_modules/@ag/` — npm silently removes it, and Metro
then fails with a bare "could not be found within the project". Declare the dependency
properly (`file:` or a workspace protocol) and let the package manager create the link.
Do not hand-symlink.

**Not yet verified:** `expo-sqlite` behaviour under a real cold start with a corrupt row,
and anything requiring a physical device or simulator — neither is possible in this
environment. Those stay on the manual checklist in Verification.

---

## Risks

- **Zero React Native experience.** Real, and the main schedule risk. Mitigated by Expo +
  expo-router (App Router mental model) + NativeWind (Tailwind already written fluently).
  Budget 2–3 weeks of ramp and do the Phase-1 spike before committing.
- **ABM/D-U-N-S lead time** — start immediately, in parallel with everything.
- **"One app, both roles" doubles the mobile surface** if taken literally. The subset above
  is the mitigation; it is a scope call, not a technical one, and is easy to revisit.
- **The undocumented Cloud Function.** `docs/06-external-services.md:26-27` is unambiguous:
  *"Before anything else in the rebuild: ask the owner what that dashboard is and whether
  anyone still uses it."* Every DISPATCH edit currently POSTs to
  `us-central1-agmtlambdaapi.cloudfunctions.net/trips`, and a menu link points at a separate
  Vercel dashboard. **This is an open question for the owner, not a decision to make.**
- **Don't start with WebSockets.** Keep the specified polling (board 3s, driver 4s) via
  TanStack Query `refetchInterval` against the cheap `getBoardVersion` endpoint. The docs
  say it plainly: *"The polling works fine; it is not the part that needs rescuing."*
  Upgrade to SSE later if it earns its place.

---

## Verification

- `cd packages/rules && bun run verify` — typecheck, 34 rule suites, and the parity run
  against the live Apps Script. **This must stay green through every phase**; it is the
  only proof the rewrite prices trips the same as the system currently sending invoices.
- `psql -f db/migrations/0001_init.sql && psql -f db/smoke.sql` — the schema still honours
  every non-negotiable. Re-run after any schema change.
- API: Jest integration tests against a real Postgres (the pattern already in use), one per
  `FailureReason`. Include a test that a `setDriverProgress` call arriving an hour stale,
  against a trip edited since, still applies — the `ifUpdatedAt` trap above.
- **The offline behaviour is the ship blocker, so test it in two layers.**
  - *Automated, in-app:* unit tests over the outbox module with a mocked transport —
    enqueue, drain, duplicate nonce, budget exhaustion → `stuck`, permanent rejection →
    `parked` without blocking the queue behind it, and a deliberately corrupt row that must
    not prevent sign-in. Plus a Maestro flow driving the five taps against a stubbed
    offline transport and asserting the queue's contents.
  - *Manual, documented, on a real device, signed off before any driver sees it:* airplane
    mode → tap all five steps → force-quit → **reboot the phone** → restore signal → open
    the app → assert every tap landed exactly once, in order, with the server's timestamps.
    Maestro cannot reboot a handset or reliably toggle airplane mode on iOS, so this stays a
    written checklist run on both platforms, not a CI job.
- Manual, on a real phone, on real cell signal: the wait timer, the 6-second undo, the
  1200ms debounce, and a deliberately wrong device clock (set the phone an hour behind and
  confirm nothing freezes at `00:00`).
