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
and the Twilio delivery path implemented, independently reviewed **twice**,
and repaired. The second review found three more blockers — and two of them
were created by the first round's own fixes: refunding an attempt for a
configuration failure gave such a row no exit at all, so twenty unsendable
emails starved every sign-in code behind them; and the shipped ten-second
timeout reported an already-delivered message as unreachable, texting a driver
the same code twice. Both reproduced live under 156 passing tests. All fixed
and re-verified against the reviewer's own attacks
(`review-findings.md`). **174 tests.**

**The first real message has been sent.** Accepted by Twilio, refused by the
carrier five seconds later — 30032, the toll-free sender is not verified. The
queue learned that by asking Twilio, through a read-back built because of it.

**Next action for the owner:** submit Toll-Free Verification for
+1 855 710 6104 in the Twilio console, and upgrade the account off trial.
Nothing is delivered until the first is approved; no code change can do it.

**Next action for the build:** an email provider (an unmet `[must]`), and
schedule the drain.

**Resolved:** the owner confirmed the repo is public as-is, knowing it carries
the live Apps Script deployment URL and spreadsheet IDs. Rotating that
deployment URL remains available to them and is not blocking.
Phase 2 is the API skeleton: `drizzle-kit pull` against `0001_init.sql`, then
endpoints starting with auth and `driver_sessions`.

**Open question for the owner (from `docs/06-external-services.md:26`):** every
DISPATCH edit currently POSTs to an undocumented Cloud Function, and a menu link
points at a separate Vercel dashboard. Ask what that dashboard is and whether
anyone still uses it, before the importer is designed.
