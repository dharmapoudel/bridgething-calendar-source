// iCalendar (.ics) parsing, recurrence expansion, and normalization into the
// CalEvent contract the UI renders. Hand-rolled against the subset calendar
// feeds actually emit (Google, Apple, Outlook): VEVENT with DTSTART/DTEND or
// DURATION, RRULE (DAILY/WEEKLY/MONTHLY/YEARLY), EXDATE, RECURRENCE-ID,
// STATUS, TRANSP, and TZID datetimes resolved through Intl.
//
// The fetch itself is injected so this stays testable without the bridgething
// client: the app wires it to client.net.fetch.

import { dateKey, pad2, safeUrl } from './model';
import type { CalEvent } from './model';

export interface FeedSource {
  url: string;
  name: string;
  color: string;
}

// Google-style calendar colors, one per feed.
export const FEED_COLORS = [
  '#00a8e8', // blue
  '#3ddc84', // green
  '#ff7070', // red
  '#ffb066', // orange
  '#b388ff', // purple
  '#4dd0e1', // teal
  '#f06292', // pink
  '#ffd54f', // yellow
];

interface WallDateTime {
  allDay: boolean;
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  tzid: string | null; // IANA zone for wall times, null when utc or floating
  utc: boolean; // trailing Z
}

interface RawEvent {
  uid: string;
  start: WallDateTime;
  end: WallDateTime | null;
  durationMs: number | null;
  summary: string;
  location: string;
  description: string;
  url: string;
  status: string;
  transp: string;
  rrule: string | null;
  exdates: WallDateTime[];
  recurrenceId: WallDateTime | null;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseProp(line: string): Prop | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = left.split(';');
  const name = (segments.shift() || '').toUpperCase();
  const params: Record<string, string> = {};
  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  return { name, params, value };
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseDateTime(prop: Prop): WallDateTime | null {
  const value = prop.value.trim();
  const params = prop.params;
  if (/VALUE=DATE/i.test(params['VALUE'] || '') || /^\d{8}$/.test(value)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return {
      allDay: true,
      year: +m[1], month: +m[2], day: +m[3],
      hour: 0, minute: 0, second: 0,
      tzid: null, utc: false,
    };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const utc = m[7] === 'Z';
  const tzid = !utc && params['TZID'] ? params['TZID'] : null;
  return {
    allDay: false,
    year: +m[1], month: +m[2], day: +m[3],
    hour: +m[4], minute: +m[5], second: +m[6] || 0,
    tzid, utc,
  };
}

function parseDuration(value: string): number | null {
  const m = value.trim().match(/^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m || (!m[2] && !m[3] && !m[4] && !m[5])) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const ms =
    (+(m[2] || 0)) * 86400000 +
    (+(m[3] || 0)) * 3600000 +
    (+(m[4] || 0)) * 60000 +
    (+(m[5] || 0)) * 1000;
  return sign * ms;
}

// Offset of an IANA zone at a UTC instant, in minutes, via Intl.
function tzOffsetMinutes(tzid: string, utcMs: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (t: string): string => {
      for (const p of parts) if (p.type === t) return p.value;
      return '';
    };
    const wallMs = Date.UTC(
      +get('year'), +get('month') - 1, +get('day'),
      (+get('hour')) % 24, +get('minute'), +get('second'),
    );
    if (Number.isNaN(wallMs)) return null;
    return Math.round((wallMs - utcMs) / 60000);
  } catch {
    return null;
  }
}

// Wall-clock components in a zone -> absolute UTC ms. Iterates the offset
// lookup so DST transitions land on the right side.
function wallToUtcMs(tzid: string, w: WallDateTime): number | null {
  const wallMs = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let guess = wallMs;
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMinutes(tzid, guess);
    if (off === null) return null;
    const next = wallMs - off * 60000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function wallToMs(w: WallDateTime): number | null {
  if (w.allDay) return Date.UTC(w.year, w.month - 1, w.day);
  if (w.utc) return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  if (w.tzid) {
    const ms = wallToUtcMs(w.tzid, w);
    if (ms !== null) return ms;
    // Unknown zone: fall through to floating/local rather than dropping.
  }
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second).getTime();
}

// Unique identity of an occurrence in wall-clock space, for EXDATE and
// RECURRENCE-ID matching.
function wallKey(w: WallDateTime): string {
  return (
    `${w.year}-${pad2(w.month)}-${pad2(w.day)}T` +
    `${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`
  );
}

function compareWall(a: WallDateTime, b: WallDateTime): number {
  const ka = wallKey(a);
  const kb = wallKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// ---- RRULE expansion, computed in wall-clock space per RFC 5545.

interface RRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: WallDateTime | null;
  byday: { ord: number | null; weekday: number }[];
  bymonthday: number[];
  bymonth: number[];
  wkst: number;
}

const WEEKDAY_LETTERS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

function parseRRule(raw: string): RRule | null {
  const parts: Record<string, string> = {};
  for (const seg of raw.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  const freq = (parts['FREQ'] || '').toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  const byday: RRule['byday'] = [];
  if (parts['BYDAY']) {
    for (const token of parts['BYDAY'].split(',')) {
      const m = token.trim().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i);
      if (!m) continue;
      byday.push({
        ord: m[1] ? parseInt(m[1], 10) : null,
        weekday: WEEKDAY_LETTERS[m[2].toUpperCase()],
      });
    }
  }
  const numList = (v: string | undefined): number[] =>
    (v || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));

  let until: WallDateTime | null = null;
  if (parts['UNTIL']) {
    until = parseDateTime({ name: 'UNTIL', params: {}, value: parts['UNTIL'] });
  }

  const wkstRaw = (parts['WKST'] || 'MO').toUpperCase();
  return {
    freq,
    interval: Math.max(1, parseInt(parts['INTERVAL'] || '1', 10) || 1),
    count: parts['COUNT'] ? parseInt(parts['COUNT'], 10) || null : null,
    until,
    byday,
    bymonthday: numList(parts['BYMONTHDAY']),
    bymonth: numList(parts['BYMONTH']),
    wkst: WEEKDAY_LETTERS[wkstRaw] ?? 1,
  };
}

function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

// nth weekday of a month (ord=1..5, or -1 for last). weekday: 0=Sunday.
function nthWeekdayOfMonth(year: number, month1: number, weekday: number, ord: number): number | null {
  const dim = daysInMonth(year, month1);
  if (ord > 0) {
    const first = new Date(year, month1 - 1, 1).getDay();
    const day = 1 + ((weekday - first + 7) % 7) + (ord - 1) * 7;
    return day <= dim ? day : null;
  }
  const last = new Date(year, month1 - 1, dim).getDay();
  return dim - ((last - weekday + 7) % 7);
}

// Generate occurrence wall datetimes. `onOccurrence` returns false to stop.
function expandRRule(start: WallDateTime, rule: RRule, onOccurrence: (w: WallDateTime) => boolean): void {
  const MAX_ITER = 3000;
  let yielded = 0;
  const untilMs = rule.until ? wallToMs(rule.until) : null;

  const accept = (w: WallDateTime): boolean => {
    if (rule.until) {
      if (rule.until.utc || rule.until.tzid) {
        const ms = wallToMs(w);
        if (ms === null || (untilMs !== null && ms > untilMs)) return true; // past UNTIL: stop
      } else if (compareWall(w, rule.until) > 0) {
        return true;
      }
    }
    if (rule.count !== null && yielded >= rule.count) return true;
    yielded++;
    return onOccurrence(w);
  };

  const base: WallDateTime = { ...start };
  const startWeekday = new Date(start.year, start.month - 1, start.day).getDay();

  if (rule.freq === 'DAILY') {
    const cursor = new Date(start.year, start.month - 1, start.day);
    for (let i = 0; i < MAX_ITER; i++) {
      const w: WallDateTime = {
        ...base,
        year: cursor.getFullYear(), month: cursor.getMonth() + 1, day: cursor.getDate(),
      };
      if (!accept(w)) return;
      cursor.setDate(cursor.getDate() + rule.interval);
    }
    return;
  }

  if (rule.freq === 'WEEKLY') {
    const days = rule.byday.length > 0 ? rule.byday.map(d => d.weekday) : [startWeekday];
    const sorted = [...new Set(days)].sort((a, b) => a - b);
    // Anchor the week on WKST containing DTSTART.
    const anchor = new Date(start.year, start.month - 1, start.day);
    anchor.setDate(anchor.getDate() - ((startWeekday - rule.wkst + 7) % 7));
    for (let week = 0; week < MAX_ITER; week++) {
      for (const wd of sorted) {
        const d = new Date(anchor);
        d.setDate(d.getDate() + week * 7 * rule.interval + ((wd - rule.wkst + 7) % 7));
        if (d < new Date(start.year, start.month - 1, start.day)) continue;
        const w: WallDateTime = {
          ...base,
          year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
        };
        if (!accept(w)) return;
      }
    }
    return;
  }

  if (rule.freq === 'MONTHLY') {
    for (let i = 0; i < MAX_ITER; i++) {
      const mDate = new Date(start.year, start.month - 1 + i * rule.interval, 1);
      const y = mDate.getFullYear();
      const mo = mDate.getMonth() + 1;
      const dim = daysInMonth(y, mo);
      const days: number[] = [];
      if (rule.bymonthday.length > 0) {
        for (const md of rule.bymonthday) {
          const d = md > 0 ? md : dim + 1 + md;
          if (d >= 1 && d <= dim) days.push(d);
        }
      } else if (rule.byday.length > 0) {
        for (const b of rule.byday) {
          if (b.ord === null) {
            // Every such weekday in the month.
            for (let d = 1; d <= dim; d++) {
              if (new Date(y, mo - 1, d).getDay() === b.weekday) days.push(d);
            }
          } else {
            const d = nthWeekdayOfMonth(y, mo, b.weekday, b.ord);
            if (d !== null) days.push(d);
          }
        }
      } else {
        if (start.day <= dim) days.push(start.day);
      }
      const uniq = [...new Set(days)].sort((a, b) => a - b);
      for (const d of uniq) {
        if (y === start.year && mo === start.month && d < start.day) continue;
        const w: WallDateTime = { ...base, year: y, month: mo, day: d };
        if (!accept(w)) return;
      }
    }
    return;
  }

  // YEARLY
  for (let i = 0; i < MAX_ITER; i++) {
    const y = start.year + i * rule.interval;
    const months = rule.bymonth.length > 0 ? rule.bymonth : [start.month];
    for (const mo of months) {
      if (mo < 1 || mo > 12) continue;
      const dim = daysInMonth(y, mo);
      let days: number[];
      if (rule.bymonthday.length > 0) {
        days = rule.bymonthday
          .map(md => (md > 0 ? md : dim + 1 + md))
          .filter(d => d >= 1 && d <= dim);
      } else if (rule.byday.length > 0) {
        days = [];
        for (const b of rule.byday) {
          if (b.ord === null) continue;
          const d = nthWeekdayOfMonth(y, mo, b.weekday, b.ord);
          if (d !== null) days.push(d);
        }
      } else {
        days = start.day <= dim ? [start.day] : [];
      }
      for (const d of [...new Set(days)].sort((a, b) => a - b)) {
        const w: WallDateTime = { ...base, year: y, month: mo, day: d };
        if (compareWall(w, start) < 0) continue;
        if (!accept(w)) return;
      }
    }
  }
}

// ---- VEVENT parsing

function parseVEvent(lines: string[]): RawEvent | null {
  let uid = '';
  let start: WallDateTime | null = null;
  let end: WallDateTime | null = null;
  let durationMs: number | null = null;
  let summary = '';
  let location = '';
  let description = '';
  let url = '';
  let status = '';
  let transp = '';
  let rrule: string | null = null;
  const exdates: WallDateTime[] = [];
  let recurrenceId: WallDateTime | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT' || line === 'END:VEVENT') continue;
    const prop = parseProp(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': uid = prop.value.trim(); break;
      case 'DTSTART': start = parseDateTime(prop); break;
      case 'DTEND': end = parseDateTime(prop); break;
      case 'DURATION': durationMs = parseDuration(prop.value); break;
      case 'SUMMARY': summary = unescapeText(prop.value); break;
      case 'LOCATION': location = unescapeText(prop.value); break;
      case 'DESCRIPTION': description = unescapeText(prop.value); break;
      case 'URL': url = prop.value.trim(); break;
      case 'STATUS': status = prop.value.trim().toUpperCase(); break;
      case 'TRANSP': transp = prop.value.trim().toUpperCase(); break;
      case 'RRULE': rrule = prop.value.trim(); break;
      case 'EXDATE': {
        for (const v of prop.value.split(',')) {
          const dt = parseDateTime({ name: 'EXDATE', params: prop.params, value: v.trim() });
          if (dt) exdates.push(dt);
        }
        break;
      }
      case 'RECURRENCE-ID': recurrenceId = parseDateTime(prop); break;
      default: break;
    }
  }
  if (!start) return null;
  return {
    uid: uid || `${wallKey(start)}-${summary}`,
    start, end, durationMs,
    summary, location, description, url, status, transp,
    rrule, exdates, recurrenceId,
  };
}

const MEETING_DOMAINS = [
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'webex.com',
  'gotomeeting.com',
  'chime.aws',
];

function firstHttpsUrl(text: string): string {
  const m = text.match(/https:\/\/[^\s"'<>]+/);
  return m ? m[0].replace(/[.,;:!?)]+$/, '') : '';
}

// Prefer an explicit URL property, then the location (Google Meet lives
// there), then the first link in the description.
function meetingUrlFor(raw: RawEvent): string {
  const candidates = [raw.url, raw.location, raw.description];
  for (const c of candidates) {
    const url = safeUrl(firstHttpsUrl(c) || (c.startsWith('https://') ? c : ''));
    if (!url) continue;
    if (MEETING_DOMAINS.some(d => url.includes(d))) return url;
  }
  for (const c of candidates) {
    const url = safeUrl(firstHttpsUrl(c));
    if (url) return url;
  }
  return '';
}

// ISO-8601 with the device-local numeric offset, so Date.parse round-trips
// to the exact instant and renders in local time.
export function toLocalIso(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

function localDateKey(ms: number): string {
  const d = new Date(ms);
  return dateKey(d.getFullYear(), d.getMonth(), d.getDate());
}

interface Occurrence {
  startMs: number;
  endMs: number;
  allDay: boolean;
  // Wall-clock date of the occurrence start. All-day events are pinned to
  // these fields (not to startMs) so the date never shifts with timezone.
  wallYear: number;
  wallMonth: number;
  wallDay: number;
  /** Days spanned, for all-day events. */
  durationDays: number;
  raw: RawEvent;
  overridden: boolean;
}

function addWallDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const d = new Date(year, month - 1, day + delta);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

function expandEvent(
  raw: RawEvent,
  overrides: Map<string, RawEvent>,
  windowStartMs: number,
  windowEndMs: number,
): Occurrence[] {
  if (raw.status === 'CANCELLED') return [];
  const out: Occurrence[] = [];
  const exdateKeys = new Set(raw.exdates.map(wallKey));

  const durationMs = (() => {
    if (raw.end) {
      const s = wallToMs(raw.start);
      const e = wallToMs(raw.end);
      if (s !== null && e !== null && e > s) return e - s;
    }
    if (raw.durationMs !== null && raw.durationMs > 0) return raw.durationMs;
    return raw.start.allDay ? 86400000 : 3600000;
  })();

  const push = (w: WallDateTime): boolean => {
    const key = wallKey(w);
    const override = overrides.get(key);
    const effective = override ?? raw;
    if (override && override.status === 'CANCELLED') return true;
    if (exdateKeys.has(key)) return true;
    const effStart = override ? override.start : w;
    const allDay = effStart.allDay;
    const s = wallToMs(effStart);
    if (s === null) return true;
    if (s > windowEndMs) return false; // occurrences are chronological: stop
    const e = (() => {
      if (override?.end) {
        const oe = wallToMs(override.end);
        if (oe !== null && oe > s) return oe;
      }
      if (override?.durationMs) return s + override.durationMs;
      return s + durationMs;
    })();
    if (e < windowStartMs) return true; // before the window: skip
    out.push({
      startMs: s,
      endMs: e,
      allDay,
      wallYear: effStart.year,
      wallMonth: effStart.month,
      wallDay: effStart.day,
      durationDays: Math.max(1, Math.round(durationMs / 86400000)),
      raw: effective,
      overridden: !!override,
    });
    return true;
  };

  const rule = raw.rrule ? parseRRule(raw.rrule) : null;
  if (rule) {
    expandRRule(raw.start, rule, push);
  } else {
    push(raw.start);
  }
  return out;
}

// One CalEvent per day spanned, so dots, agenda, and counts all work without
// special-casing multi-day events downstream. All-day events are pinned to
// their wall-clock dates; timed events split on device-local day boundaries.
function occurrencesToEvents(occ: Occurrence, feed: FeedSource): CalEvent[] {
  const raw = occ.raw;
  const events: CalEvent[] = [];
  const meetingUrl = meetingUrlFor(raw);
  const description = raw.description ? raw.description.slice(0, 2000) : undefined;

  const make = (key: string, startMs: number, endMs: number, dayIndex: number): CalEvent => ({
    id: `${raw.uid}:${occ.startMs}:${dayIndex}`,
    calendarId: feed.url,
    calendarName: feed.name,
    color: feed.color,
    dateKey: key,
    start: toLocalIso(startMs),
    end: toLocalIso(endMs),
    allDay: occ.allDay,
    title: raw.summary || '(untitled)',
    location: raw.location,
    meetingUrl: meetingUrl || undefined,
    eventUrl: undefined,
    eventType: undefined,
    responseStatus: undefined,
    description,
  });

  if (occ.allDay) {
    for (let i = 0; i < occ.durationDays; i++) {
      const dt = addWallDays(occ.wallYear, occ.wallMonth, occ.wallDay, i);
      const dayStart = new Date(dt.year, dt.month - 1, dt.day).getTime();
      events.push(make(dateKey(dt.year, dt.month - 1, dt.day), dayStart, dayStart + 86400000, i));
    }
    return events;
  }

  const startDay = new Date(occ.startMs);
  startDay.setHours(0, 0, 0, 0);
  const endDay = new Date(Math.max(occ.startMs, occ.endMs - 1));
  endDay.setHours(0, 0, 0, 0);
  const dayCount = Math.round((endDay.getTime() - startDay.getTime()) / 86400000) + 1;

  for (let i = 0; i < dayCount; i++) {
    const dayMs = startDay.getTime() + i * 86400000;
    events.push(make(localDateKey(dayMs), occ.startMs, occ.endMs, i));
  }
  return events;
}

interface ParsedFeed {
  raws: RawEvent[];
  calName: string;
  errors: string[];
}

function parseRaws(text: string): ParsedFeed {
  const errors: string[] = [];
  const lines = unfold(text);
  let calName = '';
  const raws: RawEvent[] = [];
  let current: string[] | null = null;
  let depth = 0;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      depth++;
      if (depth === 1) current = [line];
      else if (current) current.push(line);
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) current.push(line);
      if (depth === 1 && current) {
        try {
          const raw = parseVEvent(current);
          if (raw) raws.push(raw);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : 'parse error');
        }
        current = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (current) {
      current.push(line);
      continue;
    }
    if (line.startsWith('X-WR-CALNAME')) {
      const prop = parseProp(line);
      if (prop) calName = unescapeText(prop.value).trim();
    }
  }
  return { raws, calName, errors };
}

export interface ParseResult {
  events: CalEvent[];
  errors: string[];
  feedName: string;
}

// Full pipeline for one feed: parse, expand recurrences inside the window,
// normalize. Window bounds are absolute ms.
export function expandFeedEvents(
  text: string,
  feed: FeedSource,
  windowStartMs: number,
  windowEndMs: number,
): ParseResult {
  const { raws, calName, errors } = parseRaws(text);
  const resolvedFeed: FeedSource = { ...feed, name: calName || feed.name };

  // Group RECURRENCE-ID overrides under their base UID.
  const bases: RawEvent[] = [];
  const overrides = new Map<string, Map<string, RawEvent>>();
  for (const raw of raws) {
    if (raw.recurrenceId) {
      let byUid = overrides.get(raw.uid);
      if (!byUid) {
        byUid = new Map();
        overrides.set(raw.uid, byUid);
      }
      byUid.set(wallKey(raw.recurrenceId), raw);
    } else {
      bases.push(raw);
    }
  }

  const events: CalEvent[] = [];
  for (const base of bases) {
    const occs = expandEvent(base, overrides.get(base.uid) ?? new Map(), windowStartMs, windowEndMs);
    for (const occ of occs) {
      events.push(...occurrencesToEvents(occ, resolvedFeed));
    }
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { events, errors, feedName: resolvedFeed.name };
}

export async function loadFeeds(
  fetchText: (url: string) => Promise<string>,
  feeds: FeedSource[],
  windowStartMs: number,
  windowEndMs: number,
): Promise<{ events: CalEvent[]; errors: string[] }> {
  const events: CalEvent[] = [];
  const errors: string[] = [];
  const settled = await Promise.allSettled(feeds.map(f => fetchText(f.url)));
  settled.forEach((result, i) => {
    const feed = feeds[i];
    if (result.status === 'rejected') {
      errors.push(`${feed.name}: ${result.reason instanceof Error ? result.reason.message : 'fetch failed'}`);
      return;
    }
    try {
      const expanded = expandFeedEvents(result.value, feed, windowStartMs, windowEndMs);
      events.push(...expanded.events);
      errors.push(...expanded.errors.map(e => `${feed.name}: ${e}`));
    } catch (e) {
      errors.push(`${feed.name}: ${e instanceof Error ? e.message : 'parse failed'}`);
    }
  });
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { events, errors };
}
