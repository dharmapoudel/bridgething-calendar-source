import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deviceTime, fetchText, getConfig, onConfigChanged } from './client';
import { FEED_COLORS, loadFeeds } from './ics';
import {
  dateKey,
  eventsForDateKey,
  formatCountdown,
  formatKeyHeading,
  formatTimeRange,
  indexEventsByDate,
  isDeclined,
  keyForDate,
  millisUntil,
  monthGrid,
  nextEventToday,
  shouldAnnounce,
  stepMonth,
  syncState,
  todayKeyFor,
  truncateTitle,
  visibleEvents,
  weekdayOrder,
  zonedParts,
} from './model';
import type { CalEvent } from './model';

interface AppConfig {
  feeds: string[];
  weekStart: number;
  countdownMinutes: number;
  refreshMinutes: number;
  showWeekNumbers: boolean;
  showEventPanel: boolean;
}

const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseConfig(raw: {
  feeds: string | null;
  weekStart: string | null;
  countdown: string | null;
  refresh: string | null;
  showWeekNumbers: string | null;
  showEventPanel: string | null;
}): AppConfig {
  const feeds = (raw.feeds || '')
    .split('\n')
    .map(s => s.trim())
    .filter(s => /^https:\/\//i.test(s) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(s));
  const weekStart = (raw.weekStart || '').trim().toLowerCase() === 'sunday' ? 0 : 1;
  const countdownMinutes = clampInt(raw.countdown, 30, 5, 180);
  const refreshMinutes = clampInt(raw.refresh, 15, 5, 120);
  const showWeekNumbers = parseBool(raw.showWeekNumbers, true);
  const showEventPanel = parseBool(raw.showEventPanel, true);
  return { feeds, weekStart, countdownMinutes, refreshMinutes, showWeekNumbers, showEventPanel };
}

function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw === null || raw === undefined) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw || ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function timeAgo(ms: number | null, now: number): string {
  if (ms === null) return '';
  const mins = Math.max(0, Math.round((now - ms) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [syncedAtMs, setSyncedAtMs] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [selectedKey, setSelectedKey] = useState(() => keyForDate(new Date()));
  const [detail, setDetail] = useState<CalEvent | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const configRef = useRef<AppConfig | null>(null);
  configRef.current = config;
  const timeZoneRef = useRef<string | undefined>(undefined);
  timeZoneRef.current = timeZone;
  const interactedRef = useRef(false);
  const navDirRef = useRef<{ dir: 'next' | 'prev' | 'fade'; axis: 'x' | 'y' }>({
    dir: 'fade',
    axis: 'x',
  });
  const swipeStartY = useRef<number | null>(null);

  const loadConfig = useCallback(async () => {
    // URL params override companion config (testing, kiosk setups).
    const params = new URLSearchParams(window.location.search);
    const paramFeeds = params.get('ics_feeds');
    const [feeds, weekStart, countdown, refresh, showWeekNumbers, showEventPanel] =
      await Promise.all([
        paramFeeds ?? getConfig('ics_feeds'),
        params.get('week_start') ?? getConfig('week_start'),
        params.get('countdown_minutes') ?? getConfig('countdown_minutes'),
        params.get('refresh_minutes') ?? getConfig('refresh_minutes'),
        params.get('show_week_numbers') ?? getConfig('show_week_numbers'),
        params.get('show_event_panel') ?? getConfig('show_event_panel'),
      ]);
    setConfig(parseConfig({ feeds, weekStart, countdown, refresh, showWeekNumbers, showEventPanel }));
  }, []);

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
      setSyncedAtMs(Date.now());
    } catch (e) {
      setErrors([e instanceof Error ? e.message : 'Could not load feeds']);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // boot: config, device clock, live config updates.
  // The phone is the time authority (the device has no battery-backed
  // clock): both the instant and the IANA zone come from the daemon, so the
  // clock renders in the user's timezone instead of the device's (UTC).
  // The offset is re-synced every minute so drift never accumulates.
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

  // The first feed load usually races the daemon clock; once the phone's
  // timezone is known, re-expand so day buckets and times use it.
  const tzAppliedRef = useRef(false);
  useEffect(() => {
    if (timeZone !== undefined && !tzAppliedRef.current && config && config.feeds.length > 0) {
      tzAppliedRef.current = true;
      loadFeedsNow(config);
    }
  }, [timeZone, config, loadFeedsNow]);

  // fetch when feeds become known; poll on the refresh interval
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
    [viewYear, viewMonth, config, todayKey, index],
  );
  const selectedEvents = useMemo(() => {
    const list = eventsForDateKey(index, selectedKey);
    return [...list].sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
    });
  }, [index, selectedKey]);

  const next = useMemo(() => nextEventToday(visible, now, todayKey), [visible, now, todayKey]);
  const announcing = next && shouldAnnounce(next, now, config?.countdownMinutes ?? 30);
  const countdown = announcing && next ? formatCountdown(millisUntil(next, now)) : null;

  const state = syncState(syncedAtMs, now, (config?.refreshMinutes ?? 15) * 60);

  const goMonth = useCallback((delta: number, axis: 'x' | 'y' = 'x') => {
    interactedRef.current = true;
    navDirRef.current = { dir: delta > 0 ? 'next' : 'prev', axis };
    const { year, month } = stepMonth(viewYear, viewMonth, delta);
    setViewYear(year);
    setViewMonth(month);
  }, [viewYear, viewMonth]);

  const goToday = useCallback(() => {
    interactedRef.current = true;
    navDirRef.current = { dir: 'fade', axis: 'x' };
    const p = zonedParts(now, timeZoneRef.current);
    setViewYear(p.year);
    setViewMonth(p.month - 1);
    setSelectedKey(dateKey(p.year, p.month - 1, p.day));
  }, [now]);

  // knob (rotary wheel) steps months; arrow keys do the same
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (detail) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        goMonth(e.deltaX > 0 ? 1 : -1);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight') goMonth(1);
      else if (e.key === 'ArrowLeft') goMonth(-1);
      else if (e.key === 't' || e.key === 'T') goToday();
      else if (e.key === 'Escape') {
        if (detail) setDetail(null);
        else setPanelOpen(false);
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [goMonth, goToday, detail]);

  const clockText = new Date(now).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  const selectedHeading = formatKeyHeading(selectedKey);

  if (!config) {
    return (
      <div className="grid h-full w-full place-items-center bg-bg font-mono text-body text-dim">
        Loading…
      </div>
    );
  }

  // Event panel: pinned in the layout when the setting is on, otherwise a
  // slide-over that opens when a date is tapped.
  const panelPinned = config.showEventPanel;
  const panelVisible = panelPinned || panelOpen;
  const gridCols = config.showWeekNumbers ? 'grid-cols-[2rem_repeat(7,1fr)]' : 'grid-cols-7';

  const onDayClick = (key: string) => {
    interactedRef.current = true;
    if (!panelPinned && key === selectedKey) {
      setPanelOpen(v => !v);
    } else {
      setSelectedKey(key);
      if (!panelPinned) setPanelOpen(true);
    }
  };

  // Direction-aware slide for month changes: horizontal swipes/knob/arrows
  // slide sideways, vertical swipes slide up/down.
  const navAnimClass = (() => {
    const { dir, axis } = navDirRef.current;
    if (dir === 'fade') return 'month-in-fade';
    if (axis === 'y') return dir === 'next' ? 'month-in-up' : 'month-in-down';
    return dir === 'next' ? 'month-in-next' : 'month-in-prev';
  })();

  // Swipe up/down on the month grid steps months.
  const onTouchStart = (e: React.TouchEvent) => {
    swipeStartY.current = e.touches[0].clientY;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (swipeStartY.current === null) return;
    const dy = e.changedTouches[0].clientY - swipeStartY.current;
    swipeStartY.current = null;
    if (Math.abs(dy) > 48) goMonth(dy < 0 ? 1 : -1, 'y');
  };

  return (
    <div className="flex h-full w-full flex-col bg-bg text-off-white">
      {/* header */}
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-rule px-4">
        <div className="flex items-center gap-1">
          <button
            onClick={() => goMonth(-1)}
            className="rounded px-2 py-1 font-mono text-body text-dim active:bg-neutral-soft"
            aria-label="Previous month"
          >
            ‹
          </button>
          <div className="min-w-36 text-center font-display text-month font-medium">
            {MONTH_NAMES[viewMonth]} {viewYear}
          </div>
          <button
            onClick={() => goMonth(1)}
            className="rounded px-2 py-1 font-mono text-body text-dim active:bg-neutral-soft"
            aria-label="Next month"
          >
            ›
          </button>
          <button
            onClick={goToday}
            className="ml-1 rounded border border-edge px-2 py-1 font-mono text-hint text-near active:bg-neutral-soft"
          >
            Today
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2 font-mono text-hint">
          <span className="font-display text-title font-medium text-near">{clockText}</span>
        </div>
      </header>

      {/* next-event banner */}
      {announcing && next && countdown && (
        <div className="flex h-[44px] shrink-0 items-center gap-3 border-b border-rule bg-accent-soft px-4">
          <div className="font-mono text-eyebrow uppercase tracking-[0.2em] text-accent">Next</div>
          <button
            className="min-w-0 flex-1 truncate text-left font-body text-row font-medium"
            onClick={() => setDetail(next)}
          >
            {truncateTitle(next.title)} <span className="text-dim">· {countdown}</span>
          </button>
        </div>
      )}

      {/* body */}
      <div className="relative flex min-h-0 flex-1">
        {/* month grid */}
        <main
          className="flex min-w-0 flex-1 flex-col px-3 py-2"
          style={{ touchAction: 'pan-x' }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <div className={`grid shrink-0 ${gridCols} gap-1`}>
            {config.showWeekNumbers && <div />}
            {weekdayOrder(config.weekStart).map(wd => (
              <div
                key={wd}
                className="pb-1 text-center font-mono text-eyebrow uppercase tracking-[0.15em] text-dim"
              >
                {WEEKDAY_SHORT[wd]}
              </div>
            ))}
          </div>
          <div
            key={`${viewYear}-${viewMonth}`}
            className={`grid min-h-0 flex-1 gap-1 ${navAnimClass}`}
            style={{ gridTemplateRows: `repeat(${grid.length}, minmax(0, 1fr))` }}
          >
            {grid.map((week, wi) => (
              <div key={wi} className={`grid min-h-0 ${gridCols} gap-1`}>
                {config.showWeekNumbers && (
                  <div className="flex items-center justify-center font-mono text-hint text-dim">
                    {week.week}
                  </div>
                )}
                {week.days.map(day => {
                  const selected = day.key === selectedKey;
                  return (
                    <button
                      key={day.key}
                      onClick={() => onDayClick(day.key)}
                      className={`relative flex min-h-0 flex-col items-center justify-center rounded border px-1 ${
                        selected
                          ? 'border-accent bg-accent-soft'
                          : day.today
                            ? 'border-edge'
                            : 'border-transparent'
                      } ${day.inMonth ? '' : 'opacity-35'} active:bg-neutral-soft`}
                    >
                      <span
                        className={`font-display text-date leading-none font-medium ${
                          day.today ? 'text-accent' : 'text-near'
                        }`}
                      >
                        {day.day}
                      </span>
                      {day.dots.length > 0 && (
                        <span className="mt-1 flex gap-1">
                          {day.dots.map((c, i) => (
                            <span
                              key={i}
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </main>

        {/* agenda */}
        <aside
          className={
            panelPinned
              ? 'flex w-72 shrink-0 flex-col border-l border-rule bg-screen'
              : `absolute inset-y-0 right-0 z-[5] flex w-72 flex-col border-l border-rule bg-screen shadow-2xl transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${
                  panelVisible ? 'translate-x-0' : 'translate-x-full'
                }`
          }
        >
          <div className="flex shrink-0 items-center border-b border-rule px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-eyebrow uppercase tracking-[0.2em] text-dim">
                {selectedKey === todayKey ? 'Today' : 'Selected day'}
              </div>
              <div className="truncate font-display text-title font-medium">{selectedHeading}</div>
            </div>
            {!panelPinned && (
              <button
                onClick={() => setPanelOpen(false)}
                aria-label="Close event panel"
                className="ml-2 shrink-0 rounded px-2 py-1 font-mono text-body text-dim active:bg-neutral-soft"
              >
                ✕
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {config.feeds.length === 0 ? (
              <SetupGuide />
            ) : refreshing && events.length === 0 ? (
              <div className="p-4 font-mono text-body text-dim">Syncing calendars…</div>
            ) : selectedEvents.length === 0 ? (
              <div className="p-4 font-mono text-body text-dim">Nothing scheduled.</div>
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
                  <div key={i} className="font-mono text-hint text-warn">
                    {err}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* footer: sync status sits bottom-right */}
      <footer className="flex h-[30px] shrink-0 items-center justify-end gap-2 border-t border-rule px-4 font-mono text-hint text-dim">
        <span
          title={state === 'ok' ? `Updated ${timeAgo(syncedAtMs, now)}` : state}
          className={
            state === 'ok' ? 'text-ok' : state === 'stale' ? 'text-warn' : 'text-dim'
          }
        >
          ●
        </span>
        <span>{refreshing ? 'syncing…' : state === 'ok' ? timeAgo(syncedAtMs, now) : state}</span>
        <button
          onClick={() => config && loadFeedsNow(config)}
          className="rounded border border-edge px-2 py-0.5 text-near active:bg-neutral-soft"
          title="Refresh now"
        >
          ⟳
        </button>
      </footer>

      {/* event detail modal */}
      {detail && (
        <div
          className="modal-backdrop-in absolute inset-0 z-10 grid place-items-center bg-black/70 p-8"
          onClick={() => setDetail(null)}
        >
          <div
            className="modal-pop flex max-h-full w-[480px] flex-col rounded border border-edge bg-bg p-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: detail.color || '#6c7086' }}
              />
              <div className="font-mono text-eyebrow uppercase tracking-[0.2em] text-dim">
                {detail.calendarName}
              </div>
            </div>
            <div className="mt-2 font-display text-hero font-medium leading-tight">
              {detail.title}
            </div>
            <div className="mt-1 font-mono text-body text-accent">{formatTimeRange(detail, timeZone)}</div>
            {detail.location && (
              <div className="mt-1 font-body text-body text-dim">{detail.location}</div>
            )}
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-rule pt-3 font-body text-body whitespace-pre-wrap text-near">
              {detail.description ? <LinkifiedText text={detail.description} /> : 'No details.'}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setDetail(null)}
                className="flex-1 rounded border border-edge px-4 py-2.5 font-mono text-body text-near active:bg-neutral-soft"
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
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className="h-8 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: event.color || '#6c7086' }}
        />
        <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <div
            className={`truncate font-body text-row font-medium text-near ${
              declined ? 'line-through opacity-60' : ''
            }`}
          >
            {event.title}
          </div>
          <div className="truncate font-mono text-hint text-dim">
            {event.allDay ? 'All day' : formatTimeRange(event, timeZone)}
            {event.location ? ` · ${event.location}` : ''}
          </div>
        </button>
      </div>
    </li>
  );
}

// Renders plain text with any http(s) URLs turned into tappable links
// (used for event descriptions now that the Join button is gone).
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
      <div className="font-display text-title font-medium">Connect a calendar</div>
      <ol className="mt-3 list-decimal space-y-2 pl-5 font-body text-body text-dim">
        <li>
          On your phone, open the Bridgething companion app → <b className="text-near">Calendar</b>{' '}
          → <b className="text-near">Settings</b>.
        </li>
        <li>
          Paste your calendar&apos;s <b className="text-near">iCalendar (.ics) URL</b> into
          &ldquo;iCalendar feed URLs&rdquo; — one per line.
        </li>
        <li>
          Google Calendar: open calendar.google.com → calendar settings →{' '}
          <b className="text-near">Integrate calendar</b> → copy the{' '}
          <b className="text-near">Secret address in iCal format</b>.
        </li>
        <li>Apple, Outlook, and Nextcloud all publish iCal URLs the same way.</li>
      </ol>
      <div className="mt-3 font-mono text-hint text-dim">
        Your feeds stay between your phone and your calendars — this app only reads them.
      </div>
    </div>
  );
}
