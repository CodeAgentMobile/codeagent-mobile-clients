/**
 * Antigravity CLI (`agy`) on-disk auth layout — shared by `codeam link
 * antigravity` (capture) and the self-hosted credential provisioner (write).
 *
 * agy keeps its state under `~/.gemini/antigravity-cli/`:
 *   - `antigravity-oauth-token` — the OAuth login state, a JSON blob
 *     `{"token":{"access_token","token_type","refresh_token","expiry"},"auth_method":"consumer"}`
 *     (`expiry` is RFC 3339).
 *   - `settings.json` — `modelProvider: "gemini"` switches agy to a Gemini API
 *     key read from `GEMINI_API_KEY`. The env var alone does nothing: without
 *     that setting agy still asks to sign in.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LocalAgentToken, LocalAgentTokenValidation } from '../strategy';

export function antigravityDir(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli');
}

export function antigravityOauthTokenPath(home: string = os.homedir()): string {
  return path.join(antigravityDir(home), 'antigravity-oauth-token');
}

export function antigravitySettingsPath(home: string = os.homedir()): string {
  return path.join(antigravityDir(home), 'settings.json');
}

export function antigravityCredentialsPaths(): string[] {
  return [antigravityOauthTokenPath()];
}

/** The parts of the OAuth blob we check. */
interface AntigravityOauthBlob {
  token: { access_token: string; refresh_token?: string; expiry?: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Type guard for agy's OAuth login-state blob (needs a non-empty access_token). */
export function isAntigravityOauthBlob(v: unknown): v is AntigravityOauthBlob {
  if (!isRecord(v) || !isRecord(v.token)) return false;
  const { access_token: accessToken } = v.token;
  return typeof accessToken === 'string' && accessToken.length > 0;
}

/** `codeam link antigravity`: the signed-in agy's OAuth file, else GEMINI_API_KEY. */
export async function extractLocalAntigravityToken(): Promise<LocalAgentToken | null> {
  const file = antigravityOauthTokenPath();
  if (fs.existsSync(file)) {
    const credential = fs.readFileSync(file, 'utf8').trim();
    if (credential.length > 0) return { method: 'oauth', credential, source: 'flat-file' };
  }
  const key = process.env.GEMINI_API_KEY?.trim();
  if (key) return { method: 'api_key', credential: key, source: 'flat-file' };
  return null;
}

/**
 * Refuse uploading a dead OAuth snapshot. The access token is short-lived but
 * agy refreshes it from `refresh_token`, so a blob with a refresh token is
 * usable regardless of `expiry`; only a refresh-less blob past its expiry is
 * `expired`. API keys have no clock → `valid` when present.
 */
export function validateLocalAntigravityToken(token: LocalAgentToken): LocalAgentTokenValidation {
  if (token.method !== 'oauth') {
    return { status: token.credential.trim().length > 0 ? 'valid' : 'unknown' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(token.credential);
  } catch {
    return { status: 'unknown' };
  }
  if (!isAntigravityOauthBlob(parsed)) return { status: 'unknown' };
  if (parsed.token.refresh_token) return { status: 'valid' };
  const expiry = parsed.token.expiry ? Date.parse(parsed.token.expiry) : NaN;
  if (Number.isFinite(expiry) && expiry <= Date.now()) {
    return { status: 'expired', reason: 'Antigravity CLI session expired — run `agy` and sign in again.' };
  }
  return { status: 'valid' };
}
