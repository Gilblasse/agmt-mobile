/**
 * The pricing engine.
 *
 * Ported from the live one, which is a PURE function and must stay one: give it
 * the same trip, config, miles, today and selections and it always returns the
 * same lines in the same order. It reads no database and no clock — "today" and
 * "now" are passed in.
 *
 * Two ideas hold it together:
 *   * a rule the system cannot detect is never automatic — it is offered, or it
 *     does not exist at all: not charged, not offered, not shown;
 *   * a quote is a LIST OF LINES, each with its own explanation, so a price can
 *     always be read back rather than taken on trust.
 */

import { money, num } from './money.js';
import { isAfterHours, isWeekend, minutesOfDay, parseDateKey, BLANK_TIME_SENTINEL } from './time.js';
import {
  PASS_THROUGH_KEYS,
  type PricingConfig,
  type PricingKind,
  type PricingMode,
  type PricingRuleDef,
  type PricingRuleKey,
  type Quote,
  type QuoteLine,
  type QuoteOptions,
  TRANSPORT_KEYS,
  type TransportKey,
  type Trip,
} from '../types/index.js';

export const MAX_PERCENT = 200;
export const MAX_AMOUNT = 100000;
export const MODES: readonly PricingMode[] = ['auto', 'optional', 'off'];

/**
 * The catalogue. `auto` is the ONLY thing that decides whether a rule may ever
 * fire by itself — a hand-edited config cannot invent a detector.
 */
export const PRICING_RULES: readonly PricingRuleDef[] = [
  { key: 'afterHours',  group: 'Scheduling',   label: 'After hours',            auto: true },
  { key: 'weekend',     group: 'Scheduling',   label: 'Weekend',                auto: true },
  { key: 'holiday',     group: 'Scheduling',   label: 'Holiday',                auto: true },
  { key: 'sameDay',     group: 'Scheduling',   label: 'Same-day request',       auto: true },
  { key: 'shortNotice', group: 'Scheduling',   label: 'Short notice',           auto: false },
  { key: 'doorToDoor',  group: 'Assistance',   label: 'Door-to-door',           auto: false },
  { key: 'doorThrough', group: 'Assistance',   label: 'Door-through-door',      auto: false },
  { key: 'stairs',      group: 'Assistance',   label: 'Stair assistance',       auto: false },
  { key: 'attendant',   group: 'Assistance',   label: 'Extra attendant',        auto: false },
  { key: 'companion',   group: 'Assistance',   label: 'Companion / escort',     auto: false },
  { key: 'extraPax',    group: 'Assistance',   label: 'Additional passenger',   auto: false },
  { key: 'bariatric',   group: 'Equipment',    label: 'Bariatric',              auto: false },
  { key: 'oxygen',      group: 'Equipment',    label: 'Oxygen',                 auto: false },
  { key: 'powerChair',  group: 'Equipment',    label: 'Power / oversized chair', auto: false },
  { key: 'equipment',   group: 'Equipment',    label: 'Special equipment',      auto: false },
  { key: 'extraStop',   group: 'Trip',         label: 'Additional stop',        auto: false },
  { key: 'waitReturn',  group: 'Trip',         label: 'Wait and return',        auto: false },
  { key: 'tolls',       group: 'Pass-through', label: 'Tolls',                  auto: false },
  { key: 'parking',     group: 'Pass-through', label: 'Parking',                auto: false },
  { key: 'cleaning',    group: 'Other',        label: 'Cleaning / biohazard',   auto: false },
  { key: 'custom',      group: 'Other',        label: 'Additional service',     auto: false },
  { key: 'recurring',   group: 'Discounts',    label: 'Recurring trip',         auto: true,  discount: true },
  { key: 'facility',    group: 'Discounts',    label: 'Facility / volume',      auto: false, discount: true },
  { key: 'otherDisc',   group: 'Discounts',    label: 'Other discount',         auto: false, discount: true },
] as const;

export function pricingRule(key: string): PricingRuleDef | null {
  return PRICING_RULES.find((r) => r.key === key) ?? null;
}

/** Opening numbers so a fresh install is never blank. Every one is meant to change. */
export function pricingDefaults(): PricingConfig {
  const seed: Record<PricingRuleKey, { mode: PricingMode; kind: PricingKind; amount: number }> = {
    afterHours:  { mode: 'auto',     kind: 'fixed',   amount: 20 },
    weekend:     { mode: 'auto',     kind: 'percent', amount: 15 },
    holiday:     { mode: 'auto',     kind: 'fixed',   amount: 40 },
    sameDay:     { mode: 'optional', kind: 'fixed',   amount: 25 },
    shortNotice: { mode: 'off',      kind: 'fixed',   amount: 15 },
    doorToDoor:  { mode: 'off',      kind: 'fixed',   amount: 0 },
    doorThrough: { mode: 'optional', kind: 'fixed',   amount: 15 },
    stairs:      { mode: 'optional', kind: 'fixed',   amount: 25 },
    attendant:   { mode: 'optional', kind: 'fixed',   amount: 35 },
    companion:   { mode: 'optional', kind: 'fixed',   amount: 10 },
    extraPax:    { mode: 'optional', kind: 'fixed',   amount: 10 },
    bariatric:   { mode: 'optional', kind: 'fixed',   amount: 75 },
    oxygen:      { mode: 'optional', kind: 'fixed',   amount: 20 },
    powerChair:  { mode: 'optional', kind: 'fixed',   amount: 30 },
    equipment:   { mode: 'optional', kind: 'fixed',   amount: 25 },
    extraStop:   { mode: 'optional', kind: 'fixed',   amount: 12 },
    waitReturn:  { mode: 'optional', kind: 'fixed',   amount: 40 },
    tolls:       { mode: 'optional', kind: 'fixed',   amount: 0 },
    parking:     { mode: 'optional', kind: 'fixed',   amount: 0 },
    cleaning:    { mode: 'optional', kind: 'fixed',   amount: 100 },
    custom:      { mode: 'optional', kind: 'fixed',   amount: 0 },
    recurring:   { mode: 'off',      kind: 'percent', amount: 10 },
    facility:    { mode: 'off',      kind: 'percent', amount: 0 },
    otherDisc:   { mode: 'off',      kind: 'fixed',   amount: 0 },
  };
  const rules = {} as PricingConfig['rules'];
  for (const r of PRICING_RULES) rules[r.key] = { ...seed[r.key] };
  return {
    version: 1,
    updatedAt: '',
    updatedBy: '',
    base: { ambulatory: 45, wheelchair: 65, stretcher: 150, taxi: 35, other: 45 },
    mileage: { mode: 'auto', includedMiles: 5, perMile: 3, minimumFare: 0 },
    // The empty run out to the passenger. Its own allowance and its own rate,
    // because most operators bill it below the loaded rate. Off out of the box,
    // so nothing about anybody's existing prices changes when this ships.
    deadhead: { mode: 'off', includedMiles: 0, perMile: 1.5 },
    wait: { mode: 'off', graceMin: 15, intervalMin: 15, rate: 10 },
    afterHoursFrom: '19:00',
    afterHoursTo: '06:00',
    holidays: [],
    rules,
  };
}

export function normalizeMode(v: unknown): PricingMode {
  const s = String(v ?? '').toLowerCase().trim() as PricingMode;
  return MODES.includes(s) ? s : 'off';
}

export function normalizeKind(v: unknown): PricingKind {
  return String(v ?? '').toLowerCase() === 'percent' ? 'percent' : 'fixed';
}

export function normalizeHm(v: unknown, fallback: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return String(h).padStart(2, '0') + ':' + m[2];
}

/**
 * Fill a stored config out against the defaults, keeping only what validates.
 * A half-written or older config can never crash a quote — and a rule the
 * catalogue says is not detectable is demoted from `auto` to `optional` on the
 * way in as well as on the way out.
 */
export function normalizeConfig(stored: Partial<PricingConfig> | null | undefined): PricingConfig {
  const d = pricingDefaults();
  const s = stored ?? {};
  const cfg: PricingConfig = {
    ...d,
    version: Math.max(1, Math.trunc(num(s.version, 1))),
    updatedAt: String(s.updatedAt ?? ''),
    updatedBy: String(s.updatedBy ?? ''),
    base: { ...d.base },
    mileage: { ...d.mileage },
    deadhead: { ...d.deadhead },
    wait: { ...d.wait },
    afterHoursFrom: normalizeHm(s.afterHoursFrom, d.afterHoursFrom),
    afterHoursTo: normalizeHm(s.afterHoursTo, d.afterHoursTo),
    holidays: Array.isArray(s.holidays) ? s.holidays.filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(String(h))) : [],
    rules: {} as PricingConfig['rules'],
  };

  for (const k of Object.keys(d.base) as TransportKey[]) {
    cfg.base[k] = clampAmount(num(s.base?.[k], d.base[k]));
  }
  cfg.mileage = {
    mode: normalizeMode(s.mileage?.mode ?? d.mileage.mode),
    includedMiles: Math.max(0, num(s.mileage?.includedMiles, d.mileage.includedMiles)),
    perMile: clampAmount(num(s.mileage?.perMile, d.mileage.perMile)),
    minimumFare: clampAmount(num(s.mileage?.minimumFare, d.mileage.minimumFare)),
  };
  cfg.deadhead = {
    // Nothing measures deadhead miles, so 'auto' would mean the same as
    // 'optional'. Collapse it rather than pretend there are three states.
    mode: normalizeMode(s.deadhead?.mode ?? d.deadhead.mode) === 'off' ? 'off' : 'optional',
    includedMiles: Math.max(0, num(s.deadhead?.includedMiles, d.deadhead.includedMiles)),
    perMile: clampAmount(num(s.deadhead?.perMile, d.deadhead.perMile)),
  };
  cfg.wait = {
    mode: normalizeMode(s.wait?.mode ?? d.wait.mode),
    graceMin: Math.max(0, num(s.wait?.graceMin, d.wait.graceMin)),
    // A stored 0 is coerced to 1. The engine treats intervalMin <= 0 as "never
    // bill a block", so leaving a legacy 0 alone would silently stop charging
    // for waiting time on a config the old system still bills.
    intervalMin: Math.max(1, num(s.wait?.intervalMin, d.wait.intervalMin) || 1),
    rate: clampAmount(num(s.wait?.rate, d.wait.rate)),
  };

  for (const r of PRICING_RULES) {
    const stored2 = s.rules?.[r.key];
    let mode = normalizeMode(stored2?.mode ?? d.rules[r.key].mode);
    if (mode === 'auto' && !r.auto) mode = 'optional';   // cannot invent a detector
    const kind = normalizeKind(stored2?.kind ?? d.rules[r.key].kind);
    const raw = num(stored2?.amount, d.rules[r.key].amount);
    const amount = kind === 'percent' ? clampPercent(raw) : clampAmount(raw);
    cfg.rules[r.key] = { mode, kind, amount };
  }
  return cfg;
}

const clampAmount = (n: number) => Math.min(MAX_AMOUNT, Math.max(-MAX_AMOUNT, n));
const clampPercent = (n: number) => Math.min(MAX_PERCENT, Math.max(-MAX_PERCENT, n));

/**
 * Things the office is not allowed to save, said in words they can act on.
 * Ported from `pricingProblems_`. Every line here is a save that went wrong.
 */
export function configProblems(cfg: PricingConfig): string[] {
  const bad: string[] = [];

  for (const k of TRANSPORT_KEYS) {
    const v = num(cfg.base[k], -1);
    const name = k === 'other' ? 'the catch-all transport' : k;
    if (v < 0) bad.push(`The base price for ${name} cannot be negative.`);
    // A cleared box saving as a real 0 quoted those trips at nothing. Refusing
    // the save outright would be worse — an operator who genuinely does not run
    // stretcher trips could not record that, and anyone whose config already
    // held a 0 from the old bug could never save again. The QUOTE flags it.
    if (v > MAX_AMOUNT) bad.push(`The base price for ${name} is unreasonably large.`);
  }

  // A time typed as "7pm" or "19.00" used to be silently thrown away and the old
  // window kept, so a dispatcher believed a change had taken effect when it had not.
  for (const k of ['afterHoursFrom', 'afterHoursTo'] as const) {
    const label = k === 'afterHoursFrom' ? 'start' : 'end';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg[k] || ''))) {
      bad.push(`The after-hours ${label} time must be typed as HH:MM on a 24-hour clock, for example 19:00.`);
    }
  }
  if (cfg.afterHoursFrom && cfg.afterHoursFrom === cfg.afterHoursTo) {
    bad.push('The after-hours window starts and ends at the same time, so it would never apply.');
  }

  if (cfg.mileage.mode !== 'off') {
    if (cfg.mileage.perMile < 0) bad.push('The per-mile rate cannot be negative.');
    if (cfg.mileage.includedMiles < 0) bad.push('Included miles cannot be negative.');
    if (cfg.mileage.minimumFare < 0) bad.push('The minimum fare cannot be negative.');
    if (cfg.mileage.perMile === 0 && cfg.mileage.mode === 'auto') {
      bad.push('Mileage is switched on but the per-mile rate is 0 - set a rate or switch mileage off.');
    }
  }

  if (cfg.deadhead.mode !== 'off') {
    if (cfg.deadhead.perMile < 0) bad.push('The deadhead per-mile rate cannot be negative.');
    if (cfg.deadhead.includedMiles < 0) bad.push('Included deadhead miles cannot be negative.');
    if (cfg.deadhead.perMile > MAX_AMOUNT) bad.push('The deadhead per-mile rate is unreasonably large.');
    if (cfg.deadhead.perMile === 0) {
      bad.push('Deadhead mileage is switched on but the per-mile rate is 0 - set a rate or switch it off.');
    }
  }

  if (cfg.wait.mode !== 'off') {
    if (cfg.wait.rate < 0) bad.push('The waiting-time charge cannot be negative.');
    if (cfg.wait.graceMin < 0) bad.push('The free waiting period cannot be negative.');
    if (cfg.wait.intervalMin <= 0) bad.push('The waiting-time interval must be at least 1 minute.');
    if (cfg.wait.rate === 0 && cfg.wait.mode === 'auto') {
      bad.push('Waiting time is switched on but the charge is 0 - set a charge or switch it off.');
    }
  }

  for (const r of PRICING_RULES) {
    const s2 = cfg.rules[r.key];
    if (!s2 || s2.mode === 'off') continue;
    if (s2.amount < 0) bad.push(`${r.label} cannot be a negative amount.`);
    if (s2.kind === 'percent' && s2.amount > MAX_PERCENT) {
      bad.push(`${r.label} is set to ${s2.amount}% - that is outside a sensible range.`);
    }
    if (s2.kind === 'fixed' && s2.amount > MAX_AMOUNT) {
      bad.push(`${r.label} is an unreasonably large amount.`);
    }
    if (s2.amount === 0 && s2.mode === 'auto') {
      bad.push(`${r.label} is set to apply automatically but its amount is 0 - give it an amount or make it optional.`);
    }
    // 0.15 typed for a 15% rule charged fifteen hundredths of one percent.
    if (s2.kind === 'percent' && s2.amount > 0 && s2.amount < 1) {
      bad.push(`${r.label} is set to ${s2.amount}%. Percentages are typed as whole numbers, so 15% is "15", not "0.15".`);
    }
    if (s2.mode === 'auto' && !r.auto) {
      bad.push(`${r.label} cannot apply automatically - nothing can detect it.`);
    }
  }

  return bad;
}

/**
 * Free text to a pricing key. Ported exactly — the order of these tests matters
 * ("wheelchair van" is a wheelchair, not a taxi) and so does what is NOT here:
 * "sedan" and "livery" fall through to `other`, on the operator's catch-all
 * base fare, rather than being guessed at as a taxi.
 */
export function transportKey(value: unknown): TransportKey {
  const s = String(value ?? '').toLowerCase();
  if (/(wheel|w\/c|\bwc\b|chair)/.test(s)) return 'wheelchair';
  if (/(stretcher|gurney)/.test(s)) return 'stretcher';
  if (/(taxi|cab)/.test(s)) return 'taxi';
  if (/(ambulatory|walking|walker|\bamb\b|walk)/.test(s)) return 'ambulatory';
  return 'other';
}

export function transportLabel(key: TransportKey): string {
  return ({ ambulatory: 'Ambulatory', wheelchair: 'Wheelchair', stretcher: 'Stretcher',
    taxi: 'Taxi', other: 'Standard' } as Record<string, string>)[key] || 'Standard';
}

/**
 * A gap between two stamps, in whole minutes.
 *
 * A gap longer than twelve hours is a forgotten tap, not a wait. Returning it
 * as a real number is how a trip ended up billed for a hundred and ninety
 * hours of waiting.
 */
export const MAX_GAP_MINUTES = 12 * 60;

export function gapMinutes(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const x = Date.parse(a), y = Date.parse(b);
  if (!isFinite(x) || !isFinite(y)) return 0;
  const m = Math.round((y - x) / 60000);
  if (m < 0 || m > MAX_GAP_MINUTES) return 0;
  return m;
}

/**
 * Minutes a driver actually waited, from their own stamps. Never a guess, and
 * never anything that has not already happened.
 *
 * A no-show or a cancellation is the exception: the driver was at the door and
 * the wait runs to the moment the office called it off.
 */
export function waitMinutes(
  trip: Partial<Trip>,
  ended?: { outcome?: 'no-show' | 'cancelled' | string; endedAt?: string | null },
): number {
  const outcome = ended?.outcome;
  const pickupWait = trip.pickupDepartureAt
    ? gapMinutes(trip.pickupArrivalAt, trip.pickupDepartureAt)
    : (outcome === 'no-show' || outcome === 'cancelled')
      ? gapMinutes(trip.pickupArrivalAt, ended?.endedAt ?? trip.dispatchStatusAt ?? null)
      : 0;
  const dropoffWait = gapMinutes(trip.dropoffArrivalAt, trip.dropoffDepartureAt);
  return pickupWait + dropoffWait;
}

/**
 * THE ENGINE.
 *
 * Order matters and every step of it was argued about with a real invoice in
 * hand. Read the comments before changing any of it.
 */
export function quote(trip: Partial<Trip>, cfg: PricingConfig, opts: QuoteOptions = {}): Quote {
  const o: QuoteOptions = { ...opts };
  const manual: Record<string, boolean> = {};
  const dropped: Record<string, boolean> = {};
  (o.manual ?? []).forEach((k) => { manual[String(k)] = true; });
  (o.dropped ?? []).forEach((k) => { dropped[String(k)] = true; });

  const lines: QuoteLine[] = [];
  const add = (key: QuoteLine['key'], label: string, detail: string, amount: number, source: 'auto' | 'manual') => {
    lines.push({ key, label, detail: detail || '', amount: money(amount), source });
  };

  // 1. Base fare.
  const tKey = transportKey(trip.transport);
  const baseAmount = num(cfg.base[tKey], 0);
  add('base', transportLabel(tKey) + ' base fare', String(trip.transport ?? '').trim() || 'No transport set', baseAmount, 'auto');
  // A zero base is a legitimate setting — a mileage-only service, or a kind of
  // transport this operator does not run. It is only a problem if nothing else
  // fills the gap, which is checked at the end once the total is known.
  const zeroBase = !(baseAmount > 0);

  // 2. Loaded mileage.
  const miles = o.miles == null ? null : Number(o.miles);
  if (cfg.mileage.mode === 'auto' && miles != null && isFinite(miles)) {
    const billable = Math.max(0, miles - cfg.mileage.includedMiles);
    const detail = miles + ' miles'
      + (cfg.mileage.includedMiles > 0 ? ', ' + cfg.mileage.includedMiles + ' included' : '')
      + ' · ' + (Math.round(billable * 10) / 10) + ' × $' + cfg.mileage.perMile.toFixed(2);
    add('mileage', 'Loaded mileage', detail, billable * cfg.mileage.perMile, 'auto');
  } else if (cfg.mileage.mode === 'auto' && miles == null) {
    add('mileage', 'Loaded mileage', 'No distance yet — check the addresses', 0, 'auto');
    // Mileage is usually most of the fare. Quoting $0 for it looked like a
    // finished price and under-billed by the whole distance. Say so instead.
    o.incompleteQuote = true;
  }

  // 3. The fare so far is what percentages are worked out from, so a percentage
  //    rule is never quietly applied to another percentage rule.
  let fare = lines.reduce((s, l) => s + l.amount, 0);

  // 4. Minimum fare, first pass.
  if (cfg.mileage.minimumFare > 0 && fare < cfg.mileage.minimumFare) {
    add('minimum', 'Minimum fare', 'Brings the fare up to $' + cfg.mileage.minimumFare.toFixed(2), cfg.mileage.minimumFare - fare, 'auto');
    fare = cfg.mileage.minimumFare;
  }

  // 5. Deadhead — the empty run out to the passenger. The dispatcher types the
  //    miles, so there is nothing to charge until they do; it is never guessed
  //    at. Added AFTER the fare is settled, deliberately: it is a cost being
  //    passed on, not part of what the ride is worth, so a weekend percentage is
  //    not taken on top of it and it cannot mask a minimum fare. A return leg
  //    never carries one — by then the driver is already at the door.
  // The engine does NOT decide this. Whether a leg carries deadhead at all is a
  // call-site decision — see `quoteInputs` — because the engine must stay pure
  // and agnostic to a trip's relationship with other trips.
  const dhMiles = num(o.deadheadMiles, 0);
  if (cfg.deadhead.mode !== 'off' && dhMiles > 0) {
    const dhBillable = Math.max(0, dhMiles - cfg.deadhead.includedMiles);
    const dhDetail = dhMiles + ' empty miles'
      + (cfg.deadhead.includedMiles > 0 ? ', ' + cfg.deadhead.includedMiles + ' included' : '')
      + ' · ' + (Math.round(dhBillable * 10) / 10) + ' × $' + cfg.deadhead.perMile.toFixed(2);
    add('deadhead', 'Deadhead mileage', dhDetail, dhBillable * cfg.deadhead.perMile, 'manual');
  }

  // 6. Waiting time, from the driver's own stamps. Nothing is charged for
  //    waiting before the trip has actually been driven.
  if (cfg.wait.mode !== 'off' && cfg.wait.rate > 0) {
    const waited = waitMinutes(trip, { outcome: o.endedOutcome, endedAt: o.endedAt });
    const over = Math.max(0, waited - cfg.wait.graceMin);
    const blocks = cfg.wait.intervalMin > 0 ? Math.ceil(over / cfg.wait.intervalMin) : 0;
    const wanted = cfg.wait.mode === 'auto' ? blocks > 0 : !!manual['wait'];
    if (wanted && blocks > 0) {
      add('wait', 'Waiting time',
        waited + ' min waited, ' + cfg.wait.graceMin + ' free · ' + blocks + ' × $' + cfg.wait.rate.toFixed(2),
        blocks * cfg.wait.rate, cfg.wait.mode === 'auto' ? 'auto' : 'manual');
    }
  }

  // 7. Detection, against the QUOTED date and time — never against "now".
  const dateKey = String(trip.serviceDate ?? '').slice(0, 10);
  const mins = minutesOfDay(o.timeHm ?? '');
  const autoWhen: Partial<Record<PricingRuleKey, () => string | null>> = {
    afterHours: () => {
      // The old system wrote 23:58 when no time was typed. Treating it as a real
      // pickup time added a late-night surcharge to every unscheduled trip.
      if (String(o.timeHm ?? '') === BLANK_TIME_SENTINEL) return null;
      return isAfterHours(mins, cfg.afterHoursFrom, cfg.afterHoursTo) ? 'Picked up at ' + clock(mins) : null;
    },
    weekend: () => (isWeekend(dateKey) ? dayName(dateKey) : null),
    holiday: () => (cfg.holidays.includes(dateKey) ? 'Holiday' : null),
    sameDay: () => (o.today && dateKey === o.today ? 'Booked for today' : null),
    recurring: () => (String(trip.standingOrderId ?? '').trim() ? 'Part of a standing order' : null),
  };

  type Pending = { rule: PricingRuleDef; set: PricingConfig['rules'][PricingRuleKey]; why: string; source: 'auto' | 'manual' };
  const charges: Pending[] = [];
  const discounts: Pending[] = [];

  for (const r of PRICING_RULES) {
    const s = cfg.rules[r.key];
    if (!s || s.mode === 'off') continue;
    let why = '';
    let source: 'auto' | 'manual' | '' = '';
    const detector = autoWhen[r.key];
    if (s.mode === 'auto' && detector) {
      const hit = detector();
      if (hit && !dropped[r.key]) { why = hit; source = 'auto'; }
      else if (hit && dropped[r.key]) continue;          // deliberately taken off
      else if (manual[r.key]) { why = 'Added by dispatch'; source = 'manual'; }
      else continue;
    } else if (manual[r.key]) {
      why = 'Added by dispatch'; source = 'manual';
    } else continue;
    if (s.amount === 0) continue;
    (r.discount ? discounts : charges).push({ rule: r, set: s, why, source: source as 'auto' | 'manual' });
  }

  // 8. Charges, on the frozen fare.
  for (const c of charges) {
    const amount = c.set.kind === 'percent' ? (fare * c.set.amount / 100) : c.set.amount;
    const detail = c.set.kind === 'percent'
      ? (c.why ? c.why + ' · ' : '') + c.set.amount + '% of the $' + money(fare).toFixed(2) + ' fare'
      : c.why;
    add(c.rule.key, c.rule.label, detail, amount, c.source);
  }

  // 9. Discounts, on the running total MINUS pass-throughs.
  //    Charges take their percentage from `fare`, which deliberately excludes
  //    deadhead, waiting, tolls and parking — money being passed on, not earned.
  //    Discounts were using the full running total instead, so the operator was
  //    handing back a slice of their own costs.
  const running = lines.reduce((s, l) => (PASS_THROUGH_KEYS.includes(l.key) ? s : s + l.amount), 0);
  for (const d of discounts) {
    const amount = d.set.kind === 'percent' ? (running * d.set.amount / 100) : d.set.amount;
    const detail = d.set.kind === 'percent'
      ? (d.why ? d.why + ' · ' : '') + d.set.amount + '% off'
      : d.why;
    add(d.rule.key, d.rule.label, detail, -Math.abs(amount), d.source);
  }

  // 10. Total.
  let total = Math.max(0, money(lines.reduce((s, l) => s + l.amount, 0)));

  // No base fare for this transport AND nothing else to charge: whatever this
  // is, it is not a price anybody should invoice.
  if (zeroBase && !(total > 0)) o.incompleteQuote = true;

  // 11. Minimum fare, second pass. The first is taken before surcharges and
  //     discounts, so a discount could pull the total back below the stated
  //     minimum while a line in the breakdown still claimed it had been met.
  if (cfg.mileage.minimumFare > 0 && total < cfg.mileage.minimumFare) {
    const shortfall = money(cfg.mileage.minimumFare - total);
    if (shortfall > 0) {
      add('minimumFloor', 'Minimum fare', 'The minimum fare is $' + cfg.mileage.minimumFare.toFixed(2), shortfall, 'auto');
      total = money(cfg.mileage.minimumFare);
    }
  }

  return {
    total,
    incomplete: !!o.incompleteQuote,
    lines,
    transport: tKey,
    miles: miles == null || !isFinite(miles) ? null : miles,
    deadheadMiles: dhMiles > 0 ? dhMiles : 0,
    configVersion: cfg.version,
    manual: Object.keys(manual).sort(),
    dropped: Object.keys(dropped).sort(),
    quotedAt: o.now ?? '',
  };
}

/**
 * What the sheet offers under "Add to this trip": every rule that is switched
 * on, is not already applied, and is not a discount a dispatcher should be
 * handing out from a trip form. Off rules never appear — that is the point.
 */
export function quoteOptions(cfg: PricingConfig, q: Quote): PricingRuleDef[] {
  const used = new Set(q.lines.map((l) => String(l.key)));
  return PRICING_RULES.filter((r) => {
    const s = cfg.rules[r.key];
    if (!s || s.mode === 'off') return false;
    if (used.has(r.key)) return false;
    if (s.amount === 0) return false;
    if (r.discount) return false;
    return true;
  });
}

/**
 * Which time a leg is priced on. A return leg is priced on the OUTBOUND leg's
 * time: the hour a passenger happens to come back is a scheduling fact, not a
 * pricing one, and this keeps an after-hours surcharge consistent across the
 * two halves of one round trip.
 */
export function priceTime(trip: Partial<Trip>, outboundTime?: string | null): string {
  if (trip.returnOfTripId && outboundTime) return outboundTime;
  return trip.scheduledTime ?? '';
}

/**
 * Build the engine's inputs for one leg of a trip.
 *
 * This is where the two cross-trip rules live, deliberately OUTSIDE the pure
 * engine:
 *   * a return leg is priced on the outbound leg's clock;
 *   * a return leg never carries deadhead — by then the driver is already at
 *     the door, and the empty run happened on the way out.
 *
 * Every caller that prices a leg must go through here, or those rules apply in
 * some paths and not others — which is exactly how the old system ended up
 * showing one price in the preview and saving another.
 */
export function quoteInputs(
  trip: Partial<Trip>,
  opts: QuoteOptions = {},
  outboundTime?: string | null,
): QuoteOptions {
  const isReturn = !!trip.returnOfTripId;
  return {
    ...opts,
    timeHm: opts.timeHm ?? priceTime(trip, outboundTime),
    deadheadMiles: isReturn ? 0 : (opts.deadheadMiles ?? trip.deadheadMiles ?? 0),
  };
}

function clock(mins: number | null): string {
  if (mins == null) return '';
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ap = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

function dayName(dateKey: string): string {
  const d = parseDateKey(dateKey);
  if (!d) return 'Weekend';
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]!;
}
