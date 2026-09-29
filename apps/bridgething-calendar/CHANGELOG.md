## 0.2.18

Flipped theme setting interpretation per user report: stored 'light' now applies the dark theme and vice versa (to match the companion app's display). Empty/unset still defaults to dark.

## 0.2.17

Fixed unreadable secondary text: increased --color-dim opacity from 0.55 to 0.78 in both dark and light themes (light mode was 3.6:1, failing WCAG AA). Note: color-scheme: dark was already set on :root in @layer base, so no change needed there (@theme blocks only accept custom properties).

## 0.2.16

Next-event line now includes all-day events (holidays, games) instead of showing 'Nothing coming up'; all-day events display 'All day' instead of a time.

## 0.2.15

Settings page now displays the default ICS feeds when none are configured; empty stored values fall back to manifest defaults for all settings.

## 0.2.14

Fix all settings: ics_feeds now falls back to default feeds when empty (fixes events not showing after upgrade); week_start now actually controls the calendar's first day; countdown_minutes now shows a countdown for imminent events.

## 0.2.13

Default ICS feeds: US holidays (Google + CalendarLabs), Formula 1, EPL 2025-26, NFL, plus a Google calendar.

# Changelog

## 0.2.12
- True warm dark theme: the default dark theme is now a near-black warm (#161211) instead of muted rose; light theme unchanged.

## 0.2.11
- Removed the dead "Show week numbers" and "Show event panel" settings from the companion-app settings schema (neither key is referenced by the app).

## 0.2.10
- Proportional system: Monday header now matches September at 20px (nudge removed); panel padding symmetric top/bottom (40px landscape, 32px portrait month panel); DOW headers match date size (22px); clock = 2.5 x DOW row height (102.5px, top still glued to DOW top); event line's vertical center aligned to the last date row's center (landscape, 5-week grid).

## 0.2.9
- Big clock is now Source Serif Pro Medium (weight 500); its font-size spans two rows (DOW header row + first week row): 93.4px landscape / 94.2px portrait.
- Landscape: the "Monday 9/28" date header nudged down 3.6px so it looks level with "September" (δ = (30 − 22.8)/2); the clock's top margin re-derived to 15.6px so its top edge still meets the S M T W T F S row's top edge.
- The date header and clock share the same left inset in both orientations.

## 0.2.8
- Big clock is now Source Serif Pro Bold (72px, -0.02em tracking).
- Landscape: the clock's top edge aligns with the S M T W T F S header row's top edge; portrait unchanged.

## 0.2.7
- Landscape: the "Monday 9/28" date header and the "September" month title now share the same top inset (the month title wrapper's top padding was removed in landscape only) so both lines sit at exactly the same height; portrait unchanged.

## 0.2.6
- Big clock is now Inter Bold (700) at 72px with -2% letter-spacing.

## 0.2.5
- Daily Bing picture-of-the-day backdrop: fetched fresh every day through the daemon net proxy, blurred and darkened at runtime, cached per local day in localStorage (zero network when today's image is cached); falls back to the flat rose when nothing is cached and keeps the previous image on any failure.
- Big clock is now Times New Roman (bundled Tinos, metric-compatible, since the Car Thing ships no MS fonts), hardcoded at 158px with weight 400.
- Roomier month panel: generous top/right/bottom padding in both orientations; the month name's left edge now aligns exactly with the "S" Sunday header glyph.

## 0.2.1
- Match the reference mockup exactly: flat muted-rose theme (#8C5858), warm-white text, Inter throughout.
- Removed week numbers, Today button, month arrows, sync footer, pinned agenda, event dots, today highlight, AM/PM on the clock.
- Sunday-start grid with blank leading cells; title-case day header; month title without year.
- Bottom-left next-event line is now a swipeable one-line carousel of upcoming events (tap opens detail).
- Day tap / knob press opens a theme-matched day sheet (bottom sheet in portrait, centered card in landscape).

## 0.2.0

- Redesign: minimal clock/calendar layout inspired by the reference mockup — big live clock with the focused day ("Friday 9/18") and a next-upcoming-event line on the left, month grid on the right with a white selection circle
- Dark mode by default: muted dark rose theme, with an optional light theme in settings
- Animations: month grid slides on month change, selection circle glides with spring easing, clock digits fade on minute change
- Knob: rotate moves the day focus (Left/Right = day, Up/Down = week, crossing month edges steps months), press opens the focused day's events; knob scrolls the event list and detail modal
- Portrait: clock panel on top (40%), month grid below (60%); event list in a bottom sheet

## 0.1.7

- On-device portrait detection: the daemon pins the layout viewport at 800x480 and rotates the panel, so CSS (orientation: portrait) never matched on the Car Thing and the portrait layout never activated there. Detection now checks screen.orientation first (Radio 0.6.6 approach) with matchMedia as fallback; landscape unchanged

## 0.1.6

- Portrait split: the month grid now takes the top 60% of the screen and the event panel fills the bottom 40% (was 36%); landscape unchanged

## 0.1.5

- Portrait layout fix: in portrait (480x800) the month grid now takes the full width with the agenda stacked below it (Weather-style column), and the slide-over event panel becomes a bottom sheet; the event detail modal no longer overflows the narrower viewport. Landscape (800x480) is unchanged

## 0.1.4

- Month grid swipes left/right to change months again (swipe left = next month); the top/bottom swipe from 0.1.3 is removed
- Fonts now match Radio Atlas: Outfit + Inter with Noto Sans Devanagari and Noto Sans Arabic fallbacks so event titles in Hindi/Nepali/Arabic render instead of tofu blocks

## 0.1.3

- Removed the Join button: URLs in an event's description are now tappable links instead
- Removed the calendar filter chips from the bottom of the month grid
- Sync status (and the refresh button) moved to a footer at the bottom right
- Month grid swipes up/down to change months instead of left/right (swipe up = next month), with a matching vertical slide animation
- Removed the now-unused per-calendar visibility toggles
- New custom settings page in the companion app: calendar feeds are now added one per row with + / × buttons, so multiple feeds actually work (the old single-line field only ever kept one)

## 0.1.2

- Fixed the clock: time now renders in the phone's timezone (the device has no timezone of its own), and the daemon clock re-syncs every minute
- Event times and day buckets also follow the phone's timezone now
- Larger month title and larger date numbers
- Month grid only renders the weeks it needs (5 rows for September 2026 instead of a padded 6th)
- Smoother animations: direction-aware month slide, softer panel easing, event detail pops in

## 0.1.1

- Removed the persistent CALENDAR header for a cleaner top bar
- New companion settings: hide week numbers, hide the event panel
- Tapping a date slides the event panel in with an animation (tap the date again or ✕ to dismiss)
- Swipe left/right on the month grid to change months
- Catppuccin Mocha color palette matching the original Omarchy calendar

## 0.1.0

Initial release.

- Month grid with event dots, ISO week numbers, and Today shortcut
- Selected-day agenda with times, locations, and all-day events
- Next-event countdown banner with one-tap Join for Meet, Zoom, Teams, Webex, GoToMeeting, and Chime
- Event detail modal with description and location
- Full ICS support: RRULE recurrence, TZID timezones, EXDATE, RECURRENCE-ID overrides, multi-day events
- Multiple feeds with per-calendar colors and visibility filters
- Companion-app settings: feed URLs, week start, countdown window, refresh interval
- Knob / arrow-key month navigation
