# State

**Depth:** Standard — several components, internal dependencies only, and the
riskiest piece (Metro resolving the shared package) was verified in a spike
before this iteration started. Nothing in production depends on this yet.

**Product Goal:** Replace the Google Sheets / Apps Script dispatch system with a
maintainable TypeScript application, without losing a driver's tap or
mispricing a trip.

**Iteration goal (Phase 1 of `docs/08-migration-plan.md`):** One monorepo where
the parity-tested rules package is shared, unchanged, by an Expo app and a
Next.js app, with the parity harness green in CI.

**Status:** Iteration complete, locally verified, and independently reviewed.
The review found no blockers and six major findings; all six are resolved or
escalated (see `review-findings.md`). Not yet pushed.

**Next action:** Resolve the one open question below, push, confirm CI is green.

**Open decision blocking the push:** the repo is public, and
`packages/rules/legacy/` contains the live Apps Script — including the live
driver-app deployment URL and seven spreadsheet IDs for a system holding
patient names, addresses and Medicaid numbers. Confirm public is intended, or
make the repo private, before the first push.
Phase 2 is the API skeleton: `drizzle-kit pull` against `0001_init.sql`, then
endpoints starting with auth and `driver_sessions`.

**Open question for the owner (from `docs/06-external-services.md:26`):** every
DISPATCH edit currently POSTs to an undocumented Cloud Function, and a menu link
points at a separate Vercel dashboard. Ask what that dashboard is and whether
anyone still uses it, before the importer is designed.
