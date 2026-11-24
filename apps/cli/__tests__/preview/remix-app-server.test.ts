/**
 * A Remix project's own server in the console Preview (owner 2026-11-23): the same bindings the
 * platform gives it (D1 as DB, ROOMS, env), and the same `<origin>/_v/<id>/` base the player hands
 * the app — served on the preview's own origin by the app-server proxy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  devArgs,
  migrationFiles,
  migrationsApplyArgs,
  readRemixServer,
  remixServerPaths,
  wranglerBinary,
  wranglerConfigFor,
  wranglerVersionFor,
  writeWranglerConfig,
  REMIX_SERVER_COMPATIBILITY_DATE,
} from '../../src/services/preview/remix-app-server';
import {
  devRequestHeaders,
  isBundleRequest,
  publicOriginOf,
  routeFor,
  serverBasePrelude,
  serverRequestHeaders,
  startAppServerProxy,
} from '../../src/services/preview/app-server-proxy';

let dir: string;
const write = (rel: string, content: unknown): void => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'remix-server-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readRemixServer', () => {
  it('reads remix.json "server" + "env" when server/index.ts exists', () => {
    write('remix.json', {
      kind: 'MOBILE',
      server: { db: true, rooms: true },
      env: [
        { name: 'STRIPE_SECRET_KEY', secret: true, for: 'cards' },
        { name: 'PUBLIC_URL', secret: false, for: 'links' },
        { name: 'bad name', for: 'x' },
      ],
    });
    write('server/index.ts', 'export default {}');
    expect(readRemixServer(dir)).toEqual({
      db: true,
      rooms: true,
      env: [
        { name: 'STRIPE_SECRET_KEY', secret: true },
        { name: 'PUBLIC_URL', secret: false },
      ],
    });
  });
  it('null without a server declaration, or without server/index.ts', () => {
    write('remix.json', { kind: 'MOBILE' });
    write('server/index.ts', 'x');
    expect(readRemixServer(dir)).toBeNull();
    write('remix.json', { kind: 'MOBILE', server: { db: true } });
    rmSync(path.join(dir, 'server'), { recursive: true });
    expect(readRemixServer(dir)).toBeNull();
  });
});

describe('wrangler config — the platform bindings (remix-cloudflare.ts)', () => {
  it('D1 as DB with the project migrations, ROOMS + rooms-v1, compat date + nodejs_compat', () => {
    expect(wranglerConfigFor({ db: true, rooms: true, env: [] }, { PUBLIC_URL: 'https://x' })).toEqual({
      name: 'remix-local',
      main: '../../server/index.ts',
      compatibility_date: REMIX_SERVER_COMPATIBILITY_DATE,
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        { binding: 'DB', database_name: 'remix-local', database_id: 'remix-local', migrations_dir: '../../server/migrations' },
      ],
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
      migrations: [{ tag: 'rooms-v1', new_sqlite_classes: ['Room'] }],
      vars: { PUBLIC_URL: 'https://x' },
    });
  });
  it('no db / rooms / vars → none of their keys', () => {
    expect(Object.keys(wranglerConfigFor({ db: false, rooms: false, env: [] })).sort()).toEqual(
      ['compatibility_date', 'compatibility_flags', 'main', 'name'].sort(),
    );
  });
  it('writes plain values into vars and secrets into a 0600 .dev.vars, from the project .env', () => {
    write('.env', 'STRIPE_SECRET_KEY=sk_test_1\nPUBLIC_URL=https://x\nOTHER=1\n');
    const { missing } = writeWranglerConfig(dir, {
      db: true,
      rooms: false,
      env: [
        { name: 'STRIPE_SECRET_KEY', secret: true },
        { name: 'PUBLIC_URL', secret: false },
        { name: 'UNSET_ONE', secret: true },
      ],
    });
    expect(missing).toEqual(['UNSET_ONE']);
    const p = remixServerPaths(dir);
    const config = JSON.parse(readFileSync(p.config, 'utf8')) as { vars?: Record<string, string> };
    expect(config.vars).toEqual({ PUBLIC_URL: 'https://x' });
    expect(readFileSync(p.config, 'utf8')).not.toContain('sk_test_1');
    expect(readFileSync(p.devVars, 'utf8')).toBe('STRIPE_SECRET_KEY="sk_test_1"\n');
    if (process.platform !== 'win32') expect(statSync(p.devVars).mode & 0o777).toBe(0o600);
  });
  it('migrations in file-name order; persisted state under .wrangler/state; loopback dev', () => {
    write('server/migrations/0002_b.sql', '');
    write('server/migrations/0001_a.sql', '');
    write('server/migrations/notes.md', '');
    expect(migrationFiles(dir)).toEqual(['0001_a.sql', '0002_b.sql']);
    const p = remixServerPaths(dir);
    expect(p.state).toBe(path.join(dir, '.wrangler', 'state'));
    expect(migrationsApplyArgs(dir)).toEqual(['d1', 'migrations', 'apply', 'DB', '--local', '--config', p.config, '--persist-to', p.state]);
    const args = devArgs(dir, 4321, 4322);
    expect(args.slice(0, 7)).toEqual(['dev', '--config', p.config, '--ip', '127.0.0.1', '--port', '4321']);
    expect(args).toContain(p.state);
  });
  it('wrangler: the project one, else a pinned install by Node major', () => {
    expect(wranglerVersionFor('22.3.0')).toBe('4.158.0');
    expect(wranglerVersionFor('20.18.0')).toBe('4.85.0');
    const home = path.join(dir, 'home');
    const tool = wranglerBinary(dir, home, '4.158.0');
    expect(tool.installPrefix).toBe(path.join(home, '.codeam', 'tools', 'wrangler-4.158.0'));
    write('node_modules/.bin/wrangler', '#!/bin/sh');
    expect(wranglerBinary(dir, home)).toEqual({ bin: path.join(dir, 'node_modules', '.bin', 'wrangler'), installPrefix: null });
  });
});

describe('app-server proxy — routing like the platform Worker (dispatch.ts)', () => {
  it('routes /_v/local/<server path> to the server with the prefix stripped', () => {
    expect(routeFor('/_v/local/api/items?x=1', false)).toEqual({ to: 'server', path: '/api/items?x=1' });
    expect(routeFor('/_v/local/auth/login', false)).toEqual({ to: 'server', path: '/auth/login' });
    expect(routeFor('/_v/local/api/_db/x', false)).toEqual({ to: 'dev' }); // the platform's own data API
    expect(routeFor('/_v/local/index.html', false)).toEqual({ to: 'dev' });
    expect(routeFor('/api/items', false)).toEqual({ to: 'dev' }); // phone apps call through the base
    expect(routeFor('/api/items', true)).toEqual({ to: 'server', path: '/api/items' }); // web: relative
    expect(routeFor('/index.bundle?platform=web', true)).toEqual({ to: 'dev' });
  });
  it('recognises Metro bundles and the public origin', () => {
    expect(isBundleRequest('/index.bundle?platform=ios&dev=true')).toBe(true);
    expect(isBundleRequest('/node_modules/expo/AppEntry.bundle')).toBe(true);
    expect(isBundleRequest('/index.bundle.map?x')).toBe(false);
    expect(publicOriginOf({ host: 'abc.trycloudflare.com' })).toBe('https://abc.trycloudflare.com');
    expect(publicOriginOf({ host: 'localhost:9000', 'x-forwarded-host': 'p.example.com' })).toBe('https://p.example.com');
    expect(publicOriginOf({ host: '127.0.0.1:9000' })).toBe('http://127.0.0.1:9000');
    expect(serverBasePrelude('https://abc.trycloudflare.com')).toBe(
      'globalThis.__REMIX_SERVER_BASE__="https://abc.trycloudflare.com/_v/local/";',
    );
  });
  it("sets the platform's identity headers and drops a client's forged ones", () => {
    const h = serverRequestHeaders({ host: 'x', 'x-remix-app': 'forged', accept: 'a' }, 9, 'https://x');
    expect(h).toMatchObject({
      host: '127.0.0.1:9',
      accept: 'a',
      'x-remix-app': 'local',
      'x-remix-version': 'local',
      'x-remix-env': 'dev',
      'x-remix-origin': 'https://x',
    });
  });
});

describe('app-server proxy — the dev server sees a same-origin request as its own', () => {
  it("rewrites a same-origin Origin to the dev server's (Expo 500s a foreign one: the icon fonts)", () => {
    const h = devRequestHeaders(
      { host: 'p.example.com', origin: 'https://p.example.com', 'sec-fetch-dest': 'font' },
      8081,
    );
    expect(h).toMatchObject({ host: 'localhost:8081', origin: 'http://localhost:8081' });
  });
  it('leaves a cross-origin Origin alone, and adds none when there was none', () => {
    expect(devRequestHeaders({ host: 'p.example.com', origin: 'https://evil.example' }, 8081).origin).toBe(
      'https://evil.example',
    );
    expect(devRequestHeaders({ host: 'p.example.com' }, 8081).origin).toBeUndefined();
  });
  it('rewrites the loopback Origin a proxy in front already set for this hop (Expo inspector)', () => {
    const h = devRequestHeaders(
      { host: 'localhost:5001', origin: 'http://localhost:5001', 'x-forwarded-host': 'p.example.com' },
      8081,
    );
    expect(h).toMatchObject({ host: 'localhost:8081', origin: 'http://localhost:8081' });
  });
});

describe('app-server proxy — live', () => {
  const listen = (handler: http.RequestListener): Promise<http.Server> =>
    new Promise((resolve) => {
      const s = http.createServer(handler);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
  const portOf = (s: http.Server): number => (s.address() as AddressInfo).port;

  it('serves the server on the same origin and prepends the base to JS bundles only', async () => {
    const seen: string[] = [];
    const appServer = await listen((req, res) => {
      seen.push(`${req.method} ${req.url} app=${req.headers['x-remix-app']}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const devOrigins: (string | undefined)[] = [];
    const dev = await listen((req, res) => {
      devOrigins.push(req.headers.origin);
      if (req.url?.startsWith('/index.bundle')) {
        res.writeHead(200, { 'content-type': 'application/javascript', 'content-length': '7' });
        res.end('var a=1');
      } else if (req.url?.startsWith('/hbc.bundle')) {
        res.writeHead(200, { 'content-type': 'application/x-metro-bytecode-bundle' });
        res.end('BYTES');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
      }
    });
    const proxy = await startAppServerProxy({
      devPort: portOf(dev),
      serverPort: portOf(appServer),
      injectBase: true,
      routeRoot: false,
    });
    try {
      const base = `http://127.0.0.1:${proxy.port}`;
      const api = await fetch(`${base}/_v/local/api/health`, { headers: { 'X-Remix-App': 'forged' } });
      expect(await api.json()).toEqual({ ok: true });
      expect(seen).toEqual(['GET /api/health app=local']);
      const bundle = await (await fetch(`${base}/index.bundle?platform=web`)).text();
      expect(bundle).toBe(`globalThis.__REMIX_SERVER_BASE__="${base}/_v/local/";var a=1`);
      expect(await (await fetch(`${base}/hbc.bundle?platform=ios`)).text()).toBe('BYTES');
      expect(await (await fetch(`${base}/`)).text()).toBe('<html></html>');
      // A same-origin font request reaches the dev server with its own origin.
      await fetch(`${base}/assets/?unstable_path=Feather.ttf`, { headers: { Origin: base } });
      expect(devOrigins.at(-1)).toBe(`http://localhost:${portOf(dev)}`);
    } finally {
      await proxy.close();
      appServer.close();
      dev.close();
    }
  });
});
