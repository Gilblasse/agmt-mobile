// V122: the wait timer must stop. It used to count from the driver's arrival tap
// to right now, for ever - a card from last week read "191h 37m" in red.
const fs = require('fs');
const path = process.env.AG_DIR || '.';
function read(f) { return fs.readFileSync(path + '/' + f, 'utf8').replace(/\r\n/g, '\n'); }
function fnFrom(file, name) {
  const src = read(file);
  const m = new RegExp('\\n\\s*function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name + ' in ' + file);
  let d = 0, started = false;
  for (let j = m.index; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}
let pass = 0, fail = 0;
function is(l, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('  FAIL ' + l + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)); }
}
function ok(l, c) { is(l, !!c, true); }

// ---- the board -----------------------------------------------------------
const TP = read('TripsPage.html');
const TODAY = '2026-09-09';
const NOW = Date.parse(TODAY + 'T21:05:00');

const env = [
  'const WT_ENDED_ = ' + /const WT_ENDED_ = (\[[^\]]*\]);/.exec(TP)[1] + ';',
  'const WT_MAX_LIVE_MIN_ = ' + /const WT_MAX_LIVE_MIN_ = ([^;]+);/.exec(TP)[1] + ';',
  'const WT_MIDNIGHT_GRACE_MIN_ = ' + /const WT_MIDNIGHT_GRACE_MIN_ = ([^;]+);/.exec(TP)[1] + ';',
  'const NOW = ' + NOW + ';',
  'let wtZone = 0;',
  'function wtNow_() { return NOW; }',
  // the real one, so the office-day comparison is exercised for real
  'function localDateKey(date = new Date()) {',
  '  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");',
  '}',
  'function setZone(z) { wtZone = z; }',
  // a stamp is "YYYY-MM-DDTHH:MM" or a bare HH:mm read against the trip's day
  'function wtInstant_(v, dateKey) {',
  '  const s = String(v == null ? "" : v).trim();',
  '  if (!s) return null;',
  '  if (/^\\d{1,2}:\\d{2}$/.test(s)) { const p = Date.parse(dateKey + "T" + (s.length === 4 ? "0" : "") + s + ":00"); return isNaN(p) ? null : p; }',
  '  const p = Date.parse(s); return isNaN(p) ? null : p;',
  '}',
  fnFrom('TripsPage.html', 'wtStillLive_'),
  fnFrom('TripsPage.html', 'wtWaitInfo_'),
  'module.exports = { wtWaitInfo_, WT_MAX_LIVE_MIN_, WT_MIDNIGHT_GRACE_MIN_, setZone };'
].join('\n');
fs.mkdirSync('/tmp/claude-0/v122', { recursive: true });
fs.writeFileSync('/tmp/claude-0/v122/wait.js', env);
const W = require('/tmp/claude-0/v122/wait.js');

const at = function (dateKey, hhmm) { return { date: dateKey, status: 'PICKUP LOCATION', pickupArrival: dateKey + 'T' + hhmm + ':00' }; };

// the exact case from the report: Sept 1, tapped 10:28 PM, still on screen Sept 9
is('a trip from eight days ago is not counted',
   W.wtWaitInfo_(at('2026-09-01', '22:28')), null);
is('yesterday is not counted either',
   W.wtWaitInfo_(at('2026-09-08', '22:28')), null);
is('tomorrow is not counted',
   W.wtWaitInfo_(at('2026-09-10', '08:00')), null);

// today still works, which is the whole point of the pill
const live = W.wtWaitInfo_(at(TODAY, '20:35'));
ok('a driver waiting since half an hour ago on today still counts', live && live.where === 'pickup');
is('and it counts from their arrival tap', live && live.since, Date.parse(TODAY + 'T20:35:00'));

const short = W.wtWaitInfo_(at(TODAY, '21:00'));
ok('a driver who has just pulled up counts', short && short.where === 'pickup');

// a tap left open on today, past the sanity bound
is('an arrival tap left open all night stops at the bound',
   W.wtWaitInfo_(at(TODAY, '02:00')), null);
const edge = W.wtWaitInfo_(at(TODAY, '09:06'));
ok('just inside twelve hours still counts', !!edge);
is('just outside twelve hours does not', W.wtWaitInfo_(at(TODAY, '09:04')), null);
is('the bound is twelve hours', W.WT_MAX_LIVE_MIN_, 720);

// the drop-off door behaves the same way
const dOld = { date: '2026-09-01', status: 'DROPOFF LOCATION', dropoffArrival: '2026-09-01T22:28:00' };
is('a drop-off wait from a past day is not counted', W.wtWaitInfo_(dOld), null);
const dNew = { date: TODAY, status: 'DROPOFF LOCATION', dropoffArrival: TODAY + 'T20:35:00' };
ok('a drop-off wait today still counts', !!W.wtWaitInfo_(dNew));

// things that were already true must stay true
is('a completed leg is not a wait',
   W.wtWaitInfo_({ date: TODAY, status: 'PICKUP LOCATION', pickupArrival: TODAY + 'T20:35:00', pickupDeparture: TODAY + 'T20:40:00' }), null);
is('a cancelled trip is not a wait',
   W.wtWaitInfo_({ date: TODAY, status: 'PICKUP LOCATION', dispatchStatus: 'CANCEL', pickupArrival: TODAY + 'T20:35:00' }), null);
is('a no-show is not a wait',
   W.wtWaitInfo_({ date: TODAY, status: 'PICKUP LOCATION', dispatchStatus: 'NO SHOW', pickupArrival: TODAY + 'T20:35:00' }), null);
is('a trip with no arrival tap is not a wait',
   W.wtWaitInfo_({ date: TODAY, status: 'PICKUP LOCATION' }), null);
is('a trip nobody has started is not a wait', W.wtWaitInfo_({ date: TODAY, status: '' }), null);
is('nothing at all is not a wait', W.wtWaitInfo_(null), null);
is('a trip with no date is judged on the stamp alone',
   W.wtWaitInfo_({ date: '', status: 'PICKUP LOCATION', pickupArrival: TODAY + 'T20:35:00' }) != null, true);

// a machine in another timezone must not lose every pill on the board
// (wtZone is how far the office's wall clock is from this machine's)
W.setZone(4 * 60 * 60000);   // office 4 hours ahead of this browser
ok('a wait still shows when the office is already on the next day',
  !!W.wtWaitInfo_({ date: '2026-09-10', status: 'PICKUP LOCATION', pickupArrival: '2026-09-10T01:05:00' }));
W.setZone(-5 * 60 * 60000);  // office 5 hours behind
ok('and when the office is still on the previous day',
  !!W.wtWaitInfo_({ date: '2026-09-09', status: 'PICKUP LOCATION', pickupArrival: TODAY + 'T20:35:00' }));
W.setZone(0);

// a wait that began just before midnight is not cut off at midnight
is('the grace period is half an hour', W.WT_MIDNIGHT_GRACE_MIN_, 30);
const eve = { date: '2026-09-08', status: 'PICKUP LOCATION', pickupArrival: '2026-09-08T23:58:00' };
// NOW is 9 Sept 21:05, so that stamp is ~21 hours old - well past both bounds
is('yesterday evening is still not counted the next night', W.wtWaitInfo_(eve), null);
// but a wait a few minutes either side of midnight is
const nearMidnight = Date.parse('2026-09-09T00:10:00');
(function () {
  const src = require('fs').readFileSync('/tmp/claude-0/v122/wait.js', 'utf8').replace('const NOW = ' + NOW + ';', 'const NOW = ' + nearMidnight + ';');
  require('fs').writeFileSync('/tmp/claude-0/v122/wait2.js', src);
  const W2 = require('/tmp/claude-0/v122/wait2.js');
  ok('a driver who tapped at 23:58 is still counted at 00:10',
    !!W2.wtWaitInfo_({ date: '2026-09-08', status: 'PICKUP LOCATION', pickupArrival: '2026-09-08T23:58:00' }));
  is('but a tap from 23:00 the night before is not, once the grace is past',
    W2.wtWaitInfo_({ date: '2026-09-08', status: 'PICKUP LOCATION', pickupArrival: '2026-09-08T23:00:00' }), null);
  ok('and today\'s own trips are unaffected',
    !!W2.wtWaitInfo_({ date: '2026-09-09', status: 'PICKUP LOCATION', pickupArrival: '2026-09-09T00:05:00' }));
})();

// a card already on screen must stop too
ok('a pill on screen hides itself past the bound',
  /if \(mins != null && mins > WT_MAX_LIVE_MIN_\) \{ pill\.hidden = true; return; \}/.test(TP));
ok('and the stylesheet actually lets it hide', /\.wait-pill\[hidden\] \{ display: none; \}/.test(TP));
ok('a stopped tile shows nothing rather than the capped number',
  /val\.textContent = '\\u2014'; val\.classList\.add\('is-empty'\);/.test(TP));
ok('and the live tile stops growing', /if \(mins > WT_MAX_LIVE_MIN_\) \{/.test(TP));

// ---- the phone -----------------------------------------------------------
const DP = read('DriverAppPage.html');
const denv = [
  'const NOW = ' + NOW + ';',
  'function nowMs() { return NOW; }',
  'function overrideOf() { return null; }',
  'let STAGE = 2, PICK = null, DROP = null;',
  'function stageOf() { return STAGE; }',
  'function pickupStampMs() { return PICK; }',
  'function dropoffStampMs() { return DROP; }',
  'const WAIT_MAX_LIVE_MS = ' + /const WAIT_MAX_LIVE_MS = ([^;]+);/.exec(DP)[1] + ';',
  fnFrom('DriverAppPage.html', 'waitStillLive'),
  fnFrom('DriverAppPage.html', 'waitingAt'),
  'module.exports = { waitingAt, set: (s, p, d) => { STAGE = s; PICK = p; DROP = d; }, WAIT_MAX_LIVE_MS };'
].join('\n');
fs.writeFileSync('/tmp/claude-0/v122/dwait.js', denv);
const D = require('/tmp/claude-0/v122/dwait.js');

D.set(2, NOW - 20 * 60000, null);
ok('the phone counts a twenty-minute wait', !!D.waitingAt({}));
D.set(2, NOW - 13 * 60 * 60000, null);
is('the phone stops a tap left open for thirteen hours', D.waitingAt({}), null);
D.set(2, NOW - 11 * 60 * 60000, null);
ok('eleven hours still counts', !!D.waitingAt({}));
D.set(4, null, NOW - 30 * 60000);
ok('a drop-off wait counts on the phone too', !!D.waitingAt({}));
D.set(4, null, NOW - 14 * 60 * 60000);
is('and stops at the same bound', D.waitingAt({}), null);
D.set(2, null, null);
is('no stamp is no wait', D.waitingAt({}), null);
is('the phone uses the same twelve hours', D.WAIT_MAX_LIVE_MS, 12 * 60 * 60 * 1000);

console.log('\n  wait clock: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
