import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { publicLocation, upstreamRequestHeaders } from './inspector-proxy';
import { LOCAL_SERVER_PREFIX, LOCAL_VERSION_ID, REMIX_SERVER_PATH_RE } from './remix-app-server';

/**
 * Puts a Remix app's own server (`wrangler dev`, see `remix-app-server.ts`) behind the preview's
 * OWN origin, the way the platform Worker does (remix-worker `dispatch.ts`):
 *
 *     cloudflared ──► :PROXY ──┬─► /_v/local/api/… (and the other server paths) ──► wrangler /api/…
 *                              └─► everything else ──────────────────────────────► the dev server
 *
 * Same origin as the page, so no CORS and no second tunnel. The forwarded request carries the
 * platform's identity headers (`X-Remix-App/-Version/-Env/-Origin`), set here so a client can't
 * forge them — exactly as on Remix.
 *
 * A PHONE app finds its server at `globalThis.__REMIX_SERVER_BASE__` (the Remix player's prelude
 * sets it to `<origin>/_v/<id>/`). Metro serves the app as `*.bundle` JS (web and Expo Go alike),
 * so with `injectBase` the proxy PREPENDS that one assignment to every bundle response: it runs
 * before any module of the app, the app's code is never edited, and the base is the public origin
 * the request came in on (the tunnel host). A WEB app calls `api/…` relative to its page, so its
 * server paths are also routed at the root (`routeRoot`).
 *
 * Transparent otherwise: other responses are piped byte for byte, websockets (Metro / Vite HMR)
 * are tunnelled raw — to the server when the path is a server path (`/ws`), else to the dev server.
 */

export interface AppServerProxyOptions {
  /** The dev server (Metro / Vite). */
  devPort: number;
  devHost?: string;
  /** `wrangler dev`. */
  serverPort: number;
  /** Prepend `__REMIX_SERVER_BASE__` to Metro bundles (phone apps). */
  injectBase: boolean;
  /** Also route the server paths at the root (`/api/…`), for a web app's relative calls. */
  routeRoot: boolean;
}

export interface AppServerProxy {
  readonly port: number;
  close(): Promise<void>;
}

/** Where a request goes: the app's server (with the path it sees) or the dev server. */
export function routeFor(
  url: string,
  routeRoot: boolean,
): { to: 'server'; path: string } | { to: 'dev' } {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  const search = q === -1 ? '' : url.slice(q);
  if (pathname.startsWith(`${LOCAL_SERVER_PREFIX}/`)) {
    const rel = pathname.slice(LOCAL_SERVER_PREFIX.length);
    if (REMIX_SERVER_PATH_RE.test(rel)) return { to: 'server', path: rel + search };
  }
  if (routeRoot && REMIX_SERVER_PATH_RE.test(pathname)) return { to: 'server', path: pathname + search };
  return { to: 'dev' };
}

/** A Metro bundle request (`/index.bundle?platform=web…`, `/node_modules/expo/AppEntry.bundle?…`). */
export function isBundleRequest(url: string): boolean {
  const q = url.indexOf('?');
  return /\.bundle$/.test(q === -1 ? url : url.slice(0, q));
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The public origin a request came in on: the tunnel's host over https, a loopback host over http. */
export function publicOriginOf(headers: http.IncomingHttpHeaders): string {
  const host = one(headers['x-forwarded-host']) ?? one(headers.host) ?? 'localhost';
  const loopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const proto = one(headers['x-forwarded-proto']) ?? (loopback ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** The statement prepended to a bundle: the player's `__REMIX_SERVER_BASE__`, for this origin. */
export function serverBasePrelude(origin: string): string {
  return `globalThis.__REMIX_SERVER_BASE__=${JSON.stringify(`${origin}${LOCAL_SERVER_PREFIX}/`)};`;
}

/** The headers the server receives: the platform Worker's identity headers, never the client's. */
export function serverRequestHeaders(
  headers: http.IncomingHttpHeaders,
  serverPort: number,
  origin: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers, host: `127.0.0.1:${serverPort}` };
  for (const k of Object.keys(out)) if (/^x-remix-/i.test(k)) delete out[k];
  out['x-remix-app'] = LOCAL_VERSION_ID;
  out['x-remix-version'] = LOCAL_VERSION_ID;
  out['x-remix-env'] = 'dev';
  out['x-remix-origin'] = origin;
  return out;
}

/**
 * The dev server's headers for a request the proxy forwards to it. Host becomes the dev server's
 * own (as the inspector proxy does), and a SAME-ORIGIN request's `Origin` follows it: Expo's dev
 * middleware refuses an origin that is not its own host with a 500 (`default-src 'none'`), so the
 * icon fonts (`/assets/?unstable_path=…Feather.ttf`, fetched by the browser with `Origin`) failed
 * on the owner's codespace while curl, which sends none, got them (2026-11-23). A cross-origin
 * `Origin` is left alone.
 */
export function devRequestHeaders(
  headers: http.IncomingHttpHeaders,
  devPort: number,
): http.OutgoingHttpHeaders {
  const out = upstreamRequestHeaders(headers, devPort);
  const origin = one(headers.origin);
  if (origin && origin === publicOriginOf(headers)) out.origin = `http://localhost:${devPort}`;
  return out;
}

export async function startAppServerProxy(opts: AppServerProxyOptions): Promise<AppServerProxy> {
  const devHost = opts.devHost ?? '127.0.0.1';
  const upgraded = new Set<import('stream').Duplex>();

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const route = routeFor(url, opts.routeRoot);
    const origin = publicOriginOf(req.headers);
    const toServer = route.to === 'server';
    const inject = !toServer && opts.injectBase && isBundleRequest(url);
    const headers = toServer
      ? serverRequestHeaders(req.headers, opts.serverPort, origin)
      : devRequestHeaders(req.headers, opts.devPort);
    // Can't prepend into compressed bytes: bundles come uncompressed through the proxy.
    if (inject) delete headers['accept-encoding'];
    const upstream = http.request(
      {
        host: toServer ? '127.0.0.1' : devHost,
        port: toServer ? opts.serverPort : opts.devPort,
        method: req.method,
        path: toServer ? route.path : url,
        headers,
      },
      (originRes) => {
        const outHeaders = { ...originRes.headers };
        if (!toServer) {
          const location = publicLocation(originRes.headers.location, opts.devPort);
          if (location !== undefined) outHeaders.location = location;
        }
        // Only into JS: a Hermes bytecode bundle or an error page is passed through untouched.
        const js = /javascript/i.test(String(originRes.headers['content-type'] ?? ''));
        const prepend = inject && js && (originRes.statusCode ?? 500) < 400;
        if (prepend) delete outHeaders['content-length'];
        res.writeHead(originRes.statusCode ?? 502, outHeaders);
        if (prepend) res.write(serverBasePrelude(origin));
        originRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(toServer ? "the app's server is unreachable" : 'preview origin unreachable');
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, clientSocket, head) => {
    upgraded.add(clientSocket);
    const url = req.url ?? '/';
    const route = routeFor(url, opts.routeRoot);
    const toServer = route.to === 'server';
    const port = toServer ? opts.serverPort : opts.devPort;
    const headers = toServer
      ? serverRequestHeaders(req.headers, opts.serverPort, publicOriginOf(req.headers))
      : devRequestHeaders(req.headers, opts.devPort);
    const upstream = net.connect(port, toServer ? '127.0.0.1' : devHost, () => {
      const lines = [`${req.method} ${toServer ? route.path : url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        for (const value of Array.isArray(v) ? v : [v]) {
          if (value !== undefined) lines.push(`${k}: ${value}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = (): void => {
      upgraded.delete(clientSocket);
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', drop);
    upstream.on('close', drop);
    clientSocket.on('error', drop);
    clientSocket.on('close', drop);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of upgraded) s.destroy();
        upgraded.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
