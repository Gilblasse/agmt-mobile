/**
 * Parity check — does the port still behave like the live system?
 *
 *   npm run parity
 *
 * This lifts the real pricing engine and the real driver-matching function
 * straight out of `legacy/apps-script/` and runs them side by side with the
 * TypeScript port over a wide spread of inputs. It is the check that catches
 * what unit tests cannot: a rule that was reasonable to reimplement and is
 * nevertheless not what production does.
 *
 * Run it after ANY change to src/rules/pricing.ts or src/rules/drivers.ts.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist', 'src', 'rules');

if (!fs.existsSync(dist)) {
  console.error('Build first:  npm run build');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Lift the live pricing engine out of TripManager.gs
// ---------------------------------------------------------------------------

const tm = fs.readFileSync(path.join(root, 'legacy', 'apps-script', 'TripManager.gs'), 'utf8');
const from = tm.indexOf("const PRICING_PROP_");
const to = tm.indexOf('function ppOptions_');
if (from < 0 || to < 0) throw new Error('could not find the pricing engine in TripManager.gs');

const ctx = {
  Logger: { log() {} }, console, JSON, Math, Number, String, Object, Array, Date,
  isFinite, parseInt, parseFloat,
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  // The live engine asks a derived sheet for waiting minutes. Give it the same
  // arithmetic the port does, so this compares the ENGINE and not the lookup.
  ttRowFor_: (t) => {
    const gap = (a, b) => {
      if (!a || !b) return 0;
      const m = Math.round((Date.parse(b) - Date.parse(a)) / 60000);
      return (m < 0 || m > 720) ? 0 : m;
    };
    return {
      pickupWaitMin: gap(t.pickupArrival, t.pickupDeparture),
      dropoffWaitMin: gap(t.dropoffArrival, t.dropoffDeparture),
    };
  },
};
vm.createContext(ctx);
vm.runInContext(tm.slice(from, to), ctx);

const pricing = await import(pathToFileURL(path.join(dist, 'pricing.js')).href);

let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };

// Defaults must be identical, or nothing below means anything.
const liveCfg = ctx.pricingDefaults_();
if (JSON.stringify(liveCfg) !== JSON.stringify(pricing.pricingDefaults())) {
  fail('the pricing defaults have drifted from the live ones');
} else {
  console.log('  ✓ pricing defaults are identical');
}

const transports = ['Wheelchair', 'Ambulatory', 'Stretcher', 'Taxi', 'Sedan', '', 'w/c', 'gurney', 'Something else'];
const dates = ['2026-09-12', '2026-09-14', '2026-12-25', '2026-09-07'];
const times = ['09:00', '19:30', '23:58', '02:15', '06:00', '12:00', ''];
const mileSets = [null, 0, 3, 5, 12.4, 40.7, 120];
const manualSets = [[], ['stairs'], ['tolls', 'parking'], ['otherDisc'], ['tolls', 'otherDisc'], ['attendant', 'oxygen'], ['wait']];
const droppedSets = [[], ['weekend'], ['afterHours']];
const deadheads = [0, 10, 3.5, ''];

const variants = [
  (c) => c,
  (c) => { c.mileage.minimumFare = 90; return c; },
  (c) => { c.deadhead = { mode: 'optional', includedMiles: 0, perMile: 1.5 };
           c.rules.tolls = { mode: 'optional', kind: 'fixed', amount: 6.5 };
           c.rules.otherDisc = { mode: 'optional', kind: 'percent', amount: 10 }; return c; },
  (c) => { c.wait = { mode: 'auto', graceMin: 15, intervalMin: 15, rate: 10 };
           c.holidays = ['2026-12-25']; return c; },
  (c) => { c.mileage.mode = 'off'; c.base.other = 0;
           c.rules.recurring = { mode: 'auto', kind: 'percent', amount: 10 }; return c; },
  (c) => { c.deadhead = { mode: 'optional', includedMiles: 2, perMile: 2 };
           c.mileage.minimumFare = 150;
           c.rules.facility = { mode: 'optional', kind: 'percent', amount: 20 }; return c; },
];

const shape = (q) => JSON.stringify({
  total: q.total, incomplete: q.incomplete, transport: q.transport, miles: q.miles,
  deadheadMiles: q.deadheadMiles,
  lines: q.lines.map((l) => [l.key, l.label, l.detail, l.amount, l.source]),
});

let quotes = 0, quoteDiffs = 0;
for (const variant of variants) {
  const cfg = variant(JSON.parse(JSON.stringify(liveCfg)));
  for (const transport of transports)
    for (const date of dates)
      for (const timeHm of times)
        for (const miles of mileSets)
          for (const manual of manualSets)
            for (const dropped of droppedSets)
              for (const deadheadMiles of deadheads)
                for (const recurring of [null, 'so1']) {
                  const stamps = {
                    pickupArrival: '2026-09-14T14:00:00Z', pickupDeparture: '2026-09-14T14:40:00Z',
                  };
                  const liveTrip = { transport, date, recurringId: recurring, ...stamps };
                  const portTrip = {
                    transport, serviceDate: date, standingOrderId: recurring,
                    pickupArrivalAt: stamps.pickupArrival, pickupDepartureAt: stamps.pickupDeparture,
                    dropoffArrivalAt: null, dropoffDepartureAt: null,
                  };
                  const opts = { miles, timeHm, today: '2026-09-12', manual, dropped, deadheadMiles, now: 'X' };
                  const a = ctx.ppQuote_(liveTrip, cfg, { ...opts });
                  const b = pricing.quote(portTrip, cfg, { ...opts });
                  quotes++;
                  if (shape(a) !== shape(b)) {
                    quoteDiffs++;
                    if (quoteDiffs <= 3) {
                      console.error('  ✗ quote differs: ' + JSON.stringify({ transport, date, timeHm, miles, manual, dropped, deadheadMiles, recurring }));
                      console.error('      live: ' + shape(a));
                      console.error('      port: ' + shape(b));
                    }
                  }
                }
}
if (quoteDiffs) { failures++; console.error(`  ✗ ${quoteDiffs} of ${quotes} quotes differ`); }
else console.log(`  ✓ ${quotes.toLocaleString()} quotes compared, identical`);

// ---------------------------------------------------------------------------
// Lift the live driver-matching out of DriverApp.gs
// ---------------------------------------------------------------------------

const da = fs.readFileSync(path.join(root, 'legacy', 'apps-script', 'DriverApp.gs'), 'utf8');

// The live functions take the roster from a sheet rather than as an argument.
// `currentRoster` stands in for that sheet so the two can be compared at all.
let currentRoster = [];
const dctx = {
  console, String, Array, Object,
  driverStaffRoster_: () => currentRoster.map((name) => ({ name })),
};
vm.createContext(dctx);
for (const name of ['driverNameParts_', 'driverShortFormOf_', 'driverNorm_', 'driverUniqueShortForm_', 'driverMatches_']) {
  const i = da.indexOf('function ' + name);
  if (i < 0) continue;
  const end = da.indexOf('\n}', i);   // the closing brace at column 0
  vm.runInContext(da.slice(i, end + 2), dctx);
}
const drivers = await import(pathToFileURL(path.join(dist, 'drivers.js')).href);

if (typeof dctx.driverMatches_ !== 'function') {
  console.log('  – driverMatches_ not found in DriverApp.gs; skipped');
} else {
  const roster = ['Jasmin DeFino', 'Gerald DeFino JR', 'Ashleen Roberts', 'Mark Stephen', 'Chris OBrien',
    'Danielle Blasse', 'Dan Carter', 'Patrick Nolan', 'Mike Johnson', 'Mary Johnson', 'Van Der Berg', 'José Álvarez'];
  const names = [...roster, 'DeFino', 'Jasmin', 'Jasmin D', 'Lee', 'OBrien', 'Chris', 'Rick', 'Vanderberg',
    'M Johnson', 'Mike J', 'Al', 'Dan', 'Danielle', 'jose alvarez', 'JASMIN DEFINO', 'defino, jasmin', '', '   ',
    'Alberto Defino Carter', 'Ashleen', 'Roberts', 'Stephen', 'Mark', 'Gerald', 'JR', 'Nolan', 'Patrick'];
  let n = 0, diffs = 0;
  for (const r of [roster, [], roster.slice(0, 3), ['Jasmin DeFino']]) {
    currentRoster = r;
    for (const x of names)
      for (const y of names) {
        n++;
        const live = dctx.driverMatches_(x, y);
        const port = drivers.driverMatches(x, y, r);
        if (live !== port) {
          diffs++;
          if (diffs <= 5) console.error(`  ✗ driverMatches("${x}", "${y}") roster=${r.length}: live=${live} port=${port}`);
        }
      }
  }
  if (diffs) { failures++; console.error(`  ✗ ${diffs} of ${n} name comparisons differ`); }
  else console.log(`  ✓ ${n.toLocaleString()} name comparisons, identical`);
}

console.log('');
if (failures) {
  console.error(`parity: ${failures} check(s) FAILED — the port no longer matches production.`);
  process.exit(1);
}
console.log('parity: the port matches the live system.');
