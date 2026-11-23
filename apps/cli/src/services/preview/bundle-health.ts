import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Does the app actually BUILD? A dev server can answer `/` with 200 while the app's own code
 * can't be bundled: Metro serves the HTML shell and then answers the bundle with a 500
 * ("Unable to resolve module expo-clipboard", owner's codespace 2026-11-23), and the Preview
 * showed a white page with nothing in the panel. This asks for the page the way a browser does,
 * then for its entry script (Metro's `*.bundle`, Vite's module entry), and returns the build
 * error's own text when there is one.
 */

export type BundleHealth =
  | { ok: true }
  | { ok: false; status: number | null; error: string }
  | { ok: 'unknown'; reason: string };

/** The app's entry script in a served HTML page: Metro's bundle, else Vite's module entry. */
export function entryScriptOf(html: string): string | null {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((m) => ({
    src: m[1],
    tag: m[0],
  }));
  const bundle = scripts.find((s) => /\.bundle(?:\?|$)/.test(s.src));
  if (bundle) return bundle.src;
  const mod = scripts.find((s) => /type=["']module["']/i.test(s.tag) && !s.src.includes('/@vite/client'));
  return mod ? mod.src : null;
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The readable error in a failed bundle response: Metro's JSON `message`, else the text. */
export function bundleErrorText(body: string): string {
  let text = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; type?: unknown };
    if (typeof parsed.message === 'string') text = parsed.message;
  } catch {
    /* not JSON: plain text / HTML */
  }
  return text.replace(ANSI_RE, '').replace(/<[^>]+>/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1_500);
}

async function get(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string } | 'timeout' | 'error'> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
    return { status: res.status, body: await res.text() };
  } catch {
    return ac.signal.aborted ? 'timeout' : 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Page, then its entry script, on the local dev server. A first Metro build of a big app takes a
 * while, so the bundle gets `bundleTimeoutMs`; running out of time is `unknown`, never a failure.
 */
export async function checkAppBundle(
  port: number,
  opts: { bundleTimeoutMs?: number; host?: string } = {},
): Promise<BundleHealth> {
  const origin = `http://${opts.host ?? '127.0.0.1'}:${port}`;
  const page = await get(`${origin}/`, 30_000, { Accept: 'text/html' });
  if (page === 'timeout' || page === 'error') return { ok: 'unknown', reason: `page ${page}` };
  if (page.status >= 500) return { ok: false, status: page.status, error: bundleErrorText(page.body) };
  const entry = entryScriptOf(page.body);
  if (!entry) return { ok: 'unknown', reason: 'no entry script in the page' };
  const url = new URL(entry, `${origin}/`);
  if (url.origin !== origin) return { ok: 'unknown', reason: 'entry script on another origin' };
  const bundle = await get(url.toString(), opts.bundleTimeoutMs ?? 240_000);
  if (bundle === 'timeout' || bundle === 'error') return { ok: 'unknown', reason: `bundle ${bundle}` };
  if (bundle.status >= 400) {
    return { ok: false, status: bundle.status, error: bundleErrorText(bundle.body) };
  }
  return { ok: true };
}

/**
 * Keep the preview's runtime files out of the user's `git status` (the change card counted 21
 * files / +8788 lines of `.wrangler/` + `.codeam/`). Written to `.git/info/exclude` — never the
 * user's `.gitignore` — and only once. A committed `.codeam/preview.json` stays visible (git never
 * excludes a tracked file).
 */
export const GIT_EXCLUDE_LINES = [
  '# CodeAgent preview runtime files',
  '/.wrangler/',
  // The whole folder: git never hides a TRACKED file, so a committed .codeam/preview.json stays
  // visible anyway, and the one we write ourselves (the detection cache) is ours, not a change.
  '/.codeam/',
];

export function addPreviewGitExcludes(excludeFile: string): boolean {
  let current = '';
  try {
    current = fs.readFileSync(excludeFile, 'utf8');
  } catch {
    /* no exclude file yet */
  }
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = GIT_EXCLUDE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0 || (missing.length === 1 && missing[0].startsWith('#'))) return false;
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(excludeFile, `${sep}${missing.join('\n')}\n`);
  return true;
}

/** `git rev-parse --git-path info/exclude` for `cwd`; null outside a git repo. */
export function gitExcludePath(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, timeout: 5_000 }, (err, out) => {
      if (err) return resolve(null);
      const p = out.trim();
      resolve(p ? path.resolve(cwd, p) : null);
    });
  });
}
