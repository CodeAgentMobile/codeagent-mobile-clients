/**
 * Claude credential lease — the box never rotates Claude's refresh token itself.
 *
 * Claude Code's OAuth refresh token is SINGLE-USE: every refresh spends it and
 * returns a new one. The same lineage lives in the vault and on every box the
 * user runs, so a box whose own Claude refreshes spends a token the vault and
 * the other boxes still hold — the next holder to refresh gets `invalid_grant`
 * and the vault is marked dead (codeagent-3570, 2026-11-24). Two boxes whose
 * tokens expire together race the same way.
 *
 * The fix is one writer: only the server refreshes, under its per-user Redis
 * lock (`AgentCredentialRefreshService`). Before every turn — and on agent
 * activity while a turn runs — this module checks the local
 * `~/.claude/.credentials.json`; when its access token has less than
 * {@link CLAUDE_LEASE_LEAD_MS} left, it asks the server for a credential valid
 * at least that long (`provision-credential` with `minValidityMs`) and writes it
 * to the file. Claude Code refreshes only inside its last 5 minutes and re-reads
 * the file first: it finds a different, unexpired access token and adopts it
 * (`tengu_oauth_token_refresh_race_resolved`) instead of spending its own
 * refresh token.
 *
 * On demand only (repo rule): the trigger is a turn or the agent's own activity,
 * never a timer. An idle box rotates nothing.
 *
 * Cloud sessions only (codespace / self-hosted / Box): there the file was
 * injected from the vault. A LOCAL session's file is the user's own login, which
 * their Claude Code keeps refreshing outside CodeAgent too.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../../services/logger';
import {
  fetchCurrentPluginAuthToken,
  fetchProvisionCredentialDetailed,
} from '../../services/pairing.service';
import { claudeCredentialsPaths } from './local-token';

/** Lease when the local access token has less than this left. Well above
 *  Claude Code's own 5-minute refresh window, so a long tool call between two
 *  agent events still finishes before Claude would refresh. */
export const CLAUDE_LEASE_LEAD_MS = 60 * 60 * 1000;
/** A file with no OAuth login (setup-token, house proxy) is re-checked at most
 *  this often while the agent works. */
const NO_LOGIN_RECHECK_MS = 60 * 1000;

interface ClaudeOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [k: string]: unknown;
}

export interface ClaudeCredentialLeaseOptions {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /** Replayed to re-mint the plugin token when the backend rotated it. */
  pollSecret?: string;
  /** Injectable for tests: returns the leased credential blob, or null. */
  fetchLease?: (minValidityMs: number) => Promise<string | null>;
  /** Injectable for tests. Defaults to Claude's own credential paths. */
  credentialsPaths?: () => string[];
  now?: () => number;
}

export interface ClaudeCredentialLease {
  /** Lease a fresh credential when the local one is inside the lead. Single
   *  flight, never throws. */
  ensureFresh: () => Promise<void>;
  /** Run a turn: lease first, then keep leasing on agent activity until it ends. */
  duringTurn: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Agent activity (an ACP session update). Leases only while a turn runs. */
  onAgentActivity: () => void;
  /** The server said this box holds a spent token: lease now, whatever the expiry. */
  recover: () => Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `{ root, oauth }` of a Claude credentials JSON text, or null. */
function parseOauth(text: string): { root: Record<string, unknown>; oauth: ClaudeOauth } | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(root) || !isRecord(root.claudeAiOauth)) return null;
  const o = root.claudeAiOauth;
  const oauth: ClaudeOauth = {
    ...o,
    accessToken: typeof o.accessToken === 'string' ? o.accessToken : undefined,
    refreshToken: typeof o.refreshToken === 'string' ? o.refreshToken : undefined,
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
  };
  return { root, oauth };
}

function readOauth(file: string): { root: Record<string, unknown>; oauth: ClaudeOauth } | null {
  try {
    return parseOauth(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** sha256 of the refresh token in the local Claude login, or null. The server
 *  compares it with the vault's to tell a stale holder from a dead credential;
 *  the token itself never leaves the box. */
export function localClaudeRefreshTokenSha256(
  paths: () => string[] = claudeCredentialsPaths,
): string | null {
  for (const file of paths()) {
    const rt = readOauth(file)?.oauth.refreshToken;
    if (typeof rt === 'string' && rt.length > 0) {
      return crypto.createHash('sha256').update(rt).digest('hex');
    }
  }
  return null;
}

/** Write atomically with 0600: Claude Code may read the file at any moment. */
function writeAtomic0600(file: string, content: string): void {
  const tmp = path.join(path.dirname(file), `.credentials.codeam-${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createClaudeCredentialLease(
  opts: ClaudeCredentialLeaseOptions,
): ClaudeCredentialLease {
  const now = opts.now ?? Date.now;
  const paths = opts.credentialsPaths ?? claudeCredentialsPaths;
  const fetchLease =
    opts.fetchLease ??
    (async (minValidityMs: number): Promise<string | null> => {
      const ask = (pluginAuthToken: string) =>
        fetchProvisionCredentialDetailed({
          agentId: 'claude_code',
          sessionId: opts.sessionId,
          pluginId: opts.pluginId,
          pluginAuthToken,
          minValidityMs,
        });
      let res = await ask(opts.pluginAuthToken);
      if (!res.ok && (res.status === 401 || res.status === 403)) {
        const fresh = await fetchCurrentPluginAuthToken(
          opts.sessionId,
          opts.pluginId,
          opts.pollSecret,
        );
        if (fresh !== null) res = await ask(fresh);
      }
      if (!res.ok) {
        log.warn('cred-lease', `lease refused status=${res.status} code=${res.code ?? '-'}`);
        return null;
      }
      return res.method === 'oauth' ? res.credential : null;
    });

  // Last known expiry of the local access token: the hot path (every agent
  // event) is a number compare, no file read.
  let knownExpiresAt: number | null = null;
  let noLoginCheckedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;
  let turns = 0;

  const locate = (): { file: string; root: Record<string, unknown>; oauth: ClaudeOauth } | null => {
    for (const file of paths()) {
      const hit = readOauth(file);
      if (hit && typeof hit.oauth.refreshToken === 'string' && hit.oauth.refreshToken) {
        return { file, ...hit };
      }
    }
    return null;
  };

  const lease = async (force: boolean): Promise<void> => {
    const local = locate();
    if (!local) {
      // Setup-token / house proxy / not logged in: nothing of ours to rotate.
      noLoginCheckedAt = now();
      knownExpiresAt = null;
      return;
    }
    const localExpiry = typeof local.oauth.expiresAt === 'number' ? local.oauth.expiresAt : 0;
    if (!force && localExpiry - now() > CLAUDE_LEASE_LEAD_MS) {
      knownExpiresAt = localExpiry;
      return;
    }
    const blob = await fetchLease(CLAUDE_LEASE_LEAD_MS);
    const leased = blob !== null ? (parseOauth(blob)?.oauth ?? null) : null;
    if (!leased?.accessToken || !leased.refreshToken || typeof leased.expiresAt !== 'number') {
      // Server unreachable / vault dead: leave the file alone. Claude Code then
      // refreshes on its own, and the credential-sync watcher writes it back.
      knownExpiresAt = localExpiry;
      return;
    }
    if (!force && leased.expiresAt <= localExpiry) {
      knownExpiresAt = localExpiry;
      return;
    }
    if (
      leased.refreshToken === local.oauth.refreshToken &&
      leased.accessToken === local.oauth.accessToken
    ) {
      knownExpiresAt = localExpiry;
      return;
    }
    // Re-read right before writing: keep any fields Claude wrote meanwhile
    // (subscriptionType, rateLimitTier, MCP logins) and replace only the tokens.
    const current = readOauth(local.file) ?? { root: local.root, oauth: local.oauth };
    const next = {
      ...current.root,
      claudeAiOauth: {
        ...current.oauth,
        accessToken: leased.accessToken,
        refreshToken: leased.refreshToken,
        expiresAt: leased.expiresAt,
        ...(Array.isArray(leased.scopes) && leased.scopes.length > 0
          ? { scopes: leased.scopes }
          : {}),
      },
    };
    writeAtomic0600(local.file, JSON.stringify(next));
    knownExpiresAt = leased.expiresAt;
    log.info(
      'cred-lease',
      `wrote a leased claude credential (valid ${Math.round((leased.expiresAt - now()) / 60000)} min)`,
    );
  };

  const run = (force: boolean): Promise<void> => {
    if (inflight) return inflight;
    inflight = lease(force)
      .catch((err: unknown) => {
        log.warn('cred-lease', `lease failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const needsCheck = (): boolean => {
    if (knownExpiresAt !== null) return knownExpiresAt - now() <= CLAUDE_LEASE_LEAD_MS;
    return now() - noLoginCheckedAt >= NO_LOGIN_RECHECK_MS;
  };

  const ensureFresh = (): Promise<void> => (needsCheck() ? run(false) : Promise.resolve());

  return {
    ensureFresh,
    duringTurn: async <T>(fn: () => Promise<T>): Promise<T> => {
      await ensureFresh();
      turns += 1;
      try {
        return await fn();
      } finally {
        turns -= 1;
      }
    },
    onAgentActivity: () => {
      if (turns > 0) void ensureFresh();
    },
    recover: () => run(true),
  };
}

// ── The session's lease ─────────────────────────────────────────────────────
// One per CLI process, set by the composition root (`start.ts`) on cloud
// sessions once the runtime is Claude, read by the turn path and the
// credential-invalid report.
let active: ClaudeCredentialLease | null = null;

export function setActiveClaudeLease(lease: ClaudeCredentialLease | null): void {
  active = lease;
}

export function activeClaudeLease(): ClaudeCredentialLease | null {
  return active;
}
