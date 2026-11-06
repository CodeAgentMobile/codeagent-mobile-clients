import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../../services/logger';
import { DEPLOY_ID_RE, writeJson0600 } from './house-proxy-config';

/**
 * The env-delivered credential of a deploy (an `api_key` → `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
 * `CURSOR_API_KEY`…), persisted per deploy so a RESUME by a NEW host-agent process gets it back.
 *
 * WHY (dev release gate, 2026-11-06): the key lived only in the supervisor's memory
 * (`credentialEnvByDeploy`). A Box rebuilt on its volume, a wake or a self-update restart resumed
 * the session with no key, and the agent failed at start ("ACP start failed for antigravity:
 * Authentication required"). Login-FILE credentials (Claude/Codex OAuth) were never affected: the
 * file is on the volume. Same at-rest stance as those files and the house-proxy config: 0600 under
 * `~/.codeam`, written atomically, never logged.
 *
 * Path: `~/.codeam/credential-env/<deployId>.json`.
 */
export function credentialEnvPath(deployId: string): string | null {
  if (!DEPLOY_ID_RE.test(deployId) || deployId.includes('..')) return null;
  return path.join(os.homedir(), '.codeam', 'credential-env', `${deployId}.json`);
}

/** Persist (non-empty env) or remove (empty env) the deploy's credential env. Best-effort. */
export function persistCredentialEnv(deployId: string, env: Record<string, string>): void {
  const file = credentialEnvPath(deployId);
  if (!file) return;
  try {
    if (Object.keys(env).length === 0) fs.rmSync(file, { force: true });
    else writeJson0600(file, env);
  } catch (err) {
    log.warn(
      'host-agent',
      `failed to persist the credential env of deploy=${deployId.slice(0, 8)} (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The persisted credential env of a deploy, or `{}` (none, unreadable, malformed). */
export function readCredentialEnv(deployId: string): Record<string, string> {
  const file = credentialEnvPath(deployId);
  if (!file) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function clearCredentialEnv(deployId: string): void {
  persistCredentialEnv(deployId, {});
}
