# Driver App — Functional Specification

Source examined (read in full, sequentially): `DriverAppPage.html` (1,956 lines — phone UI, HTML+CSS+JS in one file) and `DriverApp.gs` (1,299 lines — Apps Script server). This document exists to let the app be rebuilt outside Google Apps Script without losing any behavior, including behavior that only exists because of a past production incident. Every such incident is quoted verbatim from the source comment that documents it.

The app is a mobile web page for drivers of Amazing Grace Mobile Transport. It is served by `serveDriverApp_(e)` (`page=driver`) from the same Apps Script project that runs the dispatcher board, reading and writing the same `DISPATCH` sheet and trip log the dispatcher panel uses.

---

## 1. How a driver gets in

### 1.1 Two independent entry paths

**Path A — Google email match (no code, "walks straight in").**
`driverAppIdentify_()` reads `Session.getActiveUser().getEmail()` (the Google account the page is opened as, inside the Apps Script iframe) and looks it up against the `STAFF` sheet roster (column E, lower-cased, trimmed). If it matches a roster row, `driverAppBootstrap()` sets `boot.driver` to that name and the page starts the app immediately — no picker, no code, no local storage needed. This is the case `driverAccessProblem_` short-circuits: `if (emailMatched) return '';`.

**Path B — texted/emailed 6-digit code, once per phone.**
Everyone else taps their name from a roster picker, receives a 6-digit code, types it in, and gets back a 32-character token that is stored in `localStorage` and re-sent on every subsequent call. This is the "V84" scheme documented at the top of the sign-in block:

> "A driver whose Google email is on the STAFF sheet still walks straight in. Anyone who has to tap their name from the list now has to prove it: a 6-digit code is texted to the number on STAFF, and only that code opens the app. Once a phone is verified it stays trusted, so this is a one-time hurdle per device — but taking someone off STAFF cuts them off, because every load re-checks the roster."

### 1.2 Roster / STAFF sheet

- Spreadsheet ID `DRIVER_STAFF_ID_ = '1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE'`, sheet name `STAFF`.
- Columns read (0-indexed from `getValues()`): `[0]` name, `[3]` phone, `[4]` email, `[45]` carrier (e.g. "att", "verizon" — used to build a carrier SMS-gateway address via `getSmsEmail`, defined elsewhere in the project).
- Roster is memoized per-request in `DRIVER_ROSTER_MEMO_` (a global, so three lookups in one call cost one sheet read) and cached in `CacheService` under key `driver-app:roster:v2` for 900 seconds (15 minutes). Comment: "The staff list changes about once a week; five minutes meant re-reading a whole second spreadsheet many times an hour during a shift... Long enough to stop re-reading a second spreadsheet many times an hour, short enough that somebody added to STAFF can use the app within a few minutes." `refreshDriverStaffRoster()` is a manually-runnable function to bust the cache immediately after editing STAFF.
- Only roster names with a phone of 10+ digits are exposed in `boot.roster` (the tappable name-picker list) — `driverAppBootstrap`: `.filter(function(r){ return String(r.phone||'').replace(/\D/g,'').length>=10; })`. A staff member with no phone number is not offered as an option in the picker at all, even though they could still receive an email code.

### 1.3 Code request/verify (server functions)

**`driverRequestCode(name)`** — called when a driver taps a name in the picker.
- Looks up the roster record by normalized name (`driverNorm_`: lowercase, strip everything but a-z0-9).
- Not found → `{ok:false, reason:'unknown'}`.
- Determines `canText` (`DRIVER_TEXTS_ENABLED_` true AND phone digits ≥10 AND carrier set) and `canMail` (has a syntactically valid email — `@` with a `.` after it).
- Neither → distinguishes three failure reasons:
  - no phone and no email at all → `{reason:'nophone'}`
  - texts globally disabled → `{reason:'textsoff'}`
  - otherwise (has a phone but no usable carrier gateway) → `{reason:'nocarrier'}`
- Resend throttle: `CacheService` key `dvsend:<norm-name>` set for `DRIVER_CODE_RESEND_SEC_ = 60` seconds. If present → `{ok:false, reason:'toosoon', wait:60, masked:<mail-and/or-phone>}`.
- On send: generates a 6-digit code (`driverMakeCode_`; leading zero is bumped to `1` so it's never suppressed by display code), stores `{code, tries:0}` at cache key `dvcode:<norm-name>` for `DRIVER_CODE_TTL_SEC_ = 600` seconds (10 minutes), and sets the resend-throttle key.
- Sends by email (`sendDriverCodeEmail_`, subject `"<code> is your Amazing Grace sign-in code"`) and/or by carrier SMS gateway (`sendDriverGatewayText_`, plain body, no subject). Returns `via: 'both'|'email'|'text'` and a masked destination string, e.g. `(845) •••-••42` or `net•••@gmail.com`.
- If both delivery attempts fail: rolls back the resend-throttle key (`cache.remove`) so the driver isn't blocked from trying again, and returns `{reason:'sendfailed'}`.

**`driverVerifyCode(name, code)`**
- No roster record → `{reason:'unknown'}`.
- No cached code (expired or never sent) → `{reason:'expired'}`.
- Wrong code → increments `tries`; at `DRIVER_CODE_MAX_TRIES_ = 5` the code is deleted and `{reason:'locked'}` is returned (driver must request a new one); otherwise `{reason:'wrong', left: <tries remaining>}`.
- Correct code → deletes both cache entries, mints a 32-char lowercase-alphanumeric token (`driverMakeToken_`), calls `driverTrustAdd_(name, token)`, and returns `{ok:true, name, token}`.

### 1.4 Trusted-device storage (server side)

`driverTrustAdd_` stores tokens in `PropertiesService.getScriptProperties()` under key `driverApp:trustedDevices:v1`, shaped as:
```
{ "<normalized-driver-name>": { "<token>": "<ISO timestamp added>", ... }, ... }
```
Oldest token is evicted once a driver has more than `DRIVER_TRUST_MAX_PER_DRIVER_ = 8` tokens (keeps the property small as a driver churns through phones).

`driverTrustValid_(name, token)` — a token is valid **only** if the driver is *still* found on the (cached) roster **and** the map has that exact token for that normalized name. This is the mechanism that revokes access the moment someone is removed from STAFF (next load re-checks the roster, whether via cache or a fresh read within 15 minutes).

### 1.5 Client-side storage

- `localStorage["ag-driver"]` — the driver's display name, set after any successful sign-in (email match or code) and read back on boot if the server-embedded bootstrap didn't already know who this is.
- `localStorage["ag-token"]` — the 32-char trust token, set only after code verification.
- `localStorage["ag-outbox"]` — the offline queue (see §4).
- `sessionStorage["ag-reloaded"]` — timestamp of the last self-reload for a new build (see §5/build-bump logic), to stop a reload loop.
- On `forgetDriver()` (used when the server says the identity is unknown), both `ag-driver` and `ag-token` are removed and in-memory `driver`/`driverToken` are cleared.

### 1.6 Unknown / stale link behavior

- If the bootstrap's email matched nobody, `pickMsg` reads: *"We did not recognize `<email>`. Tap your name below, and ask dispatch to add your email to the STAFF list so this is automatic next time."*
- If a stored driver name no longer resolves (`gotPayload` receiving `{reason:'unknown'}`), the client calls `forgetDriver()` and shows the picker with the "not recognized" messaging (`showPicker(true)`), and toasts *"That name is no longer on the staff list."* on a similar path inside `gotVerify`.
- If the trust token is present but invalid/missing/expired for a request (`reason:'verify'`), the client is told to "Please sign in again to <action>." and is routed back into `askForCode(driver)` — it does **not** forget the driver's name, since it's still presumably the right person on the wrong/untrusted device, just needs a new code.
- The app has no long-lived session cookie; identity on every single RPC is re-asserted by resending `driver` (name) + `token` and, for the two Google-identified paths, is actually re-derived server-side from `Session.getActiveUser().getEmail()` if that's available (`driverAppIdentify_()` inside `driverActionGate_`), which is stronger than trusting the client's claimed name.

### 1.7 The authorization rule: one driver cannot act on another's trip

Every action-taking server call funnels through **`driverActionGate_(driverName, token, tripKeyID)`**, which runs, in order:

1. **Identity resolution.** `who = driverAppIdentify_()`. If the active Google session matches a STAFF email, that name wins over whatever name the client claims (`claimed = who.name || driverName`). This stops a stale `localStorage` name from overriding a legitimately different signed-in Google identity.
2. **No name at all** → `{ok:false, reason:'verify'}`.
3. **`driverAccessProblem_(claimed, token, emailMatched)`**:
   - not on the roster (at all, or any more) → `'unknown'`
   - Google email matched → `''` (pass)
   - `driverTrustValid_(name, token)` → `''` (pass)
   - otherwise → `'verify'`
4. **Per-trip ownership check** (only when a `tripKeyID` is supplied — i.e. every call except the plain day-load and the location-state ping):
   - Looks the trip up fresh from `tripManager.getTripsByDate(driverDateKey_(0))` (today's date only — see below) and finds the row whose `tripKeyID` matches.
   - If the lookup itself threw (a transient read failure), the exact test is: **do not treat "we could not check" as "this is not yours."** Returns `{ok:false, reason:'record', message:'The office could not be reached just then. This will be sent again.'}` — retryable, not a false ownership rejection. Comment:
     > "V120: a read that FAILED is not the same as a trip that is not yours. The phone treats 'not yours' as final and throws the tap away, so a momentary problem reading the record used to destroy a completed pickup."
   - If no matching trip is found at all → `{ok:false, reason:'notyours'}`. Comment: "The old test let a trip with an empty DRIVER cell through for any signed-in driver. An unassigned trip belongs to the office, not the phone." (i.e. previously an unassigned trip was fair game for any driver — now it's refused.)
   - If found but `driverMatches_(tp.driver, claimed)` is false → `{ok:false, reason:'notyours'}`.
5. Success → `{ok:true, name:claimed}`.

**The name-matching test, `driverMatches_`, is itself the load-bearing authorization primitive** (used both here and for filtering "my trips" in `getDriverDayPayload`). It has an explicit worked history of a real vulnerability:

> "V120: the old rule accepted any run of letters found inside the other name, so 'Lee' matched 'Ashleen' and one driver could see — and complete — another driver's trips. This decides authorisation, so it now works on whole name parts and never guesses from a prefix."

Exact rules, as documented in-line (all examples are from the source, verbatim):

- **Matches:**
  - `"Mike"` / `"Mike Johnson"` — a whole part
  - `"Blasse"` / `"Nathaniel Blasse"`
  - `"Johnson, Mike"` / `"Mike Johnson"`
  - `"Obrien"` / `"Maureen O'Brien"` — apostrophes ignored
  - `"Vanderberg"` / `"Van Der Berg"` — a compound surname written solid
  - `"Jose"` / `"Jose Ramirez"` — accents folded away
  - `"Mike J"` / `"Mike Johnson"` — first name in full, then an initial
- **Refuses:**
  - `"Lee"` / `"Ashleen Baker"` — only inside a word
  - `"Dan"` / `"Danielle Carter"` — a prefix is not a name
  - `"Dan Rivera"` / `"Danielle Rivera"`
  - `"M Johnson"` / `"Mary Johnson"` — an initial cannot carry the match

Algorithm (`driverNameParts_` splits on non-alphanumerics after NFD-normalizing and stripping accents/apostrophes and lower-casing):

1. Normalize both names into part-arrays; call the array with the shorter joined length `few`, the other `many`.
2. **Rule 1 — subset of whole parts:** every part of `few` is literally present as a whole part of `many` → match.
3. **Rule 2 — solid compound:** `few` joined together as one string equals a contiguous run of `many`'s parts joined together → match (handles `"vanderberg"` vs parts `["van","der","berg"]`).
4. **Rule 3 — first name in full + initials:** if `few[0]` (in full) is a whole part of `many`, and every remaining part of `few` is either a whole part of `many` or a single letter equal to the first letter of some part of `many` → match. (This is precisely why `"Mike J"` matches but `"M Johnson"` does not: the *first* token must be the full name, never an initial.)
5. **Rule 4 — unique short form**, `driverUniqueShortForm_`: a last resort for real nicknames the earlier rules can't see ("Chris" for "Christopher", "Rick" for "Patrick", "Al" for "Alberto"). `driverShortFormOf_` requires every part of the shorter side to be either an exact match, or a **prefix** of a longer part (length ≥2), or a **suffix** of a longer part (length ≥4 — the 4-letter floor is explicit, because 3 letters over-matches: comment gives `"Ana"` wrongly matching `"Dana"`, `"Los"` wrongly matching `"Carlos"`). Then it walks the **entire roster** and only accepts the shortening if **exactly one** roster driver could possibly be meant by it (`hits === 1`) — an ambiguous nickname is refused even if the short-form pattern itself would otherwise line up.

This whole apparatus exists to answer one question safely: "is this the trip's driver, given all the ways dispatch might have typed a name into a free-text cell?" — get it wrong in the permissive direction and one driver can complete another's trip; get it wrong in the strict direction and a driver is locked out of their own trip because dispatch typed their name slightly differently than STAFF did.

### 1.8 "Today" scoping as an implicit access boundary

`driverActionGate_`'s trip lookup is **always against `driverDateKey_(0)`** — i.e. *today's* date in the spreadsheet's timezone (`Session.getScriptTimeZone()`), regardless of which date the driver is viewing in the app. This means every write action (`driverSetTripStep`, `driverRunningLate`, `driverDriveFromLocation`) is implicitly restricted to today's trips even though the *read* path (`getDriverDayPayload`) supports `which: 'tomorrow'`. Rebuild note: a driver cannot mark tomorrow's trips at all through this gate — tomorrow is read-only by construction, not by an explicit check.

---

## 2. Every screen

All screens are `display:none`/`display:block` toggled `<div>`s inside one HTML document — there is no client-side router; state lives in top-level JS variables (`driver`, `which`, `trips`, `sheetKey`, `sheetView`, etc.).

### 2.1 Name picker — `#pickWrap`
Shown by `showPicker(unknownEmail)`. Contains `#pickMsg` (context text) and `#pickList`, one `<button data-name="...">` per roster name (only names with ≥10-digit phones, per §1.2). Tapping a name calls `askForCode(name)`.

### 2.2 Code verification — `#vfyWrap`
Shown by `showVerify()`. Elements: `#vfyHead` (heading), `#vfyMsg` (body text, e.g. "We texted a 6-digit code to (845) •••-••42. It expires in 10 minutes."), `#vfyErr` (error banner, hidden unless there's an error), `#vfyCode` (6-digit numeric input, auto-submits at 6 digits via an `input` listener), `#vfyGo` ("Verify" button), `#vfyResend` ("Send a new code" — disabled during a 60-second cooldown ticked down every 500ms by `vfyTickResend`), `#vfyBack` ("Not you? Go back" — calls `forgetDriver()` and returns to the picker).
A hard-blocked state (`vfyBlock`, used for `nophone`/`nocarrier`/`textsoff`/`sendfailed`) hides the code input, Verify, and Resend controls entirely and shows only the error text — the driver's only recourse is to call the office.

### 2.3 Main app shell — `#appWrap`
- Top bar `.top`: hamburger `#menuBtn` → opens the drawer; `#pageTitle` ("My Day" / "Tomorrow"); `#topCall` — a phone-icon link to dispatch, hidden unless `BOOT.links.dispatch` is set.
- `#geoBar` — inline banner shown only when location permission is `denied`/`prompt`(-and-dismissed)/`unsupported`; has a "Turn on" button that reopens the full location-permission modal.
- `#hero` — the current/next-trip hero card (see §2.4).
- `#tiles` — quick-action row: Time Card (external link, if configured), Inspection (disabled, "Soon" toast), Running Late (opens `#lateBg` modal), Call Dispatch (tel: or external link).
- `#dayLabel` / `#liveDot` — "Today · Sep 12" / a "Live"/"Updating"/"Offline" status word.
- `#list` — the trip cards (see §2.5), or `#empty` ("No trips here yet. Check back soon.") when there are none.
- Bottom nav `#nav`: `#navToday` / `#navTomorrow` tab buttons, switch `which` and reload.

### 2.4 Hero card (`renderHero`, inside `#hero`)
Shows the next non-finished, non-overridden trip for **today only** (hidden entirely on the Tomorrow tab). Content depends on stage:
- Stage ≥2 (already at pickup/in transit/at drop-off): a one-line status ("You are at the pickup" / "Passenger on board" / "At the drop-off").
- Stage <2, no drive-time estimate available: "in `<duration>` · drive time unavailable".
- Stage <2, with drive-time: computes ETA vs. scheduled pickup time and renders one of three visual states via CSS class on the hero (`.late`, `.leavenow`, or plain):
  - **Late** (arriving after pickup time): red hero, warning icon, "Running late · arriving about **`<eta>`** (`<N>` min late)", plus a sub-line telling the driver whether dispatch has actually been told yet (see §9 for the exact wording rule).
  - **Leave now** (past the leave-by threshold but not yet technically late): orange hero, clock icon, "Leave now · arrive about **`<eta>`**".
  - **On time**: neutral hero, "Leave by **`<time>`** · arrive about `<time>`" plus the drive-time source and the leave-buffer cushion in minutes.
- Always shows "Next Pickup", the pickup time, passenger name, and — if the office has a start time for the shift — a "Start time" row.
- Skeleton state: while `loading && !trips.length`, hero renders as a pulsing gray placeholder (`.skhero.sk`).

### 2.5 Trip list cards (`cardHtml`, inside `#list`)
One card per trip, sorted with unfinished trips first (in original/schedule order) and finished/overridden trips at the bottom in reverse order (most recently finished first) — see the sort comparator in `render()`. Each card shows: a transport-type icon badge (top-right corner), scheduled time (and start time, if any), a status pill, a "waiting `<N>` min" pill once a wait is worth showing (§7), passenger name, pickup address, drop-off address (bold label), and a note row (dispatch/pickup/drop-off note, whichever applies — see `noteFor`) if present. A card whose ETA is currently "late" gets a red border/left icon (`.late`, `cardHz` alert icon). Tapping anywhere on a card except a nested link opens the trip's bottom sheet (`openSheet`).

### 2.6 Trip bottom sheet — `#sheet` / `#sheetBg`
A shadcn-style bottom sheet, swipe-to-dismiss (vertical drag >90px closes it), backdrop-click closes it, `Escape` key closes it. Two "views" toggled by `sheetView`:

**Main view** (`sheetView === 'main'`):
- Header: avatar-initial circle, passenger name + transport icon, an "ⓘ" button (`#shInfo`) that switches to Details.
- Status pill + transport chip.
- "CURRENT STOP" section: two `stopRow`s (Pickup, Drop-off), the active one highlighted (`.cur`, "Current destination" chip) and given a "Navigate" button that deep-links to Google Maps (`MAPS + encodeURIComponent(address)`).
- The relevant dispatch/pickup/drop-off note, if any.
- If the trip has a dispatch override (Canceled/No Show/Reassigned/Not Confirmed): a red bar, `"<override> by dispatch"`, and **no** progress controls.
- Else, for today's trips only: the wait box (§7), a "TRIP PROGRESS" section with the big primary progress button (`#shProg`, label from `STEPS[stage]`, e.g. "IN ROUTE TO PICKUP") plus a small three-dot overflow button (`#shDots`) that opens a `#shMenu` dropdown with "No Show" (disabled/countdown-labeled until the no-show wait threshold is reached) and "Cancel Trip" (red, confirms via a native `confirm()` dialog whose exact text is: *"Cancel this trip? Dispatch will see it as Canceled. Any return trip is not affected."*).
- If the trip is already complete (`stage === 5`): a single disabled "TRIP COMPLETE ✓" button, no menu.

**Details view** (`sheetView === 'details'`, reached via the ⓘ button): a back arrow + "Trip Details" header, then a full read-only field dump: Start time, Pickup time, Pickup, Drop-off, Passenger phone, Transport, Status, Arrived at pickup, Passenger on board, Arrived at drop-off, Completed, Trip ID, Dispatch notes, Pickup notes, Drop-off notes.

If the sheet's trip disappears from `trips` (e.g. reassigned away) while open, `renderSheet()` closes the sheet and — only if the day's list isn't itself momentarily empty (to avoid a false alarm on tab-switch) — toasts: *"That trip has been moved to another driver. Call the office if you are already on it."* Comment:
> "V120: a reassigned trip simply disappeared from the list and the open sheet slid shut on its own, which reads as the phone glitching. Only say so when there really is a day loaded... and telling a driver mid-trip that it was taken off them is worse than saying nothing."

### 2.7 Side drawer — `#drawer` / `#drawerBg`
Opened by the hamburger, closed by the X button, backdrop click, or `Escape`. Shows driver avatar-initial + name, then: BASE (external Maps link to `DRIVER_BASE_ADDRESS_`, hidden if not configured), Messages / My Week / Settings — all three permanently disabled placeholder rows with a "Soon" chip, toasting "`<label>` is coming soon." on tap.

### 2.8 Welcome / location-permission flow
- **`#welcome`** — a full-screen first-run welcome overlay (only shown once per session, gated by `geoAsked`), personalized with the driver's first name, explaining why location is wanted, with "Allow location & continue" / "Skip for now" buttons. Shown only when the permission state is `prompt` (never asked yet).
- **`#geoBg` / `#geoBody`** (a modal, reused for two purposes): re-invoked from the `#geoBar` "Turn on" button. If the browser permission is **blocked** (`denied`), shows numbered manual-fix instructions (tap the address-bar icon → Permissions → Location → Allow → refresh) since a JS prompt cannot re-request a denied permission. If still just unasked (`prompt`), shows the same benefits list + Allow/Not-now as the welcome screen.
- Location is reported to the server (`driverSetLocationState`) purely so the *dispatcher* view can see who has location off — see §8.

### 2.9 Running Late modal — `#lateBg`
Radio choices: "Traffic / Road Conditions" (default), "Weather", "Long Wait Time", "Other"; an optional free-text note `#lateNote`; if an ETA is known for the active trip, an inline `#lateEta` line ("Dispatch will see that you are about `<N> min`` away"); "Notify Dispatch" button (`#lateSend`) calls `driverRunningLate`.

### 2.10 Toasts / banners
- `#toast` — top-of-screen transient message, auto-hides after 3500ms (`toastMsg`).
- `#undo` — bottom "UNDO (`<n>`s)" bar, see §3.
- `#offline` — "⚠️ You are offline. Some features may be limited." shown on `window.offline` event or when a payload load fails.
- `#outboxBar` (created dynamically, not in the initial markup) — "N updates still to send", positioned 96px from bottom so it never overlaps the offline banner. See §4.

---

## 3. The tap flow (trip status progression)

### 3.1 The five ordered steps

```js
const STEPS = [
  { step: "inroute",   label: "IN ROUTE TO PICKUP",    pill: "In Route" },
  { step: "pickupin",  label: "ARRIVED AT PICKUP",     pill: "Pickup In" },
  { step: "intransit", label: "PASSENGER ON BOARD",    pill: "In Transit" },
  { step: "arrived",   label: "ARRIVED AT DROP-OFF",   pill: "Arrived" },
  { step: "complete",  label: "COMPLETE TRIP",         pill: "Complete" }
];
```
The single primary button (`#shProg`) always shows `STEPS[stage].label` — i.e. it always names the *next* action, not the current state. `stageOf(tp)` maps the trip's raw status string to an integer 0–5:
```
'' / other        -> 0
"IN ROUTE"         -> 1
"PICKUP LOCATION"  -> 2
"INTRANSIT"        -> 3
"DROPOFF LOCATION" -> 4
"COMPLETE"         -> 5
```
Server-side, the write path (`driverSetTripStepInner_`) uses an identical rank table `DRIVER_STEP_RANK_` to enforce ordering (§5). Each step, when applied, writes:

| step | writes locally (optimistic) | server field written | server timestamp column |
|---|---|---|---|
| `inroute` | `status = "IN ROUTE"` | `status` only | none |
| `pickupin` | `status = "PICKUP LOCATION"`, `pickupArrival = now` (if unset) | `status`, `pickupArrival` | `COLUMN.DISPATCH.PICKUP_IN_AT` + `COLUMN.DISPATCH.IN` |
| `intransit` | `status = "INTRANSIT"`, `pickupDeparture = now` (if unset) | `status`, `pickupDeparture` | `COLUMN.DISPATCH.INTRANSIT_AT` |
| `arrived` | `status = "DROPOFF LOCATION"`, `dropoffArrival = now` (if unset) | `status`, `dropoffArrival` | `COLUMN.DISPATCH.ARRIVED_AT` |
| `complete` | `status = "COMPLETE"`, `dropoffDeparture = now` (if unset) | `status`, `dropoffDeparture` | `COLUMN.DISPATCH.COMPLETED_AT` + `COLUMN.DISPATCH.OUT` |

Two side actions are **not** part of the ordered sequence and instead set `dispatchStatus` (an override that supersedes the stage pill entirely):

- `noshow` → `dispatchStatus = "NO SHOW"` (server: `setTripQuickStatusSingle_(key, 'NO SHOW')`)
- `cancel` → `dispatchStatus = "CANCEL"` (server: `setTripQuickStatusSingle_(key, 'CANCEL')`)

### 3.2 Irreversibility

- **`complete`, `noshow`, and `cancel` are terminal** — `isDoneTrip()` treats stage 5, "Canceled", and "No Show" as done; the sheet then shows either a disabled "TRIP COMPLETE ✓" button or an "`<override>` by dispatch" bar with no progress controls at all. There is no client affordance to undo any of these once the 6-second undo window (§3.4) has elapsed and the server has accepted them.
- **The server additionally refuses to move a trip backwards at all**, independent of the client UI (§5) — a duplicate or late-arriving tap for an earlier step than the trip is already at is a silent no-op (`{ok:true, duplicate:true}` in the same shape as success, so the client doesn't even see it as an error).
- **Cancel only affects the tapped leg.** The dispatcher-panel version of "cancel" (`setTripQuickStatus`, not called from here) also cancels a linked return leg; the driver version deliberately does not, because the return leg may belong to a different driver who was never checked by the ownership gate. The confirm dialog says this explicitly: *"Cancel this trip? Dispatch will see it as Canceled. Any return trip is not affected."* Comment:
  > "V120: setTripQuickStatus deliberately cancels the linked return leg as well, which is right when a dispatcher does it from the board and wrong from a phone: the return leg may belong to another driver, who was never checked by the gate above and simply watched the trip vanish. A driver's tap now touches this leg only."
- **No-show is time-gated**, not permission-gated: the menu item is disabled until the pickup-arrival wait has been live for `NOSHOW_MIN` (default 10) minutes, showing "No Show (in `<N>`m)" as a countdown in the meantime. See §7.

### 3.3 Debounce against double-taps

Every tap handler (progress, no-show, cancel) checks a 1200ms debounce keyed by trip: `if (lastStepTapKey === tp.key && t - lastStepTapAt < 1200) return;`. Comment on why this exists:
> "V120: tapping this re-draws the button as the NEXT step straight away, and queueStep sends the previous one immediately. On a rough road a single bounced tap therefore committed one step and queued the next, stamping a pickup the driver was still twenty minutes away from."

### 3.4 Optimistic apply + 6-second undo

`queueStep(key, step, label)`:
1. If another tap is already pending, first **commits** it immediately (`commitPending()`, flushes it into the outbox) — there is never more than one pending/undoable tap at a time.
2. Snapshots the trip's pre-tap fields (`status`, `dispatchStatus`, the four timestamp fields) into `before`.
3. Applies the change optimistically to the in-memory trip (`applyLocal`) and re-renders immediately — the driver sees the new state with zero latency, before any network call happens.
4. Shows the `#undo` bar: `"Status updated to <pill label>"` + a live "UNDO (`<n>`s)" countdown starting at 6, ticking every second (`setInterval`).
5. When the countdown reaches 0 (or the driver navigates on and `queueStep` is called again), `commitPending()` fires: it stamps a nonce (`key:step:timestamp`), pushes `{key, step, nonce, day: todayKeyForOutbox_(), at: Date.now(), tries: 0}` onto the **outbox** (§4), and calls `drainOutbox()`.

**Undo** (`#undoBtn` click, only reachable inside the 6-second window):
```js
el("undoBtn").onclick = function() {
  if (!pending) return;
  clearInterval(undoTimer);
  const tp = trips.filter(t => t.key === pending.key)[0];
  if (tp) {
    tp.status = pending.before.status;
    tp.dispatchStatus = pending.before.dispatchStatus;
    ["pickupArrival","pickupDeparture","dropoffArrival","dropoffDeparture"]
      .forEach(f => tp[f] = pending.before[f]);
  }
  forgetLocalStep(pending.key);   // <-- the fix; see below
  pending = null;
  el("undo").style.display = "none";
  render();
};
```

**The documented past failure, quoted exactly:**
> "V120: this is the fix for the step that came back. Undo restored the two status fields but left the advanced step sitting in localStage, so the next refresh a few seconds later put it right back — silently. The driver then tapped what looked like the next step and the office recorded a later stamp with the earlier one blank, which is exactly what the 'skipped step' repair on the server has been cleaning up ever since."

The concrete bug: undo only ever rolled back `tp.status`/`tp.dispatchStatus`/the four timestamp fields on the *displayed trip object* — it did **not** clear `localStage[key]` (the 90-second "don't let a stale server answer drag this card backwards" memory, §5.3) or the two ad-hoc wait-timer stamps in `localStamps` (`key:pickupin`, `key:arrived`). Because `localStage` still remembered the driver having reached the un-done stage, the very next poll (15s later) would see the server's un-advanced trip, compare it against `localStage`, and — per `keepLocalSteps`'s rule ("if the server's stage is behind what I locally remember, keep the local, more-advanced state") — silently re-apply the undone step to the UI. The driver, now looking at a card that had quietly reverted itself, would tap what appeared to be the *next* step, and the server would end up with a later stamp filled in while the earlier one was blank — a "skipped step," which a separate server-side repair job (`repairSkippedStepStamps`, referenced but not defined in these two files) has apparently been mopping up ever since. The fix, `forgetLocalStep(key)`, explicitly deletes all three: `localStage[key]`, `localStamps[key+':pickupin']`, `localStamps[key+':arrived']`.

**Rebuild requirement:** *undo must clear every piece of client-side memory that could re-derive or re-assert the undone state* — not just the fields displayed on screen. In this app that is three distinct stores (`trips[].status`/timestamps, `localStage`, `localStamps`) that all had to be found and cleared together; missing any one reproduces the bug.

---

## 4. The offline queue ("outbox")

### 4.1 Why it exists

> "V120 ... A step used to be sent once and forgotten. In a dead zone the call simply never came back (there is no timeout on google.script.run), the toast vanished after three and a half seconds, and ninety seconds later the card snapped back to where it started — so a driver could tap four milestones over half an hour and none of them ever reached the office. Taps now go into a small outbox that is written to the phone itself, so they survive a reload or the app being closed, and they are re-sent until the office confirms them."

### 4.2 Storage

- **Storage key:** `localStorage["ag-outbox"]`, a JSON array.
- **Record shape**, as pushed in `commitPending()`:
  ```json
  { "key": "<tripKeyID>", "step": "pickupin", "nonce": "<tripKeyID>:pickupin:<epoch-ms-at-tap>",
    "day": "2026-09-12", "at": 1757700000000, "tries": 0 }
  ```
  A `sentAt` field (epoch ms of the first send attempt) is added lazily the first time `drainOutbox` actually issues the RPC for that job.
- **Load-time hygiene:** on script load, the raw value is JSON-parsed inside a `try`, defaulting to `[]` on any parse failure, and then — in a **second, separate** `try` — filtered to drop any entry that lacks a `key`/`step`, or whose `day` doesn't match today (`todayKeyForOutbox_()`, the local device's Y-M-D). Comment on why both operations are separately guarded:
  > "V120: everything about reading this back is guarded. A stored value that is valid JSON but not an array (or a filter that throws) used to happen OUTSIDE the try, which killed the rest of this script block — and with it the whole app: no refresh, no rendering, no sign-in."
  This is a documented past total-outage bug: a single malformed `localStorage` value used to brick the entire app (because a thrown exception partway through a `<script>` block aborts everything after it in that block, including all the function definitions the rest of the app needs). Rebuild note: **every read of persisted client state must be defensively wrapped**, not just the JSON.parse.
- **Stale entries left overnight** (a `day` that doesn't match `todayKeyForOutbox_()`) are silently dropped rather than replayed, because "the trip does not exist [on a new day's board]" and the office would just answer `notfound`.

### 4.3 Draining / retry

`drainOutbox()` processes **one job at a time**, strictly FIFO (`outbox[0]`), never in parallel:
- Refuses to run if `draining` is already true, the outbox is empty, there is no `driver` identity yet, or there is no `driverToken` **and** the boot payload didn't already establish identity via Google email (`!(BOOT && BOOT.driver)`). Comment: a driver with only an email-based identity on the STAFF sheet, whose email path never issued them a token, must not be blocked from sending taps just because `driverToken` is empty.
- A **20-second client-side timeout** wraps the call (`google.script.run` itself has no timeout). If nothing has resolved by then:
  - If the browser reports `navigator.onLine === false`: this attempt does **not** count against the retry budget — `delete job.sentAt` (so a later real attempt isn't penalized for wait time already spent) and the job is simply retried (`done(true)` = keep, requeue).
  - Otherwise: `job.tries++`, persisted; if `tries >= OUTBOX_MAX_TRIES` (6), the job is **abandoned**: toast *"One update could not be sent - please call the office."* and the job is dropped from the outbox (`done(false)`). Otherwise it's kept for another attempt.
- **Retry trigger cadence:** `setInterval(drainOutbox, 10000)` (every 10 seconds) plus an immediate call on the `window online` event and immediately after each `commitPending()`.
- **Server-side polling for "still working" (`inflight`)**: if the server reports `{reason:'inflight'}` (another copy of the exact same nonce is mid-flight, held by the server's nonce-claim lock), the client does **not** count this as a try. Instead it checks how long *this specific job* has been outstanding since its own first send (`job.sentAt`, **not** the original tap time `job.at`) — comment:
  > "Measured from the first attempt at THIS job, not from when it was tapped - a job queued behind a slow one must not inherit its wait."
  If more than **10 minutes** have elapsed since `job.sentAt`, it gives up: toast + drop. Otherwise it just waits and retries.
- **Retryable vs. terminal server refusals:** `reason` values `'verify'`, `'unknown'`, `'record'` are retryable (count against `tries`, same 6-try/abandon rule); anything else non-`ok` (e.g. `'notyours'`, `'notfound'`, `'submitted'`) is **not** retried — the job is dropped immediately and, for the "not retryable" branch specifically, a fresh `load()` is triggered so the driver sees the corrected state.
- **Failure handler (`.withFailureHandler`) mirrors the timeout handler exactly**, with the same online-check exemption and the same double-count guard (`if (settled) return;` — a request that both hit the 20s timeout *and* later resolves/fails must not be charged twice). Comment:
  > "The twenty-second timeout above may already have counted this attempt and moved on. Without this guard a request that stalled and then failed cost two attempts out of six - and could charge the second one against a fresh send of the same step that had already started."

### 4.4 Constants

| Constant | Value | Meaning |
|---|---|---|
| `OUTBOX_MAX_TRIES` | 6 | attempts before a job is abandoned |
| client RPC timeout | 20000 ms | before an attempt is considered dead and retried |
| drain interval | 10000 ms | background retry cadence |
| `inflight` giveup window | 10 minutes | measured from `job.sentAt`, per-job |

### 4.5 Telling the driver

- Persistent count banner: a dynamically-created `#outboxBar` element, styled like the offline banner but pinned 96px from the bottom (so it never visually collides with the "you are offline" banner sitting at 60px) — text is "1 update still to send" or "`<N>` updates still to send"; hidden entirely when the outbox is empty.
- Terminal abandonment: a one-shot toast, always the same wording — *"One update could not be sent - please call the office."* — no separate UI state persists after that; the job is simply gone.

---

## 5. Idempotency and the anti-regression rule

### 5.1 The nonce

Every step-tap RPC (`driverSetTripStep`) carries a client-generated **nonce**: `"<tripKeyID>:<step>:<originalTapEpochMs>"`, computed once in `commitPending()` and then persisted verbatim into the outbox record so every retry of the same job reuses the identical nonce.

Server-side (`driverHandleTap_`):
1. `driverNonceSeen_(nonce)` — checks `CacheService` key `driver-nonce:<base64url(MD5(nonce))>` (hashed so an arbitrarily long trip key can't blow the 250-character cache-key limit, and two different taps can never collide on a shared prefix). If a result is already cached, it is returned **verbatim**, without re-running any of the write logic — a byte-for-byte repeat of whatever the first attempt produced (including `duplicate: true` if that's what was stored).
2. If not seen, **claims** the nonce first, before doing any work: writes a placeholder `{ok:false, reason:'inflight', message:'Still saving that step.'}` under that key with a 400-second TTL. Comment on why the claim happens *before* the real work, and why 400 seconds specifically:
   > "Long enough to cover the slowest a request can be - a cancel waits on the board lock, rewrites the record and sends a text, which on a busy morning is well past half a minute. A claim that expired first would let the phone's retry run the whole thing again and text the driver a second cancellation."
3. If the claim write itself fails (cache unavailable), the tap is refused with `{ok:false, reason:'record', ...}` rather than proceeding unprotected — explicit comment: "If the claim cannot be written there is no protection at all, so ask the phone to try again rather than risk doing the work twice."
4. After the real work runs, the **final** result overwrites the placeholder (`driverNonceRemember_`, same key, 6-hour TTL — the longest `CacheService` allows) — except when the underlying call *threw*, in which case the claim is explicitly released (`driverNonceForget_`) rather than left to time out, so a retry within the same minute doesn't just keep getting "still saving": comment: "A throw used to leave the claim standing for a full minute. Every retry in that minute got 'still saving', the phone used up its attempts, and the real reason - a day the office has already closed, say - never reached the driver."
5. For no-show/cancel (`setTripQuickStatusSingle_`), the result is remembered whenever the board was actually written, **including** the case where the board write succeeded but the log/record write failed (`res.boardWritten`) — because otherwise a retry would re-write the board a second time and text the driver a second cancellation notice.

### 5.2 Server-side monotonic ordering (can't move backwards)

Independent of the nonce, the ordered-step write path (`driverSetTripStepInner_`) compares ranks:
```js
const DRIVER_STEP_RANK_ = { '': 0, 'IN ROUTE': 1, 'PICKUP LOCATION': 2, 'INTRANSIT': 3, 'DROPOFF LOCATION': 4, 'COMPLETE': 5 };
...
if (newRank <= curRank) { duplicate = true; return; }   // no-op, inside the board lock
```
This runs **under the same document lock used for every other board write** (`withTripsDocumentLock_`), reading the current status cell fresh at write time — so a delayed/duplicate/out-of-order tap (e.g. a stale retry of "in route" arriving after "complete" has already landed) can never regress the trip. When this happens, the response is still shaped as success (`{ok:true, step, status:conf.label, duplicate:true, at:...}`) rather than an error, so the client doesn't surface anything alarming for what is, from the office's perspective, a no-op — but the server *also* takes the opportunity to reconcile: if the board shows the target status but the trip's log record is missing the corresponding timestamp field (the specific failure pattern this exists to patch — "board advanced, record did not," from an earlier attempt whose record write timed out after the board write had already landed), it fills in just that missing field without touching anything already set. Comment:
> "The state this repairs is 'board advanced, record did not' - which is produced when the first tap's record write timed out. That write carried the stamp as well as the status, so restoring only the status would leave a later stamp filled and this one blank: exactly the pattern repairSkippedStepStamps exists to clean up."

### 5.3 Client-side anti-regression memory (`localStage`)

Because the office's answer to a status poll can itself be *stale* relative to a write the driver just made (classic read-after-write race across a spreadsheet-backed store), the client keeps its own 90-second memory so a server answer that is *behind* what the driver already did cannot visually drag the card backwards:
```js
const LOCAL_STAGE_MS = 90000;
function rememberStage(tp) {
  localStage[tp.key] = { stage: stageOf(tp), at: Date.now(),
    pickupArrival: tp.pickupArrival||'', pickupDeparture: tp.pickupDeparture||'',
    dropoffArrival: tp.dropoffArrival||'', dropoffDeparture: tp.dropoffDeparture||'',
    status: tp.status||'' };
}
function keepLocalSteps(list) {
  const now = Date.now();
  list.forEach(tp => {
    const mine = localStage[tp.key];
    if (!mine) return;
    if (now - mine.at > LOCAL_STAGE_MS) { delete localStage[tp.key]; return; }  // memory expires
    if (stageOf(tp) >= mine.stage) { delete localStage[tp.key]; return; }       // server caught up
    tp.status = mine.status;
    ["pickupArrival","pickupDeparture","dropoffArrival","dropoffDeparture"].forEach(f => { if (!tp[f] && mine[f]) tp[f] = mine[f]; });
  });
  return list;
}
```
Documented history:
> "V107: tapping a step used to flicker - the button moved on, then snapped back to the step before, then forward again a few seconds later. The tap is saved, the board version changes, the page reloads, and the office answers with the trip as it was a moment before the write landed. The phone believed it. Now a step this driver took is remembered for a minute and a half, and an answer that is BEHIND what they did is not allowed to drag the card backwards. The moment the office catches up, the memory is dropped."

This is the exact mechanism `forgetLocalStep` had to also clear on undo (§3.4) — leaving `localStage` populated after an undo is what caused the "skipped step" regression.

---

## 6. Clock correction

### 6.1 The two separate errors

Quoted in full, because it explains both variables precisely:
> "V107: the phone is not a reliable clock. This one was an hour behind the office, which made every 'waiting since' land in the future - and because a wait is clamped at zero, the timer sat on 00:00 and never moved. Two separate errors are corrected, both measured from what the office sends with every payload: clkSkew is how far this phone's clock is out, clkZone is how far its timezone is out from the spreadsheet's. A stamp is a wall clock written in the office's zone, so it needs the second; 'now' needs the first."

- **`clkSkew`** — device clock error (this phone's `Date.now()` vs. the server's true epoch instant).
- **`clkZone`** — timezone/offset error, specifically the gap that appears when a *wall-clock string with no zone attached* gets parsed by `Date.parse` as if it were local time, versus what it actually meant in the spreadsheet's timezone.

### 6.2 Learning them (`clkLearn`)

```js
function clkLearn(serverNow, serverClock) {
  const n = Number(serverNow || 0);
  if (!n) return;
  clkSkew = n - Date.now();
  const p = Date.parse(String(serverClock || ""));
  clkZone = isNaN(p) ? 0 : (p - n);
}
```
Called from `gotPayload` on every successful day-load, fed by the server's `getDriverDayPayload` response fields:
- `serverNow: Date.now()` — the server's true epoch ms.
- `serverClock: driverServerClock_()` — the same instant formatted as a *zoneless* wall-clock string in the spreadsheet's own timezone: `Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss")`. Server-side comment:
  > "V107: the office's own wall clock for this instant, in the spreadsheet's timezone and in the same shape the progress stamps arrive in. A page that parses this the way it parses a stamp learns exactly how far its own idea of the time is out, and can correct every stamp by that amount."

### 6.3 The two correction functions

```js
function nowMs() { return Date.now() + clkSkew; }
function clkFix(ms) { return ms ? ms - clkZone : ms; }
```
- **`nowMs()` replaces every use of `Date.now()`** throughout the client for "what time is it right now" purposes (ETA math, ETA countdowns, the wait-timer tick, `tripMinutesFromNow`, `waitStillLive`, `waitedMs`, etc.).
- **`clkFix(ms)`** is applied to a wall-clock value **this phone has just parsed as if it were its own local time**, to put it back onto the office's clock — used inside `stampMs()` (see below) and inside `tripMinutesFromNow` when constructing "the scheduled pickup instant, on today's date, in local wall-clock terms."

### 6.4 Parsing a status-change stamp (`stampMs`)

```js
// V106: a stamp from the server is a sheet time-of-day ("1899-12-30T13:19:00.000Z",
// T-hours being the wall clock) or a local ISO string; one made on this phone is a
// real instant. All three become a moment on today's date.
function stampMs(v) {
  const s = String(v || "");
  if (!s) return 0;
  if (s.indexOf("1899-") === 0) {
    const m = /T(\d{2}):(\d{2})/.exec(s);
    if (!m) return 0;
    const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return clkFix(d.getTime());
  }
  const t = Date.parse(s);
  if (isNaN(t)) return 0;
  // A stamp with no zone on it ("2026-09-07T21:10:00") is the office's wall
  // clock, which this phone has just read as its own. One with a Z or an offset
  // is already an instant and is left alone.
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? t : clkFix(t);
}
```
Three input shapes are distinguished and handled differently:
1. **Google Sheets "epoch 1899" time-of-day serialization** (`"1899-12-30T13:19:00.000Z"` — this is what a spreadsheet TIME-only cell becomes when read through certain Apps Script paths; `1899-12-30` is Sheets' day-zero). Only the `HH:mm` is meaningful; it's reinterpreted onto *today's* date and then `clkFix`-ed, because it's a wall-clock-in-the-office's-zone value.
2. **A zoneless local ISO string** (`"2026-09-07T21:10:00"` — this is exactly what the server's own write path produces via `Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss")`, §3.1/§6.5) — parsed by `Date.parse`, then `clkFix`-ed, because `Date.parse` on a zoneless string treats it as *this device's* local time, not the office's.
3. **A real instant** (has a trailing `Z` or an explicit `±HH:mm` offset — this is what a **locally-generated optimistic timestamp** looks like, since it's built as `new Date(nowMs()).toISOString()` in `applyLocal`) — left untouched, no `clkFix`, because it's already an unambiguous point in time.

**Why this matters (the concrete failure being fixed):** the "wait since" timers (§7) are `nowMs() - stampMs(arrivalField)`. If a stamp is a zoneless wall-clock string and is *not* corrected for `clkZone`, then on a phone whose OS timezone differs from the spreadsheet's timezone, the resulting "since" instant lands in the *future* relative to `nowMs()`. Because every "wait" duration is clamped at zero (`Math.max(0, ...)`), the visible symptom is a countdown/count-up timer that is permanently stuck at `00:00` — it never starts counting, because the code always computes a negative-then-clamped-to-zero elapsed time.

### 6.5 Where the server produces these stamps

- `driverServerClock_()` — as above, feeds `serverClock`.
- `driverSetTripStepInner_` computes `iso = Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss")` (the zoneless-local-ISO form, case 2 above) and writes that into the trip's log record fields (`pickupArrival` etc.) — this is the same shape `stampMs` special-cases.
- The **DISPATCH sheet's own timestamp cells** (`PICKUP_IN_AT`, `IN`, `INTRANSIT_AT`, `ARRIVED_AT`, `COMPLETED_AT`, `OUT`) are set with `.setValue(now).setNumberFormat('h:mm AM/PM')` — a genuine `Date` object with a display format — but these are read back by the dispatcher board, not by this client; the driver-app client only ever consumes the *log's* string fields (`pickupArrival`/`pickupDeparture`/`dropoffArrival`/`dropoffDeparture` on the `driverTripView_` payload), which come from `tripManager` (defined elsewhere).

### 6.6 The related "which clock did the ETA math use" bug

`tripMinutesFromNow` (used for the hero's "in `<duration>`"/late/leave-by math) has its own documented past bug:
> "V120: nowMs() corrects for a phone whose clock is off; this used the raw one, so on the test phone that runs an hour behind every trip looked an hour further away, 'Leave now' fired an hour late, and dispatch was never told about a driver who really was running behind."

And the no-show menu item's wait calculation had an analogous, separately-fixed bug:
> "V120: every other wait on this screen uses nowMs(), which corrects for a phone whose clock is off; this one used the raw clock against a corrected stamp, so the two numbers on the same screen disagreed by the whole error. And a missing stamp used to UNLOCK the button, which meant a mis-tap could mark a waiting passenger as a no-show with no wait at all."
(The second sentence is a distinct fix: previously a *missing* pickup-arrival stamp made `unlocked` evaluate truthy rather than false-safe; now `unlocked = stage >= 2 && stampAt > 0 && waited >= NOSHOW_MIN * 60000` explicitly requires a real stamp.)

**Rebuild rule:** every place in the client that computes "now" or compares it to a server-origin timestamp must go through the equivalent of `nowMs()`/`clkFix()` — there is no safe shortcut, and this codebase had at least three separate places where a raw `Date.now()`/naive `Date.parse` leaked back in and had to be found and fixed individually.

---

## 7. The wait timer / no-show countdown

### 7.1 What "waiting" means

`waitingAt(tp)` — a trip is "waiting" only in exactly two stages, and only if not overridden (canceled/no-show/reassigned/not-confirmed):
- **Stage 2 (at pickup, not yet in transit):** since `pickupStampMs(tp)` — server's `pickupArrival` stamp if present, else a purely local fallback `localStamps[key+':pickupin']` (set the instant the driver tapped "Arrived at Pickup," before the server has necessarily confirmed it — so the timer starts immediately even mid-outbox-retry).
- **Stage 4 (at drop-off, not yet complete):** since `dropoffStampMs(tp)`, same pattern against `localStamps[key+':arrived']`.
- Any other stage, or an overridden trip → not waiting (`null`).

### 7.2 Maximum-live clamp

```js
const WAIT_MAX_LIVE_MS = 12 * 60 * 60 * 1000;   // 12 hours
function waitStillLive(ms) { return (ms && (nowMs() - ms) <= WAIT_MAX_LIVE_MS) ? ms : null; }
```
A wait older than 12 hours is treated as **not currently waiting at all** (returns `null`, same as no stamp). Comment:
> "V106: where the driver is standing right now - at the pickup (stage 2) or the drop-off (stage 4) - and since when. Null anywhere else. Past this an arrival tap with nothing after it is a tap the driver forgot, not a driver still at the door."
This prevents a trip left in an intermediate stage from a previous day (a forgotten tap) from showing an absurd multi-day "waiting" timer.

### 7.3 Thresholds and display rules

| Constant | Value | Effect |
|---|---|---|
| `WAIT_SHOW_MIN` | 5 minutes | wait timer/pill/box do not appear at all below this — comment: "A driver who has just pulled up does not need a stopwatch in their face. The timer and the no-show countdown appear together once the wait is real." |
| amber threshold (`waitLevel`) | ≥10 minutes | wait display turns amber |
| red threshold (`waitLevel`) | ≥20 minutes | wait display turns red |
| `NOSHOW_MIN` | `BOOT.noShowWaitMinutes`, defaults to 10 (server: `DRIVER_NOSHOW_WAIT_MIN_ = 10`) | minutes of pickup-wait before the No Show menu item unlocks |

Three renderings of the same underlying wait, kept in sync:
1. **Card wait pill** (`waitPillHtml`, in the list) — small badge, "⏱ `<N>` min", colored by `waitLevel`.
2. **Sheet wait box** (`waitBoxHtml`, only in the open bottom sheet) — larger, shows a live `mm:ss`/`h:mm:ss` counter (`waitUp`), "Waiting at pickup/drop-off" + "Since `<time>`" (+ scheduled time, if at pickup), and — only while waiting at pickup — a hint line: either `"No Show unlocks in <mm:ss> — call dispatch first if the passenger is not answering."` or, once past the threshold, `"Waited <NOSHOW_MIN>+ min? Call dispatch before marking a no-show."`.
3. **No-show menu label** — "No Show (in `<N>`m)" while locked, becomes tappable once `waited >= NOSHOW_MIN * 60000` **and** a real stamp exists (see §6.6 for the "must have a real stamp" fix).

### 7.4 Redraw rule (the 1-second ticker)

A single `setInterval(..., 1000)` drives all live-updating wait UI:
- Updates every `[data-wt2]` counter element's text (the sheet's big mm:ss) and its color class, for any currently-open wait.
- Updates every `[data-wthint]` hint line.
- Every ~30 seconds (`Date.now() % 30000 < 1000`), also refreshes every `[data-wtc]` card pill's minute count and color.
- Runs a **presence check** across all visible cards: for each card currently on screen, does `waitWorthShowing(tp)` (i.e., "should a pill be showing now") disagree with whether a `.wpill` element is actually present in that card's DOM? If any card disagrees, a full `render()` (and, if the sheet is open and needs it, `renderSheet()`) is triggered. Comment, quoted:
  > "A wait under five minutes is not in the page at all, so the moment one crosses the card has to be drawn again. What is asked is simply 'does the page still match the truth' - the page itself is the record, so this cannot go stale, and a trip that is not on screen is not considered and cannot cause a loop."
  This is the mechanism that makes a wait pill *appear* the instant it crosses the 5-minute `WAIT_SHOW_MIN` threshold, without needing a fixed "recompute every N seconds and hope it lines up" schedule — it re-derives from the DOM's actual current state every second and reconciles rather than trusting a timer to have fired at the right moment.

Separately, the hero and general trip data refresh on their own cadences: hero ETA math redraws every 30 seconds (`setInterval(renderHero, 30000)`, guarded by `!pending`), the full day payload reloads every 15 seconds (`setInterval(load, 15000)`), and a cheap "did the board change" version check polls every 4 seconds (`getBoardVersion`, §8) to trigger an out-of-cycle reload sooner when something has actually changed.

---

## 8. Every server call

### 8.1 Client → server (all `google.script.run` calls, exhaustive — verified via grep against the whole file)

| Function | Called from | Arguments | Success handling | Failure handling |
|---|---|---|---|---|
| `getDriverDayPayload` | `load()` | `(driver, which, driverToken)` | `gotPayload(p)`: reads `clkLearn`, merges `keepLocalSteps`, re-renders, triggers geo prompt + GPS drive-time lookup | sets `liveDot` to "Offline", shows `#offline` banner, still calls `render()` |
| `getBoardVersion` | `checkBoardVersion()` (every 4s) | none | compares returned opaque version string to last-seen; on change, triggers `load()` | silently clears the in-flight flag; no user-visible effect |
| `driverRunningLate` | auto-late path (`autoFlagLate`, hero-triggered) and the manual "Notify Dispatch" button (`#lateSend`) | `(tripKeyID, reasonText, driver, driverToken)` | manual path: `refused(r,...)` check then toast "Dispatch notified that you are running late."; auto path: updates `lateSent[key]` to 2 (confirmed) or 3 (failed, see below) and re-renders the hero if still showing that trip | manual: toast "Could not send - try again."; auto: marks `lateSent[key] = 3` |
| `driverSetTripStep` | `drainOutbox()` (every queued tap) | `(tripKeyID, step, driver, driverToken, nonce)` | drops the job from the outbox (`done(false)`), various `refused()` messages depending on `reason` | 20s soft-timeout + real network failure both funnel into the retry/abandon logic of §4 |
| `driverSetLocationState` | `reportGeoState()` (whenever `geoState` changes) | `(driver, geoState, driverToken)` | no-op | resets `geoReported = ""` so it will be retried on the next state check |
| `driverDriveFromLocation` | `tryGps()` (on grant + every 120s while a hero trip exists) | `(tripKeyID, lat, lng, driver, driverToken)` | if `r.ok && r.key` matches the current hero trip, caches `gpsDrive = {key, min, at}` (fresh for 5 minutes, see `driveFor`) and re-renders the hero | silently ignored |
| `driverRequestCode` | `askForCode(name)` (picker tap, and the "Send a new code" resend button) | `(name)` | `gotCodeRequest(r)` — see §1.3/§2.2 for the full branch table | shows a generic "Could not reach the office. Check your signal and try again." error and re-enables the form |
| `driverVerifyCode` | `vfySubmit()` (auto-fires at 6 digits, or Enter, or the Verify button) | `(name, code)` | `gotVerify(r)` — on success stores driver+token and calls `startApp()`; on failure shows the specific `wrong`/`locked`/`expired`/unknown-name branch | generic "Could not reach the office..." error |

**Not called from the client at all** (server-only / dispatcher-only / internal helpers): `getDriverGeoStates` (feeds the *dispatcher* view, not this app), `refreshDriverStaffRoster` (manual ops tool), `driverAssignmentAlert_`/`driverCancelAlert_` (invoked by the dispatcher-side trip-save code path, not shown in these two files, to fire the SMS/email alerts described in §9).

### 8.2 Server functions, in detail

**`serveDriverApp_(e)`** — entry point for `doGet?page=driver`. Builds `driverAppBootstrap()`, JSON-stringifies it with `<`/`>`/U+2028/U+2029 escaped (so a dispatcher-typed note containing `</script>` can't break out of the inline `<script>` block — see comment quoted in §10), and serves the templated HTML with a `viewport-fit=cover, initial-scale=1` meta tag (no `maximum-scale=1`, deliberately, so pinch-zoom works — a v120 fix).

**`driverAppBootstrap()`** — no args. Returns `{email, driver, roster, links, noShowWaitMinutes, day?}`. If Google-email identification succeeded, it also eagerly computes `day = getDriverDayPayload(name, 'today', '', true)` (the `true` = `skipDrive`, so the external Maps API call is skipped for the very first paint) so the page ships with today's trips already embedded — no network round-trip needed before first render. Comment: "the page already knows who is opening it, so it can carry their day down with it... The usual refresh still runs straight afterwards and replaces this."

**`getDriverDayPayload(driverName, which, token, skipDrive)`** — the main day-load.
- Resolves identity the same way the gate does (Google email wins if present).
- No identity → `{ok:false, reason:'unknown', email}`.
- `driverAccessProblem_` fails → `{ok:false, reason:<'unknown'|'verify'>, driver, email, build}`.
- Computes `key = driverDateKey_(which==='tomorrow' ? 1 : 0)` and pulls `tripManager.getTripsByDate(key)`.
- Filters to trips where `driverMatches_(tp.driver, name)`, maps each through `driverTripView_` (a fixed field whitelist — the exact shape sent to the client, see below), sorts by `driverTimeSortKey_`.
- For **today only**, overlays each trip's `startTime` from `driverStartTimes_()` (a separate, more-frequently-changing read of the `DISPATCH` sheet's start-time column) and — unless `skipDrive` — calls `driverAttachDrive_` to compute the next trip's estimated drive time.
- Returns `{ok:true, driver, dateKey, which, trips, serverNow: Date.now(), serverClock: driverServerClock_(), build}`.
- **`driverTripView_(tp)` — the exact wire shape**: `key, time, passenger, phone, transport, pickup, dropoff, notes, pickupNotes, dropoffNotes, status, dispatchStatus, pickupArrival, pickupDeparture, dropoffArrival, dropoffDeparture`. Nothing else from the underlying trip record (e.g. billing/insurance fields) ever reaches the driver's phone.

**`getBoardVersion()`** — referenced but its body is not in these two files (must live in the shared dispatcher/board module); treated by the client as an opaque string, compared for equality only, used purely to shortcut the 15-second poll to something faster when a change is detected.

**`driverSetTripStep(tripKeyID, step, driverName, token, nonce)`** — see §3/§5 for full behavior. Sets a module-global `DRIVER_TAP_IN_PROGRESS_ = true` for the duration of the whole call (including no-show/cancel), specifically so that an unrelated, expensive background job (a "120-day statistics rebuild," referenced but defined elsewhere) can check this flag and never start while a driver's phone is waiting on a response. Comment: "set for the whole tap, including no-show and cancel, so a 120-day statistics rebuild can never start with a driver's phone waiting on it."

**`driverRunningLate(tripKeyID, reason, driverName, token)`** — see §9 for full text/behavior. Sanitizes the reason to `[A-Za-z0-9 ,.:()-]`, truncated to 120 chars. If the reason contains an auto-generated `"... Auto - ETA in <N> min"` (or a manual `"... - ETA in <N> min"`) suffix, it strips that text out of the note and instead computes the office's own clock-derived ETA string (`Utilities.formatDate(new Date(Date.now()+N*60000), tz, 'h:mm a')`) — i.e. **the driver's phone never gets to write a finished clock time into the permanent note; it only ever sends a relative offset, and the office's own trusted clock turns that into an absolute time.** Writes into two places: the `DISPATCH` sheet's `NOTES` cell (append, deduped — skipped if a `DRIVER RUNNING LATE` entry is already there) and the trip log's `notes` field via `tripManager.updateTripInLog`, both under `withTripsDocumentLock_`. Always returns `{ok:true, note: stampText}` (no independent failure path once the gate passes) — this is why the client's auto-late toast wording (§9) has to be inferred from whether the call round-tripped at all, not from an `ok:false`.

**`driverSetLocationState(driverName, state, token)`** — validates `state` is one of `granted|denied|prompt|unsupported`. Identity resolution here has its own hardened variant: prefers the live Google-session identity; only falls back to gate-checking the client-claimed name+token if there's no Google identity; and — critically — if the roster read inside that fallback *throws*, it does **not** silently continue with the client-supplied name (which the code explicitly calls out as a previously-real hole):
> "V120: every other driver endpoint goes through the gate; this one took the name straight off the request, so anyone with the page's address could set any driver's location state." ... "this catch used to swallow the failure and carry on with the name the request supplied - so the check it was added for did not actually hold when the roster read was the thing that failed."
Writes into `PropertiesService` under `driver-app:geo`, a name→`{s, t}` map, pruning entries older than `DRIVER_GEO_KEEP_MS_` (7 days) on every write, under a 5-second `LockService` lock (best-effort — failure to acquire is swallowed, not surfaced).

**`getDriverGeoStates()`** — dispatcher-facing (not called by this client). Returns only the "worth flagging" states (`denied`, `unsupported`, `prompt`) for entries fresher than `DRIVER_GEO_FRESH_MS_` (3 hours); a `granted` state, or anything stale, is simply omitted from the result.

**`driverDriveFromLocation(tripKeyID, lat, lng, driverName, token)`** — gated exactly like a step tap. Looks up today's trip by key, requires it to have a `pickup` address, calls `driverDriveMinutes_({lat,lng}, pickup)` (Google Maps `DirectionFinder`, driving mode; results cached 600 seconds under an MD5'd `origin|dest` key, `'x'` sentinel cached for "no route found" so a bad address doesn't get re-queried every call). Returns `{ok, key, min, fromLabel:'your location', approx:false}`.

**`driverRequestCode` / `driverVerifyCode`** — fully covered in §1.3.

### 8.3 Locking summary

Every write that touches the shared `DISPATCH` sheet or the trip log goes through `withTripsDocumentLock_(fn)` (the same lock the dispatcher board uses) — this is what makes the row-lookup+row-write atomic against a concurrent dispatcher re-sort (§10, "board re-sort" bug), and what makes the rank-check-then-write in §5.2 safe against a concurrent tap. A failure to acquire the lock (`waitLock` throwing) is surfaced to the driver as a retryable `{ok:false, reason:'record', message:'The board was busy. This will be sent again.'}` rather than swallowed. Location-state writes use a separate, lighter `LockService.getScriptLock()` with only a 5-second wait and no propagated failure (best-effort).

---

## 9. Notifications / alerts to drivers

### 9.1 Triggers

All alert sending funnels through **`sendDriverText_(driverName, message, subject)`**, which is invoked from the dispatcher-side trip-editing code (not present in these two files, but its call sites are named): `driverAssignmentAlert_` and `driverCancelAlert_`. Documented triggers:

1. **New trip assigned to a driver** — "NEW TRIP for you: `<when>` - `<passenger>`, from `<pickup>`." Fires immediately, bypassing the quiet window (§9.3), because a hand-off is time-sensitive.
2. **Trip taken away from a driver** (reassigned to someone else) — "Trip removed from you: `<when>` - `<passenger>`, from `<pickup>`." Sent to the *previous* driver, alongside the "new trip" text to the new one, both immediate.
3. **Pickup time changed** — "TIME CHANGED. Now `<when>` - `<passenger>`, from `<pickup>`." Subject to the quiet window.
4. **Any other tracked field changed, today's trips only** — "TRIP UPDATED today: `<when>` - `<passenger>`, from `<pickup>`." The tracked field list is `DRIVER_ALERT_FIELDS_ = ['time','startTime','passenger','pickup','dropoff','transport','vehicle','notes','pickupNotes','dropoffNotes','dispatchStatus']`; a change to anything outside this list (e.g. billing/insurance data) sends nothing. Only fires for **today's** trips — a non-time, non-reassignment edit to *tomorrow's* schedule is deliberately quiet (comment: "Today only: tomorrow keeps the older, quieter behaviour of only calling out a hand-off or a moved time."). Subject to the quiet window.
5. **Trip canceled / no-showed / reassigned** (`driverCancelAlert_`, driven by a status change to CANCEL/NO SHOW/REASSIGN) — "Trip `<CANCELED|REASSIGNED|NO SHOW>`: `<when>` - `<passenger>`." Has its **own** dedicated throttle key (`cancel:<tripKey>:<status>`) separate from the general quiet window, specifically to stop a retried/duplicate status write from texting a second cancellation — comment: "a second line of defence behind the re-send guard."
6. **Sign-in code** (`driverRequestCode`) — "`<code>` is your Amazing Grace sign-in code" (email) / "AMAZING GRACE: `<code>` is your sign-in code. It expires in 10 minutes. If this was not you, ignore this message." (text). Not throttled by the quiet window (has its own 60-second resend cooldown, §1.3).
7. **Driver-initiated "running late"** — this is the *driver notifying dispatch*, the reverse direction (§2.9); it writes into the dispatch note, it does not itself send a text/email back to the driver.

### 9.2 What the text says (format rules)

- Every text/email is prefixed `"AMAZING GRACE: "` for the SMS/gateway body.
- The "when" clause is built by `driverAlertWhen_`: `"<day> at <time>"`, e.g. **"Sun, Sep 6 at 5:30 PM"** — day via `driverPrettyDate_` (`EEE, MMM d`), time via `driverClock_` (handles the 1899-epoch, bare `HH:mm`, `h:mm AM/PM` string, and native `Date` input shapes, always output as `h:mm a`).
- Deliberately **plain hyphens, no smart punctuation** in the detail string ("`<when>` - `<passenger>`, from `<pickup>`") — comment: "carrier text gateways mangle anything fancier."
- **The link is email-only.** The text/SMS body never contains the link at all: `driverTextOnly_` strips any line matching `/^\s*Open your Driver App:/i` and any raw URL, then ensures the message ends with "Check your Driver App." if it doesn't already. Documented reason, quoted:
  > "V101: the TEXT never carries a link. Carrier gateways treat a message with a web address - a shortened one above all - as spam, and once they flag the sender they drop everything from it for a while. Texts arrived on Thursday 3 Sep with no link in them and stopped the evening the links began. The email keeps the link; the text ends the way Thursday's did."
- The link, when present (in the email body), is `DRIVER_APP_LINK_ = 'https://shorturl.at/978LK'` — a short link maintained by the office, distinct from the actual Apps Script web-app URL (`DRIVER_APP_LINK_LONG_`, kept in a constant purely as documentation of what the short link should be forwarding to). Explicit maintenance warning:
  > "NOTE: if the web app is ever republished to a NEW deployment id, this link must be updated to match, or the text will point at the old one."

### 9.3 Quiet hours / throttling

- **`DRIVER_ALERT_QUIET_SEC_ = 600`** (10 minutes) — the general per-trip-per-driver quiet window, enforced by `driverAlertThrottled_` (a `CacheService` key `dalert:<tripKey>:<normDriverName>` that self-expires; presence = "already told recently," and setting it doubles as the marker for next time). Purpose, from the header comment:
  > "A driver already gets a text when a trip lands on them or the time moves. Now anything else that changes their day sends one too, and today's texts carry a link straight back into the Driver App. The quiet window stops a dispatcher correcting three fields in a row from buzzing the same phone three times; a trip changing hands always gets through at once."
- **New-trip and hand-off-away alerts bypass the quiet window entirely** (checked first, unconditionally sent).
- **Time-changed and generic field-changed alerts are throttled** by the general window.
- **Cancel/no-show/reassign alerts have a second, separate throttle** keyed specifically to `cancel:<tripKey>:<status>` (distinct cache key from the general one), so a cancellation can't be suppressed by an unrelated recent "trip updated" text, but also can't be duplicated by a retried write of the same cancellation.
- There is no explicit clock-based "quiet hours" (e.g. no texts between 10pm–6am) anywhere in either file — "quiet" here refers only to per-trip de-duplication within a rolling time window, not time-of-day suppression. **Rebuild note:** if the business actually wants night-time suppression, that does not exist today and must be added net-new.

### 9.4 Delivery mechanism

- **Two parallel channels, "true if at least one went":** `sendDriverText_` tries a carrier SMS gateway email (`sendDriverGatewayText_`, via `MailApp.sendEmail` to a carrier-specific address built by `getSmsEmail(phone, carrier)`, defined elsewhere) **and** a plain email (`sendDriverEmail_`, straight `MailApp.sendEmail` to the STAFF email column), and returns true if either succeeded. Comment on why both exist:
  > "V97: the code goes out by EMAIL (column E on STAFF) and, as a bonus, by text when a carrier is on file too... A driver with neither an email nor a carrier cannot be sent a code and is told to ask dispatch — deliberately, so nobody slips through unverified." And later: "The free carrier gateways are mostly switched off now... an alert that only went out as a text was reaching almost nobody. Every alert now also goes to the driver's email on STAFF."
- **No push notifications, no native SMS API** — everything is `MailApp.sendEmail`, either straight to the driver's inbox or to a carrier's email-to-SMS gateway address. **Spreadsheet/Apps-Script artefact** (see §10) — a rebuild outside Apps Script would presumably want a real SMS provider (Twilio etc.) rather than carrier email gateways, which the comments themselves note are being switched off one by one ("AT&T and T-Mobile are already gone, Verizon is winding down").
- The alert **subject line** for a generic message is auto-derived (`driverAlertSubject_`): first line of the message, `AMAZING GRACE:` prefix stripped if present, truncated at the first `.`/`!` or 70 characters (with `...`), re-prefixed `"Amazing Grace: "`.

---

## 10. Spreadsheet artefacts — mark "drop in a rebuild"

Each item below only makes sense, or takes the shape it does, because the backend of record is a Google Sheet manipulated through Apps Script's `SpreadsheetApp`/`CacheService`/`PropertiesService`/`LockService` APIs. A rebuild on a normal database + app server should replace these with the obvious equivalent (a real datetime column, a real queue/lock, a real session store, a real feature flag) rather than porting the workaround itself.

1. **The 1899-epoch time serialization in `stampMs`.** `"1899-12-30T13:19:00.000Z"` is a Google Sheets artefact: a cell formatted/typed as TIME-only, with no date component, serializes through certain Apps Script read paths as "days since Sheets' epoch (Dec 30 1899) plus a time-of-day," and a pure time value collapses to day zero. The client has to specifically detect the string prefix `"1899-"` and reinterpret only the `HH:mm` portion onto today's date. **Drop in a rebuild:** a real backend should never produce a bare time value shaped like a date; store trip stamps as proper timestamps or `HH:mm` strings, not disguised epoch dates.

2. **`driverTimeSortKey_LEGACY_UNUSED_`.** Left in the file (unused, as its name says) purely as a record of a previous, broken sort-key scheme, which mixed "a negative 1899 epoch for one trip, a positive 2026 epoch for another, plain minutes for a third" (per the comment on the function that replaced it). This is dead code that exists only because a spreadsheet cell's type is not guaranteed consistent — drop entirely; a rebuilt schema would have one canonical time representation and never need this kind of defensive parsing at all.

3. **`driverServerClock_` / the zoneless-ISO stamp shape.** The entire clock-correction scheme (§6) exists because Apps Script's `Utilities.formatDate` most naturally emits a zoneless local-time string, and the spreadsheet has its own configured timezone (`getSpreadsheetTimeZone()`) that may differ from both the server's execution timezone and the driver's phone's OS timezone. A rebuild with a real database can simply store and transmit real UTC instants (ISO-8601 with `Z`) everywhere and eliminate `clkZone`/`clkFix` entirely; only `clkSkew` (correcting for a genuinely wrong device clock) would still be worth keeping, and even that is a minor UX nicety rather than a structural necessity.

4. **`driverFindDispatchRow_` — linear row scan for a trip key.** Every write path re-locates the trip's row by reading the entire `TRIP_KEY_ID` column and scanning for a string match (`getDisplayValues()` over the whole column). This is a spreadsheet-shaped substitute for "look up by primary key," done under a lock specifically because a concurrent board re-sort can move rows out from under an unlocked scan (the "misplaced driver status" bug referenced in a comment: writing "under no lock held, so a board re-sort finishing in between could move the rows and put this driver's arrival stamp on a different passenger's line"). **Drop in a rebuild:** an indexed lookup by primary key makes this entire class of bug (and the lock discipline required to avoid it) unnecessary.

5. **`snapshotDispatchToLog(false, true)`** called after (almost) every successful board write — re-deriving two "board-computed columns" by re-running a snapshot/rebuild step, because the sheet keeps some derived data that a plain cell write doesn't automatically refresh. A relational rebuild would compute derived fields (or a view) on read, not re-snapshot the whole board after every write; the comment about this being reduced from "the full board rebuild... run on EVERY tap — 192 times on a busy morning" is itself an artefact of how expensive a full-sheet operation is in this backend.

6. **`CacheService`/`PropertiesService` used as ad hoc small databases.** The roster cache, the links cache, the driver-start-times cache, the geo-state map, the trusted-device-token map, the sign-in code and resend throttles, and the idempotency-nonce store are all `CacheService`/`PropertiesService` entries — Apps Script's only lightweight persistence primitives, each with awkward constraints that shape the code around them (250-char cache keys forcing the MD5-hashed nonce key in §5.1; 6-hour max TTL "the longest the cache accepts" forcing the nonce-remember window; `PropertiesService`'s single-blob-per-key nature forcing the whole trusted-device map to be read/mutated/rewritten atomically on every sign-in). **Drop in a rebuild:** these become straightforward rows in a real datastore (a `sessions`/`device_tokens` table, a `verification_codes` table with a TTL/expiry column, a `dedup_keys`/`idempotency_keys` table, a `driver_geo_state` table) with none of the size/TTL contortions.

7. **`withTripsDocumentLock_` / `LockService.getScriptLock()`.** Apps Script has no real transactions; every multi-step read-modify-write against the sheet has to be wrapped in an explicit script-wide lock, and a failure to acquire it (the sheet is "busy") is a normal, expected, user-visible outcome (`reason:'record'`, "The board was busy. This will be sent again."). A rebuild on a real database gets row-level transactions/optimistic-concurrency for free and would not need to surface "the board was busy" as a retryable failure mode to the end user at all.

8. **`SpreadsheetApp.flush()`** calls after writes — forces pending sheet changes to commit before the lock is released or before a dependent read; a real database's transaction commit makes this a non-issue.

9. **The `<`/`>`/U+2028/U+2029 escaping of the bootstrap JSON** (`serveDriverApp_`) is a workaround for embedding JSON inside an inline `<script>` tag in server-rendered HTML (`<?!= bootstrap ?>` — an Apps Script `HtmlService` templating directive) — a "note contains `</script>`" injection risk specific to this string-templating-into-HTML approach. A rebuild that fetches the day's trips via a JSON API call (rather than server-templating them into the page's own script block) sidesteps this category of bug entirely.

10. **The 15-second poll + 4-second `getBoardVersion` "cheap cache read" + `boardVersionSeen` diffing scheme** (§7.4/§8) is a polling substitute for a real push/subscription mechanism, shaped the way it is because Apps Script `doGet`/`google.script.run` has no server-push or websocket capability. A rebuild with a normal backend could replace the whole poll-plus-cheap-version-check apparatus with a websocket or SSE push on trip changes, eliminating both intervals and `getBoardVersion` entirely.

11. **Carrier-email SMS gateways (`getSmsEmail`) as the "text" delivery channel** (§9.4) — an artefact of not having a real SMS API available from Apps Script's built-in services; `MailApp.sendEmail` to `<number>@<carrier-gateway-domain>` is a well-known but fragile workaround, and the comments themselves document that most carriers have already turned theirs off. **Drop in a rebuild:** use a real SMS provider (Twilio, etc.) as the primary channel instead of treating email as the reliable path and SMS-via-email-gateway as a "bonus."

12. **`DRIVER_APP_LINK_` vs. `DRIVER_APP_LINK_LONG_`** — the two-URL scheme (a maintained short link, plus a constant that documents the underlying Apps Script web-app deployment URL it should point to, with an explicit comment warning that redeploying to a new deployment ID silently breaks every previously-sent text/email until the short link is manually repointed) is a workaround for Apps Script web-app deployments not having a stable URL across republishes. A rebuild with a normal hosted app has one stable URL and this entire dual-constant/manual-repoint hazard disappears.

13. **The `APP_BUILD` / `DRIVER_APP_BUILD_` matching + client self-reload** (`maybeReloadForBuild`) is a workaround for Apps Script serving whatever HTML template was last saved with no client-side build/version negotiation of its own; the client detects a mismatch against the number the server just sent and does a single self-`location.reload()` (rate-limited via `sessionStorage["ag-reloaded"]`, and deliberately deferred while a write is in flight or the outbox hasn't drained within 5 minutes — see the two stacked comments in `maybeReloadForBuild`). A rebuild with normal static-asset versioning/cache-busting or a service-worker update flow would not need this hand-rolled scheme at all.

---

## Appendix A — Key constants (verbatim values)

| Constant | Value | File |
|---|---|---|
| `APP_BUILD` / `DRIVER_APP_BUILD_` | 120 | both (must match) |
| `NOSHOW_MIN` / `DRIVER_NOSHOW_WAIT_MIN_` | 10 (minutes) | both |
| `LEAVE_BUFFER_MIN` / `DRIVER_LEAVE_BUFFER_MIN_` | 10 (minutes) | both |
| `AUTO_LATE_MIN` | 10 (minutes late before auto-notifying dispatch) | HTML |
| `WAIT_SHOW_MIN` | 5 (minutes before a wait timer appears at all) | HTML |
| `WAIT_MAX_LIVE_MS` | 12 hours | HTML |
| amber / red wait thresholds | 10 / 20 minutes | HTML (`waitLevel`) |
| `LOCAL_STAGE_MS` | 90,000 ms (90 s) | HTML |
| undo countdown | 6 seconds | HTML |
| tap debounce | 1200 ms | HTML |
| `OUTBOX_MAX_TRIES` | 6 | HTML |
| outbox RPC soft-timeout | 20,000 ms | HTML |
| outbox drain interval | 10,000 ms | HTML |
| `inflight` giveup window | 10 minutes | HTML |
| day-payload poll interval | 15,000 ms | HTML |
| board-version poll interval | 4,000 ms | HTML |
| wait-UI tick interval | 1,000 ms | HTML |
| hero ETA redraw interval | 30,000 ms | HTML |
| GPS drive-time refresh interval | 120,000 ms | HTML |
| GPS drive-time freshness | 5 minutes | HTML (`driveFor`) |
| `DRIVER_CODE_TTL_SEC_` | 600 s (10 min) | GS |
| `DRIVER_CODE_MAX_TRIES_` | 5 | GS |
| `DRIVER_CODE_RESEND_SEC_` | 60 s | GS |
| `DRIVER_TRUST_MAX_PER_DRIVER_` | 8 tokens | GS |
| roster cache TTL | 900 s (15 min) | GS |
| links cache TTL | 3600 s (1 hr) | GS |
| driver-start-times cache TTL | 60 s | GS |
| nonce claim TTL | 400 s | GS |
| nonce remember TTL | 21,600 s (6 hr, cache max) | GS |
| `DRIVER_ALERT_QUIET_SEC_` | 600 s (10 min) | GS |
| drive-time (Maps) cache TTL | 600 s | GS |
| `DRIVER_GEO_FRESH_MS_` | 3 hours | GS |
| `DRIVER_GEO_KEEP_MS_` | 7 days | GS |
| `DRIVER_BASE_ADDRESS_` | `53 Violet Ave, Poughkeepsie, NY 12601` | GS |
| `DRIVER_APP_LINK_` | `https://shorturl.at/978LK` | GS |
| `DRIVER_STAFF_ID_` | `1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE` | GS |
| `DRIVER_SHEET_ID_` | `13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA` | GS |

## Appendix B — Status/pill vocabulary

Raw `status` values (stage-ordered): `""`, `IN ROUTE`, `PICKUP LOCATION`, `INTRANSIT`, `DROPOFF LOCATION`, `COMPLETE`.
Raw `dispatchStatus` override values: `CANCEL`/`CANCELED`/`CANCELLED` → "Canceled"; `NOSHOW`/`NO SHOW` → "No Show"; `REASSIGN` → "Reassigned"; `NOTCONFIRMED`/`NOT CONFIRMED` → "Not Confirmed"; `READY` / `WAITING` (pre-stage, no override) → "Ready" / "Waiting" pills, only shown when stage is 0 and there is no override.
Displayed pill text, in priority order (overrides beat stage beats pre-state beats the default "Scheduled"): Canceled, No Show, Reassign, Not Confirmed, Complete, Arrived, In Transit, Pickup In, In Route, Ready, Waiting, Scheduled.
