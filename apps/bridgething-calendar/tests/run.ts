// Unit tests for ics.ts and model.ts. Run: bun tests/run.ts
// (also worth running under TZ=Australia/Sydney to catch TZ bugs)
import { expandFeedEvents, FEED_COLORS, toLocalIso, toZonedIso, type FeedSource } from '../src/ics';
import {
  formatCountdown,
  formatKeyHeading,
  formatTimeRange,
  isJoinableNow,
  isoWeek,
  meetingUrlFor,
  monthGrid,
  nextEventToday,
  shouldAnnounce,
  todayKeyFor,
  zonedParts,
  zonedWallToMs,
  zoneOffsetMs,
} from '../src/model';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`, extra ?? '');
  }
}

const feed: FeedSource = { url: 'https://example.com/cal.ics', name: 'Test', color: FEED_COLORS[0] };
const W0 = Date.UTC(2026, 0, 1);
const W1 = Date.UTC(2027, 0, 1);
function expand(text: string) {
  return expandFeedEvents(text, feed, W0, W1).events;
}
function expandTz(text: string, timeZone: string) {
  return expandFeedEvents(text, feed, W0, W1, timeZone).events;
}
const wrap = (body: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\nX-WR-CALNAME:Work\r\n${body}END:VCALENDAR\r\n`;

// ---- basic parsing
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260310T093000Z\r\nDTEND:20260310T100000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n',
  ));
  check('basic timed event parsed', evts.length === 1);
  check('title', evts[0]?.title === 'Standup');
  check('start instant', Date.parse(evts[0]?.start ?? '') === Date.UTC(2026, 2, 10, 9, 30));
  check('feed name from X-WR-CALNAME', evts[0]?.calendarName === 'Work');
}
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:2\r\nDTSTART;VALUE=DATE:20260311\r\nDTEND;VALUE=DATE:20260312\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n',
  ));
  check('all-day parsed', evts.length === 1 && evts[0].allDay);
  check('all-day dateKey', evts[0]?.dateKey === '2026-03-11');
}
{
  // folded lines + escaped text
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:3\r\nDTSTART:20260310T093000Z\r\nDTEND:20260310T100000Z\r\nSUMMARY:Long title that fol\r\n ds here\\, with comma\r\nEND:VEVENT\r\n',
  ));
  check('unfold + unescape', evts[0]?.title === 'Long title that folds here, with comma');
}
{
  // TZID conversion: 9:30 America/New_York in March = EDT = UTC-4
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:4\r\nDTSTART;TZID=America/New_York:20260310T093000\r\nDTEND;TZID=America/New_York:20260310T100000\r\nSUMMARY:NY meeting\r\nEND:VEVENT\r\n',
  ));
  check('TZID converts to UTC', Date.parse(evts[0]?.start ?? '') === Date.UTC(2026, 2, 10, 13, 30), evts[0]?.start);
}

// ---- recurrence
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:r1\r\nDTSTART:20260302T090000Z\r\nDTEND:20260302T093000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Daily\r\nEND:VEVENT\r\n',
  ));
  check('DAILY COUNT=3', evts.length === 3, evts.length);
  check('daily spacing', Date.parse(evts[1].start) - Date.parse(evts[0].start) === 86400000);
}
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:r2\r\nDTSTART:20260302T090000Z\r\nDTEND:20260302T093000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4\r\nSUMMARY:MWF\r\nEND:VEVENT\r\n',
  ));
  check('WEEKLY BYDAY COUNT=4', evts.length === 4, evts.length);
  const days = evts.map(e => new Date(Date.parse(e.start)).getUTCDay());
  check('weekly on Mon/Wed', days.every(d => d === 1 || d === 3), days);
}
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:r3\r\nDTSTART:20260115T090000Z\r\nDTEND:20260115T093000Z\r\nRRULE:FREQ=MONTHLY;COUNT=3\r\nSUMMARY:Monthly\r\nEND:VEVENT\r\n',
  ));
  check('MONTHLY COUNT=3', evts.length === 3, evts.map(e => e.dateKey));
  check('monthly days', evts.map(e => e.dateKey).join(',') === '2026-01-15,2026-02-15,2026-03-15');
}
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:r4\r\nDTSTART:20260302T090000Z\r\nDTEND:20260302T093000Z\r\nRRULE:FREQ=DAILY;UNTIL=20260304T090000Z\r\nSUMMARY:Until\r\nEND:VEVENT\r\n',
  ));
  check('UNTIL respected', evts.length === 3, evts.length);
}
{
  // EXDATE drops one instance
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:r5\r\nDTSTART:20260302T090000Z\r\nDTEND:20260302T093000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:20260303T090000Z\r\nSUMMARY:With exdate\r\nEND:VEVENT\r\n',
  ));
  check('EXDATE drops instance', evts.length === 2, evts.length);
  check('exdate keeps others', evts.every(e => !e.dateKey.endsWith('03-03')));
}
{
  // RECURRENCE-ID override changes one instance's title
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:r6\r\nDTSTART:20260302T090000Z\r\nDTEND:20260302T093000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Base\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:r6\r\nRECURRENCE-ID:20260303T090000Z\r\nDTSTART:20260303T110000Z\r\nDTEND:20260303T113000Z\r\nSUMMARY:Moved\r\nEND:VEVENT\r\n',
  ));
  check('recurrence-id override count', evts.length === 2, evts.length);
  check('override title applied', evts.some(e => e.title === 'Moved'));
  check('override time applied', evts.some(e => Date.parse(e.start) === Date.UTC(2026, 2, 3, 11, 0)));
}
{
  // cancelled instance via RECURRENCE-ID + STATUS:CANCELLED
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:r7\r\nDTSTART:20260302T090000Z\r\nDTEND:20260302T093000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Base\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:r7\r\nRECURRENCE-ID:20260303T090000Z\r\nDTSTART:20260303T090000Z\r\nDTEND:20260303T093000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Base\r\nEND:VEVENT\r\n',
  ));
  check('cancelled instance dropped', evts.length === 1, evts.length);
}

// ---- multi-day + meeting urls
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:m1\r\nDTSTART:20260310T090000Z\r\nDTEND:20260312T170000Z\r\nSUMMARY:Conf\r\nEND:VEVENT\r\n',
  ));
  // Expected local days depend on the machine timezone; derive them.
  const sDay = new Date(Date.UTC(2026, 2, 10, 9, 0));
  const eDay = new Date(Date.UTC(2026, 2, 12, 17, 0) - 1);
  const expected: string[] = [];
  const cursor = new Date(sDay.getFullYear(), sDay.getMonth(), sDay.getDate());
  const endC = new Date(eDay.getFullYear(), eDay.getMonth(), eDay.getDate());
  while (cursor <= endC) {
    expected.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`,
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  check('multi-day spans local days', evts.map(e => e.dateKey).join(',') === expected.join(','), evts.map(e => e.dateKey));
}
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T100000Z\r\nSUMMARY:Call\r\nLOCATION:https://meet.google.com/abc-defg-hij\r\nEND:VEVENT\r\n',
  ));
  check('meet link from location', meetingUrlFor(evts[0]) === 'https://meet.google.com/abc-defg-hij');
}
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:u2\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T100000Z\r\nSUMMARY:Call\r\nDESCRIPTION:Join: https://zoom.us/j/12345\\nSee you there\r\nEND:VEVENT\r\n',
  ));
  check('zoom link from description', meetingUrlFor(evts[0]) === 'https://zoom.us/j/12345');
}
{
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:x1\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T100000Z\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n',
  ));
  check('cancelled event dropped', evts.length === 0);
}

// ---- model
{
  check('isoWeek known', isoWeek(2026, 8, 10) === 37, isoWeek(2026, 8, 10));
  const grid = monthGrid(2026, 8, 1, '2026-09-10', {});
  check('sep 2026 renders 5 rows, no padded 6th', grid.length === 5 && grid.every(w => w.days.length === 7), grid.length);
  check('sep 1 2026 is a Tuesday', grid[0].days[1].day === 1 && grid[0].days[1].inMonth);
  check('last row still touches month', grid[4].days.some(d => d.inMonth && d.day === 30));
  const todayCell = grid.flatMap(w => w.days).find(d => d.key === '2026-09-10');
  check('today flagged', todayCell?.today === true);
  const aug = monthGrid(2026, 7, 1, '2026-08-10', {});
  check('aug 2026 genuinely spans 6 rows', aug.length === 6, aug.length);
}
{
  const mk = (start: string, title: string, allDay = false) => ({
    id: '1', calendarId: 'c', calendarName: 'C', color: '#fff',
    dateKey: '2026-09-10', start, end: start, allDay, title, location: '',
  });
  const nowMs = Date.UTC(2026, 8, 10, 12, 0, 0);
  const evts = [
    mk('2026-09-10T13:00:00+00:00', 'Later'),
    mk('2026-09-10T12:30:00+00:00', 'Sooner'),
    mk('2026-09-10T00:00:00+00:00', 'All day', true),
  ];
  const next = nextEventToday(evts, nowMs, '2026-09-10');
  check('nextEventToday picks soonest timed', next?.title === 'Sooner');
  check('countdown 30min', formatCountdown(30 * 60000) === 'in 30min');
  check('countdown hours', formatCountdown(90 * 60000) === 'in 1h 30min');
  check('announce within lead', shouldAnnounce(next, nowMs, 45) === true);
  check('no announce past lead', shouldAnnounce(next, nowMs, 10) === false);
  const joinable = { ...evts[1], meetingUrl: 'https://meet.google.com/x' };
  check('joinable in window', isJoinableNow(joinable, nowMs + 20 * 60000, '2026-09-10') === true);
  check('not joinable far out', isJoinableNow(joinable, nowMs + 60 * 60000, '2026-09-10') === false);
}

// ---- phone-timezone wall clock
{
  // 2026-03-10T01:30:00Z is 2026-03-09 21:30 in New York (EDT, UTC-4)
  const ms = Date.UTC(2026, 2, 10, 1, 30, 0);
  const p = zonedParts(ms, 'America/New_York');
  check('zonedParts date', p.year === 2026 && p.month === 3 && p.day === 9, p);
  check('zonedParts time', p.hour === 21 && p.minute === 30 && p.weekday === 1, p);
  check('todayKeyFor uses zone', todayKeyFor(ms, 'America/New_York') === '2026-03-09');
  check('zoneOffsetMs EDT', zoneOffsetMs(ms, 'America/New_York') === -4 * 3600000);
  const iso = toZonedIso(ms, 'America/New_York');
  check('toZonedIso round-trips instant', Date.parse(iso) === ms, iso);
  check('toZonedIso carries zone offset', iso === '2026-03-09T21:30:00-04:00', iso);
  check('toZonedIso without zone falls back', toZonedIso(ms, undefined) === toLocalIso(ms));
  check('zonedWallToMs round trip', zonedWallToMs(2026, 3, 9, 21, 30, 'America/New_York') === ms);
  // DST spring-forward: 2026-03-08 02:30 does not exist in New York; the
  // iteration still lands on a sane instant that day.
  const spring = zonedWallToMs(2026, 3, 8, 2, 30, 'America/New_York');
  check('zonedWallToMs DST gap sane', todayKeyFor(spring, 'America/New_York') === '2026-03-08', new Date(spring).toISOString());
  const heading = formatKeyHeading('2026-09-09');
  check('formatKeyHeading', heading === 'Wednesday, September 9', heading);
}
{
  // Same instant bucketed on Mar 9 in New York instead of Mar 10 (UTC).
  const evts = expandTz(wrap(
    'BEGIN:VEVENT\r\nUID:tz1\r\nDTSTART:20260310T013000Z\r\nDTEND:20260310T023000Z\r\nSUMMARY:Late call\r\nEND:VEVENT\r\n',
  ), 'America/New_York');
  check('zoned day bucketing', evts.length === 1 && evts[0].dateKey === '2026-03-09', evts[0]?.dateKey);
  check('zoned start keeps zone offset', evts[0]?.start === '2026-03-09T21:30:00-04:00', evts[0]?.start);
  const ev = { ...evts[0], id: '1', calendarId: 'c', calendarName: 'C', color: '#fff', title: 'Late call', location: '' };
  const range = formatTimeRange(ev, 'America/New_York');
  check('formatTimeRange in phone zone', range === '9:30 PM – 10:30 PM', range);
}
{
  // Without a zone the pipeline keeps its old device-local behavior.
  const evts = expand(wrap(
    'BEGIN:VEVENT\r\nUID:tz2\r\nDTSTART:20260310T013000Z\r\nDTEND:20260310T023000Z\r\nSUMMARY:Late call\r\nEND:VEVENT\r\n',
  ));
  check('no-zone pipeline still works', evts.length === 1 && typeof evts[0].dateKey === 'string');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
