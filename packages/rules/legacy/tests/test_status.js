// V121 regression tests: the four ways a dispatcher's status change went wrong.
// Every one of these fails against V120LIVE (the code that was live this morning).
const fs = require('fs');
const path = process.env.AG_DIR || '.';

function fnFrom(file, name) {
  const src = fs.readFileSync(path + '/' + file, 'utf8').replace(/\r\n/g, '\n');
  const re = new RegExp('\\n\\s*function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + name + ' in ' + file);
  const i = m.index;
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}
function read(file) { return fs.readFileSync(path + '/' + file, 'utf8').replace(/\r\n/g, '\n'); }

let pass = 0, fail = 0;
function is(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('  FAIL ' + label + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)); }
}
function ok(label, cond) { is(label, !!cond, true); }

// =========================================================================
// 1. THE STATUS COLUMN. DISPATCH column E is the dispatcher's status; the
//    driver's progress lives in column Q. The board writer put the driver's
//    progress into E, so every trip-form save wiped the dispatcher's status.
// =========================================================================
const f29 = read('file_29.js');

// the single-row writer: a 3-wide range anchored at TIME+1 covers C, D, E
const single = /getRange\(row, COLUMN\.DISPATCH\.TIME \+ 1, 1, 3\)\.setValues\(\[\[([\s\S]*?)\]\]\);/.exec(f29);
ok('the single-row board writer is still shaped as C,D,E', !!single);
const thirdValue = single ? single[1].split('\n').filter(function (l) {
  const t = l.trim();
  return t && t.indexOf('//') !== 0;
}).pop().trim() : '';
is('a trip save writes the DISPATCHER status into column E', thirdValue, "trip.dispatchStatus || ''");
ok('a trip save does NOT write the driver progress into column E', thirdValue.indexOf('trip.status') < 0);

// the batched writer fills the same cell as index 4 of an A..E row
const batch = /row\[3\] = t\.passenger \|\| '';\n\s*row\[4\] = ([^;]+);/.exec(f29);
ok('the batched board writer is still shaped as A..E', !!batch);
is('the batched writer also writes the dispatcher status', batch ? batch[1].trim() : '', "t.dispatchStatus || ''");

// and the read side must still agree about which column is which
const f18 = read('file_18.js');
ok('column E is read back as dispatchStatus', /dispatchStatus: row\[COLUMN\.DISPATCH\.TODAY\]/.test(f18));
ok('column Q is read back as the driver status', /status: row\[COLUMN\.DISPATCH\.STATUS\]/.test(f18));

// nothing on the trip-save path may write the driver's progress column
ok('a trip save never writes the driver progress column',
  !/COLUMN\.DISPATCH\.STATUS \+ 1/.test(
    f29.slice(f29.indexOf('writeTripToDispatchRow_(row, trip, fresh'), f29.indexOf('writeTripToDispatchRow_(row, trip, fresh') + 4000)));

// =========================================================================
// 2. THE DAY. setTripQuickStatus was pinned to today, so a status set while
//    looking at any other date was written nowhere and still reported ok.
// =========================================================================
const qs = f29.slice(f29.indexOf('function setTripQuickStatus(tripKeyID'),
                     f29.indexOf('function checkTripConflictsBatch'));
ok('the status writer accepts the day it is acting on', /function setTripQuickStatus\(tripKeyID, value, singleLegOnly, dateKey\)/.test(qs));
ok('the submitted-day check uses that day, not today', /assertDateNotSubmitted_\(dayKey\)/.test(qs));
ok('the trips it works from are that day\'s', /getTripsByDate\(dayKey\)/.test(qs));
ok('no leftover reference to a today-only trip list', qs.indexOf('todayTrips') < 0);
is('the record update reads the same day', (qs.match(/getTripsByDate\(dayKey\)/g) || []).length, 2);
ok('a status that reached nothing is reported, not ticked', /reason: 'notfound'/.test(qs));
ok('and it says plainly that it was not saved', /was not saved/.test(qs));
ok('a missing day still means today, so an open older board keeps working', /let dayKey = todayKey;/.test(qs));

// the linked-leg, restore and driver-alert loops must all use the same day
is('every loop in the status writer works from one day\'s trips',
  (qs.match(/dayTrips\.forEach/g) || []).length, 4);

// =========================================================================
// 3. THE REFRESH RACE. A board refresh landing while the office was still
//    writing handed back the OLD status and the card flipped back.
// =========================================================================
const TP = read('TripsPage.html');
ok('there is a record of statuses not yet confirmed', /const pendingStatus_ = new Map\(\)/.test(TP));
ok('a full board load keeps an unconfirmed status', /allTrips = applyPendingStatus_\(/.test(TP));
ok('a refresh keeps an unconfirmed status', /function updateTripCards\(newTrips, incomingHash\) \{\n\s*applyPendingStatus_\(newTrips\);/.test(TP));
ok('a refresh already in flight is retired when a status is chosen', /boardEpoch_ \+= 1;/.test(TP.slice(TP.indexOf('function commitStatusChange_'), TP.indexOf('function commitStatusChange_') + 2000)));
ok('an office that never answers is given a deadline', /const STATUS_ANSWER_MS_ = \d+;/.test(TP));
ok('and the deadline reports a failure rather than leaving a tick', /did not answer, so that status has not been saved/.test(TP));
ok('both status controls go through one path', (TP.match(/commitStatusChange_\(trip, value/g) || []).length >= 2);
ok('the under-way notice is on the shared path, so both controls give it',
  /if \(value && driverUnderWay_\(liveTrip_\(trip\)\) && \['CANCEL', 'NO SHOW', 'REASSIGN'\]/.test(TP));
ok('the trip\'s own date travels with every status change',
  (TP.match(/setTripQuickStatus\(trip\.tripKeyID, [a-zA-Z]+, false, normalizeDateValue\(trip\.date\)\)/g) || []).length === 2);

// the pending map, exercised for real
const pend = [
  'function tripIdentity(t) { return String(t.tripKeyID || ""); }',
  'const pendingStatus_ = new Map();',
  fnFrom('TripsPage.html', 'applyPendingStatus_'),
  'module.exports = { pendingStatus_, applyPendingStatus_ };'
].join('\n');
fs.mkdirSync('/tmp/claude-0/v121', { recursive: true });
fs.writeFileSync('/tmp/claude-0/v121/pend.js', pend);
const P = require('/tmp/claude-0/v121/pend.js');

const incoming = [{ tripKeyID: 'a', dispatchStatus: '' }, { tripKeyID: 'b', dispatchStatus: 'READY' }];
is('with nothing in the air the office wins', P.applyPendingStatus_(JSON.parse(JSON.stringify(incoming))),
   [{ tripKeyID: 'a', dispatchStatus: '' }, { tripKeyID: 'b', dispatchStatus: 'READY' }]);
P.pendingStatus_.set('a', { value: 'CANCEL', at: Date.now() });
is('a status still being saved survives a refresh', P.applyPendingStatus_(JSON.parse(JSON.stringify(incoming))),
   [{ tripKeyID: 'a', dispatchStatus: 'CANCEL' }, { tripKeyID: 'b', dispatchStatus: 'READY' }]);
P.pendingStatus_.delete('a');
is('and once it is confirmed the office wins again', P.applyPendingStatus_(JSON.parse(JSON.stringify(incoming))),
   [{ tripKeyID: 'a', dispatchStatus: '' }, { tripKeyID: 'b', dispatchStatus: 'READY' }]);
is('an empty payload is handled', P.applyPendingStatus_(null), null);

// =========================================================================
// 4. WHAT THE CARD SHOWS. Cancel / No Show / Reassign were hidden the moment
//    a driver tapped a step, so a called-off trip looked like a live job.
// =========================================================================
const R = new Function(fnFrom('TripsPage.html', 'resolveTripStatus') + '\nreturn resolveTripStatus;')();

is('a cancel shows even when the driver is in transit', R('INTRANSIT', 'CANCEL'), 'cancel');
is('a cancel shows even when the driver is en route',   R('IN ROUTE', 'CANCEL'), 'cancel');
is('a no show shows even when the driver is at the door', R('PICKUP LOCATION', 'NO SHOW'), 'noshow');
is('a reassign shows even when the driver is moving',  R('INTRANSIT', 'REASSIGN'), 'reassign');
is('a reassign shows on a trip nobody has started',    R('', 'REASSIGN'), 'reassign');
is('the board agrees with the phone, which also calls it over', R('IN ROUTE', 'REASSIGN'), 'reassign');
is('a cancel still shows on a trip nobody has started', R('', 'CANCEL'), 'cancel');
is('a cancel overrides even a completed trip',          R('COMPLETE', 'CANCEL'), 'cancel');

is('Ready still gives way to a driver in transit',      R('INTRANSIT', 'READY'), 'intransit');
is('Not Confirmed still gives way to a driver en route', R('IN ROUTE', 'NOT CONFIRMED'), 'inroute');
is('Update Time still gives way to a driver at the door', R('PICKUP LOCATION', 'UPDATE TIME'), 'pickuplocation');
is('Ready shows on a trip nobody has started',          R('', 'READY'), 'ready');
is('a completed trip still reads complete',             R('COMPLETE', ''), 'complete');
is('a trip with nothing set reads as nothing',          R('', ''), '');
is('the driver status shows when there is no override', R('INTRANSIT', ''), 'intransit');
is('an unknown dispatcher word does not hide the driver', R('INTRANSIT', 'SOMETHING ELSE'), 'intransit');

// the new-trip form must send the dispatcher status under its own name
ok('a new trip sends the typed status as the dispatcher status',
  /dispatchStatus: \(document\.getElementById\('ep-status'\)\.value \|\| ''\)\.trim\(\)/.test(TP));
ok('and does not send it as the driver progress', !/status: \(document\.getElementById\('ep-status'\)\.value \|\| ''\)\.trim\(\)/.test(TP));
ok('a standing order row has a slot for the dispatcher status', /EP_LOG_COL = \{ DATE: 0, START_TIME: 1, TIME: 2, PASSENGER: 3, TODAY: 4,/.test(TP));
ok('and fills it', /row\[EP_LOG_COL\.TODAY\] = trip\.dispatchStatus \|\| '';/.test(TP));

// a good save must not end with an error message
ok('the status box shows only the dispatcher status',
  /getElementById\('ep-status'\)\.value = trip\.dispatchStatus \|\| '';/.test(TP));
ok('and the form never sends a word the office would refuse',
  /const knownStatus = \['', 'READY', 'NOT CONFIRMED', 'REASSIGN', 'UPDATE TIME', 'COMPLETE', 'CANCEL', 'NO SHOW'\]\.indexOf\(nextStatus\) >= 0;/.test(TP));
ok('the notice reads the trip as the board currently has it',
  /driverUnderWay_\(liveTrip_\(trip\)\)/.test(TP));

// two changes to one trip must not undo each other
ok('a later change to the same trip is marked so an earlier answer cannot clear it', /held\.seq !== seq/.test(TP));
ok('the deadline allows for a busy board', /const STATUS_ANSWER_MS_ = 45000;/.test(TP));

// and the dispatcher is told when a pre-trip status will not be shown
const U = new Function('const DRIVER_UNDER_WAY_ = ' +
  /const DRIVER_UNDER_WAY_ = (\[[^\]]*\]);/.exec(TP)[1] + ';\n' +
  fnFrom('TripsPage.html', 'driverUnderWay_') + '\nreturn driverUnderWay_;')();
is('a driver in transit counts as under way',   U({ status: 'INTRANSIT' }), true);
is('a driver en route counts as under way',     U({ status: 'IN ROUTE' }), true);
is('a driver at the door counts as under way',  U({ status: 'PICKUP LOCATION' }), true);
is('a trip nobody has started does not',        U({ status: '' }), false);
is('a missing trip does not',                   U(null), false);
ok('and the dispatcher is told when the board will keep showing the driver',
  /the driver is already on this trip, so the board keeps showing their progress/.test(TP));

console.log('\n  status: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
