import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deviceTime, fetchText, getConfig, onConfigChanged } from './client';
import { useDailyBackdrop } from './backdrop';
import { FEED_COLORS, loadFeeds } from './ics';
import {
  dateFromKey,
  dateKey,
  eventsForDateKey,
  formatCountdown,
  formatKeyHeading,
  formatTime,
  formatTimeRange,
  indexEventsByDate,
  isDeclined,
  keyForDate,
  millisUntil,
  monthGrid,
  shouldAnnounce,
  stepMonth,
  todayKeyFor,
  truncateTitle,
  visibleEvents,
  zonedParts,
} from './model';
import type { CalEvent } from './model';

interface AppConfig {
  feeds: string[];
  refreshMinutes: number;
  theme: 'dark' | 'light';
  weekStart: number;
  countdownMinutes: number;
}

// Fallback for upgraders: the daemon only seeds manifest defaults on first install.
const DEFAULT_FEEDS: string[] = [
  'https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics',
  'https://www.calendarlabs.com/ical-calendar/ics/76/US_Holidays.ics',
  'https://www.calendarlabs.com/ical-calendar/ics/76/Formula_1.ics',
  'https://www.calendarlabs.com/ical-calendar/ics/75/NFL.ics',
  'https://calendar.google.com/calendar/ical/ht3jlfaac5lfd6263ulfh4tql8%40group.calendar.google.com/public/basic.ics',
];

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
// On-device theme toggle persists here (webapp has no daemon config.set); stores the DISPLAYED theme.
const THEME_OVERRIDE_KEY = 'themeOverride';
// Horizontal nudge (px) aligning the month name's left edge exactly with the
// left edge of the "S" Sunday header glyph. Positive shifts the label right.
const MONTH_NUDGE_LANDSCAPE = 22.2;
const MONTH_NUDGE_PORTRAIT = 46.7;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseConfig(raw: {
  feeds: string | null;
  refresh: string | null;
  theme: string | null;
  weekStart: string | null;
  countdown: string | null;
}): AppConfig {
  const parsed = (raw.feeds || '')
    .replace(/\\n/g, ';').replace(/\n/g, ';')
    .split(';')
    .map(s => s.replace(/\s+/g, ''))
    .filter(s => /^https:\/\//i.test(s) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(s));
  const feeds = parsed.length === 0 ? DEFAULT_FEEDS : parsed;
  const refreshMinutes = clampInt(raw.refresh, 15, 5, 120);
  const rawTheme = (raw.theme || '').trim().toLowerCase();
  // NOTE (0.2.18): interpretation is intentionally flipped per user report —
  // the companion app displays the inverse of what the device applied, so
  // stored 'light' applies the dark theme and vice versa.
  // NOTE (0.2.24): a localStorage override from the on-device theme toggle
  // button bypasses the flip — it stores the DISPLAYED theme directly.
  let theme: 'dark' | 'light' = rawTheme === 'light' ? 'dark' : rawTheme === 'dark' ? 'light' : 'dark';
  try {
    const override = localStorage.getItem(THEME_OVERRIDE_KEY);
    if (override === 'dark' || override === 'light') theme = override;
  } catch {
    // localStorage unavailable: fall through to daemon-derived theme.
  }
  const weekStart = (raw.weekStart || '').trim().toLowerCase() === 'sunday' ? 0 : 1;
  const countdownMinutes = clampInt(raw.countdown, 30, 5, 180);
  return { feeds, refreshMinutes, theme, weekStart, countdownMinutes };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw || ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Portrait detection: the daemon pins the layout viewport at 800x480 and
// rotates the panel, so CSS (orientation: portrait) never matches on-device.
// screen.orientation does report the rotated orientation, so check it first
// and keep matchMedia as the fallback (same approach as Radio 0.6.6).
function detectPortrait(): boolean {
  try {
    if (screen.orientation?.type.startsWith('portrait')) return true;
  } catch {
    /* older webview */
  }
  try {
    if (window.matchMedia('(orientation: portrait)').matches) return true;
  } catch {
    /* no matchMedia */
  }
  return false;
}

function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(detectPortrait);
  useEffect(() => {
    const update = () => setPortrait(detectPortrait());
    let orientation: ScreenOrientation | null = null;
    let mq: MediaQueryList | null = null;
    try {
      orientation = screen.orientation;
      orientation.addEventListener('change', update);
      mq = window.matchMedia('(orientation: portrait)');
      mq.addEventListener('change', update);
    } catch {
      /* listeners unavailable */
    }
    return () => {
      try {
        orientation?.removeEventListener('change', update);
        mq?.removeEventListener('change', update);
      } catch {
        /* ignore */
      }
    };
  }, []);
  return portrait;
}

function dayHeaderLabel(key: string): string {
  const d = dateFromKey(key, new Date());
  const wd = d.toLocaleDateString(undefined, { weekday: 'long' });
  return `${wd} ${d.getMonth() + 1}/${d.getDate()}`;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [selectedKey, setSelectedKey] = useState(() => keyForDate(new Date()));
  const [detail, setDetail] = useState<CalEvent | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pulseToday, setPulseToday] = useState(false);
  const [lineIdx, setLineIdx] = useState(0);
  const [lineDir, setLineDir] = useState<'next' | 'prev'>('next');
  const configRef = useRef<AppConfig | null>(null);
  configRef.current = config;
  const timeZoneRef = useRef<string | undefined>(undefined);
  timeZoneRef.current = timeZone;
  const interactedRef = useRef(false);
  const navDirRef = useRef<{ dir: 'next' | 'prev' | 'fade' }>({ dir: 'fade' });
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const lineSwipeStart = useRef<{ x: number } | null>(null);
  const pressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const isPortrait = useIsPortrait();
  const [backdropUrl, refreshBackdrop] = useDailyBackdrop(timeZone);

  // FLIP selection circle: glides one absolutely-positioned circle to the focused cell.
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const [circle, setCircle] = useState<{ x: number; y: number; s: number } | null>(null);
  const sheetListRef = useRef<HTMLDivElement | null>(null);
  const modalScrollRef = useRef<HTMLDivElement | null>(null);

  const loadConfig = useCallback(async () => {
    // URL params override companion config (testing, kiosk setups).
    const params = new URLSearchParams(window.location.search);
    const paramFeeds = params.get('ics_feeds');
    const [feeds, refresh, theme, weekStart, countdown] = await Promise.all([
      paramFeeds ?? getConfig('ics_feeds'),
      params.get('refresh_minutes') ?? getConfig('refresh_minutes'),
      params.get('theme') ?? getConfig('theme'),
      params.get('week_start') ?? getConfig('week_start'),
      params.get('countdown_minutes') ?? getConfig('countdown_minutes'),
    ]);
    setConfig(parseConfig({ feeds, refresh, theme, weekStart, countdown }));
  }, []);

  // Flips the DISPLAYED theme; persists in localStorage (no daemon config.set).
  const toggleTheme = useCallback(() => {
    setConfig(prev => {
      if (!prev) return prev;
      const next = prev.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_OVERRIDE_KEY, next);
      } catch {
        // storage unavailable: the in-memory flip still applies this session.
      }
      document.documentElement.dataset.theme = next;
      return { ...prev, theme: next };
    });
  }, []);

  const [refreshingBg, setRefreshingBg] = useState(false);
  const refreshBackground = useCallback(async () => {
    if (refreshingBg) return;
    setRefreshingBg(true);
    try {
      await refreshBackdrop();
    } finally {
      setRefreshingBg(false);
    }
  }, [refreshBackdrop, refreshingBg]);

  const loadFeedsNow = useCallback(async (cfg: AppConfig) => {
    if (cfg.feeds.length === 0) return;
    setRefreshing(true);
    setErrors([]);
    try {
      const nowMs = Date.now();
      const feeds = cfg.feeds.map((url, i) => ({
        url,
        name: `Calendar ${i + 1}`,
        color: FEED_COLORS[i % FEED_COLORS.length],
      }));
      const { events: evts, errors: errs } = await loadFeeds(
        fetchText,
        feeds,
        nowMs - 200 * 86400000,
        nowMs + 400 * 86400000,
        timeZoneRef.current,
      );
      setEvents(evts);
      setErrors(errs);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : 'Could not load feeds']);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Boot: config, device clock, live config updates. The phone is the time
  // authority (no battery-backed clock on device); offset re-synced every minute.
  useEffect(() => {
    loadConfig();
    let alive = true;
    const offsetRef = { current: 0 };
    const pullClock = (first: boolean) => {
      deviceTime().then(t => {
        if (!alive) return;
        offsetRef.current = t.ms - Date.now();
        setTimeZone(t.timeZone);
        setNow(Date.now() + offsetRef.current);
        if (first && !interactedRef.current) {
          const p = zonedParts(t.ms, t.timeZone);
          setViewYear(p.year);
          setViewMonth(p.month - 1);
          setSelectedKey(dateKey(p.year, p.month - 1, p.day));
        }
      });
    };
    pullClock(true);
    const tick = window.setInterval(() => setNow(Date.now() + offsetRef.current), 10000);
    const resync = window.setInterval(() => pullClock(false), 60000);
    const off = onConfigChanged(() => loadConfig());
    return () => {
      alive = false;
      window.clearInterval(tick);
      window.clearInterval(resync);
      off();
    };
  }, [loadConfig]);

  useEffect(() => {
    document.documentElement.dataset.theme = config?.theme ?? 'dark';
  }, [config?.theme]);

  // Per-region background brightness: LEFT (date/clock, x<35%) and RIGHT (calendar,
  // x>=35%) sampled independently; a global average can't handle photos brighter in
  // one region. Falls back to theme bg when the photo is absent. Attributes only.
  useEffect(() => {
    const root = document.documentElement;
    const theme = config?.theme ?? 'dark';
    const applyThemeFallback = () => {
      // No photo: judge by the theme's solid background so text stays readable.
      if (theme === 'light') {
        root.dataset.bgLeft = 'light';
        root.dataset.bgRight = 'light';
        root.dataset.bg = 'light';
      } else {
        root.removeAttribute('data-bg-left');
        root.removeAttribute('data-bg-right');
        root.removeAttribute('data-bg');
      }
    };
    if (!backdropUrl) {
      applyThemeFallback();
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const splitX = Math.floor(size * 0.35); // x<35%: date/clock; x>=35%: calendar grid
        let leftSum = 0;
        let leftCount = 0;
        let rightSum = 0;
        let rightCount = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            if (x < splitX) {
              leftSum += lum;
              leftCount++;
            } else {
              rightSum += lum;
              rightCount++;
            }
          }
        }
        if (cancelled) return;
        const leftLight = leftSum / leftCount > 140;
        const rightLight = rightSum / rightCount > 140;
        if (leftLight) root.dataset.bgLeft = 'light';
        else root.removeAttribute('data-bg-left');
        if (rightLight) root.dataset.bgRight = 'light';
        else root.removeAttribute('data-bg-right');
        // Global fallback for text outside both panels.
        if (leftLight || rightLight) root.dataset.bg = 'light';
        else root.removeAttribute('data-bg');
      } catch {
        if (!cancelled) applyThemeFallback();
      }
    };
    img.onerror = () => {
      if (!cancelled) applyThemeFallback();
    };
    img.src = backdropUrl;
    return () => {
      cancelled = true;
    };
  }, [backdropUrl, config?.theme]);

  // The first feed load usually races the daemon clock; once the phone's
  // timezone is known, re-expand so day buckets and times use it.
  const tzAppliedRef = useRef(false);
  useEffect(() => {
    if (timeZone !== undefined && !tzAppliedRef.current && config && config.feeds.length > 0) {
      tzAppliedRef.current = true;
      loadFeedsNow(config);
    }
  }, [timeZone, config, loadFeedsNow]);

  useEffect(() => {
    if (!config || config.feeds.length === 0) return;
    loadFeedsNow(config);
    const timer = window.setInterval(() => {
      const cfg = configRef.current;
      if (cfg) loadFeedsNow(cfg);
    }, config.refreshMinutes * 60000);
    return () => window.clearInterval(timer);
  }, [config, loadFeedsNow]);

  const visible = useMemo(
    () => visibleEvents(events, [], { hideWorkingLocation: true }),
    [events],
  );
  const index = useMemo(() => indexEventsByDate(visible), [visible]);
  const todayKey = useMemo(() => todayKeyFor(now, timeZone), [now, timeZone]);
  const grid = useMemo(
    () => monthGrid(viewYear, viewMonth, config?.weekStart ?? 1, todayKey, index),
    [viewYear, viewMonth, config?.weekStart, todayKey, index],
  );
  const selectedEvents = useMemo(() => {
    const list = eventsForDateKey(index, selectedKey);
    return [...list].sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
    });
  }, [index, selectedKey]);

  // All-day events included: holiday/sports feeds are all-day-only.
  const upcoming = useMemo(() => {
    const out: CalEvent[] = [];
    for (const ev of visible) {
      const ms = Date.parse(ev.start);
      if (Number.isNaN(ms) || ms < now) continue;
      out.push(ev);
    }
    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return out.slice(0, 8);
  }, [visible, now]);
  useEffect(() => {
    setLineIdx(i => Math.min(i, Math.max(0, upcoming.length - 1)));
  }, [upcoming.length]);
  const lineEvent = upcoming.length > 0 ? upcoming[Math.min(lineIdx, upcoming.length - 1)] : null;

  const goMonth = useCallback((delta: number) => {
    interactedRef.current = true;
    navDirRef.current = { dir: delta > 0 ? 'next' : 'prev' };
    const { year, month } = stepMonth(viewYear, viewMonth, delta);
    setViewYear(year);
    setViewMonth(month);
  }, [viewYear, viewMonth]);

  const goToday = useCallback(() => {
    interactedRef.current = true;
    const p = zonedParts(now, timeZoneRef.current);
    const tYear = p.year;
    const tMonth = p.month - 1;
    if (tYear !== viewYear || tMonth !== viewMonth) {
      // Slide toward today: future months from the right, past from the left.
      navDirRef.current = {
        dir: tYear > viewYear || (tYear === viewYear && tMonth > viewMonth) ? 'next' : 'prev',
      };
    } else {
      // Same month: grid doesn't re-mount; the FLIP circle glides instead.
      navDirRef.current = { dir: 'fade' };
    }
    setViewYear(tYear);
    setViewMonth(tMonth);
    setSelectedKey(dateKey(tYear, tMonth, p.day));
    setPulseToday(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setPulseToday(true));
    });
    window.setTimeout(() => setPulseToday(false), 550);
  }, [now, viewYear, viewMonth]);

  // Knob rotate: left/right ±1 day, up/down ±1 week; crossing a month edge steps the month.
  const moveFocus = useCallback((deltaDays: number) => {
    interactedRef.current = true;
    const d = dateFromKey(selectedKey, new Date());
    d.setDate(d.getDate() + deltaDays);
    const y = d.getFullYear();
    const mo = d.getMonth();
    if (y !== viewYear || mo !== viewMonth) {
      navDirRef.current = { dir: deltaDays > 0 ? 'next' : 'prev' };
      setViewYear(y);
      setViewMonth(mo);
    }
    setSelectedKey(keyForDate(d));
  }, [selectedKey, viewYear, viewMonth]);

  const pressFocused = useCallback(() => {
    interactedRef.current = true;
    if (detail) {
      setDetail(null);
      return;
    }
    if (sheetOpen) {
      if (selectedEvents.length > 0) setDetail(selectedEvents[0]);
      return;
    }
    setSheetOpen(true);
  }, [detail, sheetOpen, selectedEvents]);

  // Knob input arrives as arrow keys / Enter. Enter/Space is split across
  // keydown/keyup for long-press detection: keydown starts a 600ms timer,
  // keyup performs the short-press (or suppresses it if the timer fired).
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (detail) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        goMonth(e.deltaX > 0 ? 1 : -1);
      }
    };
    const scrollBy = (ref: React.RefObject<HTMLDivElement | null>, down: boolean) => {
      ref.current?.scrollBy({ top: down ? 96 : -96, behavior: 'smooth' });
    };
    const isPressKey = (e: KeyboardEvent) => e.key === 'Enter' || e.key === ' ';
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') {
        if (detail) setDetail(null);
        else setSheetOpen(false);
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        goToday();
        return;
      }
      // Hardware presets: 1/F1 toggles theme, 2/F2 refreshes background. Global.
      if (e.key === '1' || e.key === 'F1') {
        toggleTheme();
        return;
      }
      if (e.key === '2' || e.key === 'F2') {
        void refreshBackground();
        return;
      }
      if (isPressKey(e)) {
        e.preventDefault();
        // Ignore OS auto-repeat; the first keydown owns the gesture.
        if (e.repeat || pressTimer.current !== null) return;
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          longPressFired.current = true;
          setDetail(null);
          setSheetOpen(false);
          goToday();
        }, 600);
        return;
      }
      if (detail) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          scrollBy(modalScrollRef, e.key === 'ArrowDown');
        }
        return;
      }
      if (sheetOpen) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          scrollBy(sheetListRef, e.key === 'ArrowDown');
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveFocus(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveFocus(-1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveFocus(7);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(-7);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isPressKey(e)) return;
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (pressTimer.current !== null) {
        window.clearTimeout(pressTimer.current);
        pressTimer.current = null;
      }
      if (longPressFired.current) {
        longPressFired.current = false;
        return;
      }
      if (detail) {
        setDetail(null);
      } else if (sheetOpen) {
        if (selectedEvents.length > 0) setDetail(selectedEvents[0]);
        else setSheetOpen(false);
      } else {
        pressFocused();
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      // Note: the long-press timer is intentionally NOT cleared here. The
      // effect re-registers every ~10s (clock tick); clearing would cancel
      // a press in progress. Refs survive re-registration, so keyup still
      // pairs with the keydown that started the timer.
    };
  }, [goMonth, goToday, moveFocus, pressFocused, detail, sheetOpen, selectedEvents, toggleTheme, refreshBackground]);

  // Glide the selection circle to the focused cell pre-paint.
  useLayoutEffect(() => {
    const wrap = gridWrapRef.current;
    const cell = cellRefs.current.get(selectedKey);
    if (!wrap || !cell) {
      setCircle(null);
      return;
    }
    const wr = wrap.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    const s = Math.max(0, Math.min(cr.width, cr.height) - 6);
    const x = cr.left - wr.left + (cr.width - s) / 2;
    const y = cr.top - wr.top + (cr.height - s) / 2;
    setCircle(prev =>
      prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 && Math.abs(prev.s - s) < 0.5
        ? prev
        : { x, y, s },
    );
  }, [selectedKey, viewYear, viewMonth, grid, isPortrait, config !== null]);


  // Big clock: 12-hour, no leading zero, no AM/PM — like the reference.
  const clockDate = new Date(now);
  const clockRaw = clockDate.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  });
  const clockMain = clockRaw.replace(/^[AaPp][Mm]\s*|\s*[AaPp][Mm]$/g, '').trim();
  const minuteKey = clockMain;

  if (!config) {
    return (
      <div className="grid h-full w-full place-items-center bg-bg font-body text-body text-dim">
        Loading…
      </div>
    );
  }

  const onDayClick = (key: string) => {
    interactedRef.current = true;
    setSelectedKey(key);
    setSheetOpen(true);
  };

  const navAnimClass = (() => {
    const { dir } = navDirRef.current;
    if (dir === 'fade') return 'month-in-fade';
    return dir === 'next' ? 'month-in-next' : 'month-in-prev';
  })();

  // Vertical swipes are intentionally ignored.
  const onTouchStart = (e: React.TouchEvent) => {
    swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (swipeStart.current === null) return;
    const dx = e.changedTouches[0].clientX - swipeStart.current.x;
    const dy = e.changedTouches[0].clientY - swipeStart.current.y;
    swipeStart.current = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) goMonth(dx < 0 ? 1 : -1);
  };

  const onLineTouchStart = (e: React.TouchEvent) => {
    lineSwipeStart.current = { x: e.touches[0].clientX };
  };
  const onLineTouchEnd = (e: React.TouchEvent) => {
    if (lineSwipeStart.current === null) return;
    const dx = e.changedTouches[0].clientX - lineSwipeStart.current.x;
    lineSwipeStart.current = null;
    if (upcoming.length > 1 && Math.abs(dx) > 32) {
      const dir = dx < 0 ? 1 : -1;
      setLineDir(dir > 0 ? 'next' : 'prev');
      setLineIdx(i => (i + dir + upcoming.length) % upcoming.length);
    }
  };

  const eventListBody = (listRefProp: React.RefObject<HTMLDivElement | null>) => (
    <div ref={listRefProp} className="min-h-0 flex-1 overflow-y-auto">
      {config.feeds.length === 0 ? (
        <SetupGuide />
      ) : refreshing && events.length === 0 ? (
        <div className="p-4 font-body text-body text-dim">Syncing calendars…</div>
      ) : selectedEvents.length === 0 ? (
        <div className="p-4 font-body text-body text-dim">Nothing scheduled.</div>
      ) : (
        <ul className="divide-y divide-rule">
          {selectedEvents.map(ev => (
            <EventRow
              key={ev.id}
              event={ev}
              timeZone={timeZone}
              onOpen={() => setDetail(ev)}
            />
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <div className="border-t border-rule p-3">
          {errors.map((err, i) => (
            <div key={i} className="font-body text-hint text-warn">
              {err}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const sheetChrome = (
    <div className="flex shrink-0 items-center px-4 py-3">
      <div className="min-w-0 flex-1 truncate font-body text-title font-medium text-off-white">
        {formatKeyHeading(selectedKey)}
      </div>
      <button
        onClick={() => setSheetOpen(false)}
        aria-label="Close event list"
        className="ml-2 shrink-0 rounded px-2 py-1 font-body text-body text-dim active:bg-neutral-soft"
      >
        ✕
      </button>
    </div>
  );

  const weekStartIdx = config?.weekStart ?? 1;
  const dowLetters = [...WEEKDAY_LETTERS.slice(weekStartIdx), ...WEEKDAY_LETTERS.slice(0, weekStartIdx)];

  return (
    <div
      className={`relative flex h-full w-full ${isPortrait ? 'flex-col' : 'flex-row'} text-off-white`}
    >
      <div aria-hidden className="pointer-events-none fixed inset-0" style={{ zIndex: 0 }}>
        {backdropUrl && (
          <div
            key={backdropUrl}
            className="backdrop-swap absolute inset-0"
            style={{
              backgroundImage: `url(${backdropUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
        )}
        {backdropUrl && (
          <div className="absolute inset-0" style={{ background: 'rgba(24,10,10,0.38)' }} />
        )}
      </div>
      <section
        data-panel="left"
        className={`relative z-[1] flex shrink-0 flex-col ${
          isPortrait ? 'h-[40%] w-full px-6 pt-5 pb-4' : 'w-[40%] px-7 pt-10 pb-6'
        }`}
      >
        <div className="font-body text-[1.25rem] font-medium text-off-white">
          {dayHeaderLabel(selectedKey)}
        </div>
        <div
          key={minuteKey}
          className="clock-fade mt-2 leading-none whitespace-nowrap text-off-white"
          style={{
            fontFamily: '"Source Serif Pro", Georgia, "Times New Roman", serif',
            fontWeight: 500,
            // 2.5x DOW row height (22px*1.5+8=41 -> 102.5px).
            fontSize: 102.5,
            letterSpacing: '-0.02em',
            marginTop: isPortrait ? undefined : 12,
          }}
        >
          {clockMain}
        </div>
        <div
          className={`w-full select-none ${isPortrait ? 'mt-auto' : ''}`}
          style={{
            touchAction: 'pan-y',
            // Aligns event line with the last date row's center (landscape).
            marginTop: isPortrait ? undefined : 213.4,
          }}
          onTouchStart={onLineTouchStart}
          onTouchEnd={onLineTouchEnd}
        >
          {lineEvent ? (
            <button
              key={`${lineIdx}-${lineDir}`}
              onClick={() => setDetail(lineEvent)}
              className={`w-full truncate text-left font-body text-[1rem] text-off-white active:opacity-70 ${
                lineDir === 'next' ? 'month-in-next' : 'month-in-prev'
              }`}
            >
              {lineEvent && config && shouldAnnounce(lineEvent, now, config.countdownMinutes) ? (
                <>
                  <span className="text-accent">{formatCountdown(millisUntil(lineEvent, now))}</span>
                  {'  '}
                </>
              ) : null}
              <span className="text-off-white/80">{lineEvent.allDay ? 'All day' : formatTime(lineEvent.start, timeZone)}</span>
              {'  '}
              <span className="font-medium">{truncateTitle(lineEvent.title, 26)}</span>
            </button>
          ) : (
            <div className="font-body text-[1rem] text-dim">Nothing coming up</div>
          )}
        </div>
      </section>

      <main
        data-panel="right"
        className={`relative z-[1] flex min-h-0 flex-col ${
          isPortrait ? 'h-[60%] w-full pl-6 pr-10 pt-8 pb-8' : 'flex-1 pl-8 pr-14 pt-10 pb-10'
        }`}
        style={{ touchAction: 'pan-x' }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className={`flex shrink-0 items-center ${isPortrait ? 'py-3' : 'pb-3'}`}>
          <div
            className="font-body text-[1.25rem] font-medium text-off-white"
            style={{ marginLeft: isPortrait ? MONTH_NUDGE_PORTRAIT : MONTH_NUDGE_LANDSCAPE }}
          >
            {MONTH_NAMES[viewMonth]}
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-7 gap-1">
          {dowLetters.map((letter, i) => (
            <div
              key={i}
              className="pb-2 text-center font-body text-[1.375rem] text-dim"
            >
              {letter}
            </div>
          ))}
        </div>
        <div
          key={`${viewYear}-${viewMonth}`}
          ref={gridWrapRef}
          className={`relative grid min-h-0 flex-1 gap-1 ${navAnimClass}`}
          style={{ gridTemplateRows: `repeat(${grid.length}, minmax(0, 1fr))` }}
        >
          {circle && (
            <div
              aria-hidden
              className={`select-circle ${pulseToday ? 'today-arrive' : ''}`}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: circle.s,
                height: circle.s,
                borderRadius: 9999,
                transform: `translate(${circle.x}px, ${circle.y}px)`,
                background: 'var(--color-select)',
                zIndex: 0,
              }}
            />
          )}
          {grid.map((week, wi) => (
            <div key={wi} className="grid min-h-0 grid-cols-7 gap-1">
              {week.days.map(day =>
                day.inMonth ? (
                  <button
                    key={day.key}
                    ref={el => {
                      if (el) cellRefs.current.set(day.key, el);
                      else cellRefs.current.delete(day.key);
                    }}
                    onClick={() => onDayClick(day.key)}
                    className="relative flex min-h-0 items-center justify-center rounded active:bg-neutral-soft"
                  >
                    <span
                      className={`relative z-[1] font-body text-date leading-none ${
                        day.key === selectedKey
                          ? 'font-semibold text-[var(--color-select-ink)]'
                          : 'font-normal text-off-white'
                      }`}
                    >
                      {day.day}
                    </span>
                  </button>
                ) : (
                  <div key={day.key} />
                ),
              )}
            </div>
          ))}
        </div>
      </main>

      {/* Forced dark via data-theme="dark" regardless of app theme. */}
      {isPortrait ? (
        <aside
          data-theme="dark"
          className={`absolute inset-x-0 bottom-0 z-[5] flex max-h-[70%] w-full flex-col rounded-t-2xl bg-panel shadow-2xl transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${
            sheetOpen ? 'translate-y-0' : 'translate-y-[calc(100%+30px)]'
          }`}
        >
          {sheetChrome}
          {eventListBody(sheetListRef)}
        </aside>
      ) : (
        sheetOpen && (
          <div
            className="modal-backdrop-in absolute inset-0 z-[5] grid place-items-center bg-black/40"
            onClick={() => setSheetOpen(false)}
          >
            <div
              data-theme="dark"
              className="modal-pop flex max-h-[82%] w-[440px] max-w-full flex-col overflow-hidden rounded-2xl bg-panel shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              {sheetChrome}
              {eventListBody(sheetListRef)}
            </div>
          </div>
        )
      )}

      {detail && (
        <div
          className="modal-backdrop-in absolute inset-0 z-10 grid place-items-center bg-black/60 p-8"
          onClick={() => setDetail(null)}
        >
          <div
            data-theme="dark"
            className="modal-pop flex max-h-full w-[480px] max-w-full flex-col rounded-2xl bg-panel p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: detail.color || '#fbf4f2' }}
              />
              <div className="font-body text-[0.7rem] font-medium uppercase tracking-[0.18em] text-dim">
                {detail.calendarName}
              </div>
            </div>
            <div className="mt-2 font-body text-hero font-medium leading-tight text-off-white">
              {detail.title}
            </div>
            <div className="mt-1 font-body text-body text-accent">{formatTimeRange(detail, timeZone)}</div>
            {detail.location && (
              <div className="mt-1 font-body text-body text-dim">{detail.location}</div>
            )}
            <div
              ref={modalScrollRef}
              className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-rule pt-3 font-body text-body whitespace-pre-wrap text-off-white/90"
            >
              {detail.description ? <LinkifiedText text={detail.description} /> : 'No details.'}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setDetail(null)}
                className="flex-1 rounded-xl border border-edge px-4 py-2.5 font-body text-body text-off-white active:bg-neutral-soft"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EventRow({
  event,
  timeZone,
  onOpen,
}: {
  event: CalEvent;
  timeZone: string | undefined;
  onOpen: () => void;
}) {
  const declined = isDeclined(event);
  return (
    <li>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span
          className="h-8 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: event.color || '#fbf4f2' }}
        />
        <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <div
            className={`truncate font-body text-row font-medium text-off-white ${
              declined ? 'line-through opacity-60' : ''
            }`}
          >
            {event.title}
          </div>
          <div className="truncate font-body text-hint text-dim">
            {event.allDay ? 'All day' : formatTimeRange(event, timeZone)}
            {event.location ? ` · ${event.location}` : ''}
          </div>
        </button>
      </div>
    </li>
  );
}

function LinkifiedText({ text }: { text: string }) {
  const parts = linkify(text);
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'url' ? (
          <a
            key={i}
            href={part.url}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-accent underline break-all"
          >
            {part.url}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

type LinkPart = { kind: 'text'; text: string } | { kind: 'url'; url: string };

function linkify(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  const re = /(https?:\/\/[^\s<>"')\]]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let url = m[1];
    // Trailing punctuation is sentence punctuation, not part of the URL.
    const trail = url.match(/[.,;:!?)\]]+$/);
    let suffix = '';
    if (trail) {
      suffix = trail[0];
      url = url.slice(0, -suffix.length);
    }
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (url) out.push({ kind: 'url', url });
    const end = m.index + m[1].length;
    if (suffix) out.push({ kind: 'text', text: suffix });
    last = end;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

function SetupGuide() {
  return (
    <div className="p-4">
      <div className="font-body text-title font-medium text-off-white">Connect a calendar</div>
      <ol className="mt-3 list-decimal space-y-2 pl-5 font-body text-body text-dim">
        <li>
          On your phone, open the Bridgething companion app → <b className="text-off-white">Calendar</b>{' '}
          → <b className="text-off-white">Settings</b>.
        </li>
        <li>
          Paste your calendar&apos;s <b className="text-off-white">iCalendar (.ics) URL</b> into
          &ldquo;iCalendar feed URLs&rdquo; — one per line.
        </li>
        <li>
          Google Calendar: open calendar.google.com → calendar settings →{' '}
          <b className="text-off-white">Integrate calendar</b> → copy the{' '}
          <b className="text-off-white">Secret address in iCal format</b>.
        </li>
        <li>Apple, Outlook, and Nextcloud all publish iCal URLs the same way.</li>
      </ol>
      <div className="mt-3 font-body text-hint text-dim">
        Your feeds stay between your phone and your calendars — this app only reads them.
      </div>
    </div>
  );
}
