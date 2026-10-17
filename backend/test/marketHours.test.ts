import { describe, expect, it } from 'vitest';
import { earlyCloses, holidays, marketHours, nightsBetween, sessionOn, sessionsBefore } from '../src/market/usMarketHours.js';

/** "Mon 12 Oct 19:00" in India, built from parts so it does not depend on a locale's punctuation. */
function india(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`;
}

describe('US market calendar', () => {
  // As published by NYSE Group for 2026 and 2027.
  it('matches the NYSE holiday calendar for 2026', () => {
    expect([...holidays(2026)]).toEqual([
      ['2026-01-01', "New Year's Day"],
      ['2026-01-19', 'Martin Luther King, Jr. Day'],
      ['2026-02-16', "Washington's Birthday"],
      ['2026-04-03', 'Good Friday'],
      ['2026-05-25', 'Memorial Day'],
      ['2026-06-19', 'Juneteenth'],
      ['2026-07-03', 'Independence Day'],
      ['2026-09-07', 'Labor Day'],
      ['2026-11-26', 'Thanksgiving Day'],
      ['2026-12-25', 'Christmas Day'],
    ]);
    expect([...earlyCloses(2026)].sort()).toEqual(['2026-11-27', '2026-12-24']);
  });

  it('matches the NYSE holiday calendar for 2027, including observed dates', () => {
    expect([...holidays(2027).keys()]).toEqual([
      '2027-01-01',
      '2027-01-18',
      '2027-02-15',
      '2027-03-26',
      '2027-05-31',
      '2027-06-18', // Juneteenth falls on a Saturday
      '2027-07-05', // Independence Day falls on a Sunday
      '2027-09-06',
      '2027-11-25',
      '2027-12-24', // Christmas falls on a Saturday
    ]);
    // Christmas Eve is itself the holiday, so only the day after Thanksgiving closes early.
    expect([...earlyCloses(2027)]).toEqual(['2027-11-26']);
  });

  it("does not observe a Saturday New Year's Day on the Friday before", () => {
    expect(holidays(2028).has('2027-12-31')).toBe(false);
    expect(sessionOn(2027, 12, 31)).not.toBeNull();
    expect([...holidays(2028).values()]).not.toContain("New Year's Day");
  });

  it('closes on weekends and holidays', () => {
    expect(sessionOn(2026, 10, 10)).toBeNull(); // Saturday
    expect(sessionOn(2026, 10, 11)).toBeNull(); // Sunday
    expect(sessionOn(2026, 11, 26)).toBeNull(); // Thanksgiving
  });
});

describe('session times', () => {
  it('opens 9:30 and closes 16:00 New York time, whichever side of the clock change', () => {
    const summer = sessionOn(2026, 10, 12)!;
    expect(summer.opensAt.toISOString()).toBe('2026-10-12T13:30:00.000Z');
    expect(summer.closesAt.toISOString()).toBe('2026-10-12T20:00:00.000Z');
    const winter = sessionOn(2026, 11, 2)!; // the first session after US clocks go back
    expect(winter.opensAt.toISOString()).toBe('2026-11-02T14:30:00.000Z');
    expect(winter.closesAt.toISOString()).toBe('2026-11-02T21:00:00.000Z');
  });

  it('is an evening session in India, an hour later once the US leaves daylight time', () => {
    expect(india(sessionOn(2026, 10, 12)!.opensAt)).toBe('Mon 12 Oct 19:00');
    expect(india(sessionOn(2026, 10, 12)!.closesAt)).toBe('Tue 13 Oct 01:30');
    expect(india(sessionOn(2026, 11, 2)!.opensAt)).toBe('Mon 2 Nov 20:00');
    expect(india(sessionOn(2026, 11, 2)!.closesAt)).toBe('Tue 3 Nov 02:30');
    // US daylight time starts again on 14 March 2027.
    expect(india(sessionOn(2027, 3, 12)!.opensAt)).toBe('Fri 12 Mar 20:00');
    expect(india(sessionOn(2027, 3, 15)!.opensAt)).toBe('Mon 15 Mar 19:00');
  });

  it('closes at 1:00 pm New York time on early-close days', () => {
    const blackFriday = sessionOn(2026, 11, 27)!;
    expect(blackFriday.earlyClose).toBe(true);
    expect(blackFriday.closesAt.toISOString()).toBe('2026-11-27T18:00:00.000Z');
    expect(india(blackFriday.closesAt)).toBe('Fri 27 Nov 23:30');
  });
});

describe('marketHours', () => {
  it('before the open: closed, with today as the next session', () => {
    const hours = marketHours(new Date('2026-10-09T08:28:00Z')); // Friday 1:58 pm in India
    expect(hours.open).toBe(false);
    expect(hours.session.opensAt.toISOString()).toBe('2026-10-09T13:30:00.000Z');
    expect(hours.upcoming[0]!.date).toBe('2026-10-12');
    expect(hours.upcoming).toHaveLength(5);
  });

  it('during the session: open until the close', () => {
    const hours = marketHours(new Date('2026-10-09T15:00:00Z'));
    expect(hours.open).toBe(true);
    expect(hours.session.closesAt.toISOString()).toBe('2026-10-09T20:00:00.000Z');
  });

  it('after the close on Friday: closed until Monday', () => {
    const hours = marketHours(new Date('2026-10-09T20:00:01Z'));
    expect(hours.open).toBe(false);
    expect(hours.session.date).toBe('2026-10-12');
  });

  it('on a holiday: names it and skips to the next trading day', () => {
    const hours = marketHours(new Date('2026-11-26T15:00:00Z'));
    expect(hours.open).toBe(false);
    expect(hours.holiday).toBe('Thanksgiving Day');
    expect(hours.session.date).toBe('2026-11-27');
    expect(hours.session.earlyClose).toBe(true);
  });

  it('uses the New York date, not the UTC one, late in the Indian night', () => {
    // 01:00 Saturday in India is still Friday afternoon in New York: the market is open.
    const hours = marketHours(new Date('2026-10-09T19:30:00Z'));
    expect(hours.open).toBe(true);
    expect(hours.session.date).toBe('2026-10-09');
  });
});

describe('sessionsBefore', () => {
  it('lists the latest sessions newest first, skipping the weekend', () => {
    const sessions = sessionsBefore(new Date('2026-10-10T09:00:00Z'), 3); // Saturday
    expect(sessions.map((s) => s.date)).toEqual(['2026-10-09', '2026-10-08', '2026-10-07']);
  });

  it('includes a session that is still in progress, but not one that has not opened', () => {
    expect(sessionsBefore(new Date('2026-10-09T15:00:00Z'), 1)[0]!.date).toBe('2026-10-09');
    expect(sessionsBefore(new Date('2026-10-09T13:30:00Z'), 1)[0]!.date).toBe('2026-10-08');
  });

  it('steps over holidays', () => {
    const sessions = sessionsBefore(new Date('2026-11-30T12:00:00Z'), 3); // Monday morning after Thanksgiving week
    expect(sessions.map((s) => s.date)).toEqual(['2026-11-27', '2026-11-25', '2026-11-24']);
    expect(sessions[0]!.earlyClose).toBe(true);
  });
});

describe('nightsBetween', () => {
  it('counts one night between weekdays and three across a weekend', () => {
    expect(nightsBetween('2026-10-08', '2026-10-09')).toBe(1);
    expect(nightsBetween('2026-10-09', '2026-10-12')).toBe(3);
  });
});
