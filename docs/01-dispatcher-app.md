# Amazing Grace Mobile Transport — Dispatcher "Trips" Page

Functional specification reverse-engineered from `TripsPage.html` (11,909 lines), a single Google Apps Script HTML file. Goal: enough detail to rebuild the screen outside Apps Script without opening the original.

## 0. How this file fits into the larger system

This is **one HTML-service page** inside a larger Apps Script project. It is not self-contained:

- `<?!= include('TripStyles') ?>` (line 17) — a second, external stylesheet partial. Its contents are not in this file and are undocumented here.
- `<?!= include('loading') ?>` (line 3107) — an external partial injected right after `<body>`. It almost certainly defines `#loading-overlay` (referenced by `pageLoader()` at line 3866 but never defined in this file) and the **toast** UI: `showToast(message, type)` is called 56 times in this file but is **never defined** in it — it must live in this include.
- Server-rendered template variables (Apps Script `doGet` scriptlets), evaluated once at page load, become `const`/`let` bindings at the top of the inline `<script>` (line ~3426):
  - `initialDate` — the date the page should open on (`<?!= JSON.stringify(initialDate) ?>`).
  - `flashMessage` — a one-shot toast message to show on load (`<?!= JSON.stringify(flash) ?>`).
  - `injectedTrips` — the day's trips already embedded in the HTML response (`<?!= initialTrips || '[]' ?>`), so the first paint needs no round trip.
  - `tripDatesInfo` — `{dates:[...], firstDate:"..."}`, used to grey out/disable calendar days before the earliest trip on file.
  - `initialSubmitted` — whether `initialDate` is already a locked/submitted day.
  - This is classic Apps Script server-side templating: the server pre-renders JSON into the page rather than the client always fetching on load. A rebuild would replace this with a normal initial API call (or SSR of the same JSON), but should preserve the *behavior*: first paint has data already, then a lightweight "has anything changed" check runs ~1.5s later instead of a full reload (see §7, V120 SPEED note on `injectedTrips`).
- All server communication is Google Apps Script's `google.script.run` RPC bridge (see §5) — there is no REST/fetch API of its own, except one direct `fetch()` call to a third-party geocoder (Photon/Komoot) for address autocomplete (§3.6).
- The backing store is implied throughout to be a Google Sheet with named tabs: `LOG` (the historical/per-trip record, addressed by fixed column positions — see `EP_LOG_COL`, §8), `DISPATCH` (a bounded-capacity working tab drivers' phones read from), `PASSENGERS` (the passenger directory). None of these are visible in this file; only the client's assumptions about them are.

---

## 1. Screens, panels, and modals

Every screen in this SPA is a `<div>` toggled between `hidden`/visible (or `.classList` add/remove `hidden`/`open`) — there is no client-side router; panels stack visually as full-screen "pages" (`.edit-panel`) or bottom sheets (`.sh` / `ep-sheet-backdrop` pattern). Two helpers drive the full-screen ones: `shShowPanel(id)` / `shHidePanel(id, done)` (both add a `sh-anim`/`sh-off` transition class, line ~8395).

### 1.1 Main board (no wrapper id — the page body itself)
- **Purpose:** the dispatcher's home screen — the day's trips.
- **Key elements:** `<header>` (title "Trips" + `#trip-actions-btn` ellipsis menu), `#ns-entry` (Needs Scheduling banner, hidden when empty), `#date-picker-row` (date field + calendar), `.trip-search-container` (`#trip-search`), `#trip-summary`/`#last-updated`/`#refresh-btn`, `#tripList` (the actual scrollable card list), `#fab-add` (floating **+** button, bottom-right, `z-index:1500`).
- **Opens:** it *is* the app; nothing "opens" it. Loaded via `loadTrips(date)` on `DOMContentLoaded`, or immediately from `injectedTrips` if the server pre-supplied them.
- **Closes:** never; other panels stack on top of it (`z-index` 2000+) and it is revealed again when they close.

### 1.2 Header "Trip actions" sheet — `#dropdownMenu`
- **Opens:** tap `#trip-actions-btn` (the `⋯` icon) → `toggleMenu()`.
- **Closes:** `closeTripMenu()`; tapping the scrim; any outer document click not inside `.premium-menu-btn, .search-filter-btn, .dropdown, .ep-sheet-backdrop`; Escape is *not* wired for this one specifically (only for `#ep-menu`, see §1.6).
- **Contents (3 rows, per V115 comment "Add trip" was deliberately removed from here):**
  - **Passengers** → `openPassengersPanel()` (§1.9)
  - **Pricing** → `pzOpenSettings()` (§1.10)
  - **Submit** → `openSubmitConfirm()` (§1.4)

### 1.3 Group-trips sheet — `#filterMenu`
- **Opens:** tap the sliders icon `#search-filter-btn` next to search → `toggleFilterMenu()`.
- **Closes:** `closeFilterMenu()`, outside click, or picking an option.
- **Contents:** radio-like buttons **Time / Driver / Status / Transport** (`data-filter` = `time|driver|status|transport`) → `applyFilter(type)`. The active one gets a checkmark (`.fm-tick`) and the button. Persisted to `localStorage['tripsFilter']` (the **only** localStorage key in the whole app).

### 1.4 Snapshot / Submit modals
- `#snapshot-modal` — "How would you like to sync today's trip data?" **Full / Partial / Cancel**. Opened by `showSnapshotConfirm()`, itself only called by `importTrips()`. **Dead code**: nothing in the current UI calls `importTrips()` or `exportTrips()` — see §8.
- `#submit-modal` — the real, reachable end-of-day action. Opens via `openSubmitConfirm()` (from the header menu's **Submit** row). Text: "Submit N trips for MM/DD/YYYY?" Refuses to open unless the board's date is *today* (toast: "⚠️ Submit runs on TODAY's DISPATCH. Switch the date to today first."). If any Needs-Scheduling items target today with no time, the modal grows a warning row (`#submit-tbd-note`) and a third button `#submit-fix-btn` ("Go fix it") that jumps to Needs Scheduling instead. Confirm → `doSubmitTrips()` → `submitTripsFromSidebar()` (server). Text on the confirm button: "This runs the full submit for today's DISPATCH (snapshot, transfer, sort, then clear). This can't be undone." — a spreadsheet-shaped, one-way day-end batch job (§8).

### 1.5 Save/progress overlay — `#save-overlay`
- Not a "screen" a user opens, but a full-screen blocking overlay shown during any multi-step server operation (save trip, delete trip, delete passenger, pricing checks). Two faces:
  - `#save-progress` — a title (`#save-card-title`) plus a vertical list of named stages (`showSaveOverlay(title, stagesArray)`), each with a spinner → checkmark as `setSaveStage(i)` advances it.
  - `#save-celebrate` — a big animated checkmark + label, used for terminal "done" states (`celebrateOverlay(label, color, cb)`), e.g. deletes.
- Auto-dismisses itself (`completeSaveOverlay`/`hideSaveOverlay`).

### 1.6 Add/Edit Trip panel — `#edit-panel`
The single most important screen: one form services **Add**, **Edit**, **Copy**, **Schedule-from-Needs-Scheduling**, and (mounted inline) **edit-from-Trip-Details**.
- **Opens:**
  - `openTripForm()` → `openAddPanel()` — blank form, "Add Trip" (from the **+** FAB).
  - `editTrip(id, date, tripKeyID)` → `openEditPanel(trip)` — from tapping a card's pencil/edit affordances.
  - `epDuplicateTrip()` — pre-filled copy with date/driver/progress-times deliberately blanked.
  - `nsSchedule(id)` / `nsEdit(id)` — from Needs Scheduling.
  - Mounted **inside** `#tv-panel` (Trip Details) via `tvMountEditor_()` when editing from there — the *same* DOM nodes (`.ep-body`, `#ep-save`) are physically moved into `#tv-edit-host` and back (`tvUnmountEditor_()`), not duplicated.
- **Closes:** `closeEditPanel()` — routes back to wherever it was opened from via `epReturnTo` (`''`=board, `'ns'`, `'ps'`, `'pt'`, `'tv'`).
- **Header:** `#ep-back` ("← Back"), centered `#ep-title` (text changes per mode: "Add Trip" / "Edit Trip" / "View Trip" (locked day) / "New Trip · copy" / "Needs Scheduling" / "Schedule Trip"), `#ep-menu-btn` (`⋮`) opening `#ep-menu` sheet with **Trip details** / **Copy to a new trip** / **Delete trip** (each individually hidden via `epSyncMenu()` when locked/add-mode).
- **Full field list:** see §2.1.
- **Footer:** `#ep-save` button, label swaps ("💾 Save Trip" / "➕ Add Trip" / "🕓 Save to Needs Scheduling"), disabled until `epRequiredFieldsValid()` AND (in edit mode) the form actually differs from its loaded snapshot (`epFormSnapshot()`).

### 1.7 Delete-trip modals (children of the edit panel)
- `#ep-delete-modal` — for a **standing-order** trip: lists every date in the order (`epDecodeDatePattern`) as checkboxes (all pre-checked), "Delete selected dates" → `epConfirmDeleteSelected()` → `deleteRecurringTripsFromSidebar`.
- `#ep-confirm-delete-modal` — for a normal (or a standing-order trip with a corrupt/absent pattern) trip: "Delete {passenger}'s {time} trip?", plus, if a linked return/outbound leg exists, an inline **"Also delete the linked trip(s)"** checklist (`#ep-linked-list`, pre-checked) built by `epShowPlainDeleteConfirm()`. Confirm → `epDoDelete()`, which does **not** call the server immediately — it stages a 5-second client-side undo window first (§4.4).

### 1.8 Passenger-flag / blacklist modals
- `#flag-modal` — opened from the pencil-shaped 🏳 icon (`#ep-flag-btn`) beside the Passenger field, only visible once the typed name matches a known profile. "Flag passenger" (reason required, ≥3 chars) or "Remove flag" (no reason box). → `setPassengerBlacklist(name, turnOn, reason)`.
- `#bl-modal` — the **hard stop** shown when trying to save/add a trip for an already-blacklisted passenger. Shows the blacklist reason; requires typing the passenger's **last name** exactly (case-insensitive) to enable "Proceed" (`blConfirmClicked()`), which re-runs the save with an override flag.

### 1.9 Passengers directory — `#pp-panel`
- **Opens:** `openPassengersPanel()` (header menu → Passengers, or the FAB inside the panel itself for a *new* passenger).
- **Closes:** `closePassengersPanel()` — if it was opened via "View passenger details" from the edit panel (`epPassReturn`), it returns to the edit panel instead of the board.
- **Contents:** `#pp-search` (search across name/phone/Medicaid/type/addresses/blacklist reason), `#pp-select-btn` (enter multi-select mode), `#pp-summary` (count), `#pp-list` (rows built by `ppRowHtml`, each showing name, subtitle `type · phone · Medicaid`, a red **Blacklisted** pill if flagged, chevron), `#pp-fab` (+, adds a passenger).
- **Row interaction:** tap → opens `#ps-sheet` for that name (§1.9.1). **Long-press** (480ms, `ppPressStart`/`ppPressMove`/`ppPressEnd`) or the header **Select** button enters multi-select mode (`ppSelectMode`), showing checkmarks and a bottom bar `#pp-selbar` with a live count and a **Delete N** button.

#### 1.9.1 Passenger detail sheet — `#ps-sheet`
- A bottom sheet, two modes:
  - **View** (`ppSheetView()`): read-only fields (Phone numbers, Medicaid #, Transport type, Addresses, and if blacklisted: reason + who flagged it) plus a **Passenger trips** button (disabled "Checking trips…" until `getPassengerTripHistory` answers, then either "No trips on record" (disabled) or a count badge) and a **+** to add a trip for this passenger.
  - **Edit** (`ppSheetEdit()`): the shared `ppEditorHtml()` form (see §2.5) — First/Last name, phone list, Medicaid #, Type, address list, Blacklist checkbox + reason.
- Used identically for **new** passengers via `ppSheetNew()` (title "New passenger", save button reads "Add passenger").
- **Deleting** a passenger: 🗑 icon on the sheet (view mode only) → `ppAskDelete([name])` → `#pd-modal` (see below).

#### 1.9.2 Delete-passenger confirmation — `#pd-modal`
- Asks `getPassengerUpcomingCounts(names)` for how many *today-or-later* trips each selected passenger has, and threatens to delete those trips too (irreversibly, and removed from the DISPATCH board). Past trips are always kept as history. The passenger record itself is "kept for 3 days in case this was a mistake" (soft-delete on the server, not visible in this file).

### 1.10 Private Pay Pricing settings — `#pz-panel`
- **Opens:** `pzOpenSettings()` (header menu → Pricing).
- **Closes:** `pzCloseSettings()`.
- A single long form (`#pz-form`, built by `pzRenderSettings()`) covering: base price by transport type (Ambulatory/Wheelchair/Stretcher/Taxi/Other), mileage (Auto/Optional/Off toggle, included miles, per-mile rate, minimum fare), deadhead mileage, waiting time (grace period, interval, rate), after-hours window, holiday dates (comma list), and a dynamic list of named "rules" (`pzRules`, each Auto/Optional/Off + `$`/`%` amount). Sticky footer `#pz-save-bar` → `pzSaveSettings()` → `savePricingSettings(pzCfg)`, surfacing server-side validation `#pz-problems` on failure. Footer meta line shows config version + last-changed-by.

### 1.11 Private Pay price breakdown sheet — `#pz-sheet`
- **Opens:** tapping the `ⓘ` next to the price on the edit panel (`#ep-price-info` → `pzOpenSheet()`), only when "Private Pay" is checked.
- **Closes:** `pzCloseSheet()`.
- Shows every priced line item with an **Auto**/**Added** tag, a checkbox to drop an automatic line, per-leg subtotals when a return trip is included, a manually-typed **Deadhead miles** input, a list of optional add-ons, and a "Taken off this trip" list of rules the dispatcher removed (each with a "put back" toggle). Every keystroke re-quotes from the server (debounced 550ms) — **the client never computes a price itself**.

### 1.12 Needs Scheduling — `#ns-panel`
- **Opens:** tap `#ns-entry` banner (only visible when items exist) or `#ns-add-btn` (+) inside the panel.
- **Closes:** `closeNeedsScheduling()`.
- A flat list (`#ns-list`) of "pending trips" — bookings taken over the phone before the day/time is known. Each row: a colored chip (`⚠ overdue` / `📅 date only` / `⏰ time only` / `📅·⏰ ready` / `🕓 both unknown`), passenger name + transport badge, route, notes preview, "Added by X, N days ago", a **Schedule** button, and **Chased ✓** / **Remove** actions. Sorted overdue-first, then oldest-first (`nsSorted_`).
- Also injects a **"NEEDS A TIME"** strip (`nsBoardStrip_`) directly onto the board for the selected day, listing that day's not-yet-timed pending trips as clickable pseudo-cards (`.trip-card.tbd`) — tapping one jumps into `nsSchedule`.

### 1.13 Passenger Trips (history) — `#pt-panel`
- **Opens:** from the passenger sheet's "Passenger trips" button → `ppOpenTrips(name)`.
- **Closes:** `closePassengerTripsPanel()` → back to `#ps-sheet` for that passenger.
- Every trip that passenger has ever had (`getPassengerTripHistory`), newest-first, grouped **Upcoming / Today / Earlier**, capped to the 20 most recent unless filtering or "Show all N trips" is tapped. Search box searches the *entire* history, not just what's rendered. A `#pt-filter-btn` opens `#pf-sheet` with three sub-sheets:
  - `#pfd-sheet` — Date: single day (calendar with a dot per day that has a trip) or a From/To range.
  - `#pfv-sheet` — Driver: every driver who has actually driven this passenger, with per-driver trip counts, multi-select.
  - `#pfr-sheet` — Standing orders: "Standing orders only" / "One-off trips only" / a specific named order.
- Tapping a row opens `#tv-panel` (§1.14) rather than editing inline.

### 1.14 Trip Details (read view + inline editor) — `#tv-panel`
- **Opens:** `tvOpen(trip)`, either from `#pt-panel` rows (`ptOpenTrip`) or from the board via the journey sheet's ⓘ / edit-lock icon (`tvOpenFromBoard`). Tracks its own `tvSource` (`'pt'` or `'board'`) so linked-trip lookups know which pool (`ptAll` vs `allTrips`) to search.
- **Closes:** `closeTripView()`.
- **Header:** `#tv-title` "Trip details"; `#tv-actions` holds either a `⋮` menu (editable trip) or a bare copy icon (past/locked trip — "a past trip cannot be edited or deleted, but it can be copied").
- **Menu** (`#tv-menu` sheet): **Edit trip**, **Copy to a new trip**, **Delete trip**.
- **Body** (`#tv-body`, rebuilt by `tvOpen`):
  - Hero card: date/time, passenger + "leaves at HH:MM" (start time), badges (Editable / View only · past trip / Return leg / repeats-with-order-name / current status).
  - Route card: pick-up + drop-off with their stop notes.
  - Grid card: Driver, Vehicle, Transport type, Phone, Medicaid #, Invoice #, Notes.
  - **Driver progress card** (`tvProgressHtml_`): four steps — Arrived at pickup / Passenger on board / Arrived at drop-off / Completed (or a red "Cancelled/No Show/Reassigned" terminal step with its own timestamp) — each with a gap duration ("waited 12 min", "18 min on the road"), plus the two wait-time tiles (`wtTilesHtml_`, §3.5).
  - **Linked leg card** (`tvLinkedHtml_`) — if this trip has a return/outbound pair, a tappable summary row that jumps to it.
  - **Standing order card** (`tvStandingHtml_`) — if part of a repeat, the order's name (editable via `#so-name-modal` → `renameStandingOrder`), a collapsible list of every trip in the order with the current one highlighted.
- **Inline editing** (`tvStartEdit()`): re-fetches that one day fresh from the server (`getTripsPageDelta`) to avoid editing a stale copy, then physically re-parents the Add/Edit form's body and save button into `#tv-edit-host` (`tvMountEditor_`) — same form, same validation, same standing-order-spread question, just relocated. A note explains why: "Name, phone and Medicaid # belong to the passenger, so they are changed on **their own page**" — those fields are visually disabled here (`tv-locked-out` class via `tvLockPassengerFields_`).

### 1.15 Trip Journey sheet (from the board card) — dynamically created, no persistent DOM id
- **Opens:** `openJourneyDetails(trip)`, reached from the edit panel's `#ep-details` menu item ("Trip details"), or the board card's expanded activity panel's ⓘ icon.
- A bottom sheet with 3 swipeable/tappable tabs — **Trip**, **Passenger**, **Driver** — each showing a compact summary with an optional "Full details" expand toggle. Independent of, and simpler than, `#tv-panel`; this one is purely descriptive (no editing except the pencil in its header, which routes to the real edit flow).

### 1.16 Trip chat sheet — dynamically created
- **Opens:** `openJourneyChat(trip, opener)` from the small chat-bubble icon in a card's expanded "journey" controls.
- A single textarea bound to the trip's **Notes** field (`journeyChatText`/`updateTripFromSidebar(...,['notes'])`), styled as a "chat" but really just editing Notes directly. Disabled entirely on a locked (past/submitted) day.

### 1.17 Standing-order helper modals
- `#so-name-modal` — name/rename a standing order (`renameStandingOrder`).
- `#so-spread-modal` — after saving an edit to a trip that belongs to a standing order, asks whether the same field changes should also be applied to the order's other (unlocked) future days — checklist of dates fetched live from `getStandingOrderTripsFrom`, "Just this trip" vs "Apply to N other days".
- `#so-progress` — a persistent bottom toast (not a modal) tracking a long-running background job (creating/deleting a large standing order, or clearing a deleted passenger's trips), polled via `getStandingOrderJobStatus(jobId)` every 1.5s.

### 1.18 Conflict / plan warning modal — `#plan-modal`
- Shown when the server's `checkTripConflictsBatch` reports **soft** warnings (not hard conflicts) about driver reachability — "This will be very tight" or "This trip cannot be driven" — computed server-side from real driving time between addresses. "Go back" or "Save anyway"; nothing here is client-computed.

### 1.19 Near-duplicate modal — `#dup-modal`
- "Possible duplicate trip" — shown when a passenger already has a trip within twenty minutes but it isn't an exact duplicate. "Go back" or "Add anyway".

### 1.20 Undo bar — `#undo-bar`
- Persistent bottom toast, not a modal: appears for exactly 5 seconds after any delete, counting down ("Trip deleted · 5s" → "4s" → …), with an **UNDO** button. After the window (or immediately on tab close via `pagehide`/`beforeunload`), the delete is actually sent to the server and the bar flips to a busy state ("Removing the trip…") with its button hidden.

### 1.21 Quick Status sheet — `#qs-sheet`
- A tiny 4-option bottom sheet (Ready / Cancel / No Show / Clear status) — a faster alternative to opening the full edit panel just to set `dispatchStatus`. (Superseded in practice for expanded cards by the inline `<select>` in the journey/activity panel, but still reachable.)

### 1.22 New Passenger modal — `#np-modal` — **DEAD CODE**
- Fully built (first/last name, phone, Medicaid #, type, address, blacklist checkbox+reason) and fully wired (`npSave()`, `npToggleReason()`, `closeNewPassenger()`) — but **nothing in the current UI ever opens it**. `openNewPassenger()` (the actual "+" handler) was rewritten to call `ppSheetNew()` (§1.9.1) instead. See §8.

---

## 2. Controls, by screen

### 2.1 Add/Edit Trip panel (`#edit-panel`) — every field

| Field id | Type | Required | Validation / behavior | Maps to trip field |
|---|---|---|---|---|
| `ep-date` | `date` | Yes (unless Needs-Scheduling mode) | `min` = today except in NS mode; typing it sets `epDateAuto = false` | `date` |
| `ep-time` | `time` | No (defaults to `23:58` if blank on a normal add — see §7) | — | `time` |
| `ep-ns-check` | checkbox | — | "Don't know the day or time yet?" — toggles Needs-Scheduling mode (`epToggleNsMode`); only shown in Add mode | (routes to `savePendingTrip` instead) |
| `ep-ns-needed` | `date` | No | Only shown in NS mode; "needed by" date — past it, the NS row turns red/overdue | `neededBy` (pending-trip record) |
| `ep-start-toggle` / `ep-start-time` | collapsible / `time` | No | Collapsed by default, auto-opens if a value exists (`epSyncStartPanel`); hint icon explains "when the driver should be in route" | `startTime` |
| `ep-passenger` | text w/ datalist `ep-passenger-options` | **Yes** | On change, `epApplyPassengerNormalization()` re-flips "First Last" → "Last, First" against known profiles (`epNormalizePassengerName`); triggers blacklist banner + phone/medicaid/address autofill from the matched profile | `passenger` |
| `ep-flag-btn` | icon button | — | Only shown once typed name matches a known profile; opens `#flag-modal` | (server: blacklist flag) |
| `ep-pass-link` | button | — | "View passenger details" — only shown for a known name; opens `#pp-panel` sheet for that person, remembering to come back | — |
| `ep-blacklist-warning` | banner | — | Shown when the matched profile is blacklisted; shows reason + who flagged it | — |
| `ep-phone` | text w/ datalist `ep-phone-options` | No | Auto-formatted to `(XXX) XXX-XXXX` on input/change (`epFormatPhone`) | `phone` |
| `ep-medicaid` | text | No | Autofilled from profile if empty | `medicaid` |
| `ep-invoice` | text | No | — | `invoice` |
| `ep-transport` | text w/ datalist `ep-transport-options` (built-ins: Taxi/Ambulatory/Wheelchair/Stretcher, plus custom values from prior trips) | No | Autofilled from profile | `transport` |
| `ep-pickup` / `ep-dropoff` | text w/ datalist `ep-address-options` | No | Custom address-suggest widget (own-history first, then live geocoder after 4 chars, 350ms debounce) — see §3.6 | `pickup` / `dropoff` |
| `ep-private` | checkbox | — | "Private Pay" — reveals price row, triggers `pzRequote` | `privatePay` |
| price row (`ep-price-value`, `ep-price-info`) | display + icon button | — | Read-only; opens `#pz-sheet` | `price`, `pricing` (object) |
| `ep-return-checkbox` / `ep-return-time` | checkbox / `time` | Add mode only; time required if box checked | Default return time = trip time + 4h (`epAddHours`) | creates a second trip row with `returnOf` set |
| `ep-standing-checkbox` | checkbox | Add mode only | Forces `ep-return-checkbox` on too | creates a `recurringId` group |
| `ep-standing-title` | text (maxlength 60) | **Yes, if standing** | "Give the order a name so it is easy to find later" | standing-order `title` |
| `ep-standing-frequency` | select: `DAILY, WEEKDAYS, WEEKENDS, WEEKLY, BIWEEKLY, MONTHLY` | — | `WEEKLY/BIWEEKLY/MONTHLY` reveal day checkboxes | encoded into `pattern` string |
| `ep-custom-days` (7 checkboxes MON…SUN) | checkbox group | Only meaningful for the 3 freqs above | If none checked, defaults to the start date's own weekday | part of `pattern` |
| `ep-standing-start` / `ep-standing-end` | `date` | **Yes, if standing** | End ≥ start; span ≤ 183 days (leap/DST-safe UTC diff, see §7) | encoded into `pattern` |
| `ep-vehicle` | text w/ datalist `ep-vehicle-options` | No | — | `vehicle` |
| `ep-driver` | text w/ datalist `ep-driver-options` | No | — | `driver` |
| `ep-status` | text w/ datalist `ep-status-options` (`READY, NOT CONFIRMED, REASSIGN, UPDATE TIME, COMPLETE, NO SHOW, CANCEL`) | No | Colored dot (`#ep-status-dot`) mirrors `STATUS_DOT_COLORS`; free text, but only the 7 known values are sent through the fast quick-status path | `dispatchStatus` |
| `ep-t-pickupin` / `ep-t-intransit` / `ep-t-arrived` / `ep-t-completed` (behind collapsible "Driver progress times") | `time` ×4 | No | Manual override of what the driver's app would normally stamp | `pickupArrival`, `pickupDeparture`, `dropoffArrival`, `dropoffDeparture` |
| `ep-notes` | textarea | No | — | `notes` |
| `ep-pickup-notes` / `ep-dropoff-notes` (behind collapsible "Pickup & drop-off notes") | textarea ×2 | No | Shown to the driver app at the relevant stage; falls back to the general Notes if blank | `pickupNotes` / `dropoffNotes` |

Save button enable rule: `epRequiredFieldsValid()` **and**, in edit mode, `epFormSnapshot() !== epInitialState` (a single pipe-joined string of every field's current value + the private-pay flag) — i.e. the button stays disabled until something actually changed.

### 2.2 Private Pay Pricing settings (`#pz-panel`) fields
All dynamically generated inputs, ids built from keys: `pz-base-ambulatory/wheelchair/stretcher/taxi/other` (money), mileage mode segmented control (`pz-seg-mileage`: Auto/Optional/Off) + `pz-mile-included`/`pz-mile-rate`/`pz-mile-min`, deadhead segmented control (`pz-seg-deadhead`: Optional/Off only — Auto is disabled, "the system cannot detect this one on its own") + `pz-dh-included`/`pz-dh-rate`, wait-time segmented control + `pz-wait-grace`/`pz-wait-interval`/`pz-wait-rate`, `pz-ah-from`/`pz-ah-to` (after-hours window, `HH:mm` text), `pz-holidays` (comma-separated `YYYY-MM-DD` list), and one row per server-supplied rule (`pz-seg-<key>`, `pz-kind-<key>` `$`/`%` toggle, `pz-amt-<key>`). "Off" vs "Optional" is explicitly documented in the UI itself: *"Off means the charge never appears anywhere. Optional means it is offered to the dispatcher but never added on its own."*

### 2.3 New/Edit Standing-Order-Spread modal (`#so-spread-modal`)
`#so-spread-list` — one checkbox row per other date in the order (`{date, time, pickup→dropoff, isReturn}`), `#so-spread-all` toggles all, footer shows a live count ("Apply to 3 other days").

### 2.4 Passenger directory search & rows (`#pp-panel`)
`#pp-search` (free text, matches name/phone/Medicaid/type/address/blacklist-reason, plus digit-only phone matching), `#pp-select-btn` (mode toggle), `#pp-fab` (+).

### 2.5 Passenger editor form (shared: `#ps-sheet` edit mode, `#np-modal`'s dead twin, and inline directory rows in older code paths) — `ppEditorHtml()`
- First name / Last name (two required text inputs; only **Last** is actually enforced on save — "Last name is required").
- **Phone numbers** — a dynamic list (`ppListBlockHtml`), each entry its own `<input>` with a `×` remove button, plus an "Add a phone number" field wired to Enter-to-add.
- Medicaid # / Type (text, Type shares the transport datalist).
- **Addresses** — same dynamic-list pattern, each entry individually wired to the address-suggest widget.
- Blacklist checkbox → reveals a required reason textarea (≥3 chars) and shows who flagged it if already set.
- Save button text is context-sensitive ("Add passenger" for new).

### 2.6 Passenger Trips filters (`#pt-panel`)
- `#pt-search` — full-history text search.
- `#pf-sheet` root menu → `#pfd-sheet` (Date: single-day calendar or From/To range, `pfSetDateMode`), `#pfv-sheet` (Driver multi-select, counts per driver), `#pfr-sheet` (Standing-orders radio: "Standing orders only" / "One-off trips only" / a specific order by name).
- Active filters render as removable chips (`ptRenderFilterBar`) with a "Clear all" once more than one is active.

### 2.7 Board-level controls
- `#trip-search` — free text (see §3.7 for exact match fields).
- `#search-filter-btn` → `#filterMenu` (§1.3).
- `#trip-date` (native `date` input, visually hidden pointer-events but driven entirely by the custom `#calendar-pop` popup) + `#jump-today-btn` ("Today" pill, shown only when not already on today).
- `#refresh-btn` — manual refresh, spins while in flight, gives up after 20s regardless.

---

## 3. The board

### 3.1 Grouping & sorting
Trips for the selected day are always time-sorted first (`tripTimeValue`), then optionally re-grouped by the active filter (`currentFilter`, persisted in `localStorage['tripsFilter']`, default `'time'`):
- **`time`** — flat list, no sections (aside from the Past-trips/Current-upcoming split, §3.2).
- **`driver`** — one `.driver-section` per driver name, "Unassigned" always sorted first, everyone else alphabetically.
- **`status`** — one `.status-section` per resolved status, in a fixed priority order: `pending, ready, notconfirmed, reassign, inroute, pickuplocation, waiting, intransit, dropofflocation, complete, cancel, noshow` (past-trips uses a different order: `complete, noshow, cancel, reassign, pending, ready, notconfirmed, updatetime`).
- **`transport`** — one `.transport-section` per normalized transport string (case/whitespace-normalized to Title Case), "No Transport set" always sorted last.

### 3.2 "Current & upcoming" vs "Past trips" — the exact rule
Implemented in `partitionTodayTripsByHour()`. **Only applies when the selected date is today** (`isSelectedTripDateToday()`); any other date shows everything as "current" with no past-trips fold.

For today, `currentHourStart = now.getHours() * 60` (i.e. the top of the current clock hour, using the **server-corrected** clock — `wtNow_()`, not the raw browser clock, see §3.5). For each trip:
1. If its scheduled time is **at or after** the start of the current hour → **Current & upcoming**.
2. Otherwise (its hour has fully elapsed) —
   a. if it is *currently in progress* (`isTripCurrentlyInProgress`: status is one of `inroute, pickuplocation, waiting, intransit, dropofflocation`) → **Pinned** (shown above everything else, in its own `.pinned-active-trips` block, always rendered as if filter=`time` even when grouped by driver — `createPinnedTripCard`).
   b. else if it is **not settled** (`isTripSettled`: status is one of `complete, noshow, cancel, reassign`) → stays in **Current & upcoming** ("overdue and nobody has dealt with it" — literal code comment).
   c. else (settled) → **Past trips**, sorted newest-first within that section.

So an unassigned trip, or one a driver never touched, **never** ages into Past no matter how late it is — only a trip a driver is actively working, or one somebody has closed out (complete/no-show/cancel/reassign), can leave the live list. The Past-trips section itself is collapsible (`createPastTripsSection`, header shows a live count), remembering open/closed state in the in-memory `pastTripsExpanded` boolean (not persisted across reload) — except when there is *nothing* current or pinned left, in which case it renders "flat" (no toggle, everything shown, `flat=true`).

The hour-based split is **re-evaluated every 30 seconds while the tab is visible**, purely because the wall clock moving past the hour boundary needs to move trips between sections even with no data change (`lastRenderHour_` tracking in the `DOMContentLoaded` handler).

### 3.3 Collapse/expand state
- **Board section headers** (`driver-section`/`status-section`/`transport-section`): `collapsedTripSections` — an in-memory `Set` of keys like `'driver:Unassigned'` or `'transport:No Transport set'`. **Defaults to those two collapsed** on every fresh page load; nothing is persisted to storage — a reload resets everyone's manual expand/collapse choices except those two hard-coded defaults.
- **Past trips**: `pastTripsExpanded` boolean, in-memory only, same reset-on-reload caveat.
- **Needs Scheduling strip / edit-panel collapsibles** (`ep-times-panel`, `ep-start-panel`, `ep-stopnotes-panel`): plain `hidden` class toggles, reset every time the panel opens (auto-expanded only if they already contain a value).

### 3.4 Trip card anatomy (`createTripCard(trip)`)
A `<article class="trip-card">` containing:
- **Stripe color**: alternating `row-even`/`row-odd` classes assigned by build order (not DOM position) so a single-card patch never shifts every card after it (V120 perf note).
- **Terminal-state classes**: `trip-terminal-muted` (desaturated + 58% opacity) for `cancel`/`reassign`; `trip-canceled` (pink tint) / `trip-reassigned` (purple tint) / `trip-noshow` (amber-brown text only, deliberately **not** muted like cancel/reassign, so a no-show doesn't visually disappear like a truly finished trip — PRODUCTION_DARK_NO_SHOW_STATUS_V18).
- **Passenger name** (`.passenger-name-text`) + a small transport icon badge (`createTransportBadge`: `fa-wheelchair`, `fa-bed-pulse` for stretcher/gurney, `fa-taxi`, `fa-person-walking` for ambulatory, else a generic `fa-car-side`). If the resolved status is `ready`/`noshow`/`updatetime` (a *dispatcher-set, pre-driver* status) the whole name row gets a `status-<name>` class turning the text a signal color (`status-ready`/`status-updatetime` = red).
- **Route line** (`.trip-route`): cleaned pickup → a clickable **Google Maps directions** arrow link (`https://www.google.com/maps/dir/?api=1&origin=…&destination=…`) → cleaned drop-off. `cleanLocation()` truncates to the street-address portion (regex against `St|Rd|Dr|Ave|Terrace|Blvd|Ln|Way|Pl|Ct|Circle`) and caps at 22 chars with an ellipsis.
- **Driver row** (`.driver-tag`): a colored **status dot** (`.status-dot.activity-trigger`, clickable to expand the activity panel — see below) whose color comes from `STATUS_DOT_COLORS`:
  `ready:#2f9e44, cancel:#e03131, complete:#28a745, reassign:#9b59b6, noshow:#f08c00, updatetime:#e8590c, notconfirmed:#b0b0b0, intransit:#fd7e14, inroute:#fab005, waiting:#4dabf7, pickuplocation:#15aabf, dropofflocation:#1971c2`, default `#ced4da`.
  Then either the **driver name** (or, if the board is grouped by Driver, a preview of the trip's chat/notes text instead — the driver's name is redundant under its own section header), or — if the trip is canceled/reassigned/no-show — the literal terminal label ("Canceled"/"Reassigned"/"No Show") in place of the driver name entirely.
  If unassigned (and not locked, not itself a terminal status, and not the Driver grouping view) an **"Assign"** pill button appears (`assignDriverFromCard`) that opens the edit panel with the Driver field auto-focused.
  A **"🔁 Return"** button appears if the trip is a return leg (`trip.returnOf` set) — clicking it filters the search box to the linked trip's id (`filterByTripId`).
- **Note line** (`.note-line`, 📝 + first line of Notes) — click/hover shows the full text in `#note-tip`.
- **Late flag**: if Notes literally contains the substring `DRIVER RUNNING LATE` (case-insensitive) and the driver hasn't arrived yet, adds a ⚠️ icon (`.late-hz`) — a manual, text-based flag with no structured field.
- **Right-hand side**: the formatted time, and — only when a driver is actively waiting — the wait-timer pill (§3.5) on its own line beneath the time (moved out of the time box after it was found to clip and push the time off-screen — V116 note).
- **Click behavior**: tapping anywhere on the card except an interactive element expands/collapses an inline **"journey" activity panel** (`toggleTripActivity`) showing a 4-stage milestone timeline (Pickup In → Intransit → Arrived → Completed/ended-status), a quick-status `<select>` (same 7 values as the edit form, wired through the *same* `commitStatusChange_` optimistic path — see §4.5), a chat icon (opens §1.16), and an info/edit icon (opens §1.6 or, if locked, §1.15/§1.14 read views).
- **Search matchability**: every card carries a precomputed `data-hay` attribute (lowercased, joined with ``) and `data-phone` (digits only) so the fast-path search (§3.7) never re-touches the trip object.

### 3.5 Wait-timer pill
Purpose: show how long a driver has been standing at a door (arrived, but not yet departed). Entirely derived client-side from stamps already on the trip — no extra server call for the pill itself, only a clock-sync ping.
- **Clock correction** (`wtSkew`, `wtZone`): the page asks the server `getServerClock()` at load and every 10 minutes; `wtSkew` corrects for a wrong local clock, `wtZone` corrects for a wrong local *timezone* relative to the spreadsheet's own timezone (every stamp is written in the spreadsheet's wall-clock time). Explicit rationale in-code: a machine an hour fast used to make every wait pill read "0 min" forever (§7 quote).
- **Live window**: `wtWaitInfo_(trip)` only reports a wait if status is `pickuplocation` with an arrival-but-no-departure stamp, or `dropofflocation` likewise; capped at `WT_MAX_LIVE_MIN_ = 12*60` minutes old (older = the driver forgot to tap, not still waiting) and — for a trip whose date isn't "today" per the office's clock — only allowed to straddle midnight by `WT_MIDNIGHT_GRACE_MIN_ = 30` minutes.
- **Color thresholds**: `WT_AMBER_MIN_ = 10`, `WT_RED_MIN_ = 20`. Red pill also gets a pulsing ring drawn *inside* its own box (`box-shadow: inset …`, deliberately not `outside`, because `content-visibility:auto` clips anything painted outside a card's own box — a documented near-miss, §7).
- **Repaint cadence**: `wtTick_()` on a 15-second `setInterval`, skipped entirely while `document.hidden`.
- **Tooltip** (`#wt-tip`): tap or hover a pill → shows exact wait duration, arrival clock time, and — for a pickup wait — whether the driver was early/late/on-time versus the scheduled pickup time.
- **Trip-details tiles** (`wtTilesHtml_`): the same math rendered as two static "Pickup wait" / "Drop-off wait" tiles on `#tv-panel`, with a live-updating variant if that leg is still in progress.

### 3.6 Address & combo-box autosuggest
Two nearly-identical custom dropdown widgets replace native `<datalist>` popups (because Safari/mobile datalists are poor UX), both rendered into a single shared floating `<div>` per widget type (`#addr-panel`, `#combo-panel`), positioned under whichever input is focused:
- **Address fields** (`ep-pickup`, `ep-dropoff`, `np-address`, passenger-address list rows): shows "On file" (this passenger's or the general address book's saved values) first, then, once 4+ characters are typed (350ms debounce, skipped entirely while offline), a live call to **`https://photon.komoot.io/api/`** (a third-party, non-Google geocoder) biased to a lat/lon/bbox roughly covering the tri-state NY/NJ/CT area, mapping full state names to postal abbreviations via a small hard-coded table (`ADDR_STATE_ABBR`).
- **Combo fields** (Transport, Vehicle, Driver, Status, Phone, Passenger, `np-type`): same floating-panel mechanism but sourced purely from the field's own `<datalist>` (no network), with a colored dot preview for the Status field and the current value visually marked.

### 3.7 Search
- **Board search** (`#trip-search`): matches (case-insensitive substring) against `passenger, driver, pickup, dropoff, medicaid, transport, invoice, id, returnOf, notes`, plus a digits-only phone comparison if the query looks phone-shaped. Two code paths:
  - **Slow path** (`applySearch`): full re-render, used whenever the search is entered/cleared or the query isn't a strict continuation of the previous one (because the "needs a time" board strip and section shapes can change).
  - **Fast path** (`applySearchFast_`): only usable when the new query is the old query with more characters appended (i.e. normal typing) — just toggles `.search-hidden` on already-built cards using their precomputed `data-hay`, no rebuild. Falls back to the slow path for anything else (paste, backspace mid-word, clearing).
  - After narrowing, `searchHideEmptySections_()` hides any section/pinned/past-trips block left with zero visible cards, and live-recomputes the Past-trips count badge and whether the "Current & upcoming" label should show at all.
- **Passenger directory search** (`ppMatches`): name, phone, Medicaid, type, addresses, blacklist reason.
- **Passenger-history search** (`ptHaystack`): date, pretty date, formatted time, pickup, dropoff, driver, vehicle, transport, notes, both stop-notes, status, dispatchStatus.

---

## 4. Client-side state

### 4.1 Module-level variables (non-exhaustive list of the significant ones)
- `allTrips` — the board's current trip array for the selected day.
- `currentFilter` — `'time'|'driver'|'status'|'transport'`, persisted (§ below).
- `collapsedTripSections` (Set), `tripSectionSequence` (counter for unique DOM ids), `pastTripsExpanded` (bool) — all in-memory only.
- `currentLoadToken` — incremented on every `loadTrips()` call; any in-flight response whose token doesn't match the latest is discarded (guards against a slow response for day A landing after the dispatcher has already switched to day B).
- `lastHash` / `renderedHash_` — the server's opaque hash of "what the board currently is". `lastHash` is sent back on the next poll so the server can reply "unchanged"; `renderedHash_` is what's actually painted. Both are **always cleared together** via `invalidateBoard_()` — clearing only one caused the board to silently stop updating (explicit V120 comment, quoted in §7).
- `boardEpoch_` — bumped on every local optimistic change; an in-flight poll whose captured epoch has since changed discards its answer rather than clobbering the dispatcher's own just-made edit.
- `searchQuery`, `searchTimeout` — current search box state.
- `pollInFlight`, `boardVersionInFlight`, `boardVersionSeen` — polling guards (§4.6).
- `submittedDates` — `{ [dateKey]: true }` map of locked/submitted days, seeded from the server on every `getTripsPageDelta` response.
- `undoPayload` — the staged (not-yet-server-committed) delete, `{trips, tripKeyID, dateKey, extraKeys, ptTrips, seq}`.
- `formOptions` — `{ profiles: {name: {...}}, vehicles: [...], drivers: [...] }`, fetched once (`getFormOptionsBundle`) and cached for the session.
- `pendingStatus_` (Map) / `pendingSeq_` — the optimistic-status machinery, §4.5.
- `cardIndex_` (Map, tripKey → DOM node) and `cardStripe_` — perf caches so re-renders don't have to walk the whole DOM.
- `pzCfg`, `pzRules`, `pzTransports` — cached pricing config/rules, loaded once per session on opening the Pricing screen; `epQuote`/`epReturnQuote` — the live quote(s) for whatever trip is currently open in the edit form; `epManual`/`epDropped` — dispatcher overrides to the priced line items; `epDeadhead` — the one manually-typed number in the whole pricing system.
- `ppRows`, `ppSelected`, `ppSheetName`/`ppOpenName` — passenger directory state.
- `nsItems`, `nsLoaded`, `nsLoadedAt` — Needs Scheduling cache, re-fetched if the tab regains visibility more than 60s after last load.
- `ptAll`, `ptDay`/`ptFrom`/`ptTo`/`ptDrivers`/`ptRepeat`/`ptQuery` — passenger-history filter state; `ppTripCache` (name → history result) shared between the passenger sheet's trip-count check and the full history page so opening one is instant if the other already asked.
- `tvTrip`, `tvSource`, `tvEditing` — trip-details page state.
- `wtSkew`, `wtZone` — clock-correction offsets (§3.5).

### 4.2 `localStorage` — complete inventory
**Exactly one key is used in the entire application:**
| Key | Value | Written | Read |
|---|---|---|---|
| `tripsFilter` | `"time"` \| `"driver"` \| `"status"` \| `"transport"` | `applyFilter(type)` | on load, to seed `currentFilter` |

No `sessionStorage` use anywhere. Everything else described as "state" above (collapsed sections, search text, passenger filters, undo payload, caches) lives only in JS variables and is lost on refresh.

### 4.3 Caches
- `formOptions.profiles` — passenger directory mirror used by the trip form's autofill/blacklist logic; kept in sync by `epRememberPassenger()` (adds a new phone/address seen on a saved trip) and `ppSyncProfilesFromRows()` (full resync whenever the Passengers page loads).
- `ppTripCache` — per-passenger trip-history results, invalidated (`delete ppTripCache[name]`) whenever that passenger's trips are known to have changed (a delete, an undo, a rename).
- `cardIndex_` — DOM node cache keyed by trip identity, for O(1) card lookup instead of `querySelectorAll` + `.find()`.

### 4.4 Optimistic delete + 5-second undo
`epDoDelete()` removes the trip from `allTrips`/`ptAll` and closes any open panel **immediately**, then calls `startUndoDelete()`, which shows `#undo-bar` counting down from 5s (`undoSeq` distinguishes overlapping deletes so a second delete's message can't be stomped by the first one's completion). If **Undo** is pressed, the trip is simply spliced back into the in-memory arrays (`undoRestore_`) — the server was never told. If the timer expires (`finishDelete()`), the deletes are sent to the server one at a time in sequence (so a linked pair deletes in order), and only then does `invalidateBoard_()` run to force the next poll to reconcile. `pagehide`/`beforeunload` also flush the pending delete immediately (best-effort only — `google.script.run` cannot reliably finish while the page unloads; explicitly **not** claimed as fully fixed, §7). Deliberately **not** flushed on mere tab-hide (switching apps), so a dispatcher alt-tabbing doesn't lose their undo window.

### 4.5 Optimistic status changes
`commitStatusChange_(trip, value, revert)` is the single path used by **both** the board card's quick-status `<select>` and the `#qs-sheet`. It:
1. Immediately writes the new `dispatchStatus` onto the live trip object and re-renders, before the server has answered.
2. Records `{value, at, seq}` in `pendingStatus_` keyed by trip identity; every incoming poll result runs through `applyPendingStatus_()` first, which **re-overwrites** any trip that still has a pending entry — so a poll landing mid-flight can't flicker the status back to its old value.
3. Sets a **45-second** hard timeout (`STATUS_ANSWER_MS_`); if the server hasn't answered by then, treats it as a failure.
4. On confirmed failure, reverts the local value, calls the caller-supplied `revert(previousValue)` (e.g. resets a `<select>`), and toasts an error.
5. Uses a monotonically increasing `pendingSeq_` per-trip so that if two status changes are made in quick succession, a slow answer to the *first* can never undo the second.
6. Always calls `invalidateBoard_()` at the end (success or failure) so the next poll fetches the authoritative state rather than trusting the local patch forever.
Server call: `setTripQuickStatus(tripKeyID, value, false, date)` — the trip's own date is passed explicitly (§7 quote on why).

### 4.6 Polling loops (exact intervals)
| Interval | Function | What it does |
|---|---|---|
| Once, ~1.5s after paint (only when `injectedTrips` was used) | `pollTrips()` | reconciles the server-embedded initial trips against the live board |
| **every 15,000 ms** | `pollTrips()` | the main "did anything change" refresh — fetches `getTripsPageDelta(date, lastHash, isToday)`; if the server reports `unchanged`, does nothing further |
| **every 3,000 ms** | `checkBoardVersion()` | a *much* cheaper check — reads a single cache value (`getBoardVersion()`); if it differs from the last-seen version, triggers an immediate full `pollTrips()` rather than waiting for the 15s tick |
| **every 15,000 ms** | `wtTick_()` | repaints all wait-timer pills' elapsed time (skipped if tab hidden) |
| **every 30,000 ms** | inline (in `DOMContentLoaded`) | re-checks whether the wall-clock hour has advanced and, if so, re-runs `applySearch()` to move trips across the Past/Current boundary |
| **every 600,000 ms (10 min)** | `wtAskClock_()` | re-syncs `wtSkew`/`wtZone` against the server's clock |
| **every 2,500 ms, once** (`setTimeout`) | `fetchFormOptions()` | loads passenger/driver/vehicle profiles once, ~2.5s after initial paint so it doesn't compete with first paint |
| **once, 900 ms after load** | `nsLoad()` | Needs Scheduling initial fetch |
| **every 2,600 ms, once** (`setTimeout`) then **every 180,000 ms (3 min)** | `refreshGeoOff()` | driver "location turned off" chip data |
| **every 20,000 ms** | `applyGeoOff()` | repaints the "No location" chips from the cached geo-off map (cheap, no network) |

All the frequent pollers early-return under a long list of conditions to avoid wasted round-trips and to avoid clobbering in-progress work: `document.hidden`, offline, an open modal (`.modal:not(.hidden)`), the edit panel open, an undo pending, or the trip-chat sheet open (`openJourneyChatState`).

---

## 5. Every server call (`google.script.run`)

For every entry: **success handler** behavior and **failure handler** behavior are summarized; "toast on failure" generically means `handleError(e)` → `showToast("⚠️ Error: " + e.message, "error")` unless noted otherwise.

| # | Function | Args | On success | On failure |
|---|---|---|---|---|
| 1 | `getTripDatesInfo()` | — | refreshes `tripDatesInfo`/`tripDateSet`, re-renders the open calendar popup | silently ignored |
| 2 | `getTripsPageDelta(dateKey, lastHash \| null, isToday, force?)` | 3–4 args | main board load/poll: sets `submittedDates[date]`, `lastHash`/`renderedHash_`, `allTrips`, re-renders or patches cards | `loadTrips`: shows error, marks list not-busy. `pollTrips`: logs to console only (`console.error('Trip refresh failed', …)`), does not toast |
| 3 | `submitTripsFromSidebar()` | — | marks today submitted, reloads trips, toast "✅ Trips submitted" | re-enables buttons, `handleError` |
| 4 | `restoreDispatchFromLog(dateStr)` | date | `pageLoader(false)` | `handleError` — **dead**, called only from unreachable `exportTrips()` |
| 5 | `deleteTodaysLogsThenUpdateSnapshotDispatchToLog()` | — | reloads trips | `handleError` — **dead**, only from unreachable snapshot modal |
| 6 | `snapshotDispatchToLog()` | — | reloads trips | `handleError` — **dead**, same modal |
| 7 | `getFormOptionsBundle()` | — | populates `formOptions`, fills static datalists, syncs blacklist banner | swallowed (callback still fires so callers don't hang) |
| 8 | `setPassengerBlacklist(name, turnOn, reason)` | 3 | updates cached profile flag, closes flag modal, toasts | re-enables the Flag button, `handleError` |
| 9 | `checkTripConflictsBatch(trip\|trips[], blOverride, dupOverride, tripKeyID?)` | 3–4 | drives duplicate/blacklist/conflict/reachability-warning flow before every add **and** every edit save | on failure, the check is skipped entirely and the save proceeds anyway ("a check that cannot run must not stop the dispatcher working") |
| 10 | `updateTripFromSidebar(trip, changedFieldNames[] \| null)` | 2 | main **edit-save**; also used to set only `['notes']` from the trip-chat sheet | `hideSaveOverlay`, `handleError` |
| 11 | `setTripQuickStatus(tripKeyID, value, false, dateKey)` | 4 | fire-and-forget confirmation for a status set alongside a full save, and the sole call for the optimistic quick-status path (§4.5) | shown as a toast warning if `r.ok === false`, or via the 45s timeout path |
| 12 | `getStandingOrderTripsFrom(recurringId, fromDateKey, excludeTripKeyID)` | 3 | populates the "apply to other days" checklist | closes the spread modal, `handleError` |
| 13 | `applyStandingOrderEdit(recurringId, items[], fields{})` | 3 | reports how many other days were updated/locked/skipped | still closes the panel and refreshes, then `handleError` |
| 14 | `getStandingOrderMap()` | — | used to decode a standing order's date pattern before showing the delete-dates modal | `handleError` |
| 15 | `deleteTripFromSidebar(tripKeyID, dateKey)` | 2 | (called once per key, in sequence, after the 5s undo window) | restores the undone trip locally, `handleError`, and if not on the passenger-trips page, forces a board refresh |
| 16 | `deleteRecurringTripsFromSidebar(recurringId, selectedDateKeys[])` | 2 | reports deleted count + whether the pattern was switched off / kicks off `soTrackJob` for large jobs | `hideSaveOverlay`, `handleError` |
| 17 | `getStandingOrderJobStatus(jobId)` | 1 | polled every 1.5s (or 4s after a failed poll) to progress the bottom `#so-progress` bar for large async jobs (standing-order create/delete, passenger-trip bulk clear) | keeps retrying |
| 18 | `updatePassengerProfile(displayName, profile{})` | 2 | (legacy path, still used by the dead `#np-modal`'s `npSave`) | `handleError` |
| 19 | `listPendingTrips()` | — | populates `nsItems`, renders the badge/list/board strip | shows an inline "Could not load the list. Try again" in the NS panel |
| 20 | `getPrivatePayQuote(tripForQuote, manualKeys[], droppedKeys[])` | 3 | sets `epQuote` (and separately `epReturnQuote` for a paired return leg), repaints price row + breakdown sheet; **sequence-numbered** so a stale slow reply is discarded | shows "The price could not be worked out just now." |
| 21 | `getPricingSettings()` | — | populates `pzCfg`/`pzRules`/`pzTransports`, renders the settings form | shows a load-failure message in place of the form |
| 22 | `savePricingSettings(pzCfg)` | 1 | re-syncs `pzCfg` from the server's canonical copy, re-quotes if a private-pay trip is open, toast "Pricing saved" | shows itemized `#pz-problems` list, or a generic "office could not be reached" |
| 23 | `savePendingTrip(item{})` | 1 | Needs-Scheduling create/update; updates `nsItems`, board strip | `hideSaveOverlay`, `handleError` |
| 24 | `deletePendingTrip(id)` | 1 | used both for "Remove" and for cleaning up a NS item once it's really been scheduled (`nsAfterScheduled_`) | for the scheduled-cleanup path: toast "Trip added, but it is still on the Needs Scheduling list — remove it there." (the add itself already succeeded) |
| 25 | `touchPendingTrip(id)` | 1 | "Chased ✓" — updates `lastChasedAt/By`, toast "✓ Noted — chased today" | reverts busy flag, `handleError` |
| 26 | `getPassengerDirectory()` | — | populates `ppRows`, syncs `formOptions.profiles`, renders list; if a sheet-open was queued (`ppPendingSheet_`) opens it now | shows "Could not load the passenger list." |
| 27 | `getPassengerTripHistory(name)` | 1 | dual use: (a) the passenger sheet's trip-count check (cached in `ppTripCache`), (b) the full Passenger Trips page load | (a) falls back to an always-clickable button with unknown count; (b) shows "Could not load this passenger's trips." |
| 28 | `getPassengerUpcomingCounts(names[])` | 1 | populates the delete-confirmation warning with per-name upcoming-trip counts | falls back to a generic "could not check" warning, still allows deleting |
| 29 | `deletePassengersFromDirectory(names[])` | 1 | removes rows locally, invalidates the board, reports outcome, kicks off `ppTrackTripJob` for large jobs | re-enables the Delete button, `handleError` |
| 30 | `renameStandingOrder(recurringId, title)` | 2 | updates `ptOrders` cache, re-renders history + trip-details | toast "🚫 That name could not be saved." |
| 31 | `savePassengerFromDirectory(originalName, profile{}, changedFields[]\|null)` | 3 | updates the row in `ppRows`, invalidates trip caches for old/new name, re-renders, re-opens the sheet if open | re-enables Save button, `handleError` |
| 32 | `createStandingOrderFromSidebar(parentKey, standingOrder{}, rowArray[], expandedDates[], extras{})` | 5 | standing-order creation; then the shared "add" success handler (message about dispatch-board capacity, unpriced trips, etc.), kicks off `soTrackJob` | `hideSaveOverlay`, `handleError` |
| 33 | `addTripsFromSidebar(tripsToSave[])` | 1 | ordinary (non-standing) add, including a paired return leg | `hideSaveOverlay`, `handleError` |
| 34 | `getBoardVersion()` | — | the cheap 3-second heartbeat (§4.6); if changed, triggers a full `pollTrips()` | silently ignored (guard flag reset) |
| 35 | `getDriverGeoStates()` | — | populates `window.__geoOff` map, repaints "No location" chips | silently ignored |
| 36 | `getServerClock()` | — | learns `wtSkew`/`wtZone` (§3.5), immediately re-ticks wait pills | silently ignored (try/catch around the whole call) |

---

## 6. User actions, end to end

**Book a new one-off trip:** FAB (+) → `openAddPanel()` (date defaults to whatever's on screen, or today if that's in the past; time defaults to blank → server treats blank as `23:58`, i.e. sorts last) → fill required Date + Passenger → optional everything else → Save → `epSubmitNew()` builds one trip object (client-generated `id` = `driver|date|time|passenger|pickup`, `tripKeyID` = a UUID) → `checkTripConflictsBatch` (duplicate/blacklist/driver-double-book/reachability) → on a clean pass, `addTripsFromSidebar([trip])` → board refresh + toast reporting whether it actually reached the Dispatch board (capacity or unpriced-trip caveats, §5 #32/33).

**Book a round trip:** tick "Also create return trip", set/accept the auto-filled return time (outbound + 4h) → two trip objects are built client-side, the return one carrying `returnOf = <outbound id>`, swapped pickup/dropoff, and its own stop-notes swapped too; both sent in the same `addTripsFromSidebar` call.

**Book a standing order:** tick "Standing order" (forces return-trip on too), give it a required Title, pick a frequency (custom weekly/biweekly/monthly reveal day checkboxes), pick Start/End dates (≤183 days apart) → client expands the pattern into a literal list of dates (`epDecodeDatePattern`), builds one trip object per date (all sharing one `recurringId` = the first trip's key) → `createStandingOrderFromSidebar` (a different endpoint than a plain add, because it also needs the full LOG row-array shape, §8) → large orders return a `jobId` and finish asynchronously with a bottom-bar progress indicator.

**Edit a trip:** tap card → journey panel → pencil (or edit-panel `⋮` → Trip details → pencil, or the passenger-trips page which always opens through the read-only Trip Details page first) → form pre-filled, a baseline snapshot taken (`epCaptureBaseline`) → Save is disabled until something differs → on Save, only the *changed* field names are sent (`epChangedFields()`), plus pricing fields are always force-included if private-pay-relevant (§7 quote) → if the trip is standing-order-linked and something spreadable changed, asks "apply to other days?" first (§1.17) → `checkTripConflictsBatch` again (edit mode) → `updateTripFromSidebar(trip, changedFields)` → if the dispatch status also changed, a *second*, independent `setTripQuickStatus` call runs alongside it so the status-confirmation SMS/logic path stays correct even on a full edit save.

**Duplicate a trip:** from the edit-panel `⋮` or trip-details `⋮` → "Copy to a new trip" → `epDuplicateTrip()` — if the source trip has a linked return/outbound leg, the copy always starts from the **outbound** leg (even if you opened the return) and re-attaches the return automatically — Date, Driver, and all four driver-progress timestamps are deliberately left blank on the copy so the dispatcher has to look at them.

**Delete a trip:** edit-panel `⋮` → Delete, or trip-details `⋮` → Delete. Standing-order trip → date-picker modal (defaults to all dates checked) → `deleteRecurringTripsFromSidebar`. Plain trip → confirmation naming the passenger/time, offering to also delete a detected linked leg → `epDoDelete()` → immediate optimistic removal + 5-second undo bar → real server delete only after the window closes (§4.4).

**Assign / reassign a driver:** tap the "Assign" pill on an unassigned card (jumps straight into the edit form with the Driver field focused), or edit any trip and change the Driver field directly, or the board card's expanded journey view has no driver field but the Status `<select>` there covers the common re-dispatch case (setting status to `REASSIGN`, which the client already special-cases everywhere as a terminal state).

**Change dispatcher status:** three equivalent paths, all funneling through `commitStatusChange_` for the quick ones: (a) the board card's expanded quick-status `<select>`, (b) `#qs-sheet` (Ready/Cancel/No Show/Clear), (c) the Status field inside a full edit save. Statuses `READY, NOT CONFIRMED, UPDATE TIME` are deliberately hidden once the driver's own app has moved the trip past `pickuplocation`/`intransit`/etc. — the board keeps showing the driver's real progress instead (with an info toast explaining why, on the rare occasion someone tries to set one anyway).

**Price a trip:** tick Private Pay on the edit form → debounced (550ms, or immediate on the checkbox itself) call to `getPrivatePayQuote`, with a second parallel call for a paired return leg if one is being created → price row shows the total, tapping the ⓘ opens the full breakdown sheet where individual auto-applied rule lines can be unchecked (dropped) or optional extras can be added, and the one manually-typed number (deadhead miles) can be entered. Nothing is computed client-side; every keystroke that could move the price re-asks the server (sequence-numbered so a stale answer never overwrites a fresher one).

**Manage passengers:** header menu → Passengers → tap a name → view sheet (phones/addresses/Medicaid/type, plus a live "Passenger trips" count) → Edit pencil → same list-editor fields as new-passenger → Save (only changed fields sent, per-list add/remove with its own dirty-tracking).

**Blacklist a passenger:** from inside the trip form (flag icon next to Passenger, once the name matches someone on file) or from the passenger editor's own checkbox. Reason required (≥3 chars) to *set* a flag; not required to clear one. A blacklisted passenger can still be booked, but only after typing their exact last name into `#bl-modal` to confirm the override — both for a brand-new trip and for editing an existing one into using that name.

**Submit / lock a day:** header menu → Submit (only enabled/meaningful when the board is showing *today*) → confirms trip count and date, warns about any un-timed Needs-Scheduling items targeting today → `submitTripsFromSidebar()` → the day is marked `submittedDates[date] = true`, after which every edit/delete/add-to-that-day path checks `isDateLocked()` and refuses ("🚫 That day was already submitted — it is locked as history.").

**Look at a past day:** pick any date before today in the calendar, or open a locked trip from a passenger's history (`View only · past trip` badge). Editing/deleting is blocked everywhere (`isDateLocked`); the only actions still offered are **Copy to a new trip** and read-only detail views (Trip Details page, Journey sheet).

---

## 7. Rules and gotchas (quoted verbatim — these encode real past incidents)

> **"V120: `lastHash` tells the server 'send me everything'; `renderedHash_` tells the board 'you already have this'. Nulling only the first made the board ask for a fresh copy and then discard it, so it stopped updating altogether until the page was reloaded. They are only ever cleared together."** — always invalidate both hashes via `invalidateBoard_()`, never one alone.

> **"V120: this used to take the first five characters, so '9:47 PM' became '9:47 ' and produced an invalid date, and '10:47 PM' became 10:47 AM."** — and: **"\bPM\b needs a word break before the P, and '2:30pm' has a digit there — so the commonest way a dispatcher types it was read as 2:30 in the MORNING."** — all time parsing now funnels through one function, `hhmmOf_()`, specifically because three separate ad-hoc parsers used to each get AM/PM wrong differently.

> **"V120: a tick box's `.value` is the constant 'on' whether it is ticked or not, so turning Private Pay OFF never showed up as a change. The trip kept its private-pay flag and its old price and was billed twice."** — checkboxes must be read via `.checked`, not `.value`, when diffing "changed fields"; pricing fields are now *always* included in the sent field-list regardless of the diff.

> **"V120: a failed lookup used to leave this latched on, so for the rest of the session every standing-order edit saved just the one day without ever asking whether it should apply to the order's other days."** — `epSpreadAnswered` must be reset at the start of every `openEditPanel`, not just on success.

> **"V121: calling a trip off is the dispatcher's decision and it has to be visible whatever the driver is doing... Reassign belongs [in terminal overrides] too: the driver's phone already treats it as over... and nothing ever clears the driver's progress column, so a board that kept showing progress would read 'In Transit' under the OLD driver's name for ever."** — `resolveTripStatus()`'s terminal-override list (`cancel, noshow, reassign`) beats the driver's own live status unconditionally.

> **"V121: the trip's own date. Without it the office assumed today and wrote nothing at all for any other day, while still reporting success."** — `setTripQuickStatus` must always be passed the trip's real date, not assume "today".

> **"V120: undoing after moving to another day used to drop the trip onto whatever board was showing, where it could be opened and saved."** — an undo whose staged trip belongs to a different day than the one currently on screen must invalidate the board rather than splice the trip into the visible (wrong) day.

> **"V120: the delete only reaches the server when the 5-second timer fires, so closing the tab inside that window still loses it... but it is NOT a fix: google.script.run cannot complete while the page is being torn down. Properly fixing it means deleting immediately and making Undo a restore, which is a bigger change than this release should carry."** — an explicitly acknowledged, unresolved limitation. A rebuild should actually fix this (delete-then-restore semantics) rather than copy the workaround.

> **"V110: an empty list is not worth a row of the board... V118: the empty run out to the passenger. Nothing measures it, so it is a number the dispatcher types, and it stays with the trip once saved."** — deadhead mileage has no sensor; it is purely a manually-entered number, and a blank value must stay blank all the way to the server (`pzMoneyIn_` deliberately does *not* coerce `''` to `0`, because that used to defeat the server's own "you left this empty" validation and silently kept a stale price in force).

> **"V116: it keeps the OUTBOUND time on purpose. The hour a passenger happens to come back at does not change what the ride is worth, and a price that moved every time the return time was touched read as a fault, not a feature. The two legs are therefore always the same money."** — a round trip's return leg is always quoted using the *outbound* trip's date/time, never its own return time, and a deadhead charge only ever applies to the outbound leg ("the driver is already there" for the return).

> **"V120: declared in EP_LOG_COL but never filled, so every repeat lost the start time the dispatcher typed."** — a positional spreadsheet-row array is easy to silently under-populate; a named-field payload (as a rebuild should use) doesn't have this failure mode.

> **"V120: counted in fixed 24-hour blocks, a span crossing the autumn clock change gained an hour, so a legal 183-day order was refused; a span crossing the spring one lost an hour and a 184-day order slipped through."** — the 183-day standing-order cap is computed via `Date.UTC(...)` day differences specifically to be DST-safe; a naive `(end-start)/86400000` on local dates is wrong twice a year.

> **"V120: this held the finished overlay on screen for almost half a second after the work was already done, on every save and every delete. A short beat still reads as 'done'; nearly half a second reads as waiting."** — the save-overlay "done" delay was deliberately tuned down to 180ms.

> **"V116: this board worked out how long a driver had been standing at a door by subtracting a stamp from the browser's own clock. A machine an hour out — a phone on the wrong timezone, a laptop that never synced — put every stamp in the future, and because a wait is clamped at zero the pill read 0 min forever and never moved."** — hence the server-clock sync (`wtSkew`/`wtZone`) described in §3.5.

> **"V120: both stamps are wall-clock times placed on the trip's own day, so on the day the clocks go back the repeated hour collapses and a real wait computes an hour short. Give the hour back — but only on a day that really has one..."** — `wtMinutesBetween_` has an explicit fall-back-DST correction, gated so it can't mask genuinely corrupt (reversed) timestamp pairs.

> **"V120: adding a passenger triggers a second load. If the first reply landed last it put the list back to how it was, so the new passenger disappeared from the directory..."** and **"V120: replies can arrive in any order. Without this, opening one passenger and then another showed the second person's name above the first person's trips — and cached them under the wrong name for the rest of the session."** — both the passenger-directory load and the passenger-trip-history load are sequence-numbered (`ppLoadSeq`, `ptLoadSeq`) to discard stale, out-of-order responses.

> **"V104: a passenger's history is a list of its own, and the board's list is not it. A delete started from the trip details page used to change neither, so the page sat there still showing the trip that had just been deleted."** — any delete must remove the trip from *both* `allTrips` and `ptAll`, plus purge it from `ppTripCache`, not just whichever list happened to trigger the delete.

> **"V96: The server works out whether the driver can actually get from one trip to the next. Nothing here blocks a save: the dispatcher is told why, and decides."** — the reachability/"very tight" warnings (`#plan-modal`) are advisory only, never a hard block, by design.

> **"PRODUCTION_CHAT_CUSTOM_HOVER_ONLY_V13"** and the removal of the native `title` attribute on the chat icon — a deliberate choice to suppress the browser's default tooltip in favor of the custom `showNoteTip` one, presumably because the two used to show simultaneously or conflict.

> **"V120: epAddHours now reports, in `epReturnDaySpill`, how many days past midnight the result landed — but nothing reads it yet, so an overnight return still cannot be booked: a 9pm trip with a 4-hour return auto-fills 01:00 and the form's own 'return must be later' check refuses it... Left deliberately, and deliberately not claimed as fixed."** — a known, still-open bug: an overnight round trip (outbound late evening, return past midnight) cannot currently be auto-filled/booked through the normal return-trip flow. A rebuild should actually finish this (advance the return date by the spill).

> **"V99: a past trip cannot be edited or deleted, but it can be copied."** and the deliberate difference in what the trip-details `⋮` menu offers depending on `t.locked`.

---

## 8. Spreadsheet artifacts — flag clearly, drop in a rebuild

- **`EP_LOG_COL`** (line ~10105) — a hard-coded map of **fixed column indices** (`DATE:0, START_TIME:1, TIME:2, PASSENGER:3, TODAY:4, TRANSPORT:5, PHONE:6, MEDICAID:7, INVOICE:8, PICKUP:9, TRIP_KEY_ID:10, IN:11, DROPOFF:12, OUT:14, STATUS:16, VEHICLE:17, DRIVER:20, ID:23, NOTES:24, RETURN_OF:30, RECURRING_ID:31`) into a 32-cell array (`epTripToRowArray`), used **only** when creating a standing order (`createStandingOrderFromSidebar`). Note the gaps (13, 15, 18–19, 21–22, 25–29) — columns this file doesn't know or care about, owned by other parts of the spreadsheet (presumably driver-app-written columns like arrival/departure timestamps, or admin-only columns). The field named `TODAY` actually holds the **dispatcher's status override**, not "today's date" — a leftover spreadsheet-column nickname. **A rebuild should send a plain named JSON object for every create path (standing or not) and delete this whole positional-array concept entirely** — the one-off `addTripsFromSidebar` path already does this correctly; only the standing-order path still uses the row array.
- **`epTripExtras(trip)`** — a second, parallel bag of fields (`privatePay, price, pricing, milesOverride, deadheadMiles, pickupNotes, dropoffNotes, startTime`) sent *alongside* the row array specifically because "a LOG row array has no column for" them — a direct symptom of the spreadsheet's fixed-width-row limitation. In a rebuild these are just... fields on the trip record, no special-casing needed.
- **Dispatch-board capacity** (`dispatchSkipped`, `dispatchDeferred` in every save response) — the server reports that a trip "saved, but the Dispatch board is full" and needs "a free row on the DISPATCH tab". This is a **hard row-count ceiling on a physical sheet tab**. A rebuild has no reason to have any such ceiling; the whole skipped/deferred messaging (`epSaveOutcome`) should not need to exist.
- **"Submit"** (`submitTripsFromSidebar`) is explicitly described in the UI copy as "snapshot, transfer, sort, then clear" — a classic spreadsheet day-end batch job: copy the working `DISPATCH` tab's rows into the permanent `LOG` tab, then wipe `DISPATCH` for the next day. The *business concept* worth keeping (a day becomes immutable/historical once submitted, `isDateLocked()`) is legitimate; the *mechanism* (copy-tab-then-clear-tab) is not.
- **`#snapshot-modal` / `showSnapshotConfirm` / `confirmSnapshot` / `exportTrips` / `importTrips` / `restoreDispatchFromLog` / `snapshotDispatchToLog` / `deleteTodaysLogsThenUpdateSnapshotDispatchToLog`** — a whole second data-sync subsystem ("Full" vs "Partial" resync of "today's trip data") that is **completely unreachable from the current UI** (no button calls `importTrips()` or `exportTrips()` anywhere). This is dead code, almost certainly a leftover from when the header menu had more items (compare the V115 comment noting "Add trip" was removed from that same menu). **Do not rebuild this modal or its three server calls** unless there is a still-live business need for manual DISPATCH↔LOG resync outside this page.
- **`#np-modal`** and its handlers (`npSave`, `npToggleReason`, `closeNewPassenger`, `npBtn_`) — fully built and wired, but `openNewPassenger()` (the real "+" button handler) calls `ppSheetNew()` instead and never opens `#np-modal`. Dead code from before the V80 passenger-sheet rewrite; drop it.
- **`statusDisplayLabel`** — referenced defensively (`typeof statusDisplayLabel === 'function'`) in the Journey sheet's Driver tab but **never defined anywhere in this file**. Either dead/unfinished, or expected to come from the missing include — either way, that branch's fallback (`journeyText(trip.status, 'Scheduled')`) is what actually renders today.
- **`showToast(message, type)`**, **`#loading-overlay`**, and the entire toast visual system are used throughout (56 call sites) but defined in the external `include('loading')` partial, not in this file. A rebuild needs to design its own toast component from scratch — this spec cannot describe its exact markup/animation, only its call contract: `showToast(text, type?)` where `type` is `'error'`/`'success'`/omitted, fired for essentially every server-round-trip outcome.
- **Trip identity as a composite string** — `id = driver + '|' + date + '|' + time + '|' + passenger + '|' + pickup`, explicitly documented as unstable ("a trip's id is built from its driver, time and passenger, so it changes the moment a colleague reassigns it" — V120 comment on `editTrip`). `tripKeyID` (a client-generated UUID, stable for the trip's life) is the *real* identity and should be the only one a rebuild uses; `id` should not exist as a concept at all.
- **Standing-order pattern string** — `pattern = startDate + '|' + endDate + '|' + 'MON,WED,FRI'` (`epEncodeDatePattern`/`epDecodeDatePattern`), a hand-rolled serialization format reminiscent of a single spreadsheet cell holding "everything about the recurrence" as delimited text. A rebuild should use a structured recurrence object instead.
- **The 183-day standing-order cap** is an arbitrary business rule with no stated rationale in this file (possibly a spreadsheet row-count concern from an earlier version) — worth confirming with the business owner rather than assumed necessary in a rebuild.
