// Daily Unsplash landscape backdrop, cached per local day as a blurred JPEG data URL.
// Failures keep the previous image; with no cache the hook returns null.

import { useCallback, useEffect, useState } from 'react';
import { getClient } from './client';
import { todayKeyFor } from './model';

const DATE_KEY = 'unsplashBackdropDate';
const DATA_KEY = 'unsplashBackdropDataUrl';
const CHECK_MS = 30 * 60 * 1000;
const BLUR_PX = 28;

// Curated Unsplash landscape photo IDs (stable, no API key needed).
const UNSPLASH_IDS = [
  'photo-1506905925346-21bda4d32df4',
  'photo-1469474968028-56623f02e42e',
  'photo-1447752875215-b2761acb3c5d',
  'photo-1433086966358-54859d0ed716',
  'photo-1501594907352-04cda38ebc29',
  'photo-1470071459604-3b5ec3a7fe05',
  'photo-1441974231531-c6227db76b6e',
  'photo-1472214103451-9374bd1c798e',
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

// Binary fetch through the daemon net proxy (text decoding would corrupt the JPEG).
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
    // No daemon (plain browser): direct fetch.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`image returned HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

// Cover-draw at 800x480, blur, darken slightly, return JPEG data URL. Overscanned
// so the blur kernel never exposes transparent edges.
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

// Force-pull a new random Unsplash landscape, cache it under today's date.
export async function refreshBackdropNow(timeZone: string | undefined): Promise<string> {
  const day = todayKeyFor(Date.now(), timeZone);
  const fresh = await fetchFresh();
  writeCache(day, fresh);
  return fresh;
}

// Current backdrop as a JPEG data URL, or null when nothing is cached. The second
// element force-pulls a fresh random image (hardware button); null on failure.
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
        apply(cached.dataUrl); // keep previous even if stale; none -> fallback
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
