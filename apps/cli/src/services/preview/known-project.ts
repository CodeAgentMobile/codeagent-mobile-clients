import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PreviewDetection } from '@codeam/shared';

/**
 * Projects whose start command is CERTAIN without asking the agent — the
 * Preview's deterministic detection, tried after `.codeam/preview.json` and
 * before the agent's headless one-shot.
 *
 * ⚠️ WHY (2026-11-23): the owner's Remix export "Pasito" (Expo SDK 54 + a
 * `server/` + a root `remix.json`), opened on a Box with Antigravity: the
 * agent's detect one-shot never answered in 120 s, so the Preview failed and the
 * agent ran `npx expo start --web` in its own bash, which the Preview pane never
 * sees. A Remix export is OUR file layout (`remix-export-files.ts` in api-v2):
 * nothing about how to start it needs an LLM, and every agent (including one
 * without `generateOneShot`) gets the same instant answer.
 *
 * Covered:
 *   - a Remix export (root `remix.json`): MOBILE → Expo, WEB/WEB_DATA → Vite;
 *   - a plain single-package Expo app (an `expo` dependency + `app.json` /
 *     `app.config.*`);
 *   - a plain single-package Vite app whose `dev` script is `vite …`.
 * Anything else — monorepos above all — keeps the agent path.
 */

export type KnownProjectKind = 'remix-mobile' | 'remix-web' | 'expo' | 'vite';

export interface KnownProjectDetection {
  kind: KnownProjectKind;
  detection: PreviewDetection;
}

type Pkg = {
  main?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  workspaces?: unknown;
};

type RemixConfig = { kind?: unknown; template?: unknown };

/** The detect prompt's Expo shape, minus `--tunnel` (the Expo bring-up runs OUR tunnel). */
const EXPO_DETECTION: PreviewDetection = {
  framework: 'Expo',
  command: 'npx',
  args: ['expo', 'start'],
  port: 8081,
  ready_pattern: 'Waiting on http|Metro waiting|Logs for your project',
  env: {},
  setup_commands: [],
};

const VITE_PORT = 5173;
const VITE_READY = 'Local:.*http';

/** Monorepo markers: a workspace root needs the agent to pick the app. */
const MONOREPO_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json'];

function readJson<T>(file: string): T | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

function deps(pkg: Pkg): Record<string, unknown> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

function script(pkg: Pkg, name: string): string | null {
  const s = pkg.scripts?.[name];
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}

function isMonorepo(cwd: string, pkg: Pkg): boolean {
  if (pkg.workspaces !== undefined) return true;
  return MONOREPO_FILES.some((f) => fs.existsSync(path.join(cwd, f)));
}

/** An Expo app: an `expo` dependency, or the Remix entry (`main` → a file that calls `registerRootComponent`). */
function isExpoApp(cwd: string, pkg: Pkg): boolean {
  if ('expo' in deps(pkg)) return true;
  if (typeof pkg.main !== 'string') return false;
  try {
    const entry = path.resolve(cwd, pkg.main);
    if (!entry.startsWith(path.resolve(cwd) + path.sep)) return false;
    return /\bregisterRootComponent\s*\(/.test(fs.readFileSync(entry, 'utf8'));
  } catch {
    return false;
  }
}

/** `--port N` / `--port=N` in a script body, else the default. */
function portIn(body: string, fallback: number): number {
  const m = /--port(?:=|\s+)(\d{2,5})\b/.exec(body);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/**
 * Vite from its `dev` script when it is a bare `vite …` call (args after `--`
 * reach Vite: bind every interface so the tunnel reaches it whatever
 * `localhost` resolves to), else the `vite` binary directly. `null` when the
 * project has neither.
 */
function viteDetection(pkg: Pkg): PreviewDetection | null {
  const dev = script(pkg, 'dev');
  if (dev && /^vite(\s|$)/.test(dev)) {
    const extra = /(^|\s)--host\b/.test(dev) ? [] : ['--', '--host', '0.0.0.0'];
    return {
      framework: 'Vite',
      command: 'npm',
      args: ['run', 'dev', ...extra],
      port: portIn(dev, VITE_PORT),
      ready_pattern: VITE_READY,
      env: {},
      setup_commands: [],
    };
  }
  if (dev) return null; // a dev script that isn't plain vite: the agent knows better
  if (!('vite' in deps(pkg))) return null;
  // Remix WEB templates declare only `build: vite build` — no dev script.
  return {
    framework: 'Vite',
    command: 'npx',
    args: ['vite', '--host', '0.0.0.0', '--port', String(VITE_PORT)],
    port: VITE_PORT,
    ready_pattern: VITE_READY,
    env: {},
    setup_commands: [],
  };
}

/**
 * A Remix export. Its own server (`server/`, remix.json "server") is started beside the front by
 * the Preview start itself (`remix-app-server.ts`), so the detection is the front's alone.
 */
function remixDetection(cwd: string, pkg: Pkg, remix: RemixConfig): KnownProjectDetection | null {
  const mobile = remix.kind === 'MOBILE' || remix.template === 'expo-app' || isExpoApp(cwd, pkg);
  if (mobile) return { kind: 'remix-mobile', detection: { ...EXPO_DETECTION } };
  const vite = viteDetection(pkg);
  return vite ? { kind: 'remix-web', detection: vite } : null;
}

/** The deterministic detection for `cwd`, or `null` when the agent should decide. */
export function detectKnownProject(cwd: string): KnownProjectDetection | null {
  const pkg = readJson<Pkg>(path.join(cwd, 'package.json'));
  if (!pkg || isMonorepo(cwd, pkg)) return null;
  const remix = readJson<RemixConfig>(path.join(cwd, 'remix.json'));
  if (remix) return remixDetection(cwd, pkg, remix);
  if ('expo' in deps(pkg)) {
    const hasConfig = ['app.json', 'app.config.js', 'app.config.ts'].some((f) =>
      fs.existsSync(path.join(cwd, f)),
    );
    return hasConfig ? { kind: 'expo', detection: { ...EXPO_DETECTION } } : null;
  }
  // A plain Vite app only when `dev` is unambiguous (`vite …`); no dev script → agent.
  if (!script(pkg, 'dev')) return null;
  const vite = viteDetection(pkg);
  return vite ? { kind: 'vite', detection: vite } : null;
}
