// V123: Refresh must actually refresh, and the board must keep itself current
// with nobody watching.
const fs = require('fs');
const path = process.env.AG_DIR || '.';
function read(f) { return fs.readFileSync(path + '/' + f, 'utf8').replace(/\r\n/g, '\n'); }
let pass = 0, fail = 0;
function is(l, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('  FAIL ' + l + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)); }
}
function ok(l, c) { is(l, !!c, true); }

const S = read('file_24.js');
const TP = read('TripsPage.html');

// ---- the refresh button --------------------------------------------------
ok('the sync can be told to go and look properly', /function syncDispatchIfChanged_\(force\)/.test(S));
ok('and a forced sync skips the counter shortcut', /if \(!force && version && seen === version && !dueFullCheck\) return false;/.test(S));
ok('a forced sync waits its turn instead of giving up', /if \(!force\) return false;[\s\S]{0,400}Utilities\.sleep\(1200\)/.test(S));
ok('the board load takes a force flag', /function getTripsPageDelta\(dateStr, clientHash, refreshToday, force\)/.test(S));
ok('and passes it to the sync', /syncDispatchIfChanged_\(!!force\)/.test(S));
ok('a forced refresh is never answered with "nothing changed"', /if \(!force && clientHash && quickHash && clientHash === quickHash\)/.test(S));

ok('the Refresh button asks for a forced poll', /pollTrips\(true, function\(\) \{ if \(btn\) btn\.classList\.remove\("spinning"\); \}\)/.test(TP));
ok('the poll takes a force flag and a callback', /function pollTrips\(force, whenDone\)/.test(TP));
ok('a forced poll is not turned away by one already running', /if \(\(pollInFlight && !force\) \|\| document\.visibilityState === 'hidden'\)/.test(TP));
ok('the force flag reaches the office', /getTripsPageDelta\(currentDate, lastHash, currentDate === localDateKey\(\), !!force\)/.test(TP));
ok('the spinner stops when the answer lands, not on a timer', /pollInFlight = false;\n\s*finish\(\);/.test(TP));
ok('and stops anyway if the office never answers', /\}, 20000\);/.test(TP));
// every early return must still release the caller
is('every guard in the poll releases the Refresh button',
   (TP.slice(TP.indexOf('function pollTrips(force, whenDone)'), TP.indexOf('function pollTrips(force, whenDone)') + 900).match(/\{ finish\(\); return; \}/g) || []).length, 6);

ok('a forced sync that waited does not redo finished work',
  /if \(cache\.get\('dispatchFp:v1'\) === fp\) return false;/.test(S));
ok('the second shortcut is force-aware too',
  /if \(!force && clientHash && clientHash === hash\) return \{ unchanged: true/.test(S));

// ---- the background sync -------------------------------------------------
ok('there is a job that syncs with nobody watching', /function backgroundDispatchSync\(\)/.test(S));
ok('and it forces a real read', /syncDispatchIfChanged_\(true\)/.test(S));
ok('it never throws out of the timer', /catch \(e\) \{\n\s*Logger\.log\('backgroundDispatchSync: /.test(S));
ok('there is a way to install it by hand', /function installBackgroundSyncTrigger\(\)/.test(S));
ok('and to remove it', /function uninstallBackgroundSyncTrigger\(\)/.test(S));
ok('it installs itself so nobody has to run anything', /function ensureBackgroundSyncTrigger_\(\)/.test(S));
ok('the board load arms it', /try \{ ensureBackgroundSyncTrigger_\(\); \} catch \(e\) \{\}/.test(S));
ok('two boards loading at once cannot each create a timer', /LockService\.getScriptLock\(\)[\s\S]{0,80}tryLock\(0\)/.test(S));
ok('and duplicates are tidied up rather than paid for', /ScriptApp\.deleteTrigger\(tr\);[\s\S]{0,200}bgSyncChecked/.test(S));
ok('the check costs nothing once the timer exists', /if \(cache\.get\('bgSyncChecked:v1'\)\) return;/.test(S));

ok('a failed trigger check backs off instead of retrying every poll',
  /cache\.put\('bgSyncChecked:v1', '1', 300\)/.test(S));
ok('the timer stands aside while a standing order is being written',
  /soAnyJobOpen_\(\)\) return;/.test(S));
ok('and there is a cheap way to ask that', /function soAnyJobOpen_\(\)/.test(read('file_29.js')));
ok('which reads no sheet and takes no lock', /soListJobs_\(\)\.some\(function \(j\)/.test(read('file_29.js')));
ok('and stands aside only for a job that is actually moving',
  /soJobOpen_\(j\) && Number\(\(j && j\.updatedAt\) \|\| \(j && j\.createdAt\) \|\| 0\) > cutoff/.test(read('file_29.js')));
ok('so a job stranded by a lost trigger cannot switch the sync off for good',
  /var cutoff = Date\.now\(\) - 15 \* 60000;/.test(read('file_29.js')));

// the interval must be one Apps Script actually accepts
const mins = Number((/var BG_SYNC_MINUTES_ = (\d+);/.exec(S) || [])[1]);
ok('the interval is one Apps Script actually accepts', [1, 5, 10, 15, 30].indexOf(mins) >= 0);
is('and it is spaced out enough to stay clear of the daily budget', mins, 10);

console.log('\n  refresh: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
