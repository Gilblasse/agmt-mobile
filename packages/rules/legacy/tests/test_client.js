// V120 regression tests for the dispatcher board's client logic.
const fs = require('fs');
function fnFrom(path, name) {
  const src = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const re = new RegExp('\\n\\s*function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + name + ' in ' + path);
  const i = m.index;
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const TP = 'TripsPage.html';
const code = [
  'let wtZone = 0, wtSkew = 0;',
  fnFrom(TP, 'localDateKey'),
  fnFrom(TP, 'hhmmOf_'),
  fnFrom(TP, 'tripTimeValue'),
  fnFrom(TP, 'epAddHours'),
  fnFrom(TP, 'wtIsFallBackDay_'),
  fnFrom(TP, 'wtMinutesBetween_'),
  'module.exports = { hhmmOf_, tripTimeValue, epAddHours, wtMinutesBetween_, localDateKey, spill: () => epReturnDaySpill };'
].join('\n');
fs.mkdirSync('/tmp/claude-0/v120', { recursive: true });
fs.writeFileSync('/tmp/claude-0/v120/client.js', code);
const M = require('/tmp/claude-0/v120/client.js');

let pass = 0, fail = 0;
function is(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('  FAIL ' + label + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)); }
}

// ---- the shared time parser ----------------------------------------------
is('24h stays 24h',              M.hhmmOf_('08:15'), '08:15');
is('2:30 PM is the afternoon',   M.hhmmOf_('2:30 PM'), '14:30');
is('10:47 PM is the evening',    M.hhmmOf_('10:47 PM'), '22:47');
is('9:47 PM parses at all',      M.hhmmOf_('9:47 PM'), '21:47');
is('12:15 AM is after midnight', M.hhmmOf_('12:15 AM'), '00:15');
is('12:15 PM is midday',         M.hhmmOf_('12:15 PM'), '12:15');
is('an 1899 ISO stamp reads',    M.hhmmOf_('1899-12-30T13:19:00.000Z'), '13:19');
is('nonsense is nothing',        M.hhmmOf_('later'), null);
// the forms people actually type
is('2:30pm with no space',       M.hhmmOf_('2:30pm'), '14:30');
is('7:05PM run together',        M.hhmmOf_('7:05PM'), '19:05');
is('12:30am run together',       M.hhmmOf_('12:30am'), '00:30');
is('2:30 P.M. with full stops',  M.hhmmOf_('2:30 P.M.'), '14:30');
is('12:15AM run together',       M.hhmmOf_('12:15AM'), '00:15');
is('a bare 25:00 is refused',    M.hhmmOf_('25:00'), null);

is('2:30 PM sorts after noon',   M.tripTimeValue('2:30 PM'), 14 * 60 + 30);
is('08:15 sorts in the morning', M.tripTimeValue('08:15'), 8 * 60 + 15);
is('no time sorts last',         M.tripTimeValue('') > 10000, true);
is('an evening trip sorts after a morning one',
   M.tripTimeValue('9:30 PM') > M.tripTimeValue('8:15 AM'), true);

// ---- return trips over midnight ------------------------------------------
is('9pm + 4h is 1am',            M.epAddHours('21:00', 4), '01:00');
is('and it reports the next day', M.spill(), 1);
is('9am + 4h is 1pm',            M.epAddHours('09:00', 4), '13:00');
is('same day, no spill',         M.spill(), 0);

// ---- the repeated hour on the clock-change day ----------------------------
is('a normal wait',              M.wtMinutesBetween_(0, 15 * 60000), 15);
// A reversed pair on an ORDINARY day is bad data and must still read as missing,
// not be smoothed over into "no wait" - that would hide real stamp corruption.
const ordinaryDay = Date.parse('2026-09-08T14:00:00');
is('a reversed pair on a normal day is still no data',
   M.wtMinutesBetween_(ordinaryDay, ordinaryDay - 30 * 60000), null);
is('a nonsense gap is still rejected', M.wtMinutesBetween_(20 * 3600000, 0), null);
is('an ordinary wait is unaffected', M.wtMinutesBetween_(ordinaryDay, ordinaryDay + 42 * 60000), 42);

console.log('\n  client: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
