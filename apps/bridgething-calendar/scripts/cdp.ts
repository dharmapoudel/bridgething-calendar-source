#!/usr/bin/env bun
// Headless-Chromium CDP helpers for visual testing (800x480 kiosk).
// probe:  bun scripts/cdp.ts probe <url> <js-expr> [waitMs]
// shot:   bun scripts/cdp.ts shot <url> <out.png> [waitMs]
// click:  bun scripts/cdp.ts click <url> <out.png> <waitMs> <x,y>...
import { spawn } from 'node:child_process';

const CHROME = '/opt/meta-chromium/chrome';
const mode = process.argv[2];

let msgId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function send(ws: WebSocket, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
    }, 25000);
  });
}

async function launch(url: string, waitMs: number) {
  const PORT = 9333 + Math.floor(Math.random() * 4000);
  const profile = `/tmp/chrome-cdp-${PORT}-${Date.now()}`;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--window-size=800,480',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let targets: { id: string; type: string }[] = [];
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = (await res.json()) as typeof targets;
      if (targets.some(t => t.type === 'page')) break;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  const wsUrl = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    .then(r => r.json())
    .then((j: { webSocketDebuggerUrl: string }) => j.webSocketDebuggerUrl);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('ws connect failed'));
  });
  ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  };
  const page = targets.find(t => t.type === 'page')!;
  const { sessionId: sid } = (await send(ws, 'Target.attachToTarget', {
    targetId: page.id, flatten: true,
  })) as { sessionId: string };
  await send(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 800, height: 480, deviceScaleFactor: 1, mobile: false,
  }, sid);
  await send(ws, 'Page.navigate', { url }, sid);
  await new Promise(r => setTimeout(r, waitMs));
  const done = () => {
    ws.close();
    chrome.kill();
  };
  return { ws, sid, done };
}

async function main() {
  if (mode === 'probe') {
    const [, , , url, expr, waitArg] = process.argv;
    const { ws, sid, done } = await launch(url, Number(waitArg || '22000'));
    const result = (await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true }, sid)) as {
      result: { value?: unknown };
      exceptionDetails?: unknown;
    };
    if (result.exceptionDetails) console.log('EXCEPTION:', JSON.stringify(result.exceptionDetails).slice(0, 400));
    else console.log(JSON.stringify(result.result.value)?.slice(0, 3000));
    done();
  } else if (mode === 'shot' || mode === 'click') {
    const [, , , url, out, waitArg, ...clicks] = process.argv;
    const { ws, sid, done } = await launch(url, Number(waitArg || '22000'));
    for (const c of clicks) {
      const [x, y] = c.split(',').map(Number);
      await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
      await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
      await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
      await new Promise(r => setTimeout(r, 1200));
    }
    const shot = (await send(ws, 'Page.captureScreenshot', { format: 'png' }, sid)) as { data: string };
    await Bun.write(out, Buffer.from(shot.data, 'base64'));
    console.log('saved', out);
    done();
  } else {
    console.error('usage: cdp.ts <probe|shot|click> ...');
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 600));
  process.exit(0);
}

main().catch(e => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
