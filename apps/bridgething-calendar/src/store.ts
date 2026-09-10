// On-device persistent settings that live outside the companion-managed
// config: per-calendar visibility toggles.

const HIDDEN_KEY = 'bridgething-calendar:hidden-calendars';

export function getHiddenCalendars(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function setHiddenCalendars(hidden: string[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
  } catch {
    // storage unavailable: visibility just won't persist
  }
}
