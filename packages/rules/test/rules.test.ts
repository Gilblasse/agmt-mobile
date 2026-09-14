/**
 * Every assertion here describes a real failure that reached a real dispatcher
 * or a real driver. If one of these goes red, something that used to be broken
 * is broken again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { money, num, dollars } from '../src/rules/money.js';
import {
  hhmm, hhmmOrNull, isBlankTimeSentinel, timeSortValue, minutesOfDay, dateKeyOf,
  officeDateKey, isWeekend, addDays, weekdayToken, isAfterHours, liveWaitMs,
  MAX_LIVE_WAIT_MS,
} from '../src/rules/time.js';
import {
  resolveTripStatus, tripOutcome, isFinished, canAdvance, stampFieldFor,
  undoTarget, isOverdue, isTerminalDispatchStatus,
} from '../src/rules/status.js';
import { nameParts, normalizeName, driverMatches, driverOwnsTrip } from '../src/rules/drivers.js';
import {
  pricingDefaults, normalizeConfig, quote, transportKey, quoteOptions,
  configProblems, priceTime, quoteInputs, waitMinutes, PRICING_RULES,
} from '../src/rules/pricing.js';
import { expandPattern, daysForFrequency, spreadableFields } from '../src/rules/recurrence.js';
import { STANDING_ORDER_BLOCKED_FIELDS } from '../src/types/index.js';

// ---------------------------------------------------------------------------
test('money — a blank box is not a zero', () => {
  // A cleared base-fare box quoted every trip at nothing, because Number('')
  // is 0 and isFinite(0) is true, so the fallback never fired.
  assert.equal(num('', 45), 45);
  assert.equal(num(null, 45), 45);
  assert.equal(num('   ', 45), 45);
  assert.equal(num('-', 45), 45);
  assert.equal(num('.', 45), 45);
  assert.equal(num('0', 45), 0, 'a typed zero IS a zero');
  assert.equal(num('$65.50', 0), 65.5);
  assert.equal(num('abc', 12), 12);
});

test('money — half a cent rounds up, in both directions', () => {
  // Math.round(1.005 * 100) is 100.4999..., so discounts drifted one way and
  // charges the other, and a breakdown stopped adding up to its own total.
  assert.equal(money(1.005), 1.01);
  assert.equal(money(-1.005), -1.01);
  assert.equal(money(2.675), 2.68);
  assert.equal(money(-2.675), -2.68);
  assert.equal(money('nonsense'), 0);
  assert.equal(dollars(-8.7), '-$8.70');
});

// ---------------------------------------------------------------------------
test('clock — the afternoon is the afternoon', () => {
  // "2:30pm" has a digit before the P, so \bPM\b never matched and the
  // commonest way a dispatcher types a time was read as half past two in the
  // MORNING. Trips went out twelve hours early.
  assert.equal(hhmm('2:30 PM'), '14:30');
  assert.equal(hhmm('2:30pm'), '14:30');
  assert.equal(hhmm('2:30P.M.'), '14:30');
  assert.equal(hhmm('7:05PM'), '19:05');
  assert.equal(hhmm('12:15 AM'), '00:15');
  assert.equal(hhmm('12:15 PM'), '12:15');
  assert.equal(hhmm('14:30'), '14:30');
  assert.equal(hhmm('1899-12-30T17:30:00.000Z'), '17:30');
  assert.equal(hhmm('nope'), null);
  assert.equal(hhmm('29:00'), null);
});

test('clock — the blank-time sentinel dies on import', () => {
  // The old system wrote 23:58 to mean "nobody typed a time". Importing that
  // as a real time gives every untimed trip a two-minutes-to-midnight pickup.
  assert.equal(hhmmOrNull('23:58'), null);
  assert.equal(hhmmOrNull('11:58 PM'), null);
  assert.equal(hhmmOrNull('14:30'), '14:30');
  assert.equal(isBlankTimeSentinel('11:58 PM'), true);
  assert.equal(isBlankTimeSentinel(''), true);
  assert.equal(isBlankTimeSentinel('14:30'), false);
});

test('clock — a trip with no time sorts last, not first', () => {
  // An untimed trip at the top of the board was read as the next job to run.
  assert.ok(timeSortValue('') > timeSortValue('23:59'));
  assert.equal(timeSortValue('06:00'), 360);
  assert.equal(minutesOfDay('19:00'), 1140);
  assert.equal(minutesOfDay('bad'), null);
});

test('calendar — days are walked, not added in 24-hour blocks', () => {
  // Adding 86,400,000 ms lands an hour out on the two days a year the clocks
  // change, which drops or doubles a day of a standing order.
  assert.equal(addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayToken('2026-09-12'), 'SAT');
  assert.equal(isWeekend('2026-09-12'), true);
  assert.equal(isWeekend('2026-09-14'), false);
  assert.equal(dateKeyOf(new Date(2026, 8, 12)), '2026-09-12');
});

test('calendar — the day is the office\'s day, not the server\'s', () => {
  // A server in UTC calls it tomorrow from 8pm Eastern, which put the evening's
  // trips on the wrong board.
  const evening = new Date('2026-09-12T02:30:00Z'); // 10:30pm Sep 11 in New York
  assert.equal(officeDateKey(evening, 'America/New_York'), '2026-09-11');
  assert.equal(officeDateKey(evening, 'UTC'), '2026-09-12');
});

test('after-hours wraps midnight', () => {
  assert.equal(isAfterHours(minutesOfDay('20:00'), '19:00', '06:00'), true);
  assert.equal(isAfterHours(minutesOfDay('02:00'), '19:00', '06:00'), true);
  assert.equal(isAfterHours(minutesOfDay('12:00'), '19:00', '06:00'), false);
  assert.equal(isAfterHours(minutesOfDay('06:00'), '19:00', '06:00'), false, 'the window ends AT 06:00');
  assert.equal(isAfterHours(null, '19:00', '06:00'), false);
});

test('a timer that has run away shows nothing', () => {
  // A past trip sat on the board reading "191h 37m" because a driver never
  // tapped Complete. A number that large is not information.
  const now = Date.UTC(2026, 8, 12, 15, 0, 0);
  assert.equal(liveWaitMs(now - 20 * 60000, now, '2026-09-12', '2026-09-12'), 20 * 60000);
  assert.equal(liveWaitMs(now - MAX_LIVE_WAIT_MS - 1, now, '2026-09-12', '2026-09-12'), null);
  // A trip on another day only still ticks if the tap itself is recent — that
  // grace is what keeps an 11:50pm pickup ticking at ten past midnight.
  assert.equal(liveWaitMs(now - 5 * 60000, now, '2026-09-11', '2026-09-12'), 5 * 60000, 'just over midnight');
  assert.equal(liveWaitMs(now - 2 * 3600_000, now, '2026-09-10', '2026-09-12'), null, 'an old day, long over');
  assert.equal(liveWaitMs(now + 60 * 60000, now, '2026-09-12', '2026-09-12'), null, 'never negative');
  assert.equal(liveWaitMs(null, now, '2026-09-12', '2026-09-12'), null);
});

// ---------------------------------------------------------------------------
test('status — calling a trip off is visible whatever the driver is doing', () => {
  // Cancel and No Show used to be hidden the moment a driver tapped a step, so
  // a cancelled trip went on looking live and the dispatcher thought the cancel
  // had not worked.
  assert.equal(resolveTripStatus('INTRANSIT', 'CANCEL'), 'cancel');
  assert.equal(resolveTripStatus('INTRANSIT', 'NO SHOW'), 'noshow');
  // Reassign too: nothing clears the driver's column, so the board would read
  // "In Transit" under the OLD driver's name for ever.
  assert.equal(resolveTripStatus('INTRANSIT', 'REASSIGN'), 'reassign');
  // But these describe a trip that has not started, so they give way.
  assert.equal(resolveTripStatus('INTRANSIT', 'READY'), 'intransit');
  assert.equal(resolveTripStatus('', 'READY'), 'ready');
  assert.equal(resolveTripStatus('COMPLETE', 'READY'), 'complete');
});

test('status — the dispatcher\'s word decides the outcome', () => {
  const base = { dispatchStatus: '' as const, driverProgress: '' as const, dropoffDepartureAt: null };
  assert.equal(tripOutcome(base), 'in progress');
  assert.equal(tripOutcome({ ...base, driverProgress: 'COMPLETE' }), 'completed');
  assert.equal(tripOutcome({ ...base, dropoffDepartureAt: '2026-09-12T15:00:00Z' }), 'completed');
  // Declared a no-show even though the driver had tapped all the way through.
  assert.equal(tripOutcome({ dispatchStatus: 'NO SHOW', driverProgress: 'COMPLETE', dropoffDepartureAt: '2026-09-12T15:00:00Z' }), 'no-show');
  assert.equal(isFinished({ ...base, dispatchStatus: 'CANCEL' }), true);
  assert.equal(isFinished(base), false);
  assert.equal(isTerminalDispatchStatus('REASSIGN'), true);
  assert.equal(isTerminalDispatchStatus('READY'), false);
});

test('status — a tap can never move a trip backwards', () => {
  // A phone that was underground re-sends old taps when it surfaces.
  assert.equal(canAdvance('PICKUP LOCATION', 'INTRANSIT'), true);
  assert.equal(canAdvance('COMPLETE', 'INTRANSIT'), false);
  assert.equal(canAdvance('INTRANSIT', 'INTRANSIT'), false, 'a repeat is not an advance');
  assert.equal(stampFieldFor('PICKUP LOCATION'), 'pickupArrivalAt');
  assert.equal(stampFieldFor('COMPLETE'), 'dropoffDepartureAt');
  assert.equal(stampFieldFor('IN ROUTE'), null);
  assert.equal(undoTarget('INTRANSIT'), 'PICKUP LOCATION');
  assert.equal(undoTarget(''), '');
});

test('status — an overdue trip nobody dealt with stays on the board', () => {
  // This looks like a bug and is not. The operator was asked and chose it, so
  // a missed pickup cannot quietly disappear.
  const late = { scheduledTime: '09:00', dispatchStatus: '' as const, driverProgress: '' as const, dropoffDepartureAt: null };
  assert.equal(isOverdue(late, 11 * 60), true);
  assert.equal(isOverdue({ ...late, driverProgress: 'INTRANSIT' }, 11 * 60), false, 'somebody is on the way');
  assert.equal(isOverdue({ ...late, dispatchStatus: 'CANCEL' }, 11 * 60), false, 'it was dealt with');
  assert.equal(isOverdue({ ...late, scheduledTime: null }, 11 * 60), false);
});

// ---------------------------------------------------------------------------
test('identity — a driver sees their own trips and nobody else\'s', () => {
  // "Lee" is inside "Ashleen". A substring match let one driver complete
  // another driver's trips. Four tests, in order, and the last one needs the
  // roster to agree. Every expectation below is checked against the live function.
  const roster = ['Jasmin DeFino', 'Gerald DeFino JR', 'Ashleen Roberts', 'Mark Stephen',
    'Chris OBrien', 'Dan Carter', 'Danielle Blasse', 'Patrick Nolan', 'Mike Johnson', 'Mary Johnson'];

  // 1 — the same name, however it is written; and every part of the shorter
  //     name being a whole part of the longer one.
  assert.equal(driverMatches('Jasmin DeFino', 'Jasmin DeFino', roster), true);
  assert.equal(driverMatches('jasmin  defino', 'Jasmin DeFino', roster), true);
  assert.equal(driverMatches('DeFino, Jasmin', 'Jasmin DeFino', roster), true);
  assert.equal(driverMatches('DeFino', 'Jasmin DeFino', roster), true);
  assert.equal(driverMatches('OBrien', 'Chris OBrien', roster), true);

  // 2 — the shorter name written solid is a run of the longer one's parts.
  assert.equal(driverMatches('Vanderberg', 'Van Der Berg', roster), true);

  // 3 — the first name in full, then initials. Requiring the FIRST part in full
  //     separates "Mike J" from "M Johnson", which could be Mike or Mary.
  assert.equal(driverMatches('Mike J', 'Mike Johnson', roster), true);
  assert.equal(driverMatches('M Johnson', 'Mike Johnson', roster), false);

  // 4 — a short form, but only when the roster says it can mean one person.
  assert.equal(driverMatches('Chris', 'Chris OBrien', roster), true);
  assert.equal(driverMatches('Rick', 'Patrick Nolan', roster), true);

  // And the refusals that matter.
  assert.equal(driverMatches('Lee', 'Ashleen Roberts', roster), false, 'never a bare substring');
  assert.equal(driverMatches('Dan', 'Danielle Blasse', roster), false, 'Dan Carter is also on staff');
  assert.equal(driverMatches('Danielle Blasse', 'Dan Carter', roster), false);
  assert.equal(driverMatches('Mark Stephen', 'Ashleen Roberts', roster), false);
  assert.equal(driverMatches('', 'Jasmin DeFino', roster), false);

  assert.equal(normalizeName("O'Brien"), 'obrien');
  assert.deepEqual(nameParts('José  Álvarez'), ['jose', 'alvarez']);
});


test('identity — a failed lookup is not "not yours"', () => {
  // Conflating the two destroyed a completed pickup: the record could not be
  // read, the app called it somebody else's trip, and the work was thrown away.
  const driver = { id: 'd1', name: 'Jasmin DeFino' };
  assert.deepEqual(driverOwnsTrip(null, driver), { ok: false, reason: 'lookup-failed' });
  assert.deepEqual(driverOwnsTrip({ driverId: 'd1', driverName: null }, driver), { ok: true });
  assert.deepEqual(driverOwnsTrip({ driverId: 'd2', driverName: null }, driver), { ok: false, reason: 'not-yours' });
  assert.deepEqual(driverOwnsTrip({ driverId: null, driverName: '' }, driver), { ok: false, reason: 'no-driver' });
  assert.deepEqual(driverOwnsTrip({ driverId: null, driverName: 'Jasmin DeFino' }, driver, ['Jasmin DeFino']), { ok: true });
});

// ---------------------------------------------------------------------------
test('pricing — the catalogue is complete and only detectable rules may be automatic', () => {
  assert.equal(PRICING_RULES.length, 24);
  const autoKeys = PRICING_RULES.filter((r) => r.auto).map((r) => r.key).sort();
  assert.deepEqual(autoKeys, ['afterHours', 'holiday', 'recurring', 'sameDay', 'weekend']);
  // A hand-edited config cannot invent a detector.
  const cfg = normalizeConfig({ rules: { stairs: { mode: 'auto', kind: 'fixed', amount: 25 } } } as never);
  assert.equal(cfg.rules.stairs.mode, 'optional');
  assert.equal(cfg.rules.afterHours.mode, 'auto');
});

test('pricing — a trip is priced as a breakdown, never as one number', () => {
  const cfg = pricingDefaults();
  const q = quote(
    { transport: 'Wheelchair', serviceDate: '2026-09-14', standingOrderId: null },
    cfg,
    { miles: 12.4, timeHm: '10:00', today: '2026-09-14' },
  );
  assert.equal(q.lines[0]!.key, 'base');
  assert.equal(q.lines[0]!.amount, 65);
  assert.equal(q.lines[1]!.key, 'mileage');
  assert.equal(q.lines[1]!.amount, money((12.4 - 5) * 3));
  assert.equal(q.total, money(65 + (12.4 - 5) * 3));
  assert.equal(q.incomplete, false);
  assert.equal(q.transport, 'wheelchair');
});

test('pricing — no distance means the price is not finished', () => {
  // Mileage is usually most of the fare. A $0 mileage line looked like a
  // finished price and under-billed by the whole distance.
  const q = quote({ transport: 'Wheelchair', serviceDate: '2026-09-14' }, pricingDefaults(), { miles: null, timeHm: '10:00' });
  assert.equal(q.incomplete, true);
  assert.equal(q.lines.find((l) => l.key === 'mileage')!.amount, 0);
});

test('pricing — a percentage is never taken on another percentage', () => {
  const cfg = pricingDefaults();
  cfg.rules.weekend = { mode: 'auto', kind: 'percent', amount: 15 };
  cfg.rules.holiday = { mode: 'auto', kind: 'fixed', amount: 40 };
  cfg.holidays = ['2026-09-12'];
  const q = quote({ transport: 'Ambulatory', serviceDate: '2026-09-12' }, cfg, { miles: 5, timeHm: '10:00' });
  // fare = base 45 + mileage 0. Weekend is 15% of 45, not of 45 + the $40 holiday.
  assert.equal(q.lines.find((l) => l.key === 'weekend')!.amount, money(45 * 0.15));
});

test('pricing — an untimed trip is never charged a late-night fee', () => {
  // 23:58 is what the old app wrote when nobody typed a time.
  const cfg = pricingDefaults();
  const late = quote({ transport: 'Ambulatory', serviceDate: '2026-09-14' }, cfg, { miles: 5, timeHm: '23:58' });
  assert.equal(late.lines.some((l) => l.key === 'afterHours'), false);
  const real = quote({ transport: 'Ambulatory', serviceDate: '2026-09-14' }, cfg, { miles: 5, timeHm: '21:00' });
  assert.equal(real.lines.find((l) => l.key === 'afterHours')!.amount, 20);
});

test('pricing — a discount comes off the fare, not off the tolls', () => {
  // The operator was handing back a slice of their own pass-through costs.
  const cfg = pricingDefaults();
  cfg.rules.tolls = { mode: 'optional', kind: 'fixed', amount: 6.5 };
  cfg.rules.otherDisc = { mode: 'optional', kind: 'percent', amount: 10 };
  const q = quote({ transport: 'Wheelchair', serviceDate: '2026-09-14' }, cfg, {
    miles: 12.4, timeHm: '10:00', manual: ['tolls', 'otherDisc'],
  });
  const discountable = 65 + money((12.4 - 5) * 3);   // 87.20 — no tolls
  assert.equal(q.lines.find((l) => l.key === 'otherDisc')!.amount, money(-discountable * 0.1));
  assert.equal(q.total, money(discountable + 6.5 - discountable * 0.1));
});

test('pricing — deadhead is a cost passed on, and a return leg never carries one', () => {
  const cfg = pricingDefaults();
  cfg.deadhead = { mode: 'optional', includedMiles: 0, perMile: 1.5 };
  cfg.rules.weekend = { mode: 'auto', kind: 'percent', amount: 15 };
  const out = quote({ transport: 'Ambulatory', serviceDate: '2026-09-12', returnOfTripId: null }, cfg, {
    miles: 5, timeHm: '10:00', deadheadMiles: 10,
  });
  assert.equal(out.lines.find((l) => l.key === 'deadhead')!.amount, 15);
  // The weekend percentage is on the $45 fare, not on 45 + 15.
  assert.equal(out.lines.find((l) => l.key === 'weekend')!.amount, money(45 * 0.15));
  // By the return the driver is already at the door. That rule lives at the call
  // site, not inside the engine — the engine must stay agnostic to how one trip
  // relates to another — so every caller prices a leg through `quoteInputs`.
  const backTrip = { transport: 'Ambulatory', serviceDate: '2026-09-12', returnOfTripId: 't1', deadheadMiles: 10 };
  const back = quote(backTrip, cfg, quoteInputs(backTrip, { miles: 5, timeHm: '10:00' }));
  assert.equal(back.lines.some((l) => l.key === 'deadhead'), false);
  assert.equal(back.deadheadMiles, 0);
  // The engine on its own still charges whatever it is handed — that is the point.
  const raw = quote(backTrip, cfg, { miles: 5, timeHm: '10:00', deadheadMiles: 10 });
  assert.equal(raw.lines.find((l) => l.key === 'deadhead')!.amount, 15);
});

test('pricing — one place decides how a leg is priced', () => {
  // The old system applied the return-leg rules in the save path and in one of
  // the two preview paths, so the office could be shown a price it would not get.
  const out = { returnOfTripId: null, scheduledTime: '09:00', deadheadMiles: 8 };
  const back = { returnOfTripId: 't1', scheduledTime: '20:00', deadheadMiles: 8 };
  assert.deepEqual(quoteInputs(out, {}, '09:00'), { timeHm: '09:00', deadheadMiles: 8 });
  assert.deepEqual(quoteInputs(back, {}, '09:00'), { timeHm: '09:00', deadheadMiles: 0 });
});

test('pricing — the minimum fare is checked again after the discounts', () => {
  // The first bump happens before surcharges, so a discount could pull the
  // total back under the minimum while a line still claimed it had been met.
  const cfg = pricingDefaults();
  cfg.mileage.minimumFare = 60;
  cfg.rules.otherDisc = { mode: 'optional', kind: 'percent', amount: 50 };
  const q = quote({ transport: 'Taxi', serviceDate: '2026-09-14' }, cfg, { miles: 0, timeHm: '10:00', manual: ['otherDisc'] });
  assert.equal(q.total, 60);
  assert.ok(q.lines.some((l) => l.key === 'minimumFloor'));
});

test('pricing — waiting time comes from the driver\'s own stamps', () => {
  const cfg = pricingDefaults();
  cfg.wait = { mode: 'auto', graceMin: 15, intervalMin: 15, rate: 10 };
  const trip = {
    transport: 'Wheelchair', serviceDate: '2026-09-14',
    pickupArrivalAt: '2026-09-14T14:00:00Z', pickupDepartureAt: '2026-09-14T14:40:00Z',
    dropoffArrivalAt: null, dropoffDepartureAt: null,
  };
  assert.equal(waitMinutes(trip), 40);
  const q = quote(trip, cfg, { miles: 5, timeHm: '10:00' });
  // 40 waited, 15 free, 25 over, rounded up to two 15-minute blocks.
  assert.equal(q.lines.find((l) => l.key === 'wait')!.amount, 20);
  // Nothing is charged before the trip has been driven.
  const notYet = quote({ transport: 'Wheelchair', serviceDate: '2026-09-14' }, cfg, { miles: 5, timeHm: '10:00' });
  assert.equal(notYet.lines.some((l) => l.key === 'wait'), false);

  // A gap longer than twelve hours is a forgotten tap, not a wait. Billing it
  // is how a trip ends up charged for a hundred and ninety hours of waiting.
  assert.equal(waitMinutes({
    pickupArrivalAt: '2026-09-14T14:00:00Z', pickupDepartureAt: '2026-09-16T09:00:00Z',
  }), 0);

  // A no-show is the exception: the driver was at the door, and the wait runs
  // to the moment the office called it off.
  assert.equal(waitMinutes(
    { pickupArrivalAt: '2026-09-14T14:00:00Z', pickupDepartureAt: null },
    { outcome: 'no-show', endedAt: '2026-09-14T14:35:00Z' },
  ), 35);
  // But only for a no-show or a cancellation.
  assert.equal(waitMinutes(
    { pickupArrivalAt: '2026-09-14T14:00:00Z', pickupDepartureAt: null },
    { outcome: 'in progress', endedAt: '2026-09-14T14:35:00Z' },
  ), 0);
});

test('pricing — a rule the office switched off is not offered', () => {
  const cfg = pricingDefaults();
  const q = quote({ transport: 'Ambulatory', serviceDate: '2026-09-14' }, cfg, { miles: 5, timeHm: '10:00' });
  const offered = quoteOptions(cfg, q).map((r) => r.key);
  assert.ok(offered.includes('stairs'));
  assert.ok(!offered.includes('shortNotice'), 'off');
  assert.ok(!offered.includes('doorToDoor'), 'off');
  assert.ok(!offered.includes('recurring'), 'a discount is not handed out from a trip form');
  assert.ok(!offered.includes('tolls'), 'its amount is zero, so there is nothing to add');
});

test('pricing — nothing to charge at all is not a price', () => {
  const cfg = pricingDefaults();
  cfg.base = { ...cfg.base, other: 0 };
  cfg.mileage.mode = 'off';
  const q = quote({ transport: 'Something else', serviceDate: '2026-09-14' }, cfg, { timeHm: '10:00' });
  assert.equal(q.total, 0);
  assert.equal(q.incomplete, true, 'zero is not a quote');
});

test('pricing — the office is refused in words, not codes', () => {
  const cfg = pricingDefaults();
  cfg.rules.holiday = { mode: 'auto', kind: 'fixed', amount: 0 };
  cfg.wait = { mode: 'auto', graceMin: 15, intervalMin: 0, rate: 10 };
  const problems = configProblems(cfg);
  assert.ok(problems.some((p) => /Holiday/.test(p) && /amount is 0/.test(p)));
  assert.ok(problems.some((p) => /interval must be at least/.test(p)));

  // 0.15 typed for a 15% rule charged fifteen hundredths of one percent.
  const typo = pricingDefaults();
  typo.rules.weekend = { mode: 'auto', kind: 'percent', amount: 0.15 };
  assert.ok(configProblems(typo).some((p) => /whole numbers/.test(p)), 'a percentage typo is caught');

  // A time typed as "7pm" was thrown away and the old window silently kept.
  const badTime = pricingDefaults();
  badTime.afterHoursFrom = '7pm';
  assert.ok(configProblems(badTime).some((p) => /24-hour clock/.test(p)));

  const sameWindow = pricingDefaults();
  sameWindow.afterHoursTo = sameWindow.afterHoursFrom;
  assert.ok(configProblems(sameWindow).some((p) => /never apply/.test(p)));

  const negatives = pricingDefaults();
  negatives.base = { ...negatives.base, wheelchair: -50 };
  negatives.mileage = { mode: 'auto', includedMiles: 5, perMile: 0, minimumFare: -1 };
  const found = configProblems(negatives);
  assert.ok(found.some((p) => /base price for wheelchair cannot be negative/.test(p)));
  assert.ok(found.some((p) => /per-mile rate is 0/.test(p)));
  assert.ok(found.some((p) => /minimum fare cannot be negative/.test(p)));

  const deadheadOn = pricingDefaults();
  deadheadOn.deadhead = { mode: 'optional', includedMiles: 0, perMile: 0 };
  assert.ok(configProblems(deadheadOn).some((p) => /Deadhead mileage is switched on/.test(p)));

  // And a clean config complains about nothing.
  assert.deepEqual(configProblems(pricingDefaults()), []);
});

test('pricing — a stored waiting interval of zero is read as one minute', () => {
  // The engine treats an interval of 0 as "never bill a block". A config saved
  // with 0 before that was guarded would silently stop charging for waiting.
  const cfg = normalizeConfig({ wait: { mode: 'auto', graceMin: 15, intervalMin: 0, rate: 10 } } as never);
  assert.equal(cfg.wait.intervalMin, 1);
});

test('pricing — a return leg is priced on the outbound leg\'s clock', () => {
  assert.equal(priceTime({ returnOfTripId: 't1', scheduledTime: '20:00' }, '09:00'), '09:00');
  assert.equal(priceTime({ returnOfTripId: null, scheduledTime: '20:00' }, '09:00'), '20:00');
});

test('pricing — free text becomes a transport key', () => {
  assert.equal(transportKey('Wheelchair'), 'wheelchair');
  assert.equal(transportKey('w/c'), 'wheelchair');
  assert.equal(transportKey('Stretcher (bariatric)'), 'stretcher');
  assert.equal(transportKey('AMBULATORY'), 'ambulatory');
  assert.equal(transportKey('Taxi'), 'taxi');
  assert.equal(transportKey('cab'), 'taxi');
  assert.equal(transportKey('Wheelchair van'), 'wheelchair', 'a wheelchair van is not a taxi');
  assert.equal(transportKey('gurney'), 'stretcher');
  // "Sedan" and "livery" are NOT guessed at as a taxi — they fall through to
  // the operator's catch-all base fare, which is a deliberate choice.
  assert.equal(transportKey('Sedan'), 'other');
  assert.equal(transportKey('Livery'), 'other');
  assert.equal(transportKey(''), 'other');
});

// ---------------------------------------------------------------------------
test('standing orders — the days are the days the office picked', () => {
  const dates = expandPattern({ startDate: '2026-09-14', endDate: '2026-09-27', days: ['MON', 'WED', 'FRI'] });
  assert.deepEqual(dates, ['2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21', '2026-09-23', '2026-09-25']);
  assert.deepEqual(daysForFrequency('WEEKDAYS'), ['MON', 'TUE', 'WED', 'THU', 'FRI']);
  assert.deepEqual(daysForFrequency('WEEKENDS'), ['SAT', 'SUN']);
  assert.deepEqual(daysForFrequency('DAILY'), []);
});

test('standing orders — generation is capped', () => {
  const all = expandPattern({ startDate: '2026-01-01', days: [] });
  assert.equal(all.length, 183);
  const small = expandPattern({ startDate: '2026-01-01', days: [], maxDays: 5 });
  assert.equal(small.length, 5);
});

test('standing orders — a date or a driver\'s progress is never copied across', () => {
  const changed = ['scheduledTime', 'driverName', 'serviceDate', 'driverProgress', 'notes'];
  assert.deepEqual(
    spreadableFields(changed, STANDING_ORDER_BLOCKED_FIELDS),
    ['scheduledTime', 'driverName', 'notes'],
  );
});
