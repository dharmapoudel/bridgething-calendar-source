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
  try {
    const t = await getClient().time.get({ timeoutMs: 8000 });
    if (t.ok && t.response.time.wallClockUnixS) return t.response.time.wallClockUnixS * 1000;
  } catch {
    // fall through
  }
  return Date.now();
}
