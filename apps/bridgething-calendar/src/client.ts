// Bridgething client wiring: daemon connection, config surface reads, and
// proxied network fetch. The daemon URL logic mirrors @bridgething/webapp-shared.

import { BridgethingClient, type NetFetchReply } from '@bridgething/client';

const OFF_DEVICE_URL = 'ws://127.0.0.1:8891/';
export const DAEMON_PROXY_PATH = '/__bridgething';

export function daemonUrl(): string {
  const override = import.meta.env.VITE_BRIDGETHING_URL;
  if (override) return override;
  if (typeof window === 'undefined') return OFF_DEVICE_URL;
  const { host } = window.location;
  return import.meta.env.DEV ? `ws://${host}${DAEMON_PROXY_PATH}/` : `ws://${host}/`;
}

let client: BridgethingClient | null = null;

export function getClient(): BridgethingClient {
  if (!client) client = new BridgethingClient({ url: daemonUrl() });
  return client;
}

export async function getConfig(key: string): Promise<string | null> {
  try {
    const res = await getClient().config.get({ key }, { timeoutMs: 8000 });
    return res.ok ? res.response.value : null;
  } catch {
    return null;
  }
}

export function onConfigChanged(handler: () => void): () => void {
  try {
    return getClient().config.onChanged(handler);
  } catch {
    return () => {};
  }
}

// Fetch text through the daemon's net proxy (needs the net.fetch permission).
export async function fetchText(url: string): Promise<string> {
  try {
    const res = await getClient().net.fetch(
      {
        request: {
          url,
          method: 'GET',
          headers: [],
          body: null,
          timeoutMs: 20_000,
          redirect: 'follow',
        },
      },
      { timeoutMs: 8000 },
    );
    // The daemon answered: its verdict is final, no fallback.
    if (!res.ok) {
      throw new DaemonVerdict(
        res.kind === 'domain' ? 'no network — connect your phone' : 'fetch failed',
      );
    }
    const reply = res.response as NetFetchReply;
    const status = reply.response.status;
    if (status >= 400) throw new DaemonVerdict(`feed returned HTTP ${status}`);
    const body = reply.response.body as unknown as number[];
    return new TextDecoder().decode(new Uint8Array(body));
  } catch (err) {
    if (err instanceof DaemonVerdict) throw err;
    // No daemon reachable (plain browser, test harness): direct fetch.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
    return await res.text();
  }
}

/** The daemon responded (possibly with an error): do not fall back. */
class DaemonVerdict extends Error {}

// Device wall clock, falling back to the local clock when the daemon is not
// reachable (simulator / dev).
export async function deviceNowMs(): Promise<number> {
  return (await deviceTime()).ms;
}

export interface DeviceTime {
  /** True instant in ms. The device has no battery-backed clock, so the
   * phone (via the daemon) is the time authority. */
  ms: number;
  /** IANA zone from the phone for *displaying* wall time. Undefined when the
   * daemon is unreachable, in which case the runtime's local zone applies. */
  timeZone: string | undefined;
}

/** Full time info from the daemon: instant + the phone's timezone. */
export async function deviceTime(): Promise<DeviceTime> {
  try {
    const t = await getClient().time.get({ timeoutMs: 8000 });
    if (t.ok) {
      const info = t.response.time;
      const ms = info.wallClockUnixS ? info.wallClockUnixS * 1000 : Date.now();
      return { ms, timeZone: resolveTimeZone(info) };
    }
  } catch {
    // fall through
  }
  return { ms: Date.now(), timeZone: undefined };
}

// The daemon docs say: read the zone from tzIana; when it is null, use
// utcOffsetMinutes plus dstOffsetMinutes.
function resolveTimeZone(info: {
  tzIana: string | null;
  utcOffsetMinutes: number | null;
  dstOffsetMinutes: number | null;
}): string | undefined {
  if (info.tzIana) {
    try {
      // Validate: an unknown zone must not crash formatting later.
      new Intl.DateTimeFormat('en-US', { timeZone: info.tzIana });
      return info.tzIana;
    } catch {
      // fall through to the numeric offset
    }
  }
  const offMin = (info.utcOffsetMinutes ?? 0) + (info.dstOffsetMinutes ?? 0);
  if (offMin % 60 === 0) {
    const hours = offMin / 60;
    if (hours === 0) return 'Etc/UTC';
    // Etc/GMT signs are inverted: Etc/GMT+5 means UTC-5.
    return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
  }
  return undefined;
}
