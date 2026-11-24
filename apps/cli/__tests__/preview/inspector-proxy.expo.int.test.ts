import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { startInspectorProxy, type InspectorProxy } from '../../src/services/preview/inspector-proxy';
import {
  devRequestHeaders,
  startAppServerProxy,
  type AppServerProxy,
} from '../../src/services/preview/app-server-proxy';

/**
 * Point mode had no hover highlight on an Expo preview (owner 2026-11-23): the Expo bring-up never
 * put the inspector in front of Metro, so the dashboard fell back to drawing boxes. Now the WEB
 * build gets it like any Vite app. These run the real chain against a Metro stand-in that refuses,
 * like Expo's dev middleware, any Origin that isn't its own host (the 2026-11-23 icon-font 500).
 */

const SCRIPT = '<script id="codeam-inspector"></script>';
const PUBLIC_HOST = 'preview-x.codeagent-mobile.com';

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});

async function fakeMetro(): Promise<number> {
  const server = http.createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    const origin = req.headers.origin;
    if (origin && origin !== `http://localhost:${port}`) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('origin refused');
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>app</title></head><body><div id="root"></div></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'font/ttf' });
    res.end('font');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

function get(
  port: number,
  path: string,
  headers: http.OutgoingHttpHeaders,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host: PUBLIC_HOST, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const page = { accept: 'text/html', 'sec-fetch-dest': 'iframe' };
const font = { origin: `https://${PUBLIC_HOST}`, 'sec-fetch-dest': 'font' };

async function inspector(targetPort: number): Promise<InspectorProxy> {
  const p = await startInspectorProxy({ targetPort, script: SCRIPT, upstreamHeaders: devRequestHeaders });
  closers.push(() => p.close());
  return p;
}

describe('the Expo web preview behind the inspector', () => {
  it('tunnel → inspector → Metro: the page gets the picker, same-origin assets still load', async () => {
    const metro = await fakeMetro();
    const insp = await inspector(metro);
    expect((await get(insp.port, '/', page)).body).toContain(SCRIPT);
    expect(await get(insp.port, '/assets/?unstable_path=Feather.ttf', font)).toEqual({ status: 200, body: 'font' });
  });

  it('tunnel → inspector → app-server proxy → Metro (a Remix MOBILE app with a server)', async () => {
    const metro = await fakeMetro();
    const app: AppServerProxy = await startAppServerProxy({
      devPort: metro,
      serverPort: 1, // never reached: no server path below
      injectBase: true,
      routeRoot: false,
    });
    closers.push(() => app.close());
    const insp = await inspector(app.port);
    expect((await get(insp.port, '/', page)).body).toContain(SCRIPT);
    expect(await get(insp.port, '/assets/?unstable_path=Feather.ttf', font)).toEqual({ status: 200, body: 'font' });
  });

  it('without the Origin rewrite Metro refuses the fonts — why Expo passes devRequestHeaders', async () => {
    const metro = await fakeMetro();
    const plain = await startInspectorProxy({ targetPort: metro, script: SCRIPT });
    closers.push(() => plain.close());
    expect((await get(plain.port, '/assets/?unstable_path=Feather.ttf', font)).status).toBe(500);
  });
});
