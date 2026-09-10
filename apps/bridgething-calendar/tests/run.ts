// Unit tests for ics.ts and model.ts. Run: bun tests/run.ts
// (also worth running under TZ=Australia/Sydney to catch TZ bugs)
import { expandFeedEvents, FEED_COLORS, type FeedSource } from '../src/ics';
import {
  formatCountdown,
  isJoinableNow,
  isoWeek,
  meetingUrlFor,
  monthGrid,
  nextEventToday,
  shouldAnnounce,
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
  check('grid is 6x7', grid.length === 6 && grid.every(w => w.days.length === 7));
  check('sep 1 2026 is a Tuesday', grid[0].days[1].day === 1 && grid[0].days[1].inMonth);
  const todayCell = grid.flatMap(w => w.days).find(d => d.key === '2026-09-10');
  check('today flagged', todayCell?.today === true);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
