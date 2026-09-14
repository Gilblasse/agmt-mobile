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

**Status:** outbox worker, Running Late, contract binding, envelope coverage
and the Twilio adapter implemented, independently reviewed, and repaired. The
Twilio round found three blockers, seven major and nine minor findings, all
under a fully green suite — every one a wrong fact recorded rather than a
crash: a sign-in code sent to a stranger in Maine, a carrier refusal filed as a
delivery, and a console switch that would have thrown the whole queue away. All
fixed and re-verified against the reviewer's own attacks
(`review-findings.md`). 156 tests.

**Next action:** an email provider (an unmet `[must]`, see the backlog),
schedule the drain, and one real message through a real Twilio account. Until
a message actually leaves, no driver can sign in.

**Resolved:** the owner confirmed the repo is public as-is, knowing it carries
the live Apps Script deployment URL and spreadsheet IDs. Rotating that
deployment URL remains available to them and is not blocking.
Phase 2 is the API skeleton: `drizzle-kit pull` against `0001_init.sql`, then
endpoints starting with auth and `driver_sessions`.

**Open question for the owner (from `docs/06-external-services.md:26`):** every
DISPATCH edit currently POSTs to an undocumented Cloud Function, and a menu link
points at a separate Vercel dashboard. Ask what that dashboard is and whether
anyone still uses it, before the importer is designed.
