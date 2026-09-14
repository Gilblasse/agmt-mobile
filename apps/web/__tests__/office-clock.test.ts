import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { officeToday, officeTomorrow, officeYesterday, serverClock, tappability } from '@/lib/office-clock';

/**
 * The office's clock decides what day it is (CLAUDE.md, non-negotiable #3).
 * No database and no server: these are pure date rules, and they are the ones
 * a wrong answer hides in — a driver checking tomorrow late in the evening.
 */

/** An instant, expressed as the wall-clock time it is in the office. */
const at = (iso: string) => new Date(iso);

describe('the office day', () => {
  it('rolls at midnight in the office, not in UTC', () => {
    // 02:30 UTC is still the previous evening in New York.
    assert.equal(officeToday(at('2026-09-13T02:30:00Z')), '2026-09-12');
    assert.equal(officeToday(at('2026-09-13T04:30:00Z')), '2026-09-13');
  });

  it('does not skip a day when the clocks go forward', () => {
    // 23:00 ET on the Saturday before spring forward. Adding 24 hours of
    // milliseconds crosses a 23-hour local day and lands on Monday, so a
    // driver checking ahead saw Monday and Sunday's shift vanished.
    const saturdayNight = at('2027-03-14T04:00:00Z');
    assert.equal(officeToday(saturdayNight), '2027-03-13');
    assert.equal(officeTomorrow(saturdayNight), '2027-03-14');
  });

  it('does not repeat a day when the clocks go back', () => {
    // The same arithmetic fails the other way on a 25-hour day: +24h lands
    // back on the same date, so "tomorrow" would have shown today's trips.
    const fallBack = at('2027-11-07T04:00:00Z');
    assert.equal(officeToday(fallBack), '2027-11-07');
    assert.equal(officeTomorrow(fallBack), '2027-11-08');
  });

  it('steps backwards across the same boundaries', () => {
    assert.equal(officeYesterday(at('2027-03-15T04:00:00Z')), '2027-03-14');
    assert.equal(officeYesterday(at('2027-11-08T05:00:00Z')), '2027-11-07');
  });

  it('tells the phone the wall time here, in 24 hours', () => {
    const clock = serverClock(at('2026-09-13T04:05:00Z'));
    assert.equal(clock.serverClock, '00:05', 'midnight reads 00:xx, never 24:xx');
    assert.equal(clock.timeZone, 'America/New_York');
    assert.equal(clock.serverNow, '2026-09-13T04:05:00.000Z');
  });
});

describe('which days a driver may still tap', () => {
  const now = at('2026-09-13T16:00:00Z'); // midday in the office
  const today = officeToday(now);
  const yesterday = officeYesterday(now);
  const tomorrow = officeTomorrow(now);

  it('allows today whatever the step', () => {
    assert.equal(tappability(today, 'none', now), 'ok');
    assert.equal(tappability(today, 'complete', now), 'ok');
  });

  it('allows yesterday while the trip is still running', () => {
    // A 23:45 pickup is still the trip the driver is inside at 00:10.
    assert.equal(tappability(yesterday, 'in_transit', now), 'ok');
  });

  it('closes yesterday once the trip is finished', () => {
    assert.equal(tappability(yesterday, 'complete', now), 'closed');
  });

  it('separates "not yet" from "closed"', () => {
    // Different answers so the phone can tell a driver which it is, instead of
    // discarding the tap as an unretryable validation error.
    assert.equal(tappability(tomorrow, 'none', now), 'not-yet');
    assert.equal(tappability('2020-01-01', 'in_transit', now), 'closed');
  });
});
