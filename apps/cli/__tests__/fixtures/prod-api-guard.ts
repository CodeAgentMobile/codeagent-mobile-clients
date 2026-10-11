// __tests__/fixtures/prod-api-guard.ts
//
// Global vitest setup file (vitest.config.ts `setupFiles`): fails any test
// that lets a `fetch` reach a real (non-loopback) host.
//
// ⚠️ WHY. Specs boot real code paths with fake sessions (`sess-1` /
// `plugin-1`). Every best-effort call those paths made without a mock went to
// `https://api.codeagent-mobile.com` from every local and CI run: ~1.5k prod
// 401s/day on /api/commands/send, scratch, baton state, credits and
// project-env (codeagent-1rhl), and 855 of the 870 prod 401s on the manifest
// refresh (codeagent-d5an). The calls swallow errors, so no test noticed, and
// they hid the real prod 401 ratio.
//
// The original `fetch` is wrapped once per test file, not spied, so a spec's
// own `vi.spyOn(globalThis, 'fetch')` / `vi.stubGlobal('fetch', …)` layers on
// top and restores back to this guard. A blocked request answers 503, so
// best-effort callers take their offline path, and the test that sent it
// fails. Loopback stays open for specs that run an in-test HTTP server.
// Default imports: the CommonJS module objects. The `* as` namespace of a
// builtin is read-only; `syncBuiltinESMExports` propagates these writes to it.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { afterAll, afterEach, expect } from 'vitest';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isRealHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !LOOPBACK_HOSTS.has(parsed.hostname) && !parsed.hostname.endsWith('.localhost');
}

const realFetch = globalThis.fetch;
const hits: string[] = [];

globalThis.fetch = async function guardedFetch(input, init) {
  const url = urlOf(input);
  if (isRealHost(url)) {
    hits.push(url);
    return new Response('{}', { status: 503 });
  }
  return realFetch(input, init);
} as typeof fetch;

// The same guard for node:http / node:https. Most CLI transports
// (`pairing.service` `_postJsonAuthed`, the file-watcher and streaming
// transports, the chunk emitter, the command relay) never touch `fetch`, so
// the fetch guard alone let `project-env/push|pull`, `beads/team-memories` and
// the manifest refresh keep reaching prod from every CI run (codeagent-fndr
// audit, 2026-10-11: ~2.3k prod 401s in a week, all `sess-1`/`s1` fixtures).
// The request is created and destroyed before it is sent, so callers take
// their error path exactly as they would offline.
type RequestFn = typeof https.request;

/** The request's target as a URL string, or null when it cannot be read. */
function targetOfRequestArgs(args: unknown[], scheme: 'http' | 'https'): string | null {
  const [first, second] = args;
  if (typeof first === 'string' || first instanceof URL) return String(first);
  const opts = (first ?? second) as
    { hostname?: string | null; host?: string | null; path?: string | null } | undefined;
  const host = (opts?.hostname ?? opts?.host ?? 'localhost').replace(/:\d+$/, '');
  return `${scheme}://${host}${opts?.path ?? ''}`;
}

function guardRequest(mod: typeof http | typeof https, scheme: 'http' | 'https'): void {
  const realRequest = mod.request.bind(mod) as RequestFn;
  const guarded = ((...args: Parameters<RequestFn>) => {
    const target = targetOfRequestArgs(args, scheme);
    const req = realRequest(...args);
    if (target && isRealHost(target)) {
      hits.push(target);
      req.destroy(new Error(`prod-api-guard: blocked request to ${target}`));
    }
    return req;
  }) as RequestFn;
  mod.request = guarded;
  mod.get = ((...args: Parameters<RequestFn>) => {
    const req = guarded(...args);
    req.end();
    return req;
  }) as typeof mod.get;
}

guardRequest(http, 'http');
guardRequest(https, 'https');
syncBuiltinESMExports();

afterEach(() => {
  const sent = hits.splice(0);
  expect(
    sent,
    `this test sent requests to a real host; mock the HTTP layer: ${sent.join(', ')}`,
  ).toEqual([]);
});

// Catches fire-and-forget calls that land after the last test of the file.
afterAll(() => {
  const sent = hits.splice(0);
  expect(
    sent,
    `requests to a real host after the last test; mock the HTTP layer: ${sent.join(', ')}`,
  ).toEqual([]);
});
