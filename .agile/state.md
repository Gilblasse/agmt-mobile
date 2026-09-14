# State

**Depth:** Standard, with one deliberate escalation. Nothing in production
depends on this yet, but this slice is authentication that will eventually
guard patient names, addresses and Medicaid numbers, so the authorization gate
— not the happy path — was treated as the risky part, and the independent
review pass is mandatory rather than optional.

**Product Goal:** Replace the Google Sheets / Apps Script dispatch system with a
maintainable TypeScript application, without losing a driver's tap or
mispricing a trip.

**Iteration goal (Phase 2, first slice):** driver sign-in end to end — one-time
code, verified session, and an authorized request — against real PostgreSQL.

**Status:** Phase 1 delivered, pushed, CI green. Phase 2 first slice
implemented and locally verified (17/17 integration tests); independent review
pending.

**Next action:** collect the review, resolve findings, push.

**Resolved:** the owner confirmed the repo is public as-is, knowing it carries
the live Apps Script deployment URL and spreadsheet IDs. Rotating that
deployment URL remains available to them and is not blocking.
Phase 2 is the API skeleton: `drizzle-kit pull` against `0001_init.sql`, then
endpoints starting with auth and `driver_sessions`.

**Open question for the owner (from `docs/06-external-services.md:26`):** every
DISPATCH edit currently POSTs to an undocumented Cloud Function, and a menu link
points at a separate Vercel dashboard. Ask what that dashboard is and whether
anyone still uses it, before the importer is designed.
