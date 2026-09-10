# Changelog

## 0.1.2 — 2026-09-10

- Fixed the clock: time now renders in the phone's timezone (the device has no timezone of its own), and the daemon clock re-syncs every minute
- Event times and day buckets also follow the phone's timezone now
- Larger month title and larger date numbers
- Month grid only renders the weeks it needs (5 rows for September 2026 instead of a padded 6th)
- Smoother animations: direction-aware month slide, softer panel easing, event detail pops in

## 0.1.1 — 2026-09-09

- Removed the persistent CALENDAR header for a cleaner top bar
- New companion settings: hide week numbers, hide the event panel
- Tapping a date slides the event panel in with an animation (tap the date again or ✕ to dismiss)
- Swipe left/right on the month grid to change months
- Catppuccin Mocha color palette matching the original Omarchy calendar

## 0.1.0 — 2026-09-09

Initial release.

- Month grid with event dots, ISO week numbers, and Today shortcut
- Selected-day agenda with times, locations, and all-day events
- Next-event countdown banner with one-tap Join for Meet, Zoom, Teams, Webex, GoToMeeting, and Chime
- Event detail modal with description and location
- Full ICS support: RRULE recurrence, TZID timezones, EXDATE, RECURRENCE-ID overrides, multi-day events
- Multiple feeds with per-calendar colors and visibility filters
- Companion-app settings: feed URLs, week start, countdown window, refresh interval
- Knob / arrow-key month navigation
