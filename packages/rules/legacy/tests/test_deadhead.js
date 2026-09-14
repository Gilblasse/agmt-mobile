// V118: deadhead - the empty run out to the passenger, typed by the dispatcher.
process.env.TZ = 'America/New_York';
const fs = require('fs');
const src = fs.readFileSync('/home/claude/work/file_29.js', 'utf8').replace(/\r\n/g, '\n');
function grab(name) {
  const re = new RegExp('(?:^|\\n)(function ' + name + '\\s*\\([^)]*\\)\\s*\\{)');
  const m = re.exec(src); if (!m) throw new Error('missing ' + name);
  let i = m.index + m[0].indexOf('function'), depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); } }
}
function grabConst(n) { const m = new RegExp('const ' + n + '\\s*=[^;]*;').exec(src); if (!m) throw new Error('missing ' + n); return m[0]; }
const consts = ['PRICING_PROP_','PRICING_MAX_PERCENT_','PRICING_MAX_AMOUNT_','PRICING_TRANSPORTS_','PRICING_MODES_','PRICING_RULES_','PLAN_DRIVE_CACHE_SECONDS_','TRIP_TIMES_MAX_GAP_MIN_'];
const names = ['pricingRule_','pricingDefaults_','pricingNum_','pricingMode_','pricingKind_','pricingHm_','pricingMoney_','pricingConfig','savePricingSettings','pricingProblems_',
  'ppIsPrivate_','ppTransportKey_','ppTransportLabel_','ppMinutesOfDay_','ppIsAfterHours_','ppIsWeekend_','ppDayName_','ppClock_','ppWaitMinutes_','ppQuote_','ppOptions_','planDriveInfo_','planNorm_',
  'ppRouteKey_','repricePrivatePayTrips_','stAddrKey_','ttRowFor_','ttInstant_','ttTimeOfDay_','ttScheduled_','ttClock_','ttGap_','pendingDateKey_'];
const code = consts.map(grabConst).join('\n') + '\n' + names.map(grab).join('\n');

const props = {}; const cache = {};
const ctx = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
  Session: { getScriptTimeZone: () => 'America/New_York' },
  Utilities: { formatDate: (d, tz, f) => { const p = n => String(n).padStart(2,'0'); return f === 'HH:mm' ? p(d.getHours())+':'+p(d.getMinutes()) : d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); },
    base64EncodeWebSafe: s => Buffer.from(String(s)).toString('base64'), computeDigest: (a,s) => String(s), DigestAlgorithm: { MD5: 'md5' } },
  Maps: { newDirectionFinder: () => ({ setOrigin(){return this;}, setDestination(){return this;}, setMode(){return this;},
      getDirections(){ return { routes:[{legs:[{duration:{value:1620}, distance:{value:32186.9}}]}] }; } }), DirectionFinder: { Mode: { DRIVING:'d' } } },
  Logger: { log() {} }, pendingActor_: () => 't@e.com',
  tripManager: { getTripsByDate: () => [] }
};
const api = new Function(...Object.keys(ctx), code + '\nreturn { ppQuote_, pricingDefaults_, pricingConfig, savePricingSettings, pricingProblems_, repricePrivatePayTrips_ };')(...Object.values(ctx));

let P = 0, F = 0;
const eq = (a,b,l,x) => { const ok = JSON.stringify(a)===JSON.stringify(b); ok?P++:F++; console.log((ok?'ok   ':'FAIL ')+l+(ok?'':'\n       got  '+JSON.stringify(a)+'\n       want '+JSON.stringify(b)+(x!==undefined?'\n       ctx  '+JSON.stringify(x):''))); };

const trip = { privatePay:'true', transport:'Wheelchair', date:'2026-09-08', time:'10:00', pickup:'A', dropoff:'B' };
const line = (q, k) => (q.lines || []).filter(l => l.key === k)[0];

// ---- off out of the box ----
let cfg = api.pricingDefaults_();
eq(cfg.deadhead, { mode:'off', includedMiles:0, perMile:1.5 }, 'a fresh config has deadhead switched off');
let q = api.ppQuote_(trip, cfg, { miles: 20, deadheadMiles: 30, timeHm: '10:00' });
eq(!line(q, 'deadhead'), true, 'switched off, even 30 typed miles change nothing');
const offTotal = q.total;

// ---- switched on ----
cfg.deadhead = { mode: 'optional', includedMiles: 10, perMile: 1.5 };
q = api.ppQuote_(trip, cfg, { miles: 20, deadheadMiles: 0, timeHm: '10:00' });
eq(!line(q, 'deadhead'), true, 'switched on but no miles typed: still nothing - it is never guessed at');
eq(q.total, offTotal, 'and the price is exactly what it was');

q = api.ppQuote_(trip, cfg, { miles: 20, deadheadMiles: 30, timeHm: '10:00' });
const dh = line(q, 'deadhead');
eq(!!dh, true, '30 empty miles typed: a deadhead line appears');
eq(dh.amount, 30, '20 billable miles at $1.50 = $30.00', dh);
eq(dh.detail, '30 empty miles, 10 included · 20 × $1.50', 'and it shows its working', dh.detail);
eq(dh.source, 'manual', 'marked as the dispatcher\'s own entry, not something detected');
eq(q.total, offTotal + 30, 'the total goes up by exactly that', [offTotal, q.total]);
eq(q.deadheadMiles, 30, 'the quote remembers the miles');

// ---- the allowance ----
q = api.ppQuote_(trip, cfg, { miles: 20, deadheadMiles: 10, timeHm: '10:00' });
eq(line(q, 'deadhead').amount, 0, 'exactly the free allowance costs nothing');
eq(q.total, offTotal, 'so the price does not move');
q = api.ppQuote_(trip, cfg, { miles: 20, deadheadMiles: 4, timeHm: '10:00' });
eq(line(q, 'deadhead').amount, 0, 'under the allowance costs nothing either');
q = api.ppQuote_(trip, cfg, { miles: 20, deadheadMiles: 10.5, timeHm: '10:00' });
eq(line(q, 'deadhead').amount, 0.75, 'half a mile over is charged as half a mile', line(q,'deadhead'));
cfg.deadhead.includedMiles = 0;
q = api.ppQuote_(trip, cfg, { miles: 20, deadheadMiles: 8, timeHm: '10:00' });
eq(line(q, 'deadhead').detail, '8 empty miles · 8 × $1.50', 'with no allowance it does not mention one', line(q,'deadhead').detail);
cfg.deadhead.includedMiles = 10;

// ---- it is charged on the fare, and percentages are not taken on it twice ----
cfg.rules.weekend = { mode: 'auto', kind: 'percent', amount: 15 };
const sat = Object.assign({}, trip, { date: '2026-09-12' });
const noDh = api.ppQuote_(sat, cfg, { miles: 20, deadheadMiles: 0, timeHm: '10:00' });
const withDh = api.ppQuote_(sat, cfg, { miles: 20, deadheadMiles: 30, timeHm: '10:00' });
eq(line(noDh, 'weekend').amount, line(withDh, 'weekend').amount,
   'a percentage surcharge is worked out on the fare, so deadhead does not inflate it',
   [line(noDh,'weekend'), line(withDh,'weekend')]);
eq(withDh.total, noDh.total + 30, 'the deadhead is simply added on top', [noDh.total, withDh.total]);
delete cfg.rules.weekend.mode; cfg.rules.weekend = { mode: 'off', kind: 'percent', amount: 15 };

// ---- rubbish in the box cannot break a quote ----
[null, undefined, '', 'abc', -5, {}].forEach(function(v) {
  const r = api.ppQuote_(trip, cfg, { miles: 20, deadheadMiles: v, timeHm: '10:00' });
  eq(!line(r, 'deadhead') && r.total === offTotal, true, 'a deadhead value of ' + JSON.stringify(v) + ' is ignored, not fatal', r.total);
});

// ---- settings: stored, read back, and validated ----
props[Object.keys(props).length ? 'x' : 'x'] = undefined;
let saved = api.savePricingSettings(Object.assign(api.pricingDefaults_(), { deadhead: { mode: 'optional', includedMiles: 8, perMile: 2.25 } }));
eq(saved.ok, true, 'a sensible deadhead setting saves', saved.problems);
eq(api.pricingConfig().deadhead, { mode:'optional', includedMiles:8, perMile:2.25 }, 'and reads back exactly');

let bad = api.savePricingSettings(Object.assign(api.pricingDefaults_(), { deadhead: { mode: 'optional', includedMiles: 5, perMile: 0 } }));
eq(bad.ok, false, 'switched on with a rate of 0 is refused');
eq(bad.problems.some(p => /rate is 0/.test(p)), true, 'and says why in words', bad.problems);
bad = api.savePricingSettings(Object.assign(api.pricingDefaults_(), { deadhead: { mode: 'optional', includedMiles: -3, perMile: 2 } }));
eq(bad.problems.some(p => /Included deadhead miles cannot be negative/.test(p)), true, 'negative free miles are refused', bad.problems);
bad = api.savePricingSettings(Object.assign(api.pricingDefaults_(), { deadhead: { mode: 'optional', includedMiles: 1, perMile: -2 } }));
eq(bad.problems.some(p => /per-mile rate cannot be negative/.test(p)), true, 'a negative rate is refused', bad.problems);
// switched off, a rate of 0 is nobody's business
eq(api.savePricingSettings(Object.assign(api.pricingDefaults_(), { deadhead: { mode: 'off', includedMiles: 0, perMile: 0 } })).ok, true,
   'switched off, a rate of 0 is fine');
// a config saved before deadhead existed still opens
props['privatePay:pricing:v1'] = JSON.stringify({ version: 3, base: { wheelchair: 65 }, mileage: { mode: 'auto', includedMiles: 5, perMile: 3 } });
eq(api.pricingConfig().deadhead, { mode:'off', includedMiles:0, perMile:1.5 }, 'an older stored config gets the default and cannot crash');

// ---- the server prices what it saves ----
const cfg2 = api.pricingDefaults_();
cfg2.version = 9;
cfg2.deadhead = { mode: 'optional', includedMiles: 10, perMile: 1.5 };
props['privatePay:pricing:v1'] = JSON.stringify(cfg2);
const out = { tripKeyID:'a', id:'ID-a', privatePay:'true', transport:'Wheelchair', date:'2026-09-08', time:'10:00',
  pickup:'A', dropoff:'B', deadheadMiles: 30, pricing: { miles: 20, manual: [], dropped: [] } };
const back = Object.assign({}, out, { tripKeyID:'b', id:'ID-b', time:'14:00', pickup:'B', dropoff:'A', returnOf:'ID-a' });
api.repricePrivatePayTrips_([out, back]);
eq(!!(out.pricing.lines || []).filter(l => l.key === 'deadhead')[0], true, 'the trip out is saved with its deadhead');
eq(!(back.pricing.lines || []).filter(l => l.key === 'deadhead')[0], true,
   'the return leg is NOT - the driver is already there');
eq(out.price - back.price, 30, 'so the trip out costs exactly the deadhead more', [out.price, back.price]);
eq(out.pricing.deadheadMiles, 30, 'and the snapshot records the miles for next time');

console.log('\n' + P + ' passed, ' + F + ' failed');
process.exit(F ? 1 : 0);
