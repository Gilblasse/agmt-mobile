# Improvements

How the work is done, not what the code should become. Refactoring ideas
belong in `backlog.md` observations.

## After Phase 2, slice 2 (the tap flow)

**The evidence.** Two independent reviews have now found blockers in code whose
whole test suite was green. The sign-in slice: 17 tests passing, two blockers.
The tap flow: 51 tests passing, three blockers — including a lost tap, the one
failure CLAUDE.md says must never happen. In both cases the defects appeared
only when requests arrived together, and in both cases every test fired its
requests one after another.

That is not bad luck twice. It is a habit: tests were written to describe the
feature working, and the feature does work, one request at a time.

### 1. Write the concurrent case first, for anything with a nonce, a counter or a guard

Not "add concurrency tests at the end" — first. Three of the five blockers so
far were read-modify-write races, and each one was invisible to a sequential
test by construction. If a piece of state is read and then written, the test
that matters fires `Promise.all` at it before the one that walks through it
politely.

*Measurable next iteration:* every endpoint that writes shared state ships with
at least one concurrent test in the same commit as the endpoint.

### 2. Run the attack, not the test, before calling a fix done

This one is already working and should stay. Every fix in both review rounds
was checked by re-running the reviewer's own probe, and that caught two things
the passing tests did not: the `ON CONFLICT` predicate had to match a partial
index, and my own demo script's short nonces were being rejected before the
logic ran. A green suite says the code does what the suite expects; the attack
says whether the defect is gone.

### 3. Stop claiming a property in a comment without a test that holds it

`lib/api/result.ts` said handlers "never throw past the handler" while two did.
`lib/db/index.ts` said a missing `DATABASE_URL` failed "loudly at startup" when
it did not. The sign-in route said its reply was identical for an unknown
caller while returning a masked phone number. Each was a sentence written with
the intention, before the code met it.

*Measurable next iteration:* when a comment states a guarantee, the commit
either adds the check that enforces it or the comment says "not yet".

## Not changing

The records themselves are earning their place — `decisions.md` stopped the
`driverVerify` deviation being re-argued twice, and `review-findings.md` is
what makes "all fixed" checkable rather than a claim. Depth stays Standard
with a mandatory independent review while this remains security-sensitive.
