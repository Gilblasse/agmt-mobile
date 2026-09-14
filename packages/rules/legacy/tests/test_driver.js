// V120 regression tests for driver identity matching and step ordering.
const fs = require('fs');
const src = fs.readFileSync('DriverApp.gs', 'utf8');
function grab(n) {
  const m = new RegExp('\\nfunction ' + n + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found ' + n);
  const i = m.index; let d = 0, s = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; s = true; }
    else if (src[j] === '}') { d--; if (s && d === 0) return src.slice(i, j + 1); }
  }
}
const rank = /const DRIVER_STEP_RANK_ = \{[^}]*\};/.exec(src)[0];
// driverMatches_ now asks the roster to settle an ambiguous short form, so the
// harness supplies one. ROSTER is swapped per test to model a real STAFF sheet.
let ROSTER = [];
const ctx = eval('(function(){' +
  'function driverStaffRoster_(){ return ROSTER; }' +
  grab('driverNorm_') + grab('driverMatches_') + grab('driverNameParts_') + grab('driverShortFormOf_') +
  grab('driverUniqueShortForm_') + rank.replace('const','var') + grab('driverTimeSortKey_') +
  'return {driverMatches_, DRIVER_STEP_RANK_, driverTimeSortKey_};})')();
const driverMatches_ = ctx.driverMatches_, DRIVER_STEP_RANK_ = ctx.DRIVER_STEP_RANK_, driverTimeSortKey_ = ctx.driverTimeSortKey_;

let pass = 0, fail = 0;
function is(l, g, w) { if (JSON.stringify(g) === JSON.stringify(w)) pass++; else { fail++; console.log('  FAIL ' + l + '  got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w)); } }

// --- real shorthands that MUST keep working -------------------------------
is('exact name',              driverMatches_('Mike Johnson', 'Mike Johnson'), true);
is('first name only',         driverMatches_('Mike', 'Mike Johnson'), true);
is('surname only',            driverMatches_('Blasse', 'Nathaniel Blasse'), true);
is('first + initial',         driverMatches_('Mike J', 'Mike Johnson'), true);
is('comma form',              driverMatches_('Johnson, Mike', 'Mike Johnson'), true);
is('short first name',        driverMatches_('Sam', 'Sam Adeyemi'), true);
is('extra title',             driverMatches_('Dr. Ashleen Brown', 'Ashleen Brown'), true);
is('case and punctuation',    driverMatches_('  mike   johnson ', 'Mike Johnson'), true);

// --- the collisions this exists to stop -----------------------------------
is('Lee is not Ashleen',      driverMatches_('Lee', 'Ashleen Baker'), false);
is('Ashleen is not Lee',      driverMatches_('Ashleen Baker', 'Lee'), false);
is('different people',        driverMatches_('Mike Johnson', 'Sarah Chen'), false);
is('a blank driver matches nobody', driverMatches_('', 'Mike Johnson'), false);
is('nobody matches a blank',  driverMatches_('Mike Johnson', ''), false);
is('an initial alone is not enough', driverMatches_('M', 'Mike Johnson'), false);

// --- step ordering ---------------------------------------------------------
is('in route before pickup',  DRIVER_STEP_RANK_['IN ROUTE'] < DRIVER_STEP_RANK_['PICKUP LOCATION'], true);
is('complete is last',        DRIVER_STEP_RANK_['COMPLETE'], 5);
is('an unknown status is the start', DRIVER_STEP_RANK_[''], 0);

// --- the driver's day sorts by time of day ---------------------------------
const day = ['1899-12-30T21:30:00.000Z', '08:15', '2:30 PM', '9:00 AM', ''];
const sorted = day.slice().sort((a, b) => driverTimeSortKey_(a) - driverTimeSortKey_(b));
is('the day runs in order, blanks last', sorted, ['08:15', '9:00 AM', '2:30 PM', '1899-12-30T21:30:00.000Z', '']);

// --- names that look alike but are different people ------------------------
is('Dan is not Danielle',     driverMatches_('Dan', 'Danielle Carter'), false);
is('Danielle is not Dan',     driverMatches_('Danielle Carter', 'Dan Reyes'), false);
is('Chris is not Christina',  driverMatches_('Chris', 'Christina Lopez'), false);
is('Sam is not Samantha',     driverMatches_('Sam', 'Samantha Ruiz'), false);
is('Ann is not Annette',      driverMatches_('Ann', 'Annette Poe'), false);
is('Ben is not Benjamin',     driverMatches_('Ben', 'Benjamin Kay'), false);
is('but Sam still matches Sam Adeyemi', driverMatches_('Sam', 'Sam Adeyemi'), true);
// "M Johnson" is refused, exactly as it is on the live version: with two Johnsons
// on the roster a bare initial cannot say which one, and this gates who may cancel
// a trip. "Mike J" is fine, because the given name is there in full.
is('an initial alone is refused, as on live', driverMatches_('M Johnson', 'Mike Johnson'), false);
is('but a full first name plus an initial works', driverMatches_('Mike J', 'Mike Johnson'), true);
is('matching is symmetric',   driverMatches_('Mike Johnson', 'Mike') === driverMatches_('Mike', 'Mike Johnson'), true);

// --- names dispatch really types, that MUST keep working -------------------
is("O'Brien written without the apostrophe", driverMatches_('Obrien', "Maureen O'Brien"), true);
is("apostrophe on the roster side only",     driverMatches_("O'Brien", 'Maureen OBrien'), true);
is('a compound surname written solid',        driverMatches_('Vanderberg', 'Piet Van Der Berg'), true);
is('and the other way round',                 driverMatches_('Van Der Berg', 'Piet Vanderberg'), true);
is('De La Cruz written solid',                driverMatches_('Delacruz', 'Maria De La Cruz'), true);
is('a hyphenated given name run together',    driverMatches_('Annmarie', 'Ann-Marie Lopez'), true);
is('accents folded away',                     driverMatches_('Jose Ramirez', 'Jos\u00e9 Ram\u00edrez'), true);
is('a suffix on the board',                   driverMatches_('Robert Johnson Jr', 'Robert Johnson'), true);
is('a van number in the cell',                driverMatches_('Mike Johnson (Van 3)', 'Mike Johnson'), true);
is('Jo Ann vs JoAnn',                         driverMatches_('Jo Ann Smith', 'JoAnn Smith'), true);
is('a two-letter surname',                    driverMatches_('Ng', 'David Ng'), true);

// --- ambiguous or different people: must be refused ------------------------
is('Dan Rivera is not Danielle Rivera', driverMatches_('Dan Rivera', 'Danielle Rivera'), false);
is('Chris Johnson is not Christine Johnson', driverMatches_('Chris Johnson', 'Christine Johnson'), false);
is('Sam Lee is not Samantha Lee',      driverMatches_('Sam Lee', 'Samantha Lee'), false);
is('Rob Wilson is not Robert Wilson',  driverMatches_('Rob Wilson', 'Robert Wilson'), false);
is('an initial cannot carry it',       driverMatches_('M Johnson', 'Mary Johnson'), false);
is('not even for the right person',    driverMatches_('M Johnson', 'Mike Johnson'), false);
is('J. Smith is not Joseph Smith',     driverMatches_('J. Smith', 'Joseph Smith'), false);

// --- short forms: safe when only one driver could be meant -----------------
const names = n => n.map(x => ({ name: x }));
ROSTER = names(['Christopher Perez', 'Mike Johnson', 'Samantha Lee']);
is('Chris means Christopher when he is the only one', driverMatches_('Chris', 'Christopher Perez'), true);
is('Sam means Samantha when she is the only one',     driverMatches_('Sam', 'Samantha Lee'), true);

ROSTER = names(['Patrick Moore', 'Mike Johnson']);
is('Rick means Patrick when he is the only one',      driverMatches_('Rick', 'Patrick Moore'), true);

ROSTER = names(['Alberto Diaz']);
is('Al means Alberto when he is the only one',        driverMatches_('Al', 'Alberto Diaz'), true);

// ...and refused the moment it could mean two people
ROSTER = names(['Dan Reyes', 'Danielle Carter']);
is('Dan is refused when both are on the roster',      driverMatches_('Dan', 'Danielle Carter'), false);
is('and Dan Reyes still matches himself',             driverMatches_('Dan', 'Dan Reyes'), true);

ROSTER = names(['Lee Chan', 'Ashleen Baker']);
is('Lee is refused when Ashleen is also on the roster', driverMatches_('Lee', 'Ashleen Baker'), false);
is('and Lee Chan still matches himself',              driverMatches_('Lee', 'Lee Chan'), true);

ROSTER = names(['Eric Sanders', 'Erica Sanders']);
is('Eric is refused when Erica is also on the roster', driverMatches_('Eric', 'Erica Sanders'), false);

ROSTER = [];
is('with no roster, a short form is refused',         driverMatches_('Chris', 'Christopher Perez'), false);
is('but a whole name still works with no roster',     driverMatches_('Mike', 'Mike Johnson'), true);

// --- the matcher must read the same in BOTH directions --------------------
// The texts and emails resolve the roster the other way round, so an asymmetric
// matcher would silently stop a driver's alerts while their app still worked.
function bothWays(label, a, b, want) {
  is(label, driverMatches_(a, b), want);
  is(label + ' (the other way round)', driverMatches_(b, a), want);
}
ROSTER = names(['Christopher Perez', 'Mike Johnson', 'Samantha Lee', 'Alberto Diaz', 'Patrick Moore']);
bothWays('Chris on a full roster',  'Chris', 'Christopher Perez', true);
bothWays('Sam on a full roster',    'Sam', 'Samantha Lee', true);
bothWays('Al on a full roster',     'Al', 'Alberto Diaz', true);
bothWays('Rick on a full roster',   'Rick', 'Patrick Moore', true);
bothWays('Mike on a full roster',   'Mike', 'Mike Johnson', true);

// A short form must never reach into the MIDDLE of a name, whoever is on the roster.
ROSTER = names(['Ashleen Baker', 'Mike Johnson', 'Carlos Ruiz', 'Dana Fox']);
bothWays('Lee cannot reach inside Ashleen', 'Lee', 'Ashleen Baker', false);
bothWays('Ana cannot reach inside Dana',    'Ana', 'Dana Fox', false);
bothWays('Los cannot reach inside Carlos',  'Los', 'Carlos Ruiz', false);
bothWays('but Ruiz is a whole name part',   'Ruiz', 'Carlos Ruiz', true);
bothWays('and Ash is the start of Ashleen', 'Ash', 'Ashleen Baker', true);

ROSTER = names(['Rick Moore', 'Mike Johnson']);
bothWays('the roster holding the short form', 'Patrick Moore', 'Rick Moore', true);

console.log('\n  driver: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
