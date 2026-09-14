// ================== DRIVER APP (phone web app for drivers) ==================
// Served from doGet with page=driver. Reads/writes the same DISPATCH + LOG data
// the dispatcher panel uses, so both stay in sync. Old drivers sheet untouched.

const DRIVER_STAFF_ID_ = '1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE';
const DRIVER_SHEET_ID_ = '13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA';
const DRIVER_TEXTS_ENABLED_ = true;
const DRIVER_NOSHOW_WAIT_MIN_ = 10;
// V98: the page carries the same number. When they differ the page reloads itself, so
// a deploy reaches every open phone within one refresh (15 s) instead of never.
const DRIVER_APP_BUILD_ = 120;

// ---- Telling the driver about today's trip (V83) -----------------------------
// A driver already gets a text when a trip lands on them or the time moves. Now
// anything else that changes their day sends one too, and today's texts carry a link
// straight back into the Driver App. The quiet window stops a dispatcher correcting
// three fields in a row from buzzing the same phone three times; a trip changing hands
// always gets through at once.
// NOTE: if the web app is ever republished to a NEW deployment id, this link must be
// updated to match, or the text will point at the old one.
// V100: the short link the office hands out. It forwards to the driver app.
const DRIVER_APP_LINK_ = 'https://shorturl.at/978LK';
const DRIVER_APP_LINK_LONG_ = 'https://script.google.com/macros/s/AKfycbwGX9q5xcAZetI4YsrtJOBw_tdOcItbF7vTnm-mEKkhHk9ARA4OfhZEICm6xkDxy5us/exec?page=driver';
const DRIVER_ALERT_QUIET_SEC_ = 600;
const DRIVER_ALERT_FIELDS_ = ['time', 'startTime', 'passenger', 'pickup', 'dropoff',
  'transport', 'vehicle', 'notes', 'pickupNotes', 'dropoffNotes', 'dispatchStatus'];

function serveDriverApp_(e) {
  const template = HtmlService.createTemplateFromFile('DriverAppPage');
  let boot = {};
  try { boot = driverAppBootstrap(); } catch (err) { boot = { error: String(err && err.message || err) }; }
  // V120: the page now carries the driver's trips, which include free text a
  // dispatcher typed. JSON.stringify does not escape "<", so a note containing
  // "</script>" would end the block and leave the driver a blank app.
  template.bootstrap = JSON.stringify(boot)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  // V120: maximum-scale=1 blocked pinch-zoom, so a driver who could not read a
  // small address in daylight had no way to make it bigger.
  return template.evaluate()
    .setTitle('Amazing Grace Driver')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function driverNorm_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// V120 SPEED: driverAppIdentify_, driverRosterFind_ and driverTrustValid_ each
// ask for the roster, so a single button tap fetched it three times. It is the
// same answer every time within one request.
let DRIVER_ROSTER_MEMO_ = null;

function driverStaffRoster_() {
  if (DRIVER_ROSTER_MEMO_) return DRIVER_ROSTER_MEMO_;
  const cache = CacheService.getScriptCache();
  const hit = cache.get('driver-app:roster:v2');
  if (hit) {
    try { DRIVER_ROSTER_MEMO_ = JSON.parse(hit); return DRIVER_ROSTER_MEMO_; } catch (e2) {}
  }
  const sheet = SpreadsheetApp.openById(DRIVER_STAFF_ID_).getSheetByName('STAFF');
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][0] || '').trim();
    if (!name) continue;
    list.push({ name: name, phone: String(data[i][3] || '').trim(), email: String(data[i][4] || '').trim().toLowerCase(), carrier: String(data[i][45] || '').trim() });
  }
  // The staff list changes about once a week; five minutes meant re-reading a
  // whole second spreadsheet many times an hour during a shift.
  // Long enough to stop re-reading a second spreadsheet many times an hour, short
  // enough that somebody added to STAFF can use the app within a few minutes.
  try { cache.put('driver-app:roster:v2', JSON.stringify(list), 900); } catch (e3) {}
  DRIVER_ROSTER_MEMO_ = list;
  return list;
}

// Call after editing STAFF so the change is picked up straight away.
// Runnable from the Apps Script editor after adding somebody to STAFF, so the
// office does not have to wait out the cache.
function refreshDriverStaffRoster() { return refreshDriverStaffRoster_(); }

function refreshDriverStaffRoster_() {
  DRIVER_ROSTER_MEMO_ = null;
  try { CacheService.getScriptCache().remove('driver-app:roster:v2'); } catch (e) {}
  return driverStaffRoster_().length;
}

function driverAppIdentify_() {
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim(); } catch (err) {}
  const roster = driverStaffRoster_();
  const match = email ? roster.find(function(r) { return r.email && r.email === email; }) : null;
  return { email: email, name: match ? match.name : '', roster: roster };
}

function driverAppBootstrap() {
  const who = driverAppIdentify_();
  const out = {
    email: who.email,
    driver: who.name,
    roster: who.roster.filter(function(r) { return String(r.phone || '').replace(/\D/g, '').length >= 10; }).map(function(r) { return r.name; }),
    links: driverAppLinks_(),
    noShowWaitMinutes: DRIVER_NOSHOW_WAIT_MIN_
  };
  // V120 SPEED: the page already knows who is opening it, so it can carry their
  // day down with it. Without this the app rendered empty and the driver waited a
  // full round trip - on a phone, on cellular - before seeing a single trip.
  // The usual refresh still runs straight afterwards and replaces this.
  if (who.name) {
    try {
      // Skip the drive-time lookup here: it is an external call, and this runs
      // before a single byte of the page has been sent. The refresh that follows
      // a second later fills the times in.
      const day = getDriverDayPayload(who.name, 'today', '', true);
      if (day && day.ok) out.day = day;
    } catch (e) { Logger.log('bootstrap day skipped: ' + ((e && e.message) || e)); }
  }
  return out;
}

// One source of truth for BASE: when the address is set in code it also builds the
// drawer's BASE button, so the old hyperlink on the drivers sheet cannot disagree with
// it. Applied on the way out of BOTH paths, so an hour-old cache entry is corrected too.
function driverApplyBaseOverride_(links) {
  const out = links || {};
  if (DRIVER_BASE_ADDRESS_) out.base = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(DRIVER_BASE_ADDRESS_);
  return out;
}

function driverAppLinks_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('driver-app:links:v1');
  if (hit) { try { return driverApplyBaseOverride_(JSON.parse(hit)); } catch (e2) {} }
  const out = { base: '', dispatch: '', inspection: '', timecard: '', schedule: '' };
  try {
    const sh = SpreadsheetApp.openById(DRIVER_SHEET_ID_).getSheetByName('3');
    const linkOf = function(a1) {
      try {
        const rt = sh.getRange(a1).getRichTextValue();
        if (rt) {
          const direct = rt.getLinkUrl();
          if (direct) return direct;
          for (let k = 0; k < rt.getRuns().length; k++) { const u = rt.getRuns()[k].getLinkUrl(); if (u) return u; }
        }
      } catch (e3) {}
      try {
        const f = String(sh.getRange(a1).getFormula() || '');
        return '';
      } catch (e4) { return ''; }
    };
    const formulaUrl = function(a1) {
      const f = String(sh.getRange(a1).getFormula() || '');
      const bits = f.split(String.fromCharCode(34));
      return bits.length > 1 ? bits[1] : '';
    };
    out.timecard = linkOf('O4') || formulaUrl('O4');
    out.inspection = linkOf('L1') || formulaUrl('L1');
    out.dispatch = linkOf('E1') || formulaUrl('E1');
    out.base = linkOf('C1') || formulaUrl('C1');
    out.schedule = linkOf('S1') || formulaUrl('S1');
  } catch (err) {}
  try { cache.put('driver-app:links:v1', JSON.stringify(out), 3600); } catch (e5) {}
  return driverApplyBaseOverride_(out);
}

function driverMatches_(tripDriver, driverName) {
  const a = driverNorm_(tripDriver);
  const b = driverNorm_(driverName);
  if (!a || !b) return false;
  if (a === b) return true;

  // V120: the old rule accepted any run of letters found inside the other name, so
  // "Lee" matched "Ashleen" and one driver could see - and complete - another
  // driver's trips. This decides authorisation, so it now works on whole name
  // parts and never guesses from a prefix.
  //
  //   matches:  "Mike"/"Mike Johnson"      a whole part
  //             "Blasse"/"Nathaniel Blasse"
  //             "Johnson, Mike"/"Mike Johnson"
  //             "Obrien"/"Maureen O'Brien"  apostrophes are ignored
  //             "Vanderberg"/"Van Der Berg" a compound surname written solid
  //             "Jose"/"Jose Ramirez"       accents are folded away
  //             "Mike J"/"Mike Johnson"     first name in full, then an initial
  //
  //   refuses:  "Lee"/"Ashleen Baker"       only inside a word
  //             "Dan"/"Danielle Carter"     a prefix is not a name
  //             "Dan Rivera"/"Danielle Rivera"
  //             "M Johnson"/"Mary Johnson"  an initial cannot carry the match
  const pa = driverNameParts_(tripDriver), pb = driverNameParts_(driverName);
  if (!pa.length || !pb.length) return false;
  const ja = pa.join(''), jb = pb.join('');
  const few = ja.length <= jb.length ? pa : pb;
  const many = ja.length <= jb.length ? pb : pa;

  // 1. every part of the shorter name is a whole part of the longer one
  if (few.every(function(t) { return many.indexOf(t) >= 0; })) return true;

  // 2. the shorter name written solid is a run of the longer one's parts
  const joined = few.join('');
  for (let i = 0; i < many.length; i++) {
    let acc = '';
    for (let j = i; j < many.length; j++) {
      acc += many[j];
      if (acc === joined) return true;
      if (acc.length > joined.length) break;
    }
  }

  // 3. the first name matches in full, and the rest are initials of real parts.
  //    Requiring the FIRST part in full is what separates "Mike J" (fine) from
  //    "M Johnson" (ambiguous between Mike and Mary Johnson, so refused).
  if (few.length > 1 && many.indexOf(few[0]) >= 0) {
    const rest = few.slice(1).every(function(t) {
      if (many.indexOf(t) >= 0) return true;
      return t.length === 1 && many.some(function(u) { return u.charAt(0) === t; });
    });
    if (rest) return true;
  }

  // 4. Last resort: a short form the rules above cannot see - "Chris" for
  //    "Christopher", "Rick" for "Patrick", "Al" for "Alberto". Drivers rely on
  //    these and they all worked before. Two things keep them safe. First, the
  //    short form must line up with the START or the END of a whole name part,
  //    never the middle - which is what let "Lee" match "AshLEEn". Second, the
  //    roster has to agree there is only one driver it could possibly mean.
  return driverUniqueShortForm_(tripDriver, driverName);
}

// One way of splitting a name, used everywhere: accents folded, apostrophes
// ignored, split on anything that is not a letter or a digit.
function driverNameParts_(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // Jose == Jose
    .toLowerCase()
    .replace(/['\u2019]/g, '')                          // OBrien == O'Brien
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Is every part of `few` a whole part of `many`, or a recognisable shortening of
// one? A shortening has to sit at the start of the part ("Chris" of
// "Christopher") or at the end ("Rick" of "Patrick"). An ending has to be at
// least four letters, because three-letter tails match far too much - which is
// how "Ana" would otherwise pick up "Dana" and "Los" would pick up "Carlos".
function driverShortFormOf_(few, many) {
  if (!few.length || !many.length) return false;
  return few.every(function(t) {
    return many.some(function(u) {
      if (u === t) return true;
      if (u.length <= t.length) return false;
      if (t.length >= 2 && u.indexOf(t) === 0) return true;
      if (t.length >= 4 && u.lastIndexOf(t) === u.length - t.length) return true;
      return false;
    });
  });
}

function driverUniqueShortForm_(tripDriver, driverName) {
  const pa = driverNameParts_(tripDriver), pb = driverNameParts_(driverName);
  if (!pa.length || !pb.length) return false;
  const shorter = pa.join('').length <= pb.join('').length ? pa : pb;
  const longer = pa.join('').length <= pb.join('').length ? pb : pa;
  if (!driverShortFormOf_(shorter, longer)) return false;
  let roster = [];
  try { roster = driverStaffRoster_() || []; } catch (e) { return false; }
  if (!roster.length) return false;
  let hits = 0, only = '';
  for (let i = 0; i < roster.length; i++) {
    const rp = driverNameParts_(roster[i] && roster[i].name);
    if (!rp.length) continue;
    if (driverShortFormOf_(shorter, rp) || driverShortFormOf_(rp, shorter)) {
      hits += 1;
      only = driverNorm_(roster[i].name);
      if (hits > 1) return false;      // more than one driver it could mean
    }
  }
  // Either side may be the roster name - this is called in both orders, and the
  // texts and emails go out through the reverse one.
  return hits === 1 && (only === driverNorm_(tripDriver) || only === driverNorm_(driverName));
}

function driverDateKey_(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// V107: the office's own wall clock for this instant, in the spreadsheet's
// timezone and in the same shape the progress stamps arrive in. A page that
// parses this the way it parses a stamp learns exactly how far its own idea
// of the time is out, and can correct every stamp by that amount.
function driverServerClock_() {
  try {
    const tz = activeSpreadsheet_().getSpreadsheetTimeZone();
    return Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss");
  } catch (e) { return ''; }
}

function driverTripView_(tp) {
  return {
    key: String(tp.tripKeyID || ''),
    time: String(tp.time || ''),
    passenger: String(tp.passenger || ''),
    phone: String(tp.phone || ''),
    transport: String(tp.transport || ''),
    pickup: String(tp.pickup || ''),
    dropoff: String(tp.dropoff || ''),
    notes: String(tp.notes || ''),
    pickupNotes: String(tp.pickupNotes || ''),
    dropoffNotes: String(tp.dropoffNotes || ''),
    status: String(tp.status || ''),
    dispatchStatus: String(tp.dispatchStatus || ''),
    pickupArrival: String(tp.pickupArrival || ''),
    pickupDeparture: String(tp.pickupDeparture || ''),
    dropoffArrival: String(tp.dropoffArrival || ''),
    dropoffDeparture: String(tp.dropoffDeparture || '')
  };
}

// V120: this returned three different kinds of number depending on how the sheet
// happened to store the time - a negative 1899 epoch for one trip, a positive 2026
// epoch for another, plain minutes for a third. Sorted together, a 9:30 PM trip
// landed at the top of the driver's morning. Everything is now minutes past
// midnight, and a trip with no time sorts last rather than first.
function driverTimeSortKey_(v) {
  const s = String(v == null ? '' : v);
  let m = /(?:^|T)(\d{1,2}):(\d{2})/.exec(s);
  if (!m) m = /(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return 24 * 60 + 1;
  let h = Number(m[1]);
  const up = s.toUpperCase();
  // V120: \bPM\b needs a word break before the P, and "9:30pm" has a digit there -
  // so a trip typed that way sorted into the driver's morning.
  if (/P\.?M\.?(?![A-Z])/.test(up) && h < 12) h += 12;
  if (/A\.?M\.?(?![A-Z])/.test(up) && h === 12) h = 0;
  if (h > 23) return 24 * 60 + 1;
  return h * 60 + Number(m[2]);
}

function driverTimeSortKey_LEGACY_UNUSED_(v) {
  const s = String(v || '');
  const t = Date.parse(s);
  if (!isNaN(t)) return t;
  const mm = s.match(/(\d+):(\d+)/);
  if (!mm) return 0;
  let h = Number(mm[1]);
  const isPm = s.toUpperCase().indexOf('PM') >= 0;
  if (isPm && h < 12) h += 12;
  if (!isPm && h === 12) h = 0;
  return h * 60 + Number(mm[2]);
}

function getDriverDayPayload(driverName, which, token, skipDrive) {
  const who = driverAppIdentify_();
  const claimed = who.name || String(driverName || '').trim();
  if (!claimed) return { ok: false, reason: 'unknown', email: who.email };
  // V84: a name tapped from the picker only counts once this phone has been through a
  // texted code. An email the STAFF sheet knows still walks straight in.
  const problem = driverAccessProblem_(claimed, token, !!who.name);
  if (problem) return { ok: false, reason: problem, driver: claimed, email: who.email, build: DRIVER_APP_BUILD_ };
  const name = claimed;
  const offset = (String(which || '') === 'tomorrow') ? 1 : 0;
  const key = driverDateKey_(offset);
  let trips = [];
  try { trips = tripManager.getTripsByDate(key) || []; } catch (err) {}
  const mine = trips.filter(function(tp) { return tp && driverMatches_(tp.driver, name); }).map(driverTripView_);
  mine.sort(function(a, b) { return driverTimeSortKey_(a.time) - driverTimeSortKey_(b.time); });
  if (!offset) {
    try {
      const st = driverStartTimes_();
      mine.forEach(function(tp) { if (tp && st[tp.key]) tp.startTime = st[tp.key]; });
    } catch (eSt) {}
  }
  // V120: skipped when this is building the page itself - the drive time is an
  // external lookup, and nothing should hold up the first byte of the page for it.
  if (!offset && !skipDrive) { try { driverAttachDrive_(mine); } catch (eDr) {} }
  return { ok: true, driver: name, dateKey: key, which: offset ? 'tomorrow' : 'today', trips: mine,
    serverNow: Date.now(), serverClock: driverServerClock_(), build: DRIVER_APP_BUILD_ };
}

function driverStartTimes_() {
  const cacheKey = 'driver-app:starts:v1';
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (eC) {}
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) { try { return JSON.parse(hit); } catch (eP) {} }
  }
  const out = {};
  try {
    const sheet = activeSpreadsheet_().getSheetByName('DISPATCH');
    const last = sheet ? sheet.getLastRow() : 0;
    if (last >= 2) {
      const keys = sheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1, last - 1, 1).getDisplayValues();
      const starts = sheet.getRange(2, COLUMN.DISPATCH.START_TIME + 1, last - 1, 1).getDisplayValues();
      for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i][0] || '').trim();
        const s = String(starts[i][0] || '').trim();
        if (k && s && !/^11:58\s*PM$/i.test(s) && s !== '23:58') out[k] = s;   // V100: 11:58 PM was the stand-in for blank
      }
    }
  } catch (eR) {}
  try { if (cache) cache.put(cacheKey, JSON.stringify(out), 60); } catch (eW) {}
  return out;
}

function driverFindDispatchRow_(sheet, key) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const keys = sheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1, last - 1, 1).getDisplayValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0] || '').trim() === key) return i + 2;
  }
  return 0;
}

// V120: a phone that loses signal re-sends. Remembering what each send did, for
// long enough to cover any retry, makes a repeat harmless.
function driverNonceKey_(n) {
  // Hashed, so however long a trip key grows the cache key stays well inside the
  // 250-character limit and two different taps can never collide.
  try {
    const d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(n || ''), Utilities.Charset.UTF_8);
    return 'driver-nonce:' + Utilities.base64EncodeWebSafe(d);
  } catch (e) { return 'driver-nonce:' + String(n || '').slice(0, 120); }
}
function driverNonceSeen_(n) {
  try {
    const raw = CacheService.getScriptCache().get(driverNonceKey_(n));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function driverNonceRemember_(n, result) {
  // Six hours - the longest the cache accepts. Asking for more is rejected
  // outright, which would leave nothing remembered at all and quietly undo the
  // whole point of this. Failures are logged rather than swallowed for the same
  // reason: a guard that has stopped working must not do so invisibly.
  try { CacheService.getScriptCache().put(driverNonceKey_(n), JSON.stringify(Object.assign({}, result, { duplicate: true })), 21600); }
  catch (e) { Logger.log('driverNonceRemember_: ' + ((e && e.message) || e)); }
}
// Held only while the tap is being handled, so a second copy of the same tap
// arriving at the same moment waits rather than running the work twice.
// Returns false when the claim could not be written - which means a re-send
// could not be recognised, so the safe thing is to ask the phone to try again
// rather than run the work unprotected and risk doing it twice.
function driverNonceClaim_(n) {
  // Long enough to cover the slowest a request can be - a cancel waits on the
  // board lock, rewrites the record and sends a text, which on a busy morning is
  // well past half a minute. A claim that expired first would let the phone's
  // retry run the whole thing again and text the driver a second cancellation.
  // Safe to hold, because every exit path either releases it or replaces it.
  try {
    CacheService.getScriptCache().put(driverNonceKey_(n), JSON.stringify({ ok: false, reason: 'inflight', message: 'Still saving that step.' }), 400);
    return true;
  } catch (e) {
    Logger.log('driverNonceClaim_: ' + ((e && e.message) || e));
    return false;
  }
}
function driverNonceForget_(n) {
  try { CacheService.getScriptCache().remove(driverNonceKey_(n)); } catch (e) {}
}

// V120: the order the steps run in, so a late-arriving repeat of an earlier tap
// can be recognised and ignored rather than moving the trip backwards.
const DRIVER_STEP_RANK_ = { '': 0, 'IN ROUTE': 1, 'PICKUP LOCATION': 2, 'INTRANSIT': 3, 'DROPOFF LOCATION': 4, 'COMPLETE': 5 };

function driverSetTripStep(tripKeyID, step, driverName, token, nonce) {
  const key = String(tripKeyID || '').trim();
  if (!key) throw new Error('Missing trip.');
  const gate = driverActionGate_(driverName, token, key);
  if (!gate.ok) return gate;
  const s = String(step || '').toLowerCase();
  // V120 SPEED: set for the whole tap, including no-show and cancel, so a 120-day
  // statistics rebuild can never start with a driver's phone waiting on it.
  DRIVER_TAP_IN_PROGRESS_ = true;
  try {
    return driverHandleTap_(key, s, step, nonce);
  } finally {
    DRIVER_TAP_IN_PROGRESS_ = false;
  }
}

function driverHandleTap_(key, s, step, nonce) {
  // V120: a phone with no signal re-sends. The progress steps recognise a repeat
  // by their own order, but no-show and cancel have no order to compare against -
  // so without this a re-sent cancel re-stamped the time and texted the driver a
  // second cancellation. The nonce the phone sends makes a repeat a no-op.
  if (nonce) {
    const seen = driverNonceSeen_(nonce);
    if (seen) return seen;
    // Claim the nonce straight away. Two copies of the same tap can be in flight
    // at once (the phone gives up waiting after twenty seconds and re-sends), and
    // without this both would run - which for a cancel means the driver is texted
    // twice. If the claim cannot be written there is no protection at all, so ask
    // the phone to try again rather than risk doing the work twice.
    if (!driverNonceClaim_(nonce)) {
      return { ok: false, reason: 'record', message: 'Dispatch is busy. This will be sent again.' };
    }
  }
  if (s === 'noshow' || s === 'cancel') {
    let res;
    try {
      res = (s === 'noshow') ? setTripQuickStatusSingle_(key, 'NO SHOW') : setTripQuickStatusSingle_(key, 'CANCEL');
    } catch (eQ) {
      // A throw used to leave the claim standing for a full minute. Every retry
      // in that minute got "still saving", the phone used up its attempts, and
      // the real reason - a day the office has already closed, say - never
      // reached the driver.
      if (nonce) driverNonceForget_(nonce);
      throw eQ;
    }
    // Remember it whenever the board was actually written - including the case
    // where the board took the change but the record did not. Otherwise a retry
    // writes the board a second time and texts the driver another cancellation.
    if (nonce && res && (res.ok !== false || res.boardWritten)) driverNonceRemember_(nonce, res);
    else if (nonce) driverNonceForget_(nonce);
    return res;
  }
  // V120: setTripQuickStatus deliberately cancels the linked return leg as well,
  // which is right when a dispatcher does it from the board and wrong from a
  // phone: the return leg may belong to another driver, who was never checked by
  // the gate above and simply watched the trip vanish. A driver's tap now touches
  // this leg only.
  const map = {
    inroute: { label: 'IN ROUTE', stamp: -1, extra: -1, field: '' },
    pickupin: { label: 'PICKUP LOCATION', stamp: COLUMN.DISPATCH.PICKUP_IN_AT, extra: COLUMN.DISPATCH.IN, field: 'pickupArrival' },
    intransit: { label: 'INTRANSIT', stamp: COLUMN.DISPATCH.INTRANSIT_AT, extra: -1, field: 'pickupDeparture' },
    arrived: { label: 'DROPOFF LOCATION', stamp: COLUMN.DISPATCH.ARRIVED_AT, extra: -1, field: 'dropoffArrival' },
    complete: { label: 'COMPLETE', stamp: COLUMN.DISPATCH.COMPLETED_AT, extra: COLUMN.DISPATCH.OUT, field: 'dropoffDeparture' }
  };
  const conf = map[s];
  if (!conf) { if (nonce) driverNonceForget_(nonce); throw new Error('Unknown step: ' + step); }
  let res;
  try {
    res = driverSetTripStepInner_(key, s, conf);
  } catch (eI) {
    if (nonce) driverNonceForget_(nonce);
    throw eI;
  }
  if (nonce && res && res.ok !== false) driverNonceRemember_(nonce, res);
  else if (nonce) driverNonceForget_(nonce);
  return res;
}

function driverSetTripStepInner_(key, s, conf) {
  const tz = activeSpreadsheet_().getSpreadsheetTimeZone();
  const now = new Date();
  const todayKey = driverDateKey_(0);
  // V120: the dispatcher's own status change checks this; a driver's tap did not,
  // so stamps could still land on a day the office had closed off as history.
  try { assertDateNotSubmitted_(todayKey); }
  catch (eSub) { return { ok: false, reason: 'submitted', message: String((eSub && eSub.message) || eSub) }; }
  const sheet = activeSpreadsheet_().getSheetByName('DISPATCH');
  let row = 0;
  let duplicate = false;
  // V120: the row was looked up and written with no lock held, so a board re-sort
  // finishing in between could move the rows and put this driver's arrival stamp
  // on a different passenger's line - which is what the "misplaced driver status"
  // repair has been cleaning up. Find the row and write it under the same lock
  // everything else uses.
  let boardBusy = false;
  try {
  withTripsDocumentLock_(function() {
    row = sheet ? driverFindDispatchRow_(sheet, key) : 0;
    if (!row) return;
    const statusCell = sheet.getRange(row, COLUMN.DISPATCH.STATUS + 1);
    const cur = String(statusCell.getDisplayValue() || '').toUpperCase().trim();
    const curRank = DRIVER_STEP_RANK_[cur] === undefined ? 0 : DRIVER_STEP_RANK_[cur];
    const newRank = DRIVER_STEP_RANK_[conf.label] === undefined ? 0 : DRIVER_STEP_RANK_[conf.label];
    // A phone with no signal re-sends. Without this, a delayed copy of an earlier
    // tap arriving after a later one pulled the trip back a step, and the driver's
    // next tap then skipped a stamp.
    if (newRank <= curRank) { duplicate = true; return; }
    statusCell.setValue(conf.label);
    if (conf.stamp >= 0) {
      const stampCell = sheet.getRange(row, conf.stamp + 1);
      if (!stampCell.getValue()) stampCell.setValue(now).setNumberFormat('h:mm AM/PM');
    }
    if (conf.extra >= 0) {
      const extraCell = sheet.getRange(row, conf.extra + 1);
      if (!extraCell.getValue()) extraCell.setValue(now).setNumberFormat('h:mm AM/PM');
    }
    SpreadsheetApp.flush();
  });
  } catch (eLock) {
    // waitLock throws when the board is busy. Saying so lets the phone keep the
    // tap and send it again, instead of giving up on it.
    boardBusy = true;
    Logger.log('driver board write: ' + ((eLock && eLock.message) || eLock));
  }
  if (boardBusy) return { ok: false, reason: 'record', message: 'The board was busy. This will be sent again.' };
  // V120: the full board rebuild used to run on EVERY tap - 192 times on a busy
  // morning, each one holding the board lock for a second or more. The record is
  // written directly below, so the rebuild is only needed to pick up the two
  // board-computed columns, and only when this tap actually changed something.
  if (row && !duplicate) { try { snapshotDispatchToLog(false, true); } catch (e2) {} }
  if (duplicate) {
    // The board already shows this step, but the record may not - a previous tap
    // whose record write failed leaves exactly that state - so still reconcile.
    try {
      withTripsDocumentLock_(function() {
        (tripManager.getTripsByDate(driverDateKey_(0)) || []).forEach(function(tp) {
          if (!tp || String(tp.tripKeyID || '').trim() !== key) return;
          // The state this repairs is "board advanced, record did not" - which is
          // produced when the first tap's record write timed out. That write
          // carried the stamp as well as the status, so restoring only the status
          // would leave a later stamp filled and this one blank: exactly the
          // pattern repairSkippedStepStamps exists to clean up.
          const dFields = [], dOver = {};
          if (String(tp.status || '').toUpperCase().trim() !== conf.label) { dFields.push('status'); dOver.status = conf.label; }
          if (conf.field && !tp[conf.field]) {
            dFields.push(conf.field);
            dOver[conf.field] = Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss");
          }
          if (dFields.length) tripManager.updateTripInLog(tp, dFields, dOver);
        });
      });
    } catch (eDup) { Logger.log('duplicate reconcile: ' + ((eDup && eDup.message) || eDup)); }
    return { ok: true, step: s, status: conf.label, duplicate: true,
             at: Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss") };
  }
  const iso = Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss");
  // V75: hold the trips lock, and name the fields being changed, so a dispatcher
  // saving at the same moment neither loses their edit nor drops another trip.
  let ttTrip = null;   // V106: the trip as just saved, for its TRIP_TIMES row
  try {
    withTripsDocumentLock_(function() {
      (tripManager.getTripsByDate(todayKey) || []).forEach(function(tp) {
        if (!tp || String(tp.tripKeyID || '').trim() !== key) return;
        const fields = ['status'];
        const overrides = { status: conf.label };
        if (conf.field && !tp[conf.field]) { fields.push(conf.field); overrides[conf.field] = iso; }
        tripManager.updateTripInLog(tp, fields, overrides);
        ttTrip = Object.assign({}, tp, overrides);
      });
    });
  } catch (e3) {}
  // The wait-time row is refreshed after the trips lock is released; it takes its
  // own short lock and never throws, so a driver's tap cannot fail because of it.
  if (ttTrip) { try { tripTimesRecord_(ttTrip); } catch (e4) {} }
  // V120: when the trip was not on the board and not in today's records, every
  // write above was skipped and this still returned ok - so a driver tapped
  // through a whole trip, saw no warning at all, and nothing was ever recorded.
  if (!row && !ttTrip) return { ok: false, reason: 'notfound' };
  return { ok: true, step: s, status: conf.label, at: iso, onBoard: !!row };
}

function driverRunningLate(tripKeyID, reason, driverName, token) {
  const key = String(tripKeyID || '').trim();
  if (!key) throw new Error('Missing trip.');
  const gate = driverActionGate_(driverName, token, key);
  if (!gate.ok) return gate;
  const tz = activeSpreadsheet_().getSpreadsheetTimeZone();
  let cleanReason = String(reason || '').replace(/[^A-Za-z0-9 ,.:()-]/g, '').slice(0, 120).trim();
  // V120: the phone used to format its own clock and send the finished time, which
  // was then written permanently into the dispatcher's note. On a phone an hour
  // out that note said the wrong thing and could never be corrected. The phone now
  // sends how far away it is and the office reads its own clock.
  let etaText = '';
  const etaM = /in (\d{1,3}) min/i.exec(cleanReason);
  if (etaM) {
    etaText = ' ETA ' + Utilities.formatDate(new Date(Date.now() + Number(etaM[1]) * 60000), tz, 'h:mm a');
    cleanReason = cleanReason.replace(/\s*-?\s*Auto\s*-\s*ETA in \d{1,3} min/i, '').replace(/\s*-?\s*ETA in \d{1,3} min/i, '').trim();
    if (!cleanReason) cleanReason = 'Auto';
  }
  const stampText = 'DRIVER RUNNING LATE' + (cleanReason ? ' (' + cleanReason + ')' : '') + etaText + ' ' + Utilities.formatDate(new Date(), tz, 'h:mm a');
  const sheet = activeSpreadsheet_().getSheetByName('DISPATCH');
  const row = sheet ? driverFindDispatchRow_(sheet, key) : 0;
  if (row) {
    const cell = sheet.getRange(row, COLUMN.DISPATCH.NOTES + 1);
    const cur = String(cell.getDisplayValue() || '').trim();
    if (cur.indexOf('DRIVER RUNNING LATE') < 0) cell.setValue(cur ? cur + ' | ' + stampText : stampText);
    SpreadsheetApp.flush();
    try { snapshotDispatchToLog(false, true); } catch (e2) {}
  }
  // V75: same lock as every other write path, and only the notes field is written.
  try {
    withTripsDocumentLock_(function() {
      (tripManager.getTripsByDate(driverDateKey_(0)) || []).forEach(function(tp) {
        if (!tp || String(tp.tripKeyID || '').trim() !== key) return;
        const cur = String(tp.notes || '').trim();
        if (cur.indexOf('DRIVER RUNNING LATE') < 0) {
          tripManager.updateTripInLog(tp, ['notes'], { notes: cur ? cur + ' | ' + stampText : stampText });
        }
      });
    });
  } catch (e3) {}
  return { ok: true, note: stampText };
}

// ---- driver alerts: carrier text AND email (V98) ----------------------------
// The free carrier gateways are mostly switched off now (see the sign-in notes
// further down), so an alert that only went out as a text was reaching almost
// nobody. Every alert now also goes to the driver's email on STAFF. The text is
// kept as a bonus for the carriers that still accept one.
function driverAlertSubject_(message) {
  let s = String(message || '').split('\n')[0].replace(/^AMAZING GRACE:\s*/i, '').trim();
  const stop = s.search(/[.!]\s|$/);
  if (stop > 0) s = s.slice(0, stop);
  if (s.length > 70) s = s.slice(0, 67) + '...';
  return 'Amazing Grace: ' + (s || 'trip update');
}

// One carrier text, nothing else. Returns true only when Google accepted it.
function sendDriverGatewayText_(rec, message) {
  try {
    if (!rec || !rec.phone || !rec.carrier) return false;
    const smsEmail = getSmsEmail(rec.phone, String(rec.carrier).toLowerCase().trim());
    if (!smsEmail) return false;
    MailApp.sendEmail({ to: smsEmail, subject: '', body: message });
    return true;
  } catch (err) { return false; }
}

// One ordinary email. Returns true only when Google accepted it.
function sendDriverEmail_(rec, subject, body) {
  try {
    if (!driverHasEmail_(rec)) return false;
    MailApp.sendEmail({ to: String(rec.email).trim(), subject: subject, body: body });
    return true;
  } catch (err) {
    Logger.log('sendDriverEmail_: ' + ((err && err.message) || err));
    return false;
  }
}

// An alert to a driver, by every route on file. True if at least one went.
function sendDriverText_(driverName, message, subject) {
  if (!DRIVER_TEXTS_ENABLED_) return false;
  let rec = null;
  try {
    const roster = driverStaffRoster_();
    rec = roster.find(function(r) { return driverMatches_(r.name, driverName); }) || null;
  } catch (err) { return false; }
  if (!rec) return false;
  // V101: the TEXT never carries a link. Carrier gateways treat a message with a
  // web address - a shortened one above all - as spam, and once they flag the
  // sender they drop everything from it for a while. Texts arrived on Thursday
  // 3 Sep with no link in them and stopped the evening the links began. The email
  // keeps the link; the text ends the way Thursday's did.
  const byText = sendDriverGatewayText_(rec, driverTextOnly_(message));
  const byMail = sendDriverEmail_(rec, subject ? ('Amazing Grace: ' + subject) : driverAlertSubject_(message), message);
  return byText || byMail;
}

// The alert without its link line, ending "Check your Driver App."
function driverTextOnly_(message) {
  const kept = String(message || '').split('\n')
    .filter(function(l) { return !/^\s*Open your Driver App:/i.test(l) && !/https?:\/\//i.test(l); })
    .join(' ').replace(/\s+/g, ' ').trim();
  if (!kept) return String(message || '');
  return /Check your Driver App\.?$/i.test(kept) ? kept : kept + ' Check your Driver App.';
}

// ---- V100: times and dates in alerts read like a person wrote them ---------
// A time reaches here as "1899-12-30T17:30:00.000Z" (how a 5:30 PM cell travels
// through the code), as "17:30", as "5:30 PM", or as a Date. All become "5:30 PM".
function driverClock_(v) {
  if (v === undefined || v === null || v === '') return '';
  let h = null, m = null;
  if (typeof v === 'string') {
    const s = v.trim();
    let mm = s.match(/T(\d{2}):(\d{2})/);
    if (!mm) mm = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
    if (mm) {
      h = Number(mm[1]); m = Number(mm[2]);
      const ap = (mm[3] || '').toUpperCase();
      if (ap === 'PM' && h < 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
    } else {
      return s;
    }
  } else if (v && typeof v.getHours === 'function') {
    try { return Utilities.formatDate(v, Session.getScriptTimeZone(), 'h:mm a'); } catch (e) { return ''; }
  } else {
    return String(v);
  }
  if (h === null || isNaN(h) || isNaN(m)) return String(v);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + ('0' + m).slice(-2) + ' ' + ap;
}

// "2026-09-06" -> "Sun, Sep 6"
function driverPrettyDate_(v) {
  if (!v) return '';
  const s = String(v);
  const mm = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let d = null;
  if (mm) d = new Date(Number(mm[1]), Number(mm[2]) - 1, Number(mm[3]), 12, 0, 0);
  else if (v && typeof v.getFullYear === 'function') d = v;
  if (!d || isNaN(d)) return s;
  try { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'EEE, MMM d'); } catch (e) { return s; }
}

// "Sun, Sep 6 at 5:30 PM"
function driverAlertWhen_(trip) {
  const day = driverPrettyDate_(trip && trip.date);
  const clock = driverClock_(trip && trip.time);
  if (day && clock) return day + ' at ' + clock;
  return day || clock || '';
}

function driverAlertKey_(dateKey) {
  const today = driverDateKey_(0);
  const tomorrow = driverDateKey_(1);
  const k = String(dateKey || '').trim();
  return k === today || k === tomorrow;
}

// True if this driver was already told about this trip in the last few minutes. The
// script cache expires on its own, so there is nothing to clean up afterwards.
function driverAlertThrottled_(tripKeyID, driverName) {
  try {
    const key = 'dalert:' + String(tripKeyID || '') + ':' + driverNorm_(driverName);
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return true;
    cache.put(key, '1', DRIVER_ALERT_QUIET_SEC_);
    return false;
  } catch (err) { return false; }
}

function driverAlertMarkSent_(tripKeyID, driverName) {
  try {
    CacheService.getScriptCache().put('dalert:' + String(tripKeyID || '') + ':' + driverNorm_(driverName), '1', DRIVER_ALERT_QUIET_SEC_);
  } catch (err) {}
}

// Which of the details a driver actually cares about changed? Uses the dispatcher's own
// list of edited fields when there is one, and otherwise compares against the trip as it
// was stored. An invoice number or a Medicaid # means nothing to the driver, so a save
// that only touches those sends nothing.
function driverAlertChanged_(trip, prev, changedFields) {
  if (Array.isArray(changedFields) && changedFields.length) {
    return changedFields.filter(function(f) { return DRIVER_ALERT_FIELDS_.indexOf(f) >= 0; });
  }
  if (!prev) return [];
  return DRIVER_ALERT_FIELDS_.filter(function(f) {
    return String(prev[f] == null ? '' : prev[f]).trim() !== String(trip[f] == null ? '' : trip[f]).trim();
  });
}

function driverAlertIsToday_(dateKey) {
  return String(dateKey || '') === driverDateKey_(0);
}

function driverAssignmentAlert_(trip, oldDriver, oldTime, prev, changedFields) {
  try {
    if (!trip || !driverAlertKey_(trip.date)) return;
    const newDriver = String(trip.driver || '').trim();
    const prevDriver = String(oldDriver || '').trim();
    const isToday = driverAlertIsToday_(trip.date);
    const line = 'AMAZING GRACE: ';
    // V100: "Sun, Sep 6 at 5:30 PM - Blasse, Nathaniel, from 127 Bermuda Blvd" (plain
    // hyphens on purpose: carrier text gateways mangle anything fancier)
    const when = driverAlertWhen_(trip);
    const who = String(trip.passenger || '').trim();
    const detail = when + (who ? ' - ' + who : '') + (String(trip.pickup || '').trim() ? ', from ' + String(trip.pickup).trim() : '');
    const link = '\nOpen your Driver App: ' + DRIVER_APP_LINK_;
    const key = String(trip.tripKeyID || trip.id || '');

    // A trip changing hands always goes out at once, quiet window or not.
    if (newDriver && !driverMatches_(prevDriver, newDriver)) {
      sendDriverText_(newDriver, line + 'NEW TRIP for you: ' + detail + '.' + link, 'New trip ' + when + (who ? ' - ' + who : ''));
      driverAlertMarkSent_(key, newDriver);
      if (prevDriver) sendDriverText_(prevDriver, line + 'Trip removed from you: ' + detail + '.' + link, 'Trip removed ' + when + (who ? ' - ' + who : ''));
      return;
    }
    if (!newDriver) return;

    if (oldTime && String(oldTime) !== String(trip.time || '')) {
      if (!driverAlertThrottled_(key, newDriver)) {
        sendDriverText_(newDriver, line + 'TIME CHANGED. Now ' + detail + '.' + link, 'Time changed - now ' + when + (who ? ' - ' + who : ''));
      }
      return;
    }

    // Anything else that changes their day. Today only: tomorrow keeps the older,
    // quieter behaviour of only calling out a hand-off or a moved time.
    if (!isToday) return;
    if (!driverAlertChanged_(trip, prev, changedFields).length) return;
    if (driverAlertThrottled_(key, newDriver)) return;
    sendDriverText_(newDriver, line + 'TRIP UPDATED today: ' + detail + '.' + link, 'Trip updated ' + when + (who ? ' - ' + who : ''));
  } catch (err) {}
}

function driverCancelAlert_(trip, newStatus) {
  try {
    if (!trip || !driverAlertKey_(trip.date)) return;
    const drv = String(trip.driver || '').trim();
    if (!drv) return;
    const raw = String(newStatus || 'CANCEL').toUpperCase().trim();
    // V120: a second line of defence behind the re-send guard. The assignment
    // alerts have always had a quiet window; this one did not, so a repeat could
    // reach the driver as a second cancellation text for the same trip.
    if (driverAlertThrottled_('cancel:' + String(trip.tripKeyID || '') + ':' + raw, drv)) return;
    const label = raw === 'CANCEL' ? 'CANCELED' : raw === 'REASSIGN' ? 'REASSIGNED' : raw;   // "NO SHOW" stays
    const when = driverAlertWhen_(trip);
    const who = String(trip.passenger || '').trim();
    sendDriverText_(drv, 'AMAZING GRACE: Trip ' + label + ': ' + when + (who ? ' - ' + who : '') + '.\nOpen your Driver App: ' + DRIVER_APP_LINK_,
      'Trip ' + label.charAt(0) + label.slice(1).toLowerCase() + ' ' + when + (who ? ' - ' + who : ''));
  } catch (err) {}
}





// ---- drive-time / leave-by estimates for the Driver App header ----
const DRIVER_BASE_ADDRESS_ = '53 Violet Ave, Poughkeepsie, NY 12601';
const DRIVER_LEAVE_BUFFER_MIN_ = 10;

function driverAddressFromMapsUrl_(url) {
  try {
    const u = String(url || '');
    let m = u.match(/[?&](?:q|query|destination|daddr)=([^&#]+)/i);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, ' ')).replace(/@.*$/, '').trim();
    m = u.match(/\/maps\/(?:place|search)\/([^/@?#]+)/i);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
    m = u.match(/\/maps\/dir\/[^/]*\/([^/@?#]+)/i);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  } catch (e) {}
  return '';
}

function driverBaseAddress_() {
  if (DRIVER_BASE_ADDRESS_) return DRIVER_BASE_ADDRESS_;
  try { return driverAddressFromMapsUrl_((driverAppLinks_() || {}).base); } catch (e) { return ''; }
}

function driverDriveMinutes_(origin, dest) {
  const isCoord = !!(origin && typeof origin === 'object' && origin.lat != null && origin.lng != null);
  const o = isCoord ? (Number(origin.lat).toFixed(5) + ',' + Number(origin.lng).toFixed(5)) : String(origin || '').trim();
  const d = String(dest || '').trim();
  if (!o || !d) return null;
  const cache = CacheService.getScriptCache();
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, (o + '|' + d).toLowerCase(), Utilities.Charset.UTF_8);
  const key = 'driver-app:drive:' + Utilities.base64EncodeWebSafe(raw);
  const hit = cache.get(key);
  if (hit) return hit === 'x' ? null : Number(hit);
  let mins = null;
  try {
    const df = Maps.newDirectionFinder().setDestination(d).setMode(Maps.DirectionFinder.Mode.DRIVING);
    if (isCoord) { df.setOrigin(Number(origin.lat), Number(origin.lng)); } else { df.setOrigin(o); }
    const res = df.getDirections();
    const leg = res && res.routes && res.routes[0] && res.routes[0].legs && res.routes[0].legs[0];
    if (leg && leg.duration && leg.duration.value) mins = Math.max(1, Math.round(leg.duration.value / 60));
  } catch (e) {}
  try { cache.put(key, mins === null ? 'x' : String(mins), 600); } catch (e2) {}
  return mins;
}

function driverIsOver_(tp) {
  const d = driverNorm_(tp.dispatchStatus);
  return d === 'cancel' || d === 'canceled' || d === 'cancelled' || d === 'noshow' || d === 'reassign' || d === 'notconfirmed';
}

function driverAttachDrive_(mine) {
  let nextIdx = -1;
  for (let i = 0; i < mine.length; i++) {
    const tp = mine[i];
    if (driverIsOver_(tp) || driverNorm_(tp.status) === 'complete') continue;
    nextIdx = i; break;
  }
  if (nextIdx < 0) return;
  const next = mine[nextIdx];
  let origin = '', fromLabel = '';
  for (let j = nextIdx - 1; j >= 0; j--) {
    const s = driverNorm_(mine[j].status);
    if ((s === 'complete' || s === 'dropofflocation') && mine[j].dropoff) { origin = mine[j].dropoff; fromLabel = 'previous drop-off'; break; }
  }
  if (!origin) { origin = driverBaseAddress_(); fromLabel = 'BASE'; }
  const mins = origin ? driverDriveMinutes_(origin, next.pickup) : null;
  next.drive = { min: mins, fromLabel: fromLabel, approx: true };
}

function driverDriveFromLocation(tripKeyID, lat, lng, driverName, token) {
  const key = String(tripKeyID || '').trim();
  const la = Number(lat), ln = Number(lng);
  if (!key || isNaN(la) || isNaN(ln)) return { ok: false };
  const gate = driverActionGate_(driverName, token, key);
  if (!gate.ok) return gate;
  let tp = null;
  try { tp = (tripManager.getTripsByDate(driverDateKey_(0)) || []).filter(function(t) { return t && String(t.tripKeyID || '').trim() === key; })[0]; } catch (e) {}
  if (!tp || !tp.pickup) return { ok: false };
  const mins = driverDriveMinutes_({ lat: la, lng: ln }, String(tp.pickup));
  return { ok: mins !== null, key: key, min: mins, fromLabel: 'your location', approx: false };
}


// ---- driver location-permission reporting (for the dispatcher view) ----
const DRIVER_GEO_PROP_ = 'driver-app:geo';
const DRIVER_GEO_FRESH_MS_ = 3 * 60 * 60 * 1000;
const DRIVER_GEO_KEEP_MS_ = 7 * 24 * 60 * 60 * 1000;

function driverGeoMap_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(DRIVER_GEO_PROP_);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (e) { return {}; }
}

function driverSetLocationState(driverName, state, token) {
  const s = String(state || '').toLowerCase();
  if (['granted', 'denied', 'prompt', 'unsupported'].indexOf(s) < 0) return { ok: false };
  // V120: every other driver endpoint goes through the gate; this one took the
  // name straight off the request, so anyone with the page's address could set
  // any driver's location state.
  let name = '';
  try {
    const who = driverAppIdentify_();
    if (who && who.name) name = who.name;
    else {
      const gate = driverActionGate_(String(driverName || '').trim(), token, '');
      if (!gate.ok) return gate;
      name = gate.name;
    }
  } catch (e) {
    // V120: this catch used to swallow the failure and carry on with the name the
    // request supplied - so the check it was added for did not actually hold when
    // the roster read was the thing that failed.
    return { ok: false, reason: 'verify' };
  }
  if (!name) return { ok: false };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (eL) {}
  try {
    const map = driverGeoMap_();
    map[name] = { s: s, t: Date.now() };
    const cutoff = Date.now() - DRIVER_GEO_KEEP_MS_;
    Object.keys(map).forEach(function(k) { if (!map[k] || !map[k].t || map[k].t < cutoff) delete map[k]; });
    PropertiesService.getScriptProperties().setProperty(DRIVER_GEO_PROP_, JSON.stringify(map));
  } catch (e2) {} finally { try { lock.releaseLock(); } catch (e3) {} }
  return { ok: true };
}

function getDriverGeoStates() {
  const map = driverGeoMap_();
  const out = {};
  const now = Date.now();
  Object.keys(map).forEach(function(k) {
    const v = map[k];
    if (!v || !v.t || (now - v.t) > DRIVER_GEO_FRESH_MS_) return;
    if (v.s === 'denied' || v.s === 'unsupported' || v.s === 'prompt') out[k] = v.s;
  });
  return out;
}


// ============================================================================
//  Driver sign-in codes (V84)
// ----------------------------------------------------------------------------
//  A driver whose Google email is on the STAFF sheet still walks straight in.
//  Anyone who has to tap their name from the list now has to prove it: a 6-digit
//  code is texted to the number on STAFF, and only that code opens the app.
//  Once a phone is verified it stays trusted, so this is a one-time hurdle per
//  device — but taking someone off STAFF cuts them off, because every load
//  re-checks the roster.
//
//  V97: the code goes out by EMAIL (column E on STAFF) and, as a bonus, by text
//  when a carrier is on file too (sendDriverText_ builds a carrier gateway address
//  from phone + carrier, but most of those gateways have now been switched off).
//  A driver with neither an email nor a carrier cannot be sent a code and is told
//  to ask dispatch — deliberately, so nobody slips through unverified.
//  driverStaffRoster_ caches for 5 minutes, so a roster change takes up to that
//  long to bite.
// ============================================================================

const DRIVER_CODE_TTL_SEC_ = 600;        // a code is good for ten minutes
const DRIVER_CODE_MAX_TRIES_ = 5;        // then the code is burned and they resend
const DRIVER_CODE_RESEND_SEC_ = 60;      // one text a minute per driver
const DRIVER_TRUST_PROPERTY_ = 'driverApp:trustedDevices:v1';
const DRIVER_TRUST_MAX_PER_DRIVER_ = 8;  // keeps the stored property small

function driverRosterFind_(name) {
  const key = driverNorm_(name);
  if (!key) return null;
  const roster = driverStaffRoster_() || [];
  for (let i = 0; i < roster.length; i++) {
    if (driverNorm_(roster[i].name) === key) return roster[i];
  }
  return null;
}

function driverPhoneDigits_(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return (d.length === 11 && d.charAt(0) === '1') ? d.slice(1) : d;
}

function driverHasPhone_(rec) { return !!rec && driverPhoneDigits_(rec.phone).length >= 10; }
function driverCanBeTexted_(rec) { return driverHasPhone_(rec) && !!String(rec.carrier || '').trim(); }

// "(845) •••-••42" — enough to recognise your own number, not enough to learn one.
function driverMaskPhone_(phone) {
  const d = driverPhoneDigits_(phone);
  if (d.length < 10) return '';
  return '(' + d.slice(0, 3) + ') •••-••' + d.slice(-2);
}

// ---- the code itself --------------------------------------------------------

function driverCodeCacheKey_(name) { return 'dvcode:' + driverNorm_(name); }
function driverResendKey_(name) { return 'dvsend:' + driverNorm_(name); }

function driverMakeCode_() {
  let code = '';
  for (let i = 0; i < 6; i++) code += String(Math.floor(Math.random() * 10));
  if (code.charAt(0) === '0') code = '1' + code.slice(1);   // never show a leading zero
  return code;
}

// A sign-in code can also go out as an ordinary email. The free carrier text
// gateways are being switched off one by one (AT&T and T-Mobile are already
// gone, Verizon is winding down), so email is the path we can actually rely on
// and the text is a bonus whenever the carrier still accepts it.
function driverHasEmail_(rec) {
  const e = String((rec && rec.email) || '').trim();
  const at = e.indexOf('@');
  return at > 0 && e.indexOf('.', at) > at + 1;
}

// "net***@gmail.com" - enough to recognise your own inbox, not enough to learn one.
function driverMaskEmail_(email) {
  const e = String(email || '').trim();
  const at = e.indexOf('@');
  if (at < 1) return '';
  return e.slice(0, Math.min(3, at)) + '•••' + e.slice(at);
}

function sendDriverCodeEmail_(rec, code) {
  try {
    if (!driverHasEmail_(rec)) return false;
    MailApp.sendEmail({
      to: String(rec.email).trim(),
      subject: code + ' is your Amazing Grace sign-in code',
      body: 'Hi ' + rec.name + ',\n\n'
        + code + ' is your sign-in code for the Amazing Grace driver app.\n'
        + 'It expires in 10 minutes.\n\n'
        + 'If this was not you, you can ignore this email.\n'
    });
    return true;
  } catch (errMail) {
    Logger.log('sendDriverCodeEmail_: ' + ((errMail && errMail.message) || errMail));
    return false;
  }
}

// Called when a driver taps their name in the picker.
function driverRequestCode(name) {
  const cleanName = String(name || '').trim();
  const rec = driverRosterFind_(cleanName);
  if (!rec) return { ok: false, reason: 'unknown' };
  const canText = DRIVER_TEXTS_ENABLED_ && driverCanBeTexted_(rec);
  const canMail = driverHasEmail_(rec);
  if (!canText && !canMail) {
    if (!driverHasPhone_(rec) && !rec.email) return { ok: false, reason: 'nophone', name: rec.name };
    if (!DRIVER_TEXTS_ENABLED_) return { ok: false, reason: 'textsoff', name: rec.name };
    return { ok: false, reason: 'nocarrier', name: rec.name };
  }
  const maskedMail = canMail ? driverMaskEmail_(rec.email) : '';
  const maskedPhone = canText ? driverMaskPhone_(rec.phone) : '';
  const bothWays = maskedMail && maskedPhone ? (maskedMail + ' and ' + maskedPhone) : (maskedMail || maskedPhone);

  const cache = CacheService.getScriptCache();
  if (cache.get(driverResendKey_(cleanName))) {
    return { ok: false, reason: 'toosoon', wait: DRIVER_CODE_RESEND_SEC_, masked: bothWays };
  }
  const code = driverMakeCode_();
  cache.put(driverCodeCacheKey_(cleanName), JSON.stringify({ code: code, tries: 0 }), DRIVER_CODE_TTL_SEC_);
  cache.put(driverResendKey_(cleanName), '1', DRIVER_CODE_RESEND_SEC_);
  const byMail = canMail ? sendDriverCodeEmail_(rec, code) : false;
  const byText = canText ? sendDriverGatewayText_(rec,
    'AMAZING GRACE: ' + code + ' is your sign-in code. It expires in 10 minutes. If this was not you, ignore this message.') : false;
  if (!byMail && !byText) {
    try { cache.remove(driverResendKey_(cleanName)); } catch (eResend) {}
    return { ok: false, reason: 'sendfailed', masked: bothWays };
  }
  const sentTo = byMail && byText ? (maskedMail + ' and ' + maskedPhone) : (byMail ? maskedMail : maskedPhone);
  const via = byMail && byText ? 'both' : (byMail ? 'email' : 'text');
  return { ok: true, masked: sentTo, via: via, name: rec.name, expires: DRIVER_CODE_TTL_SEC_ };
}

// ---- trusted phones ---------------------------------------------------------

function driverTrustMap_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(DRIVER_TRUST_PROPERTY_) || '{}');
  } catch (e) { return {}; }
}

function driverTrustSave_(map) {
  PropertiesService.getScriptProperties().setProperty(DRIVER_TRUST_PROPERTY_, JSON.stringify(map));
}

function driverMakeToken_() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}

function driverTrustAdd_(name, token) {
  const key = driverNorm_(name);
  const map = driverTrustMap_();
  const mine = map[key] || {};
  mine[token] = new Date().toISOString();
  // Oldest out first, so a driver who keeps changing phones cannot grow this forever.
  const tokens = Object.keys(mine).sort(function(a, b) { return mine[a] < mine[b] ? -1 : 1; });
  while (tokens.length > DRIVER_TRUST_MAX_PER_DRIVER_) { delete mine[tokens.shift()]; }
  map[key] = mine;
  driverTrustSave_(map);
}

// A token only counts while the person is STILL on the STAFF sheet, so taking a
// driver off the roster locks them out at their next refresh.
function driverTrustValid_(name, token) {
  const key = driverNorm_(name);
  const t = String(token || '');
  if (!key || !t) return false;
  if (!driverRosterFind_(name)) return false;
  const map = driverTrustMap_();
  return !!(map[key] && map[key][t]);
}

function driverTrustRevoke_(name) {
  const map = driverTrustMap_();
  delete map[driverNorm_(name)];
  driverTrustSave_(map);
}

// ---- checking the code ------------------------------------------------------

function driverVerifyCode(name, code) {
  const cleanName = String(name || '').trim();
  const rec = driverRosterFind_(cleanName);
  if (!rec) return { ok: false, reason: 'unknown' };
  const cache = CacheService.getScriptCache();
  const raw = cache.get(driverCodeCacheKey_(cleanName));
  if (!raw) return { ok: false, reason: 'expired' };
  let state;
  try { state = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'expired' }; }

  const given = String(code || '').replace(/\D/g, '');
  if (given !== String(state.code)) {
    state.tries = Number(state.tries || 0) + 1;
    if (state.tries >= DRIVER_CODE_MAX_TRIES_) {
      cache.remove(driverCodeCacheKey_(cleanName));
      return { ok: false, reason: 'locked' };
    }
    cache.put(driverCodeCacheKey_(cleanName), JSON.stringify(state), DRIVER_CODE_TTL_SEC_);
    return { ok: false, reason: 'wrong', left: DRIVER_CODE_MAX_TRIES_ - state.tries };
  }

  cache.remove(driverCodeCacheKey_(cleanName));
  cache.remove(driverResendKey_(cleanName));
  const token = driverMakeToken_();
  driverTrustAdd_(rec.name, token);
  return { ok: true, name: rec.name, token: token };
}

// ---- the gate the app passes through ----------------------------------------
// Returns '' when this request may proceed, or the reason it may not.
function driverAccessProblem_(name, token, emailMatched) {
  const rec = driverRosterFind_(name);
  if (!rec) return 'unknown';                        // not on the roster (any more)
  if (emailMatched) return '';                       // signed in as themselves
  if (driverTrustValid_(rec.name, token)) return ''; // a phone that has been verified
  return 'verify';
}

// V98: every action a driver takes (a step, running late, a drive-time lookup)
// carries their name and token, and passes the same gate as loading the day.
// A trip that today's list shows assigned to somebody else is refused too.
function driverActionGate_(driverName, token, tripKeyID) {
  const who = driverAppIdentify_();
  const claimed = who.name || String(driverName || '').trim();
  if (!claimed) return { ok: false, reason: 'verify' };
  const problem = driverAccessProblem_(claimed, token, !!who.name);
  if (problem) return { ok: false, reason: problem };
  const key = String(tripKeyID || '').trim();
  if (key) {
    let tp = null;
    let lookupFailed = false;
    try {
      tp = (tripManager.getTripsByDate(driverDateKey_(0)) || []).filter(function(t) { return t && String(t.tripKeyID || '').trim() === key; })[0] || null;
    } catch (e) { lookupFailed = true; Logger.log('driverActionGate_ lookup: ' + ((e && e.message) || e)); }
    // V120: a read that FAILED is not the same as a trip that is not yours. The
    // phone treats "not yours" as final and throws the tap away, so a momentary
    // problem reading the record used to destroy a completed pickup.
    if (lookupFailed) return { ok: false, reason: 'record', message: 'The office could not be reached just then. This will be sent again.' };
    // The old test let a trip with an empty DRIVER cell through for any signed-in
    // driver. An unassigned trip belongs to the office, not the phone.
    if (!tp) return { ok: false, reason: 'notyours' };
    if (!driverMatches_(tp.driver, claimed)) return { ok: false, reason: 'notyours' };
  }
  return { ok: true, name: claimed };
}
