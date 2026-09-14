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

## After Phase 2, slice 3 (the outbox and the late notice)

**The previous improvement was written down and not applied, and it cost four
blockers.**

Last round's first action was: *"Write the concurrent case first, for anything
with a nonce, a counter or a guard."* This round shipped two pieces of state
with exactly that shape. Both got a concurrency test. Both tests were
constructed so they could not fail for the bug that was there:

- the outbox test used a sender returning in microseconds, so no claim could
  go stale while a send was in flight — the one regime where the lease matters;
- the ETA dedupe test `await`ed its two calls one after the other, so it passed
  against an implementation with no dedupe transaction at all.

So the rule was followed to the letter and missed the point. Writing *a*
concurrent test is not the control; writing one that fails against the current
code is.

### 1. A new test for a race must be seen to fail first

Before a race fix is committed, run the new test against the unfixed code and
record the failure in the commit message. If it passes on both, it is not
testing the race. This is the only one of these that would have caught all four
blockers, because each had a test that passed on both sides.

### 2. A fake must be as slow and as hostile as the real thing

Every timing guarantee here was asserted against an instant, always-succeeding
stub. A lease, a timeout and a back-off are all invisible to that. Fakes now
come in three shapes by default — slow, failing, and hanging — and the slow one
is the default for anything with a deadline.

### 3. A recorded decision is a checklist for the next endpoint, not a diary

`decisions.md` said *"A tap is decided under a lock on the trip row"*, naming
the exact trigger — an offline queue draining two taps back to back. The next
endpoint written read a trip, decided, and wrote, with no lock, and was hit by
that precise scenario. The file was being appended to and not read.

Before adding an endpoint that reads a row and then writes it, re-read
`decisions.md` and say in the commit message which entries apply. Cheap, and it
converts the record from history into a constraint.

## Not changing

Re-running the reviewer's own attack rather than trusting the suite. It is the
only reason these fixes are known to work: the tests passed before the fixes
too.

## Round 4 — the Twilio adapter

**What the rule from round 3 was worth.** "A race test must be seen failing
against the unfixed code before the fix is committed" was followed here, and it
worked: the claim-re-stamp fix has a test that was run against the code with
the guard removed and did fail. So did the region and the accepted-vs-delivered
tests, run against the reverted logic. That is the first round where the
evidence for a fix is a failure I actually watched rather than a suite I
trusted.

**What it did not catch.** Four rounds now, and every single blocker has been
found by the reviewer under a fully green suite. The pattern in this round is
sharper than "missing tests": all three blockers were cases where the code
recorded a *fact that was not true* — a number was valid, a message was
delivered, a failure was permanent — and the tests asserted on the same fact
the code had invented. `assert.deepEqual(result, { delivered: true })` cannot
fail when `delivered: true` is what the code returns for everything.

**Improvement for the next iteration:** for any value that claims something
about the outside world — delivered, valid, permanent, sent — the test must
assert against a *second, independent* description of that world, not against
the code's own report. In this round that would have meant asserting the number
Twilio was actually asked to text (it was), and asserting on the provider's
stated status rather than on the HTTP code (it was not). Where no second
description exists, the value must not claim more than it knows: that is what
renaming `delivered` to `accepted` did, and it is the more reliable fix of the
two.

**Second improvement:** the test suite's teardown was destroying rows in a
database it did not own, and it took the reviewer to notice. Any test that
deletes must first prove it is talking to a database that exists to be
deleted from. Done here; do it at the start of the next slice that needs a
new fixture, not after.
