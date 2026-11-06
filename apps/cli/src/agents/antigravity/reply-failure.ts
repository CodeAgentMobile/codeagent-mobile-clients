/**
 * Classify an Antigravity (`agy acp`) turn that "completed" with agy's failure
 * banner (codeagent-6bg9).
 *
 * agy never reports a provider failure as a JSON-RPC error. Captured live on a
 * CodeAgent Box (agy 1.5.2, GEMINI_API_KEY = an invalid key, 2026-11-06): the
 * ONLY thing streamed is the agent_message_chunk
 * `⚠ Agent execution terminated due to error.` and `session/prompt` resolves
 * `{"stopReason":"end_turn"}` — nothing on stderr, no cause in the reply. The
 * cause lives only in agy's own log,
 * `~/.gemini/antigravity-cli/log/acp-server-<YYYYMMDD_HHMMSS>-<pid>.log`:
 *
 *   E1106 18:16:15.662983 233 errorreport.go:247] agent executor error: generating and
 *   executing: Error 400, Message: API key not valid. Please pass a valid API key.,
 *   Status: INVALID_ARGUMENT, Details: [... reason:API_KEY_INVALID ...]
 *
 * So on a banner reply we read the TAIL of the newest acp-server log under the
 * agy process's HOME (sync, bounded, only on a failed turn) and decide auth vs
 * generic from the error entries written since the turn started.
 *
 * A missing or expired-and-unrefreshable credential fails EARLIER, at
 * `session/new` (`-32000 Authentication required`), on the existing startup
 * path — this only matters for a credential that goes bad mid-session.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../../services/logger';

/** agy's own banner for a turn its provider call failed. */
const AGY_TERMINATED_RE = /Agent execution terminated due to error/i;
/**
 * agy's notice is the banner (plus, possibly in a future agy, the provider's
 * message). The bound keeps a substantive reply that merely QUOTES the banner
 * from being classified; the required banner keeps a reply that merely
 * discusses an API-key error from matching.
 */
const AGY_ERROR_REPLY_MAX = 1000;
/** Google credential failures, as agy logs them (or might one day stream them). */
const AUTH_CAUSE_RE = new RegExp(
  [
    'API_KEY_INVALID',
    'API key not valid',
    'API key expired',
    '\\bUNAUTHENTICATED\\b',
    'invalid authentication credentials',
    '(?:Error|code|status)[:\\s]*401\\b',
    '\\binvalid_grant\\b',
    'Token has been expired or revoked',
    // PERMISSION_DENIED is auth only with a credential reason (a blocked or
    // unregistered key, an under-scoped token) — not e.g. a disabled API.
    'PERMISSION_DENIED[^\\n]{0,400}?(?:API_KEY_\\w+|ACCESS_TOKEN_\\w+|CREDENTIALS_MISSING|CONSUMER_INVALID|unregistered callers)',
  ].join('|'),
  'i',
);

/** Bytes of the log tail inspected — the failing turn's entries are at the end. */
export const AGY_LOG_TAIL_BYTES = 16 * 1024;
/** Clock slack between the turn start (our clock) and agy's log timestamps. */
const SINCE_SLACK_MS = 2_000;
/** glog prefix: `E1106 18:16:15.662983 …` — severity, MMDD, local time. */
const GLOG_PREFIX_RE = /^([IWEF])(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s/;

export function antigravityLogDir(home: string): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'log');
}

function newestAcpServerLog(home: string): string | null {
  const dir = antigravityLogDir(home);
  let best: { file: string; mtime: number } | null = null;
  for (const name of fs.readdirSync(dir)) {
    if (!/^acp-server-.*\.log$/.test(name)) continue;
    const file = path.join(dir, name);
    const mtime = fs.statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file ?? null;
}

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** glog timestamps carry no year: take the current one, or last year when that lands in the future. */
function glogTime(m: RegExpExecArray, now: number): number {
  const year = new Date(now).getFullYear();
  const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3));
  const at = (y: number): number =>
    new Date(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms).getTime();
  const t = at(year);
  return t > now + 86_400_000 ? at(year - 1) : t;
}

/**
 * The ERROR/FATAL entries (with their continuation lines) in `tail`, keeping
 * only those stamped at/after `since` when given. A line before the first
 * parseable prefix (the cut at the tail's start) belongs to an unknown entry
 * and is dropped.
 */
export function recentErrorEntries(tail: string, since: number | undefined, now = Date.now()): string[] {
  const out: string[] = [];
  let keep = false;
  for (const line of tail.split('\n')) {
    const m = GLOG_PREFIX_RE.exec(line);
    if (m) {
      const severe = m[1] === 'E' || m[1] === 'F';
      keep = severe && (since === undefined || glogTime(m, now) >= since - SINCE_SLACK_MS);
      if (keep) out.push(line);
    } else if (keep && out.length > 0) {
      out[out.length - 1] += `\n${line}`;
    }
  }
  return out;
}

/** Mask credential-shaped tokens (Google API keys, OAuth access/refresh tokens). */
export function redactCredentials(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza…[redacted]')
    .replace(/ya29\.[0-9A-Za-z._-]+/g, 'ya29.…[redacted]')
    .replace(/1\/\/[0-9A-Za-z._-]{10,}/g, '1//…[redacted]');
}

/** The newest agy error entry since the turn started that names a credential failure. */
function authCauseFromLog(home: string, since: number | undefined): string | null {
  try {
    const file = newestAcpServerLog(home);
    if (!file) return null;
    const entries = recentErrorEntries(readTail(file, AGY_LOG_TAIL_BYTES), since);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (AUTH_CAUSE_RE.test(entries[i])) return entries[i];
    }
    return null;
  } catch {
    // No log dir / unreadable → we can't tell; fall back to the generic frame.
    return null;
  }
}

export interface AntigravityReplyContext {
  /** Epoch ms the failing turn's prompt was sent — scopes the log scan. */
  turnStartedAt?: number;
  /** Env the agy process runs with (its HOME locates the log). */
  env?: NodeJS.ProcessEnv;
}

/**
 * `'auth_failed'` → re-auth bubble + reportCredentialInvalid; `'agent_error'`
 * → the honest generic failure frame; `null` → a real reply.
 */
export function classifyAntigravityReply(
  finalText: string,
  ctx: AntigravityReplyContext = {},
): 'auth_failed' | 'agent_error' | null {
  const t = finalText.trim();
  if (t.length === 0 || t.length > AGY_ERROR_REPLY_MAX) return null;
  if (!AGY_TERMINATED_RE.test(t)) return null;
  // Cheap first check: the cause in the reply itself.
  if (AUTH_CAUSE_RE.test(t)) return 'auth_failed';
  const home = ctx.env?.HOME || os.homedir();
  const cause = authCauseFromLog(home, ctx.turnStartedAt);
  if (!cause) return 'agent_error';
  log.info(
    'acpRunner',
    `antigravity: credential failure in agy log — ${redactCredentials(cause).slice(0, 300)}`,
  );
  return 'auth_failed';
}
