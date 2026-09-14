# State

**Depth:** Standard, with one deliberate escalation. Nothing in production
depends on this yet, but this slice is authentication that will eventually
guard patient names, addresses and Medicaid numbers, so the authorization gate
— not the happy path — was treated as the risky part, and the independent
review pass is mandatory rather than optional.

**Product Goal:** Replace the Google Sheets / Apps Script dispatch system with a
maintainable TypeScript application, without losing a driver's tap or
mispricing a trip.

**Iteration goal (autonomous):** make sign-in usable end to end — the outbox
worker — then the Running Late notice and the recorded contract/envelope debt.

**Status:** outbox worker, Running Late, contract binding and envelope
coverage implemented, independently reviewed, and repaired — four blockers and
eight major findings, all fixed and re-verified against the reviewer's own
attacks (`review-findings.md`). 103 tests.

**Next action:** plug in an SMS provider and schedule the drain. Until then no
message is delivered and no driver can sign in.

**Resolved:** the owner confirmed the repo is public as-is, knowing it carries
the live Apps Script deployment URL and spreadsheet IDs. Rotating that
deployment URL remains available to them and is not blocking.
Phase 2 is the API skeleton: `drizzle-kit pull` against `0001_init.sql`, then
endpoints starting with auth and `driver_sessions`.

**Open question for the owner (from `docs/06-external-services.md:26`):** every
DISPATCH edit currently POSTs to an undocumented Cloud Function, and a menu link
points at a separate Vercel dashboard. Ask what that dashboard is and whether
anyone still uses it, before the importer is designed.
