# Amazing Grace Mobile Transport — rebuild

Non-emergency medical transport: wheelchair, stretcher, ambulatory and taxi
trips, booked by an office and driven by drivers with phones.

This repository replaces a Google Sheet with an Apps Script project bolted to
it — 37 files, 28,779 lines. **The old system still runs.** There is no cutover
weekend: drivers are mid-route, patients have appointments, and the office
cannot stop. Read `docs/08-migration-plan.md` before changing how anything is
rolled out.

## Layout

```
packages/rules/   The business rules, ported from the live system and proven
                  against it. Pure, dependency-free, no DOM. Both apps import
                  this and get the same answers.
  legacy/         All 37 live Apps Script files. The parity harness runs them.
apps/web/         Next.js — the dispatcher board and every API endpoint.
apps/mobile/      Expo — the driver app, and the office's on-the-go screens.
db/               PostgreSQL schema and its smoke test. Raw SQL is the truth.
docs/             What the system is, both apps, the API, the data model,
                  the migration plan, and the feature checklist.
```

## Getting started

```bash
bun install
bun run build:rules   # apps import the package's compiled output — build it first
bun run verify        # typecheck, 34 rule suites, and the parity run
```

Then either app:

```bash
bun run dev:web       # http://localhost:3000
bun run dev:mobile    # Expo
```

The database is optional until the API has a store:

```bash
createdb agnext
psql -d agnext -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
psql -d agnext -v ON_ERROR_STOP=1 -f db/smoke.sql   # rolls back, leaves nothing
```

## `bun run verify` is the important one

It type-checks, runs 34 rule suites, and then runs `tools/parity.mjs`, which
loads the **live Apps Script** out of `packages/rules/legacy/` into a sandbox
and compares it against the port: **1,778,112 quotes and 6,084 driver-name
comparisons**, in about 40 seconds.

If it fails, the rewrite has drifted from the system that is currently sending
invoices. Run it after any change to `pricing.ts` or `drivers.ts`.

## Sending messages

Sign-in codes and driver alerts queue in the `notifications` table. Nothing
sends inline — the old system did, and a driver was sometimes told twice, or
not at all with no record either way.

Three things have to be true before a driver can actually sign in:

1. **A provider is configured.** Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
   and `TWILIO_FROM` (see `.env.example`). Without all three the server logs
   `no delivery provider configured` at boot and messages stay queued.
2. **Something drains the queue.** Point a scheduler at
   `POST /api/jobs/drain-outbox` every minute with `CRON_SECRET` as a bearer
   token. On Vercel that is a cron entry; anywhere else, a timer.
3. **Twilio itself is set up to send.** Four settings in the console decide
   whether anything reaches a handset, and none of them are visible from here:
   A2P 10DLC brand and campaign registration (US 10-digit numbers, takes days,
   and unregistered traffic is silently filtered), whether the account is
   still on trial (only verified numbers, and a notice pasted in front of
   every message), whether `TWILIO_FROM` is SMS-capable at all, and
   geographic permissions for the countries being texted. `.env.example`
   spells each one out. These are the likeliest reason a correct
   configuration sends nothing.

The line the server prints at startup says what is *configured*:

```
[notifications] sms: Twilio (account AC1234…, from +15551234567,
no status callback — delivery is never confirmed); email: none
```

**Read it as exactly that and no more.** It is the credentials parsing, not a
message arriving. It said "Twilio" while the drain was sending nothing at all,
and it cannot see any of the four console settings above. The only proof is a
real message to a real handset.

### Knowing whether a message arrived

`docs/06-external-services.md` gives one reason for abandoning the carrier
email gateways: no delivery confirmation. So the queue distinguishes the two
facts it used to conflate:

| `notifications.state` | What it means |
|---|---|
| `accepted` | Twilio took the message. Nobody knows if the driver has it. |
| `sent` | Twilio confirmed the handset received it. |
| `failed` | Twilio reported it undelivered. `last_error` says why. |
| `abandoned` | Given up on — the number cannot be texted, or the message was no longer worth sending. |

A message only ever gets past `accepted` if `TWILIO_STATUS_CALLBACK_URL` is
set to this deployment's public URL, so Twilio has somewhere to report to.
Reports are rejected unless they carry Twilio's signature for that exact URL.

Email has no provider yet, so a driver with no phone number on file cannot be
sent a code. This is a gap, not a decision: `docs/07-feature-checklist.md:182`
makes sign-in code delivery a `[must]` by "whichever channel(s) are actually
available for that driver". They are still told a code was sent — telling an
anonymous caller otherwise would turn sign-in into a way to read the roster —
so the office has to notice. See `docs/06-external-services.md`.

## The non-negotiables

Each one is a production failure that has already happened. `CLAUDE.md` has the
full list and the story behind each. The short version:

1. The office's status and the driver's progress are two different fields.
2. A driver's tap is never lost and never applied twice.
3. The office's clock decides what time it is — never the phone's.
4. A price is a breakdown, never one number. Nil and zero are different facts.
5. An overdue trip nobody dealt with stays in front of the dispatcher.
6. Cancelling is visible whatever the driver is doing.
7. A blank is a blank. The old system wrote `23:58` to mean "no time given".

## Where this is up to

The rules, types, API contract and schema came from the rebuild kit and are
covered by tests. **Not built yet:** authentication, the importer, the driver
screens, the dispatcher board, and every endpoint body except a scaffold
`POST /api/pricing/quote`.

Both app entry screens are scaffolds that exercise the shared rules to prove
the wiring. Delete them when the real screens land.

See `docs/mobile-tech-stack-recommendation.md` for why Expo, and
`docs/07-feature-checklist.md` for everything that still has to exist.
