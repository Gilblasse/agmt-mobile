# Amazing Grace Mobile Transport — Rebuild Feature Checklist

This is the "have we built everything?" list for the rebuild. It is meant to be
ticked off item by item as work is finished, and read by the office to confirm
nothing they rely on today has been dropped by accident.

Every item traces back to the five specification documents (`01`–`05` in this
folder). Nothing here is invented.

**How to read the priority tags:**
- **[must]** — the office or the drivers cannot do their job on day one without this.
- **[should]** — important, expected, and will be missed, but the system can go live without it for a short time.
- **[later]** — a real feature worth having, but nobody's day depends on it.

Lines starting with ⚠ call out a specific way this exact feature has gone
wrong before, or could easily go wrong again, so the rebuild doesn't repeat it.

---

## Dispatcher board

- [ ] Live trip board for a chosen day **[must]** — show every trip scheduled for the selected date, sorted by time by default.
- [ ] Current & upcoming vs. Past split **[must]** — on today's board only, move a trip into "Past" once its hour has fully gone by, but only if it has actually been closed out (completed, no-showed, cancelled, or reassigned).
  - ⚠ A trip nobody has dealt with — no driver working it, no status set — must never age into "Past" no matter how late it gets. It has to keep nagging the dispatcher from the live list.
- [ ] Pinned "in progress" trips **[must]** — once a trip's hour has passed but a driver is actively working it (en route, at the pickup, waiting, in transit, at the drop-off), show it in its own attention-grabbing block above everything else.
- [ ] Group the board by Time / Driver / Status / Transport **[must]** — let the dispatcher switch how trips are grouped, and remember the last choice for next time.
- [ ] Collapsible section headers **[should]** — let each group (e.g. one driver's trips) be collapsed or expanded; "Unassigned" and "No transport set" start collapsed by default.
- [ ] Trip card **[must]** — one row per trip: passenger name, a transport-type icon, the route, the driver, the time, a colored status dot, and a one-line note preview.
- [ ] Tap a card to expand its journey/activity panel **[must]** — a compact inline timeline (In route → At pickup → In transit → At drop-off → Complete), a quick-status dropdown, and shortcuts to the trip's chat notes and full details.
- [ ] Quick status change from the board **[must]** — set a trip's status (Ready, Not Confirmed, Reassign, Update Time, Complete, Cancel, No Show, or clear it) without opening the full edit form.
  - ⚠ Every status change must always say which day the trip belongs to. A status set while viewing a day other than today must never silently apply to the wrong day (or nowhere at all) while still reporting success.
- [ ] Wait-timer pill on a card **[should]** — while a driver is waiting at a pickup or drop-off, show how long, coloring the pill amber then red the longer it runs.
  - ⚠ The wait time has to be corrected against the office's own clock, not the browser's. A phone or laptop with a wrong clock or timezone must never leave a wait timer stuck at zero forever.
- [ ] "Driver running late" flag on a card **[later]** — visually flag a trip whose notes mention a driver running late.
- [ ] One-tap "Assign" on an unassigned trip **[must]** — jump straight into editing that trip with the driver field ready to fill in.
- [ ] Turn-by-turn directions link on a card **[should]** — one tap opens a map with directions from pickup to drop-off.
- [ ] Board search **[must]** — free-text search across passenger, driver, pickup/drop-off address, Medicaid #, transport type, invoice #, notes, and (if it looks like a phone number) digits-only phone matching.
- [ ] Date picker showing which days have trips **[must]** — a calendar that greys out days with nothing on them and never lets a dispatcher pick a day before the very first trip on file.
- [ ] "Jump to today" shortcut **[should]** — one tap to return to today's board from any other date.
- [ ] Manual refresh **[should]** — a button to force an immediate check for changes, separate from the automatic background refresh.
- [ ] Automatic live refresh **[must]** — the board must reflect another dispatcher's edit, or a driver's tap, within a matter of seconds, without anyone touching the keyboard, and cheaply enough to not slow the office down over a whole day of use.
- [ ] "Needs a time" strip on today's board **[should]** — trips that belong on today but have no time yet appear as a clickable strip directly on the board, not just buried in a separate list.
- [ ] Trip details (read-only) page **[should]** — a full-page view of one trip: route, notes, a driver-progress timeline with wait durations, a link to its return/outbound leg if any, and its standing order membership if any.
- [ ] Past/locked day is view-and-copy only **[must]** — any day before today, or any day already submitted, can be looked at and copied into a new booking, but never edited or deleted from the board.
- [ ] Undo a delete for a few seconds **[should]** — deleting a trip shows a short countdown with an Undo button before it's actually removed from the system.
  - ⚠ Undo has to actually cancel the delete. It must never just visually put the trip back while a delete is still quietly on its way to the server in the background.
- [ ] Warn before saving a risky trip **[must]** — check for an exact duplicate, a same-passenger or same-driver double-booking, a near-duplicate (same passenger within 20 minutes of another trip), and a blacklisted passenger before letting a trip save, and let the dispatcher see and decide on each one.
- [ ] Driver-reachability warning **[should]** — using a real drive-time estimate, warn when two of a driver's trips are scheduled too close together to physically make it, in plain English ("this will be very tight" / "this trip cannot be driven").
  - ⚠ This warning must never block a save outright — only ever offer "go back" or "save anyway." The dispatcher may know something the system doesn't.

## Booking and editing a trip

- [ ] Add a one-off trip **[must]** — book a ride with a date and a passenger required, and everything else (time, driver, vehicle, notes, addresses) optional.
- [ ] Book a round trip in one step **[must]** — one checkbox creates a matching return leg with pickup and drop-off swapped and a suggested return time (default: four hours after the outbound time).
  - ⚠ An overnight round trip — leaving late in the evening and returning after midnight — has to actually work. It must not get silently refused just because the auto-filled return time reads as "before" the outbound time on the clock.
- [ ] Edit an existing trip **[must]** — change any field on a trip, saving only the fields that actually changed so two people editing different parts of the same trip at the same time never wipe out each other's work.
  - ⚠ Turning "Private Pay" off has to register as a real, saveable change. A checkbox being unchecked must never look identical to a checkbox nobody touched — that has previously left a trip billed twice at its old price.
- [ ] Copy a trip into a new booking **[should]** — duplicate a trip's details into a fresh one, but leave the date, driver, and every driver-progress timestamp blank so nobody assumes they already carried over.
  - ⚠ Copying the return leg of a round trip should start from the outbound leg and rebuild its own return pair, not create an orphaned single leg.
- [ ] Delete a trip **[must]** — remove a booking, with a plain confirmation naming the passenger and the time.
- [ ] Offer to delete a linked leg too **[should]** — when deleting one leg of a round trip, offer (pre-checked) to delete the other leg at the same time.
- [ ] Passenger auto-fill **[must]** — typing a known passenger's name fills in their phone, Medicaid #, transport type, and saved addresses automatically.
- [ ] Passenger name auto-correction **[should]** — recognize and clean up a typed name against known passengers (e.g. "First Last" typed but matched to a "Last, First" profile).
- [ ] Address autosuggest **[should]** — suggest this passenger's own past addresses first, then fall back to a live map search after a few characters are typed.
- [ ] Phone number formatting **[later]** — automatically format a typed phone number as it's entered.
- [ ] Optional separate "start time" **[should]** — an optional "leaves the garage at" time, distinct from the scheduled pickup time.
- [ ] Manual override of driver-progress timestamps **[should]** — let the dispatcher correct a driver's tap times by hand when something needs fixing.
- [ ] Separate pickup-note and drop-off-note fields **[should]** — notes specific to the pickup stop or the drop-off stop, shown to the driver at the right moment, falling back to the general trip note if left blank.
- [ ] Save is disabled until something actually changed **[should]** — stop an accidental no-op save, and in edit mode, keep Save disabled until the form differs from what was loaded.
- [ ] Blacklist warning and override **[must]** — warn clearly when booking a flagged passenger, showing the reason, and require typing that passenger's exact last name before allowing the booking to go through anyway.
- [ ] Exact-duplicate and near-duplicate detection **[must]** — block an exact repeat trip outright, and warn (without blocking) on a same-passenger trip booked within 20 minutes of another.
- [ ] Double-booking detection **[must]** — refuse to save a trip that puts the same driver, or the same passenger, in two places at the same scheduled time.
- [ ] Trip chat / quick note **[later]** — a lightweight, chat-styled box for adding a quick note to a trip, disabled once the day is locked.
- [ ] Stable trip identity **[must]** — a trip's permanent ID must never change just because its driver, time, or passenger name is edited later.

## Standing orders

- [ ] Create a standing (recurring) order **[must]** — book a trip that repeats daily, on weekdays, on weekends, or on custom days of the week, between a start and end date, generating every date's trip in one action.
  - ⚠ The maximum allowed span (183 days) must be counted in a way that a daylight-saving clock change can't shorten or lengthen — a legitimate 183-day order should never be refused, and an illegal 184-day one should never slip through, just because of when the clocks changed.
- [ ] Name every standing order **[must]** — require a short title so office staff can find it later, and allow renaming it at any time.
- [ ] Automatic return leg on every date **[should]** — a standing order can include a same-day return trip on every date it generates, all sharing one return time.
- [ ] Large orders finish in the background **[should]** — creating dozens of dates should not make the dispatcher sit and wait; the very first day saves immediately and the rest complete on their own with a visible progress indicator.
- [ ] "Apply to other days?" after editing one day **[must]** — after saving a change to a trip that's part of a standing order, ask whether the same change should also apply to the order's other, still-editable days.
  - ⚠ That question has to be asked freshly every time the edit screen opens. It must never remember a "no" (or a failed lookup) from earlier in the session and silently stop asking.
- [ ] Delete some or all dates of a standing order **[must]** — pick which specific dates to remove from a repeating order, or remove them all, with any date already submitted/locked automatically left alone (and reported, not silently skipped).
- [ ] Standing order auto-retires when empty **[should]** — once no trip anywhere still belongs to a standing order, its pattern disappears on its own rather than lingering as an orphan the office has to notice and clean up.
- [ ] Bulk-edit a field across many days of one order **[should]** — change one field (driver, vehicle, notes, etc.) across every future day of a standing order in a single action, batched so it doesn't take one slow save per day.
  - ⚠ Identity fields (date, trip id, status, price) must never be part of a bulk edit — a mass edit must never move a trip's date, and price always has to be worked out fresh for each day, never copied from one day to the rest (a Saturday's weekend surcharge shouldn't spread onto a Monday).
- [ ] Jump between every trip in the same order **[should]** — from any one trip in a standing order, see and jump to any other date in that same order.

## Passengers

- [ ] Passenger directory **[must]** — a searchable list of every passenger, showing name, phone(s), Medicaid #, transport type, address(es), and blacklist status at a glance.
- [ ] Add a new passenger **[must]** — create a passenger profile on its own, without needing to book a trip first.
- [ ] Edit a passenger's profile **[must]** — update any of their details, saving only what actually changed.
- [ ] Multiple phone numbers and addresses per passenger **[should]** — store more than one of each, with the first entered treated as the primary one.
- [ ] Blacklist a passenger **[must]** — flag a passenger with a required reason (at least a few words), recording who flagged them and when.
- [ ] Remove a blacklist flag **[should]** — clear the flag without needing to give a reason.
- [ ] Delete a passenger **[must]** — remove them from the directory, warning first how many upcoming (today-or-later) trips will also be removed; trips already in the past are always kept as history.
  - ⚠ A deleted passenger should stay recoverable for a few days in case it was a mistake, not disappear the instant Delete is pressed.
- [ ] Bulk-select and delete several passengers at once **[should]** — select more than one passenger (long-press or a Select mode) and remove them together.
- [ ] Full trip history per passenger **[must]** — every trip a passenger has ever had, searchable across the whole history, not just what's currently on screen.
- [ ] Filter a passenger's history **[should]** — by a single date or a date range, by which driver drove them, and by whether a trip belongs to a standing order or is a one-off.
- [ ] Show upcoming trip count before deleting **[should]** — a quick "N trips today or later" count shown before confirming a passenger delete, so the office knows the real impact.
- [ ] Passenger profile auto-updates from bookings **[should]** — booking a trip for a known passenger with a new phone number or address should add it to their profile automatically, without ever overwriting what's already saved.
- [ ] Consistent passenger name matching everywhere **[must]** — the exact same name-normalization rule (ignoring case and extra spaces) must be used for matching a passenger during booking, blacklist checks, and directory search, so "john smith" and "John Smith" are always recognized as the same person.

## Drivers and vehicles

- [ ] Driver roster **[must]** — a maintained list of staff drivers with name, phone, email, and (for text alerts) their cell carrier.
- [ ] Assign a driver to a trip **[must]** — a free-text, suggestion-assisted driver field on every trip; the office should not need a rigid driver database to keep working day to day.
- [ ] Reliable fuzzy driver-name matching **[must]** — correctly recognize a driver from a nickname, an initial-plus-surname, or a slightly different spelling of their typed name, without ever letting one driver's typed name accidentally resolve to a different driver.
  - ⚠ A short or partial name must never match just because it happens to appear inside a longer one (for example, "Lee" must never match "Ashleen"). This is a real access-control boundary, not just a display nicety — getting it wrong the permissive way lets one driver see or complete another driver's trip.
- [ ] Assign a vehicle to a trip **[should]** — a free-text, suggestion-assisted vehicle field on every trip.
- [ ] Removing a driver cuts off their access immediately **[must]** — taking someone off the driver roster must stop their driver-app access within minutes, without any separate "revoke" step.
- [ ] One driver cannot see or act on another driver's trips **[must]** — every driver-app action has to freshly check that the trip really belongs to the driver making the request.
  - ⚠ A momentary system hiccup while checking ownership must be treated as "please try again," never as "this trip isn't yours." Those two situations look the same to a phone but the second one can permanently throw away a driver's completed work.
- [ ] Confirm what "Ready" does to a trip's scheduled time **[must]** — today, marking a trip Ready overwrites its scheduled pickup time with the current real-world clock time; before launch, the business needs to confirm whether that's intentional (and if so, where the "real" scheduled time is meant to live instead) or a long-standing bug to fix.
- [ ] Confirm whether reassigning a driver should clear arrival timestamps **[should]** — today, changing a trip's driver silently wipes its pickup-arrival timestamps; decide with the business whether the rebuild should keep this behavior or preserve the old driver's timestamps for audit purposes.

## Pricing

- [ ] Turn on Private Pay per trip **[must]** — a checkbox that brings a trip into the pricing engine; every other billing type (insurance, Medicaid, broker, facility) never touches pricing at all.
- [ ] Live price quote while booking **[must]** — as the dispatcher fills in a private-pay trip, show a running total that updates automatically, computed by the server on every relevant keystroke — never guessed or calculated by the screen itself.
- [ ] Price breakdown view **[should]** — show every line making up the price (base fare, mileage, surcharges, discounts, pass-through costs), each marked Automatic or Added, with the ability to drop an automatic line or add an optional one.
- [ ] Base fare by transport type **[must]** — an office-editable dollar rate for each transport type (ambulatory, wheelchair, stretcher, taxi, other).
- [ ] Mileage-based pricing **[must]** — bill for miles beyond an included allowance, at a configurable per-mile rate, with a minimum-fare floor.
- [ ] Deadhead mileage **[should]** — a manually-typed empty-run mileage figure, billed as a pass-through cost, never measured automatically.
  - ⚠ A deliberately blank deadhead figure must stay blank all the way to save — it must never be treated as zero, which would silently defeat the "you left this empty" check.
- [ ] Waiting-time charge **[should]** — bill for driver waiting time beyond a grace period, computed only from what actually happened (the driver's own tap timestamps), never estimated ahead of time.
- [ ] After-hours / weekend / holiday surcharges **[should]** — automatic rate adjustments for late-night, weekend, and specifically-named holiday trips.
  - ⚠ A trip with no time typed must never accidentally trigger the after-hours surcharge just because "no time" happens to look like a late-night time internally.
- [ ] Same-day / short-notice surcharges **[later]** — an extra charge for a trip booked with very little lead time.
- [ ] Assistance and equipment add-on charges **[should]** — a menu of optional charges (door-to-door, stairs, extra attendant, bariatric, oxygen, extra passenger, etc.), each independently priced and toggle-able per trip.
- [ ] Discounts **[should]** — percentage or fixed-amount discounts, including an automatic discount for a trip that's part of a standing order.
- [ ] Round-trip pricing consistency **[must]** — price a round trip's return leg using the outbound leg's own scheduled time, so the two legs of one round trip always cost the same no matter what time the return actually runs.
- [ ] Minimum fare re-checked after discounts **[should]** — re-apply the minimum-fare floor after surcharges and discounts are added, not only before, so a discount can never push a trip's total below the stated minimum.
- [ ] Never silently under-price or zero-price a trip **[must]** — if a distance or other required figure can't be resolved, mark the quote as incomplete rather than quietly showing a finished-looking price of $0.
  - ⚠ "Not priced" and "priced at exactly zero dollars" are two different things and must never be confused with each other anywhere in the system.
- [ ] Keep a fair price when a re-check briefly fails **[should]** — if a live mileage re-check fails but the route hasn't actually changed and a real price was already agreed, keep the old price (flagged as possibly stale) rather than blanking it out.
- [ ] Pricing settings screen **[must]** — one place for the office to edit every base fare, mileage rate, wait-time rate, after-hours window, holiday date list, and optional rule, with clear validation messages instead of silently discarding bad input.
  - ⚠ Saving new settings must never reset a field nobody touched back to a factory default, and a rate meant as "15%" but typed as "0.15" needs to be caught and flagged, not quietly billed as 0.15%.
- [ ] Auto / Optional / Off per pricing rule **[should]** — each rule can be set to fire automatically, be offered but not automatic, or never appear at all — and only a rule the system can genuinely detect on its own may ever be set to fire automatically.

## The driver app

- [ ] Sign in automatically on a recognized account **[should]** — a driver opening the app on an account the office already has on file walks straight in with no picker or code.
- [ ] Sign in with a one-time code otherwise **[must]** — everyone else picks their name from a list and receives a 6-digit code (by text and/or email) valid for 10 minutes, with a short resend cooldown and a limited number of wrong tries before the code locks out.
- [ ] Stay signed in on a trusted phone **[must]** — once verified, a phone doesn't need a fresh code every time it's used — but access is still re-checked against the current driver roster on every single use.
- [ ] Today / Tomorrow schedule view **[must]** — a driver sees every trip assigned to them today, and can look ahead at tomorrow's (view-only, no progress taps).
- [ ] Next-trip summary card **[should]** — a prominent summary of the very next trip, showing whether the driver should leave now, is already running late, or is comfortably on schedule, based on a real drive-time estimate.
- [ ] Trip list, unfinished first **[must]** — every trip assigned to this driver today, with unfinished ones shown first in schedule order and finished/ended ones pushed to the bottom.
- [ ] Wait timer while stopped **[should]** — shows how long the driver has been waiting at the current pickup or drop-off, with a note about when marking a no-show becomes possible.
- [ ] Step-by-step trip progress **[must]** — four ordered taps a driver works through in order: in route, arrived at pickup, passenger on board, arrived at drop-off, complete.
  - ⚠ The system must refuse to let a trip's progress move backwards, and a duplicate or late-arriving tap for a step already passed must be silently treated as "already done," never as an error the driver has to deal with.
- [ ] No Show and Cancel from the phone **[must]** — a driver can mark a trip as a no-show (only once a real waiting period has actually passed) or cancel it outright; both are one-way, final actions.
  - ⚠ A driver cancelling from their own phone must only affect the trip they tapped on — never an unrelated return leg that could belong to a completely different driver who was never asked.
- [ ] Undo a tap for a few seconds **[should]** — a short window to undo the most recent progress tap before it's sent to the office.
  - ⚠ Undo has to clear every single piece of memory the app keeps about that step — not just what's currently shown on screen — or the undone step can silently reappear on its own a few seconds later.
- [ ] Keep working with no signal **[must]** — a tap made with no connection is saved on the phone itself and automatically retried until the office confirms it, surviving the app being closed or the phone restarting.
  - ⚠ Reading a corrupted saved queue back on launch must never be able to crash or freeze the whole app — a driver has to still be able to sign in and see their day even if the saved queue is garbage.
- [ ] Never send the same action twice **[must]** — a tap that gets retried after a slow or dropped connection must be recognized as the very same action and never applied twice (for example, a driver must never be texted two cancellation notices for one cancel).
- [ ] Trip detail (read-only) view **[should]** — full details of one trip: times, addresses, phone number, transport type, notes, and every timestamp recorded so far.
- [ ] Navigate button **[must]** — one tap opens turn-by-turn directions to the driver's current stop.
- [ ] Call dispatch **[should]** — one tap to call the office directly.
- [ ] "Running Late" notice to dispatch **[must]** — let a driver tell dispatch they're running late, with a reason and an optional note, translated into an absolute clock time worked out from the office's own clock — never whatever time the driver's own phone happens to show.
- [ ] Auto-detected running-late alert **[later]** — automatically flag dispatch when a driver's live estimated arrival has drifted past their scheduled pickup by a set number of minutes, with no action needed from the driver.
- [ ] Optional location sharing **[should]** — let a driver share live location so the office can see who currently has it turned off, with a clear ask/allow flow and instructions for fixing a blocked permission.
- [ ] Graceful handling of a trip taken away mid-view **[should]** — if a trip a driver is currently looking at gets reassigned away from them, tell them plainly rather than have it silently vanish from the screen.
- [ ] Correct time everywhere, even on a wrong phone clock **[must]** — every "how long has this been" or "am I running late" calculation has to be corrected against the office's own clock, never trust the phone's clock or timezone as-is.
- [ ] Reserved spots for future features **[later]** — placeholders for things like Time Card, Inspection, Messages, My Week, and Settings, clearly marked "coming soon" rather than dead or broken links.

## Notifications

- [ ] New trip assigned **[must]** — text and/or email the driver immediately when a trip lands on their schedule, even outside any quiet window.
- [ ] Trip taken away (reassigned) **[must]** — tell the previous driver immediately when a trip is moved to somebody else, at the same time the new driver is told about it.
- [ ] Pickup time changed **[must]** — tell the assigned driver when a trip's scheduled time moves.
- [ ] Other trip details changed **[should]** — tell the driver about other changes to today's trip (address, transport type, vehicle, notes, status), but stay quiet about changes that don't affect the driver (like billing fields) and about non-time changes to tomorrow's schedule.
- [ ] Trip cancelled / no-showed / reassigned **[must]** — tell the driver plainly whenever dispatch ends a trip out from under them.
  - ⚠ A retried or duplicated status write must never result in a second cancellation text going out for the exact same event.
- [ ] Quiet window to avoid spamming a driver **[should]** — don't send more than one "something about your day changed" text per trip within a short window, but a genuine hand-off or a time change should always get through immediately regardless.
- [ ] Sign-in code delivery **[must]** — deliver the one-time sign-in code by text and/or email, whichever channel(s) are actually available for that driver.
- [ ] Two delivery channels, either one is enough **[should]** — attempt both email and text for an alert, and consider it delivered if either one succeeds.
- [ ] Plain, gateway-safe text formatting **[should]** — keep text messages to plain punctuation with no web links (some carrier gateways treat a link as spam and can start blocking the sender entirely), while emails can safely include a link back into the app.
- [ ] Driver's "running late" note reaches the dispatcher **[must]** — a driver's Running Late tap has to show up as a visible note on the trip for the dispatcher to see on the board.
- [ ] Reliable, modern delivery channel **[must]** — replace the old carrier-email "text" trick with a real SMS provider; several major carriers have already shut off the free gateways this system currently depends on.

## The day (submit / lock)

- [ ] Submit today's trips **[must]** — a single end-of-day action that locks today's trips permanently as history.
  - ⚠ Submit has to refuse to run on any day other than today, with a clear message telling the dispatcher to switch to today's date first.
- [ ] Warn about un-timed trips before submitting **[should]** — if any trip due today still has no scheduled time, warn before locking the day and offer a direct shortcut to go fix it.
- [ ] A locked day is truly locked **[must]** — once a day is submitted, nothing can add, edit, or delete a trip on it, ever, through any path — this is the record invoices and payroll get read from.
- [ ] Past days are view-and-copy only **[must]** — any day before today can be looked at and copied into a new booking, but never edited or deleted.
- [ ] Locking is checked on every single write path **[must]** — trip creation, editing, deleting, every standing-order action, and every quick status change must each independently refuse to touch a locked day, rather than trusting one central check.

## Planning and drive times

- [ ] Driver-reachability check **[should]** — using a real drive-time estimate (not just "same time slot"), warn when two of a driver's trips are scheduled too close together to physically make it.
  - ⚠ This check must never block a save — it can only warn. The dispatcher may have information the system doesn't.
- [ ] Learned stop-dwell time **[later]** — instead of a fixed guess for how long a driver typically needs at a pickup or drop-off, learn it from real completed-trip history (per passenger, per address, and fleet-wide as a fallback), and only trust it once there's enough history to be confident.
- [ ] Shared, cached distance lookups **[later]** — reuse a distance/duration lookup for the same route instead of asking the mapping service again for every trip that uses it.
- [ ] Manual mileage override **[should]** — let the dispatcher type in a mileage figure by hand when the mapping service can't resolve an address, and have that typed number always win over any automatic lookup.

## Reporting and history

- [ ] Passenger trip history **[must]** — every trip a given passenger has ever had, searchable and filterable, viewable from their profile.
- [ ] Full audit trail per trip **[should]** — every timestamp a driver's phone recorded for a trip (arrived at pickup, passenger on board, arrived at drop-off, completed), plus computed wait time, drive time, and lateness, visible on one screen.
- [ ] Operational performance dashboard **[later]** — a behind-the-scenes view of how long key actions take to complete, for the office's own technical/ops staff, not for dispatchers or drivers.
- [ ] Failed background job list **[later]** — a place to see any standing-order or bulk job that's stuck, errored, or lost track of itself, so it can be retried or investigated.

## Admin and settings

- [ ] Pricing settings (see Pricing section) **[must]** — one screen for the office to control every price the system quotes.
- [ ] Driver roster management **[must]** — add, edit, or remove a driver from the roster (name, phone, email, carrier); removing someone must immediately cut off their driver-app access.
- [ ] Vehicle list management **[should]** — maintain the list of vehicles that can be assigned to a trip.
- [ ] Grant or revoke a person's driver-app access **[should]** — a controlled screen for adding or removing someone's access, notifying them by email either way.
- [ ] Data-repair tools for the office's technical staff **[later]** — the ability to preview ("dry run") and then apply a fix for a specific known class of data problem, always showing exactly what it would change before anything is written.
- [ ] Confirm whether a second "board" sheet holds real data **[must]** — today, an undocumented second sheet ("Page 2 of Dispatch") receives the same address-suggestion treatment as the real board; find out from the business whether it holds live trips that need to be migrated, or is a stale leftover safe to ignore.

## Integrations

- [ ] Turn-by-turn directions **[must]** — open a route from pickup to drop-off (or to a driver's current stop) directly in a mapping app, from both the dispatcher board and the driver app.
- [ ] Reliable text/email delivery **[must]** — a real, modern channel for delivering sign-in codes and driver alerts; the current carrier-gateway-email trick is fragile and already failing for several carriers.
- [ ] Distance and drive-time lookups **[must]** — a real mapping/directions service for mileage-based pricing, reachability warnings, and estimated arrival times.
- [ ] Confirm the external data feed **[later]** — find out whether anything still depends on the existing feed of edited-trip data to an outside cloud service, and either keep sending it or formally retire it.
- [ ] Confirm the external time-sheet dashboard link **[later]** — find out whether the separately-hosted driver time-sheet dashboard needs to keep receiving data from the rebuilt system.

## Background jobs

- [ ] Standing-order creation/deletion for many dates **[must]** — the first date saves immediately while the dispatcher waits; every other date completes in the background with visible progress, and a re-run must never create a duplicate trip on a date already done.
- [ ] Passenger-delete cleanup **[should]** — after deleting a passenger with many upcoming trips, remove those trips in the background rather than making the office wait.
- [ ] Nightly end-of-day housekeeping **[should]** — whatever automated "close out the day" tasks the office needs, run on their own overnight with no confirmation dialog, since nobody is there to click one.
- [ ] Periodic history tidy-up **[later]** — some form of ongoing housekeeping so historical trip records stay easy to query as the dataset grows over years (see "Do not rebuild" — the current mechanism for this is entirely a side effect of using a spreadsheet and should not be copied as-is).
- [ ] Recompute learned stop-dwell times **[later]** — periodically relearn typical pickup/drop-off dwell times from recently completed trips.
- [ ] Repair sweeps for stuck data **[later]** — background or on-demand repair passes for things like an orphaned standing order or a stuck background job, always previewing the change before applying it.

---

## Do not rebuild

These are things the current system technically contains, but which are
broken, dead, or abandoned. They should not be carried into the rebuild as
working features — each one is listed with why.

- **The `conisole.log` typo breaks "Send Start Times."** A misspelled `console.log` call in the driver start-time emailer throws an error the instant it finds a real matching trip, so the feature currently fails for every driver/date combination that actually has something to send.
- **A misspelled function name breaks "Enable Auto-Open Sidebar."** The menu item calls a function name that doesn't match the one actually defined, so clicking it always fails outright.
- **The `data[0][45]` carrier bug.** The driver-options dropdown reports every single driver's SMS carrier as the *first* driver's carrier — a copy-paste indexing mistake. (The actual text-sending code elsewhere reads it correctly, per driver — only this one dropdown-building function has the bug.)
- **An abandoned web/calendar trip-request stub.** One helper function exists (finding a free row to insert into) with no feature ever built around it — evidence of a never-finished "request a trip online" idea, not a working feature to replicate.
- **A superseded "New Passenger" modal.** A fully-built new-passenger popup exists in the code, but the real "+" button was rewritten long ago to open a different, newer screen instead — nothing in the app opens the old one anymore.
- **A dead snapshot/export/import subsystem.** A "Full sync / Partial sync" popup and its three related server actions exist but are wired to nothing in the current screen — safe to drop unless the business identifies a live need for manual resyncing outside the normal save flow.
- **A syntax typo in the shared address-autofill script.** A `const` keyword is misspelled, which can silently break the passenger address auto-fill for both the Add and Edit trip forms depending on exactly how the page loads it — needs a real fix, not a straight port, if this logic is reused.
- **A dead, likely-broken time-subtraction helper.** An unused function for subtracting a duration from a time appears to compute the wrong thing even on the rare chance it were called.
- **Assorted debug/test-only scratch functions.** A handful of functions exist purely for one developer's manual testing (a couple of which reference a variable that only exists in a commented-out line above them, so calling them throws immediately) — none are used by any real screen.
- **Google Sheets sharing-permission scripts.** A set of tools for granting/removing access to specific ranges of a spreadsheet has no equivalent concept in a normal application — access control belongs entirely in the app's own login and permissions system instead.
- **Physical row-sorting to fake date/time order.** A whole family of code exists purely to physically reorder rows in a spreadsheet so they display in date/time order — a real system simply asks its data store for trips "in order," with nothing to sort or maintain.
- **The reused-row board and its "phantom stamp" cleanup jobs.** The dispatcher board's hard 100-trip capacity, and the several repair jobs that exist to clean up one trip's driver timestamps bleeding onto the next trip that reuses its row, exist purely because of a fixed-size, row-reuse spreadsheet design — a real database has neither the capacity limit nor the row-reuse problem, so none of this needs to be carried forward.
- **The two-sheet reconciliation layer.** A large amount of code exists purely to keep a "working board" spreadsheet and a "permanent history" spreadsheet in sync with each other — a real system has one single table for trips, so there is nothing to reconcile in the first place.
- **The 1899-epoch time trick and the `23:58` "no time" placeholder.** Storing "no time was entered" as a specific fake time value (which has repeatedly leaked into what dispatchers and the pricing engine see as a real time) is a spreadsheet-only workaround — a real system should use an actual blank/null value to mean "not set," with no placeholder value that could ever be mistaken for a real answer.

## Things the office does by typing into the spreadsheet

These are real, ongoing workflows the business depends on today that have no
dedicated screen at all — they only exist as a spreadsheet menu item, a
script someone runs by hand, or an edit made directly into a sheet cell. The
rebuild needs a proper screen (or a deliberate decision to retire the
workflow) for each of these, or the office loses a capability it has today
without realizing it until it's needed.

- [ ] Filling in a trip's mileage — done today by a bulk "map it" menu action that scans the whole board and writes a formula into each blank mileage cell; no screen shows or lets someone trigger this directly.
- [ ] Sending each driver their day's start time — done today through two separate pop-up pickers reached from spreadsheet menu items, entirely outside the normal dispatcher screens (and currently broken end to end, see "Do not rebuild").
- [ ] Restoring a day's board after a mistake — a recovery tool exists to rebuild the live board from history for a chosen date, but it only runs from the Apps Script editor or an interactive spreadsheet prompt, not from any screen a dispatcher could use themselves under pressure.
- [ ] Granting or revoking someone's access to the driver-facing spreadsheet — done today by directly editing a Google Sheet's own sharing settings through a side panel, not through any user/role management screen.
- [ ] Weekly and one-off history cleanup — a periodic tidy-up of old historical trip records runs only as a spreadsheet-triggered background job, started or scheduled from a menu item, with no dashboard showing what it did or whether it's needed again.
- [ ] Rebuilding the passenger list after data loss — a full passenger-list recovery-from-backup process exists only as a script run manually by hand.
- [ ] Fixing corrupted trip data — several distinct repair passes (misplaced driver timestamps, misplaced driver status, skipped progress steps, blank-looking start times, orphaned standing orders, leftover test trips) exist only as scripts someone with developer access runs by hand, always previewing first — there is no screen where office staff can see that a problem exists, let alone fix it themselves.
- [ ] Un-deleting a passenger within the grace period — the underlying "restore from trash" capability exists, but nothing in the passenger screens offers a way to use it; today it can only be done by someone running the function directly.
- [ ] Checking on or retrying a stuck background job — the underlying functions exist to list failed jobs and retry them, but there's no dashboard; today this also requires someone running a function by hand.
- [ ] Reviewing how fast the system is running — raw performance numbers are collected, but nothing displays them; today reading them means running a function and reading raw output.
- [ ] Sorting the board by driver — this exists only as a spreadsheet menu action; it's not offered as a grouping choice in the day-to-day dispatcher screen the way sorting by time/status/transport is.

## Counts

| Priority | Count |
|---|---|
| **[must]** | 76 |
| **[should]** | 59 |
| **[later]** | 16 |
| **Total feature items (with a priority)** | 151 |
| Spreadsheet-only workflows needing a screen (no priority — see that section) | 11 |
| Items listed under "Do not rebuild" (broken/dead — not counted as features) | 14 |

*(Counts include every `- [ ]` checklist item in the feature sections above (Dispatcher board through Background jobs). The "Do not rebuild" list and the "Things the office does by typing into the spreadsheet" list are reference lists, not features to build, and are counted separately here rather than folded into the 151.)*
