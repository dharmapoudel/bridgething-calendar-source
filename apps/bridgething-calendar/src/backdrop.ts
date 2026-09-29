// Daily Unsplash landscape backdrop, cached per local day.
//
// On launch: if localStorage holds today's image, it is applied with zero
// network traffic. Otherwise a random landscape photo is fetched from
// Unsplash (curated ID list, no API key) through the daemon net proxy (same
// path as the ICS feeds), blurred + darkened on an offscreen canvas, and
// cached as a JPEG data URL. Every 30 minutes the hook re-checks whether the
// local day has rolled over and, if so, swaps in a fresh random image in the
// background. A manual refresh button can force-pull a new random image at
// any time. Any failure keeps the previous image (even if stale); with no
// cache at all the hook returns null and the app falls back to the flat
// rose background.

import { useCallback, useEffect, useState } from 'react';
import { getClient } from './client';
import { todayKeyFor } from './model';

const DATE_KEY = 'unsplashBackdropDate';
const DATA_KEY = 'unsplashBackdropDataUrl';
const CHECK_MS = 30 * 60 * 1000;
const BLUR_PX = 28;

// Curated Unsplash landscape photo IDs (stable, no API key needed).
const UNSPLASH_IDS = [
  'photo-1506905925346-21bda4d32df4', // mountain
  'photo-1469474968028-56623f02e42e', // sunlight landscape
  'photo-1447752875215-b2761acb3c5d', // forest
  'photo-1433086966358-54859d0ed716', // waterfall
  'photo-1501594907352-04cda38ebc29', // lake tahoe
  'photo-1470071459604-3b5ec3a7fe05', // foggy hills
  'photo-1441974231531-c6227db76b6e', // forest road
  'photo-1472214103451-9374bd1c798e', // field sunset
];

function randomUnsplashUrl(): string {
  const id = UNSPLASH_IDS[Math.floor(Math.random() * UNSPLASH_IDS.length)];
  return `https://images.unsplash.com/${id}?w=800&h=480&fit=crop&q=80`;
}

function readCache(): { date: string | null; dataUrl: string | null } {
  try {
    return {
      date: localStorage.getItem(DATE_KEY),
      dataUrl: localStorage.getItem(DATA_KEY),
    };
  } catch {
    return { date: null, dataUrl: null };
  }
}

function writeCache(date: string, dataUrl: string): void {
  try {
    localStorage.setItem(DATE_KEY, date);
    localStorage.setItem(DATA_KEY, dataUrl);
  } catch {
    // storage full or unavailable: the in-memory image still displays.
  }
}

// Binary fetch through the daemon net proxy. Text decoding would corrupt a
// JPEG, so this returns the raw response bytes instead.
async function fetchBytes(url: string): Promise<Uint8Array> {
  try {
    const res = await getClient().net.fetch(
      {
        request: {
          url,
          method: 'GET',
          headers: [],
          body: null,
          timeoutMs: 30_000,
          redirect: 'follow',
        },
      },
      { timeoutMs: 12_000 },
    );
    if (!res.ok) throw new Error('daemon net.fetch failed');
    const reply = res.response as unknown as {
      response: { status: number; body: number[] };
    };
    if (reply.response.status >= 400) {
      throw new Error(`image returned HTTP ${reply.response.status}`);
    }
    return new Uint8Array(reply.response.body);
  } catch {
    // no daemon reachable (plain browser): direct fetch.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`image returned HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

// Cover-draw the photo at 800x480, blur it, darken slightly for legibility,
// and return a JPEG data URL. The blurred draw is overscanned so the blur
// kernel never exposes transparent edges.
async function processImage(bytes: Uint8Array): Promise<string> {
  const W = 800;
  const H = 480;
  const bmp = await createImageBitmap(
    new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }),
  );
  try {
    const cover = document.createElement('canvas');
    cover.width = W;
    cover.height = H;
    const cctx = cover.getContext('2d');
    if (!cctx) throw new Error('no 2d context');
    const scale = Math.max(W / bmp.width, H / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    cctx.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);

    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    const margin = BLUR_PX * 3 + 6;
    // detect gpu blur support by round-tripping the property.
    let filtered = false;
    try {
      const fx = ctx as CanvasRenderingContext2D & { filter: string };
      const want = `blur(${BLUR_PX}px)`;
      fx.filter = want;
      filtered = fx.filter === want;
      if (filtered) {
        ctx.drawImage(cover, -margin, -margin, W + margin * 2, H + margin * 2);
        fx.filter = 'none';
      }
    } catch {
      filtered = false;
    }
    if (!filtered) {
      // cheap blur: draw tiny, then upscale with smoothing on.
      const tiny = document.createElement('canvas');
      tiny.width = 40;
      tiny.height = 24;
      const tctx = tiny.getContext('2d');
      if (!tctx) throw new Error('no 2d context');
      tctx.drawImage(cover, 0, 0, 40, 24);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tiny, -margin, -margin, W + margin * 2, H + margin * 2);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, W, H);
    return out.toDataURL('image/jpeg', 0.82);
  } finally {
    bmp.close();
  }
}

async function fetchFresh(): Promise<string> {
  const bytes = await fetchBytes(randomUnsplashUrl());
  return processImage(bytes);
}

// Force-pull a new random Unsplash landscape, cache it under today's date,
// and return the processed data URL. Exported for the manual refresh button.
// Never throws: on failure it rethrows so the caller can keep the old image.
export async function refreshBackdropNow(timeZone: string | undefined): Promise<string> {
  const day = todayKeyFor(Date.now(), timeZone);
  const fresh = await fetchFresh();
  writeCache(day, fresh);
  return fresh;
}

// Returns the current backdrop as a JPEG data URL, or null when no image is
// cached (the app then falls back to the flat rose background). Never throws.
// The second element forces a fresh random Unsplash pull (used by the manual
// refresh button); it resolves to the new data URL or null on failure.
export function useDailyBackdrop(timeZone: string | undefined): [string | null, () => Promise<string | null>] {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  const forceRefresh = useCallback(async (): Promise<string | null> => {
    try {
      const fresh = await refreshBackdropNow(timeZone);
      setDataUrl(fresh);
      return fresh;
    } catch {
      return null;
    }
  }, [timeZone]);

  useEffect(() => {
    let alive = true;
    const today = () => todayKeyFor(Date.now(), timeZone);
    const apply = (url: string | null) => {
      if (alive) setDataUrl(url);
    };

    const refresh = async (cached: {
      date: string | null;
      dataUrl: string | null;
    }) => {
      const day = today();
      if (cached.date === day && cached.dataUrl) {
        apply(cached.dataUrl);
        return;
      }
      try {
        const fresh = await fetchFresh();
        writeCache(day, fresh);
        apply(fresh);
      } catch {
        // keep the previous image even if stale; none -> rose fallback.
        apply(cached.dataUrl);
      }
    };

    refresh(readCache());

    const timer = window.setInterval(() => {
      const cached = readCache();
      if (cached.date !== today()) void refresh(cached);
    }, CHECK_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [timeZone]);

  return [dataUrl, forceRefresh];
}
