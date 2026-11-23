import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { parseDotenv } from './dotenv';

/**
 * A Remix project's OWN SERVER, run in the console Preview the way the Remix platform runs it
 * (owner 2026-11-23: "the server must work in the console exactly as on the feed/player").
 *
 * How the platform runs it (codeagent-mobile, api-v2 `remix-server-deploy.ts` +
 * `remix-cloudflare.ts`, remix-worker `dispatch.ts` / `prelude.ts`):
 *   - `server/index.ts` is a Cloudflare Worker (Hono), bundled with the `workerd` conditions and
 *     put in the Remix dispatch namespace with compatibility date `2026-08-01` + `nodejs_compat`;
 *   - remix.json "server"."db" → its own D1 bound as `DB`, migrations `server/migrations/*.sql`
 *     applied in file-name order; "rooms" → the script's `Room` class bound as `ROOMS` (SQLite
 *     Durable Object, migration tag `rooms-v1`); "env" → each name bound as a secret / plain var;
 *   - the platform Worker forwards `<origin>/_v/<versionId>/{api,auth,webhooks,ws,__cron,__check-env}/…`
 *     to the script with the version prefix stripped and `X-Remix-App/-Version/-Env/-Origin`
 *     headers set; a phone app finds it at `globalThis.__REMIX_SERVER_BASE__` = `<origin>/_v/<id>/`.
 *
 * Here: the same script under `wrangler dev` (workerd + a local D1 via miniflare) with a
 * generated config carrying THE SAME bindings, the migrations applied to the local D1 first, its
 * state kept in `<project>/.wrangler/state` (survives restarts). `app-server-proxy.ts` puts it
 * behind the preview's own origin exactly like the platform Worker does.
 */

/** api-v2 `remix-cloudflare.ts` — change both. */
export const REMIX_SERVER_COMPATIBILITY_DATE = '2026-08-01';
export const REMIX_SERVER_COMPATIBILITY_FLAGS = ['nodejs_compat'];
export const REMIX_ROOMS_MIGRATION_TAG = 'rooms-v1';
/** remix-worker `dispatch.ts` SERVER_PATH_RE — the paths the platform forwards to the script. */
export const REMIX_SERVER_PATH_RE = /^\/(?:api(?!\/_db(?:\/|$))|auth|webhooks|ws|__cron|__check-env)(?:\/|$)/;
/** The "version" of a console preview: the base is `<origin>/_v/local/`, like `/_v/<id>/`. */
export const LOCAL_VERSION_ID = 'local';
export const LOCAL_SERVER_PREFIX = `/_v/${LOCAL_VERSION_ID}`;

/**
 * Wrangler, pinned. Node 22 (the Box image) gets a current one; an older Node the last wrangler
 * whose engines accept it (4.85.0: node >=20.3). Both are kept outside the project
 * (`~/.codeam/tools/`): the user's package.json and lockfile are theirs.
 */
export const WRANGLER_VERSION_NODE22 = '4.158.0';
export const WRANGLER_VERSION_NODE20 = '4.85.0';

export interface RemixServerDecl {
  db: boolean;
  rooms: boolean;
  /** The configuration names remix.json "env" declares, split as the platform binds them. */
  env: { name: string; secret: boolean }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** remix.json "server" + `server/index.ts`, or `null` when the project has no server of its own. */
export function readRemixServer(cwd: string): RemixServerDecl | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(cwd, 'remix.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.server)) return null;
  if (!fs.existsSync(path.join(cwd, 'server', 'index.ts'))) return null;
  const env = Array.isArray(raw.env)
    ? raw.env.flatMap((e) =>
        isRecord(e) && typeof e.name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(e.name)
          ? [{ name: e.name, secret: e.secret !== false }]
          : [],
      )
    : [];
  return { db: raw.server.db === true, rooms: raw.server.rooms === true, env };
}

/** Where the generated config, `.dev.vars` and the local state live. */
export function remixServerPaths(cwd: string): { dir: string; config: string; devVars: string; state: string } {
  const dir = path.join(cwd, '.codeam', 'remix-server');
  return {
    dir,
    config: path.join(dir, 'wrangler.json'),
    devVars: path.join(dir, '.dev.vars'),
    state: path.join(cwd, '.wrangler', 'state'),
  };
}

/**
 * The wrangler config with the platform's bindings. Paths are relative to the config's folder
 * (`.codeam/remix-server/`), which is how wrangler resolves them. Plain (non-secret) env values
 * go in `vars`; secrets go in `.dev.vars` (never in this file, never in argv).
 */
export function wranglerConfigFor(
  decl: RemixServerDecl,
  plainVars: Record<string, string> = {},
): Record<string, unknown> {
  return {
    name: 'remix-local',
    main: '../../server/index.ts',
    compatibility_date: REMIX_SERVER_COMPATIBILITY_DATE,
    compatibility_flags: REMIX_SERVER_COMPATIBILITY_FLAGS,
    ...(decl.db
      ? {
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'remix-local',
              database_id: 'remix-local',
              migrations_dir: '../../server/migrations',
            },
          ],
        }
      : {}),
    ...(decl.rooms
      ? {
          durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
          migrations: [{ tag: REMIX_ROOMS_MIGRATION_TAG, new_sqlite_classes: ['Room'] }],
        }
      : {}),
    ...(Object.keys(plainVars).length > 0 ? { vars: plainVars } : {}),
  };
}

/** A `.dev.vars` line: the value JSON-quoted (wrangler reads dotenv syntax). */
function devVarsText(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n');
}

/**
 * Writes the config + `.dev.vars`. The declared env names take their values from the project's
 * `.env` (what the Environment Variables screen edits) — on Remix the owner types them in the
 * app's settings; here they live in the project. A name with no value stays unset, exactly as an
 * unsaved one on the platform. Returns the names left unset.
 */
export function writeWranglerConfig(cwd: string, decl: RemixServerDecl): { missing: string[] } {
  const p = remixServerPaths(cwd);
  let dotenv: Record<string, string> = {};
  try {
    dotenv = Object.fromEntries(
      parseDotenv(fs.readFileSync(path.join(cwd, '.env'), 'utf8')).map((v) => [v.key, v.value]),
    );
  } catch {
    /* no .env: every value unset */
  }
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  const missing: string[] = [];
  for (const e of decl.env) {
    const v = dotenv[e.name];
    if (v === undefined || v === '') missing.push(e.name);
    else (e.secret ? secret : plain)[e.name] = v;
  }
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.config, `${JSON.stringify(wranglerConfigFor(decl, plain), null, 2)}\n`);
  fs.writeFileSync(p.devVars, `${devVarsText(secret)}\n`, { mode: 0o600 });
  fs.chmodSync(p.devVars, 0o600);
  return { missing };
}

/** The migrations wrangler will apply, in order (file names carry the NNNN prefix). */
export function migrationFiles(cwd: string): string[] {
  try {
    return fs
      .readdirSync(path.join(cwd, 'server', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    return [];
  }
}

export function wranglerVersionFor(nodeVersion: string = process.versions.node): string {
  return Number(nodeVersion.split('.')[0]) >= 22 ? WRANGLER_VERSION_NODE22 : WRANGLER_VERSION_NODE20;
}

/** The wrangler binary to run: the project's own when it has one, else our pinned tool install. */
export function wranglerBinary(
  cwd: string,
  home: string = os.homedir(),
  version: string = wranglerVersionFor(),
): { bin: string; installPrefix: string | null } {
  const own = path.join(cwd, 'node_modules', '.bin', 'wrangler');
  if (fs.existsSync(own)) return { bin: own, installPrefix: null };
  const prefix = path.join(home, '.codeam', 'tools', `wrangler-${version}`);
  const bin = path.join(prefix, 'node_modules', '.bin', 'wrangler');
  return { bin, installPrefix: fs.existsSync(bin) ? null : prefix };
}

/** A free loopback port (bind 0, read it, release it). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Env every wrangler call runs with: no telemetry prompt, no update banner. */
export function wranglerEnv(): Record<string, string> {
  return { WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', CI: '1' };
}

/** `wrangler d1 migrations apply DB --local` against the persisted state. */
export function migrationsApplyArgs(cwd: string): string[] {
  const p = remixServerPaths(cwd);
  return ['d1', 'migrations', 'apply', 'DB', '--local', '--config', p.config, '--persist-to', p.state];
}

/** `wrangler dev` on loopback:`port`, local runtime, persisted state. */
export function devArgs(cwd: string, port: number, inspectorPort: number): string[] {
  const p = remixServerPaths(cwd);
  return [
    'dev',
    '--config',
    p.config,
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--persist-to',
    p.state,
    '--show-interactive-dev-session=false',
    '--inspector-port',
    String(inspectorPort),
  ];
}

/** Spawns `wrangler dev` detached (its own group: teardown kills workerd with it). */
export function spawnWranglerDev(
  bin: string,
  cwd: string,
  port: number,
  inspectorPort: number,
): ChildProcess {
  return spawn(bin, devArgs(cwd, port, inspectorPort), {
    cwd,
    env: { ...process.env, ...wranglerEnv() },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
}
