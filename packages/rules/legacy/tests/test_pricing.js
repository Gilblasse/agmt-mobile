// V120 regression tests for the pricing engine, run against the real source.
const fs = require('fs');
let src = fs.readFileSync('file_29.js', 'utf8').replace(/\r\n/g, '\n');

// Pull out just the pure pricing functions we can exercise without a spreadsheet.
function grab(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const PRELUDE = `
const PRICING_MODES_ = ['off','auto','manual'];
const PRICING_MAX_AMOUNT_ = 100000;
const PRICING_MAX_PERCENT_ = 100;
const PRICING_TRANSPORTS_ = ['ambulatory','wheelchair','stretcher','other'];
const PRICING_RULES_ = [
  {key:'afterHours', label:'After hours', group:'time'},
  {key:'weekend', label:'Weekend', group:'time'},
  {key:'holiday', label:'Holiday', group:'time'},
  {key:'sameDay', label:'Same day', group:'time'},
  {key:'recurring', label:'Standing order', group:'other', discount:true},
  {key:'tolls', label:'Tolls', group:'cost'},
  {key:'parking', label:'Parking', group:'cost'}
];
function ppTransportKey_(v){ const s=String(v||'').toLowerCase();
  if(s.indexOf('stretch')>=0) return 'stretcher';
  if(s.indexOf('wheel')>=0) return 'wheelchair';
  if(s.indexOf('amb')>=0) return 'ambulatory';
  return 'other'; }
function ppTransportLabel_(k){ return k.charAt(0).toUpperCase()+k.slice(1); }
function ppMinutesOfDay_(hm){ const m=/^(\\d{1,2}):(\\d{2})/.exec(String(hm||'')); return m?Number(m[1])*60+Number(m[2]):-1; }
function ppIsAfterHours_(mins,f,t){ if(mins<0)return false; const F=ppMinutesOfDay_(f),T=ppMinutesOfDay_(t);
  if(F<=T) return mins>=F&&mins<T; return mins>=F||mins<T; }
function ppIsWeekend_(k){ const d=new Date(String(k)+'T12:00:00'); const n=d.getDay(); return n===0||n===6; }
function ppDayName_(k){ return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(String(k)+'T12:00:00').getDay()]; }
function ppClock_(m){ let h=Math.floor(m/60), mi=m%60; const ap=h>=12?'PM':'AM'; h=h%12||12; return h+':'+String(mi).padStart(2,'0')+' '+ap; }
function ppWaitMinutes_(t){ return Number(t.__wait||0); }
`;

const code = PRELUDE + [
  grab('pricingNum_'), grab('pricingMode_'), grab('pricingKind_'),
  grab('pricingMoney_'), grab('ppQuote_')
].join('\n') + '\nmodule.exports = { pricingNum_, pricingMoney_, ppQuote_ };';

fs.mkdirSync('/tmp/claude-0/v120', { recursive: true });
fs.writeFileSync('/tmp/claude-0/v120/pricing.js', code);
const M = require('/tmp/claude-0/v120/pricing.js');

let pass = 0, fail = 0;
function is(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log('  FAIL ' + label + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)); }
}

// ---- pricingNum_ ----------------------------------------------------------
is('blank falls back',        M.pricingNum_('', 45), 45);
is('null falls back',         M.pricingNum_(null, 45), 45);
is('garbage falls back',      M.pricingNum_('abc', 45), 45);
is('a real zero is a zero',   M.pricingNum_('0', 45), 0);
is('dollars parse',           M.pricingNum_('$45.00', 1), 45);
is('thousands parse',         M.pricingNum_('1,250', 1), 1250);
is('negative parses',         M.pricingNum_('-10', 1), -10);

// ---- pricingMoney_ --------------------------------------------------------
is('half cent rounds up',     M.pricingMoney_(1.005), 1.01);
is('negatives round the same way', M.pricingMoney_(-1.005), -1.01);
is('NaN is zero',             M.pricingMoney_('x'), 0);
is('plain value survives',    M.pricingMoney_(33.5), 33.5);

// ---- ppQuote_ -------------------------------------------------------------
const cfg = {
  version: 1,
  base: { ambulatory: 45, wheelchair: 65, stretcher: 120, other: 45 },
  mileage: { mode: 'auto', includedMiles: 5, perMile: 3, minimumFare: 0 },
  deadhead: { mode: 'manual', includedMiles: 0, perMile: 1.5 },
  wait: { mode: 'auto', graceMin: 15, intervalMin: 15, rate: 10 },
  afterHoursFrom: '19:00', afterHoursTo: '06:00', holidays: [],
  rules: {
    afterHours: { mode: 'auto', kind: 'fixed', amount: 20 },
    weekend: { mode: 'auto', kind: 'percent', amount: 15 },
    holiday: { mode: 'auto', kind: 'percent', amount: 25 },
    sameDay: { mode: 'auto', kind: 'fixed', amount: 15 },
    recurring: { mode: 'auto', kind: 'percent', amount: 10, discount: true },
    tolls: { mode: 'manual', kind: 'fixed', amount: 12 },
    parking: { mode: 'manual', kind: 'fixed', amount: 8 }
  }
};
const trip = (o) => Object.assign({ date: '2026-09-09', transport: 'Ambulatory', time: '09:00' }, o);

const q1 = M.ppQuote_(trip(), cfg, { miles: 40, timeHm: '09:00' });
is('40 miles quotes correctly', q1.total, 45 + 35 * 3);
is('a complete quote is not flagged', !!q1.incomplete, false);

const q2 = M.ppQuote_(trip(), cfg, { miles: null, timeHm: '09:00' });
is('no distance is flagged incomplete', q2.incomplete, true);

const q3 = M.ppQuote_(trip(), cfg, { miles: 10, timeHm: '23:58' });
is('23:58 is not after hours', q3.lines.some(l => l.key === 'afterHours'), false);
const q4 = M.ppQuote_(trip(), cfg, { miles: 10, timeHm: '20:30' });
is('20:30 is after hours', q4.lines.some(l => l.key === 'afterHours'), true);

// discount must not come off deadhead
const cfgD = JSON.parse(JSON.stringify(cfg));
cfgD.mileage.mode = 'off';
const q5 = M.ppQuote_(trip({ recurringId: 'r1' }), cfgD, { miles: null, deadheadMiles: 10, timeHm: '09:00' });
is('discount ignores the deadhead pass-through', q5.total, M.pricingMoney_(45 - 4.5 + 15));

// minimum fare is a floor on the TOTAL
const cfgM = JSON.parse(JSON.stringify(cfg));
cfgM.mileage.minimumFare = 60;
const q6 = M.ppQuote_(trip({ recurringId: 'r1' }), cfgM, { miles: 6, timeHm: '09:00' });
is('the total never lands under the minimum fare', q6.total >= 60, true);

// weekend surcharge still applies
const q7 = M.ppQuote_(trip({ date: '2026-09-12' }), cfgD, { miles: null, timeHm: '09:00' });
is('Saturday carries the weekend surcharge', q7.total, M.pricingMoney_(45 * 1.15));

// ---- a zero base fare is a legitimate mileage-only setting ----------------
const cfgZero = JSON.parse(JSON.stringify(cfg));
cfgZero.base.ambulatory = 0;
cfgZero.mileage.includedMiles = 0;
cfgZero.mileage.perMile = 4;
const qz = M.ppQuote_(trip(), cfgZero, { miles: 20, timeHm: '09:00' });
is('mileage-only pricing still produces a price', qz.total, 80);
is('and it is not flagged as unpriceable', !!qz.incomplete, false);

// ...but a quote that comes to nothing is not a price
const cfgNothing = JSON.parse(JSON.stringify(cfgZero));
cfgNothing.mileage.mode = 'off';
const qn = M.ppQuote_(trip(), cfgNothing, { miles: null, timeHm: '09:00' });
is('a quote of nothing is flagged', qn.incomplete, true);
is('and the total really is nothing', qn.total, 0);

console.log('\n  pricing: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
