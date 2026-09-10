// Pure date and event math for the calendar app.
// Ported from the omarchy-calendar Model.js. Everything here is UI-free so it
// can be unit tested under node; the React layer owns rendering.

export interface CalEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  color: string;
  dateKey: string; // YYYY-MM-DD in the phone's timezone
  start: string; // ISO-8601 with numeric offset, parseable by Date.parse
  end: string;
  allDay: boolean;
  title: string;
  location: string;
  meetingUrl?: string;
  eventUrl?: string;
  eventType?: string;
  responseStatus?: string;
  /** Plain-text notes, truncated for display. */
  description?: string;
}

export interface DayCell {
  key: string;
  year: number;
  month: number;
  day: number;
  weekday: number;
  inMonth: boolean;
  weekend: boolean;
  today: boolean;
  hasEvent: boolean;
  dots: string[];
}

export interface WeekRow {
  week: number;
  days: DayCell[];
}

const MS_PER_DAY = 86400000;
export const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export function pad2(value: number): string {
  const n = Math.floor(Math.abs(value));
  return (n < 10 ? '0' : '') + n;
}

// ---------------------------------------------------------------------------
// Timezone-aware wall-clock fields.
//
// The Car Thing does not know the user's timezone (no battery-backed clock;
// the phone is the time authority), so every wall-clock read goes through
// the IANA zone the daemon reports. When timeZone is undefined we fall back
// to the runtime's local zone (simulator / dev).
// ---------------------------------------------------------------------------

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });
    partsFormatterCache.set(timeZone, f);
  }
  return f;
}

export function zonedParts(ms: number, timeZone: string | undefined): ZonedParts {
  if (!timeZone) {
    const d = new Date(ms);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      weekday: d.getDay(),
    };
  }
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string): number => {
    const v = parts.find(p => p.type === type)?.value;
    return v === undefined ? 0 : parseInt(v, 10);
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    hour: get('hour') % 24, // hour12:false can yield "24" at midnight
    minute: get('minute'),
    second: get('second'),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** "YYYY-MM-DD" for the instant in the given zone — the zone-aware today key. */
export function todayKeyFor(ms: number, timeZone: string | undefined): string {
  const p = zonedParts(ms, timeZone);
  return dateKey(p.year, p.month - 1, p.day);
}

/** Offset to add to a UTC instant to get wall time in the zone, in ms. */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant of a wall-clock time in the zone (iterated: converges across DST). */
export function zonedWallToMs(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wallUtc = Date.UTC(year, month1 - 1, day, hour, minute);
  let guess = wallUtc;
  for (let i = 0; i < 3; i++) {
    const next = wallUtc - zoneOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

// Stable "yyyy-MM-dd" identity for a day, built from local fields so the key
// never shifts across timezones.
export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

export function keyForDate(date: Date): string {
  return dateKey(date.getFullYear(), date.getMonth(), date.getDate());
}

export function coerceWeekStart(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? ((Math.round(value) % 7) + 7) % 7 : null;
  }
  const text = String(value).trim().toLowerCase();
  if (text === '') return null;
  for (let i = 0; i < WEEKDAY_NAMES.length; i++) {
    if (WEEKDAY_NAMES[i] === text || WEEKDAY_NAMES[i].slice(0, 3) === text) return i;
  }
  const parsed = parseInt(text, 10);
  return Number.isFinite(parsed) ? ((parsed % 7) + 7) % 7 : null;
}

// Configured week start, falling back to Monday when the setting is missing
// or nonsense.
export function normalizedWeekStart(value: unknown, fallback = 1): number {
  const configured = coerceWeekStart(value);
  if (configured !== null) return configured;
  const fallbackStart = coerceWeekStart(fallback);
  return fallbackStart === null ? 1 : fallbackStart;
}

export function weekStartSettingName(index: unknown): string {
  return WEEKDAY_NAMES[normalizedWeekStart(index, 1)];
}

export function weekdayOrder(weekStart: unknown): number[] {
  const start = normalizedWeekStart(weekStart, 1);
  const out: number[] = [];
  for (let i = 0; i < 7; i++) out.push((start + i) % 7);
  return out;
}

// ISO-8601 week number: the week owning the Thursday of that date's
// Monday-based week.
export function isoWeek(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);
}

// Always six rows of seven days. A fixed grid keeps the panel exactly the
// same height in every month, so stepping through the year never makes the
// layout jump.
export function monthGrid(
  year: number,
  month: number,
  weekStart: unknown,
  todayKey: string,
  eventIndex: Record<string, CalEvent[]>,
): WeekRow[] {
  const start = normalizedWeekStart(weekStart, 1);
  const leading = (new Date(year, month, 1).getDay() - start + 7) % 7;
  const cursor = new Date(year, month, 1 - leading);
  const weeks: WeekRow[] = [];

  for (let w = 0; w < 6; w++) {
    const days: DayCell[] = [];
    let thursday: { year: number; month: number; day: number } | null = null;
    for (let d = 0; d < 7; d++) {
      const cellYear = cursor.getFullYear();
      const cellMonth = cursor.getMonth();
      const cellDay = cursor.getDate();
      const weekday = cursor.getDay();
      const key = dateKey(cellYear, cellMonth, cellDay);
      if (weekday === 4) thursday = { year: cellYear, month: cellMonth, day: cellDay };
      days.push({
        key,
        year: cellYear,
        month: cellMonth,
        day: cellDay,
        weekday,
        inMonth: cellMonth === month && cellYear === year,
        weekend: weekday === 0 || weekday === 6,
        today: key === todayKey,
        hasEvent: !!eventIndex[key],
        dots: eventColors(eventIndex, key, 3),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    // Stop after the last week that touches the month: no padded 6th row.
    // A month that genuinely spans six weeks (e.g. Aug 2026, Mon-first) still
    // gets all six; September 2026 renders five.
    if (!days.some(d => d.inMonth)) break;
    // Number every row by the ISO week owning its Thursday.
    const anchor = thursday ?? { year: days[0].year, month: days[0].month, day: days[0].day };
    weeks.push({ week: isoWeek(anchor.year, anchor.month, anchor.day), days });
  }
  return weeks;
}

export function stepMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const target = new Date(year, month + delta, 1);
  return { year: target.getFullYear(), month: target.getMonth() };
}

// ---- Event helpers. The UI renders whatever the ICS layer produced; none of
//      this knows where the events came from.

export function indexEventsByDate(events: CalEvent[]): Record<string, CalEvent[]> {
  const index: Record<string, CalEvent[]> = {};
  for (const event of events || []) {
    const key = event && event.dateKey;
    if (!key) continue;
    (index[key] ??= []).push(event);
  }
  return index;
}

export function eventsForDateKey(index: Record<string, CalEvent[]>, key: string): CalEvent[] {
  if (!index || !key) return [];
  return index[key] || [];
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
}

// The calendars present in a synced document, in display order. Derived from
// the events themselves so the app can only ever offer calendars that
// actually have events.
export function calendarsInDocument(events: CalEvent[]): CalendarInfo[] {
  const byId: Record<string, boolean> = {};
  const ordered: CalendarInfo[] = [];
  for (const event of events || []) {
    const id = event && event.calendarId;
    if (!id || byId[id]) continue;
    byId[id] = true;
    ordered.push({ id, name: event.calendarName || id, color: event.color || '' });
  }
  ordered.sort((a, b) => a.name.localeCompare(b.name));
  return ordered;
}

export function isCalendarHidden(hidden: string[], calendarId: string): boolean {
  if (!hidden || !hidden.length) return false;
  return hidden.indexOf(String(calendarId)) !== -1;
}

// Returns a new list rather than mutating, so the caller can hand the result
// straight to the store.
export function toggleHiddenCalendar(hidden: string[], calendarId: string): string[] {
  const id = String(calendarId);
  const next: string[] = [];
  let found = false;
  for (const h of hidden || []) {
    if (String(h) === id) {
      found = true;
      continue;
    }
    next.push(h);
  }
  if (!found) next.push(id);
  return next;
}

// Google's "working from home" markers arrive as all-day events; without this
// they eat a line of every single day while describing no commitment at all.
const NOISY_EVENT_TYPES = ['workingLocation'];

export function isNoisyEventType(event: CalEvent): boolean {
  const type = event && event.eventType;
  if (!type) return false;
  return NOISY_EVENT_TYPES.indexOf(String(type)) !== -1;
}

export function isDeclined(event: CalEvent): boolean {
  return !!event && String(event.responseStatus || '') === 'declined';
}

export function isOutOfOffice(event: CalEvent): boolean {
  return !!event && String(event.eventType || '') === 'outOfOffice';
}

// Only https is ever launched. A meeting link is supplied by whoever sent the
// invitation, so treating it as trusted input would be a mistake.
export function safeUrl(url: string | undefined | null): string {
  const text = String(url || '').trim();
  if (!text.startsWith('https://')) return '';
  if (/[\s"'<>]/.test(text)) return '';
  return text;
}

export function meetingUrlFor(event: CalEvent): string {
  return event ? safeUrl(event.meetingUrl) : '';
}

export function eventUrlFor(event: CalEvent): string {
  return event ? safeUrl(event.eventUrl) : '';
}

// How long before the start, and after the end, a meeting still counts as
// joinable. A Join button on next Tuesday's meeting is noise that dilutes the
// one that matters, so the affordance only appears around the actual time.
const JOIN_LEAD_MINUTES = 15;
const JOIN_GRACE_MINUTES = 15;

export function isJoinableNow(event: CalEvent, nowMs: number, todayKey: string): boolean {
  if (!meetingUrlFor(event)) return false;

  // An all-day event has no useful clock window, so it stays joinable for the
  // whole day it belongs to.
  if (event.allDay) return event.dateKey === todayKey;

  const startMs = Date.parse(event.start);
  let endMs = Date.parse(event.end);
  if (Number.isNaN(startMs)) return false;
  if (Number.isNaN(endMs) || endMs < startMs) endMs = startMs;

  const opensAt = startMs - JOIN_LEAD_MINUTES * 60 * 1000;
  const closesAt = endMs + JOIN_GRACE_MINUTES * 60 * 1000;
  return nowMs >= opensAt && nowMs <= closesAt;
}

export interface VisibleOptions {
  hideWorkingLocation?: boolean;
  hideDeclined?: boolean;
}

export function visibleEvents(
  events: CalEvent[],
  hidden: string[],
  options?: VisibleOptions,
): CalEvent[] {
  if (!events || !events.length) return [];
  const opts = options || {};
  const dropNoisy = opts.hideWorkingLocation !== false;
  const dropDeclined = opts.hideDeclined === true;
  const visible: CalEvent[] = [];
  for (const event of events) {
    if (isCalendarHidden(hidden, event.calendarId)) continue;
    if (dropNoisy && isNoisyEventType(event)) continue;
    if (dropDeclined && isDeclined(event)) continue;
    visible.push(event);
  }
  return visible;
}

// ---- The next thing coming up.

// All-day events are deliberately excluded. They start at midnight, so a
// countdown to one either reads as hours in the past or as tomorrow, and
// neither tells you anything you wanted to know.
export function nextEvent(events: CalEvent[], nowMs: number): CalEvent | null {
  let best: CalEvent | null = null;
  let bestMs: number | null = null;
  for (const event of events || []) {
    if (!event || event.allDay) continue;
    const startMs = Date.parse(event.start);
    if (Number.isNaN(startMs) || startMs < nowMs) continue;
    if (bestMs === null || startMs < bestMs) {
      bestMs = startMs;
      best = event;
    }
  }
  return best;
}

// Scoped to today on purpose: something eighteen hours out is tomorrow, and
// answering "what is next" with tomorrow is noise when the day's agenda is
// listed right beside it.
export function nextEventToday(events: CalEvent[], nowMs: number, todayKey: string): CalEvent | null {
  const todays: CalEvent[] = [];
  for (const event of events || []) {
    if (event && event.dateKey === todayKey) todays.push(event);
  }
  return nextEvent(todays, nowMs);
}

// Returns null past a day out: the caller's signal to show nothing rather
// than a countdown nobody is acting on.
export function formatCountdown(deltaMs: number | null): string | null {
  if (deltaMs === null || Number.isNaN(deltaMs) || deltaMs < 0 || deltaMs >= DAY_MS) return null;
  if (deltaMs < MINUTE_MS) return 'now';
  const minutes = Math.floor(deltaMs / MINUTE_MS);
  if (minutes < 60) return `in ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}min`;
}

const MAX_ANNOUNCE_TITLE = 40;

export function truncateTitle(title: string | null | undefined, limit?: number): string {
  const text = String(title === undefined || title === null ? '' : title);
  const max = limit || MAX_ANNOUNCE_TITLE;
  if (text.length <= max) return text;
  return text.slice(0, max - 1).replace(/\s+$/, '') + '…';
}

// How long until an event starts, or null when it cannot be read.
export function millisUntil(event: CalEvent | null, nowMs: number): number | null {
  if (!event) return null;
  const startMs = Date.parse(event.start);
  if (Number.isNaN(startMs)) return null;
  return startMs - nowMs;
}

// The banner only appears when something is close enough to act on. Further
// out the header stays a clock, which is what it is most of the day.
export function shouldAnnounce(event: CalEvent | null, nowMs: number, leadMinutes: number): boolean {
  const delta = millisUntil(event, nowMs);
  if (delta === null || delta < 0) return false;
  return delta <= leadMinutes * MINUTE_MS;
}

// Turn a YYYY-MM-DD key back into a local Date, for formatting a heading.
// Built field by field rather than parsed from the string, because
// new Date("2026-08-10") is UTC midnight and lands on the previous day for
// anyone west of Greenwich.
export function dateFromKey(key: string, fallback: Date): Date {
  const parts = String(key || '').split('-');
  if (parts.length !== 3) return fallback;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return fallback;
  return new Date(year, month - 1, day);
}

export function eventColors(
  index: Record<string, CalEvent[]>,
  key: string,
  limit: number,
): string[] {
  const events = eventsForDateKey(index, key);
  const colors: string[] = [];
  for (const e of events) {
    const color = e.color;
    if (!color || colors.indexOf(color) !== -1) continue;
    colors.push(color);
    if (limit > 0 && colors.length >= limit) break;
  }
  return colors;
}

export type SyncState = 'missing' | 'stale' | 'ok';

// "missing" means we have nothing to show and should say so rather than
// render an empty calendar that looks like a quiet week.
export function syncState(
  syncedAtMs: number | null,
  nowMs: number,
  intervalSeconds: number,
): SyncState {
  if (syncedAtMs === null || Number.isNaN(syncedAtMs)) return 'missing';
  const thresholdMs = intervalSeconds * 4 * 1000;
  return nowMs - syncedAtMs > thresholdMs ? 'stale' : 'ok';
}

// "9:30 AM" / "2:05 PM" style, in the phone's timezone when known.
export function formatTime(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

export function formatTimeRange(event: CalEvent, timeZone?: string): string {
  if (event.allDay) return 'All day';
  const s = formatTime(event.start, timeZone);
  const e = formatTime(event.end, timeZone);
  if (!s) return '';
  return e && e !== s ? `${s} – ${e}` : s;
}

// "Wednesday, September 9" for a YYYY-MM-DD key, rendered via UTC so the
// date can never shift with the device's timezone.
export function formatKeyHeading(key: string): string {
  const parts = String(key || '').split('-');
  if (parts.length !== 3) return key;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return key;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}
